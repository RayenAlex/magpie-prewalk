package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/access"
	"github.com/yetone/magpie/internal/budget"
	"github.com/yetone/magpie/internal/plugin"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/settings"
	"github.com/yetone/magpie/internal/testenv"
	"github.com/yetone/magpie/internal/usage"
)

// projectRoot uses the path the runner passes; runtime.Caller resolves to the
// overlayed source name inside the magpie checkout, not to this project.
func projectRoot(t *testing.T) string {
	t.Helper()
	root := os.Getenv("PREWALK_PROJECT_ROOT")
	if root == "" {
		_, file, _, ok := runtime.Caller(0)
		if !ok {
			t.Fatal("cannot locate project root; run scripts/test-provider-gateway.sh")
		}
		root = filepath.Dir(filepath.Dir(filepath.Dir(file)))
	}
	if _, err := os.Stat(filepath.Join(root, "src", "provider")); err != nil {
		t.Fatalf("PREWALK_PROJECT_ROOT does not name this project: %v", err)
	}
	return root
}

func providerPackageDir(t *testing.T) string {
	t.Helper()
	return filepath.Join(projectRoot(t), "dist", "magpie-prewalk-provider")
}

func copyPackage(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.WalkDir(src, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o600)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func patchFile(t *testing.T, path, old, replacement string) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := strings.ReplaceAll(string(b), old, replacement)
	if s == string(b) {
		t.Fatalf("mutation did not apply to %s", path)
	}
	if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}

type billingFixture struct {
	t        *testing.T
	up       *httptest.Server
	gw       *httptest.Server
	installed string
	service  access.Key
	serviceSecret string
	entrySecret string
	stateDir string
	mu       sync.Mutex
	served   []string
	upstreamCalls int
	seenHeader http.Header
	businessBodies []string
	judgmentBodies []string
	cancelStarted chan struct{}
	cancelSeen chan struct{}
	shared bool
	refuse atomic.Bool
	classifyVerdict string
	classifyRaw string
	classifyCalls int
	businessCalls int
	classifyFail bool
	classifyDelay time.Duration
	classifyStarted chan struct{}
	classifyCancelled chan struct{}
	healthVerdict string
	healthRaw string
	healthCalls int
	healthFail bool
	healthDelay time.Duration
	healthStarted chan struct{}
	healthCancelled chan struct{}
}

func newBillingFixture(t *testing.T, pluginDir string) *billingFixture {
	t.Helper()
	f := &billingFixture{t:t, cancelStarted:make(chan struct{},1), cancelSeen:make(chan struct{},1), classifyStarted:make(chan struct{},1), classifyCancelled:make(chan struct{},1), healthStarted:make(chan struct{},1), healthCancelled:make(chan struct{},1), classifyVerdict:"plan_then_execute", healthVerdict:"replan", shared:true}
	fresh(t)
	budget.Forget()
	t.Setenv("MAGPIE_BUN", testenv.Bun(t))
	f.stateDir=filepath.Join(t.TempDir(),"state")
	t.Setenv("PREWALK_STATE_DIR", f.stateDir)
	t.Setenv("MAGPIE_TRUST_PROXY","1")
	t.Cleanup(plugin.Settle)
	f.up = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
		var body map[string]any
		if err:=json.NewDecoder(r.Body).Decode(&body);err!=nil{t.Error(err);w.WriteHeader(400);return}
		model,_:=body["model"].(string)
		var content any
		if ms,ok:=body["messages"].([]any);ok&&len(ms)>0{if m,ok:=ms[0].(map[string]any);ok{content=m["content"]}}
		f.mu.Lock(); f.seenHeader=r.Header.Clone(); f.upstreamCalls++
		cancelled:=content=="cancel-probe"
		if !cancelled{f.served=append(f.served,model)}
		f.mu.Unlock()
		if cancelled{
			select{case f.cancelStarted<-struct{}{}:default:}
			select{case <-r.Context().Done():f.cancelSeen<-struct{}{};case <-time.After(6*time.Second):t.Error("inner upstream did not see cancellation")}
			return
		}
		if auth:=r.Header.Get("Authorization");auth!="Bearer upstream-only"&&auth!="Bearer second-only"{t.Error("vendor credential replaced")}
		if f.refuse.Load(){w.WriteHeader(401);fmt.Fprint(w,"real provider refused");return}
		raw,_:=json.Marshal(body)
		rawText:=string(raw)
		if strings.Contains(rawText,"execution_health")||strings.Contains(rawText,"task_route"){
			f.mu.Lock();f.judgmentBodies=append(f.judgmentBodies,rawText);f.mu.Unlock()
		}
		if strings.Contains(rawText,"execution_health"){
			f.mu.Lock();f.healthCalls++;verdict:=f.healthVerdict;rawAnswer:=f.healthRaw;fail:=f.healthFail;delay:=f.healthDelay;f.mu.Unlock()
			select{case f.healthStarted<-struct{}{}:default:}
			if delay>0{select{case <-time.After(delay):case <-r.Context().Done():select{case f.healthCancelled<-struct{}{}:default:};return}}
			if fail{w.WriteHeader(500);fmt.Fprint(w,"health failed");return}
			content:=rawAnswer
			if content==""{
				ref:="history:0"
				var doc struct{Messages []struct{Role string `json:"role"`;Content string `json:"content"`} `json:"messages"`}
				if json.Unmarshal(raw,&doc)==nil{for _,m:=range doc.Messages{if m.Role=="user"{var q struct{Evidence []string `json:"evidence"`};if json.Unmarshal([]byte(m.Content),&q)==nil&&len(q.Evidence)>0{ref=q.Evidence[0]}}}}
				ev:=[]string{}
				if verdict=="replan"{ev=[]string{ref}}
				evJSON,_:=json.Marshal(ev)
				content=fmt.Sprintf(`{"templateVersion":1,"verdict":%q,"evidence":%s}`,verdict,evJSON)
			}
			w.Header().Set("Content-Type","application/json")
			json.NewEncoder(w).Encode(map[string]any{"id":"health","model":model,"choices":[]map[string]any{{"index":0,"message":map[string]any{"role":"assistant","content":content},"finish_reason":"stop"}},"usage":map[string]any{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})
			return
		}
		if strings.Contains(string(raw),"task_route"){
			f.mu.Lock();f.classifyCalls++;verdict:=f.classifyVerdict;rawAnswer:=f.classifyRaw;fail:=f.classifyFail;delay:=f.classifyDelay;f.mu.Unlock()
			select{case f.classifyStarted<-struct{}{}:default:}
			if delay>0{select{case <-time.After(delay):case <-r.Context().Done():select{case f.classifyCancelled<-struct{}{}:default:};return}}
			if fail{w.WriteHeader(500);fmt.Fprint(w,"classify failed");return}
			content:=rawAnswer
			if content==""{content=fmt.Sprintf(`{"templateVersion":1,"verdict":%q,"evidence":["history:0"]}`,verdict)}
			w.Header().Set("Content-Type","application/json")
			json.NewEncoder(w).Encode(map[string]any{"id":"judge","model":model,"choices":[]map[string]any{{"index":0,"message":map[string]any{"role":"assistant","content":content},"finish_reason":"stop"}},"usage":map[string]any{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})
			return
		}
		w.Header().Set("Content-Type","text/event-stream")
		f.mu.Lock();f.businessCalls++;f.businessBodies=append(f.businessBodies,string(raw));f.mu.Unlock()
		fmt.Fprintf(w,"data: {\"id\":\"real\",\"model\":%q,\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":null}]}\n\n",model)
		fmt.Fprintf(w,"data: {\"id\":\"real\",\"model\":%q,\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"total_tokens\":10}}\n\ndata: [DONE]\n\n",model)
	}))
	t.Cleanup(f.up.Close)
	if err:=provider.Save(provider.Provider{ID:"real",Name:"Fake real",Key:"upstream-only",Keys:[]provider.KeyAccount{{Key:"second-only"}},Models:[]string{"planner","executor","outside"},Chat:f.up.URL+"/v1"});err!=nil{t.Fatal(err)}
	keys,secrets:=newCaller(t,"Prewalk service","Entry caller")
	f.service,f.serviceSecret,f.entrySecret=keys[0],secrets[0],secrets[1]
	for _,c:=range []struct{action string;change access.Change}{
		{"models-key",access.Change{Key:keys[0].ID,Models:[]string{"real/planner","real/executor"}}},
		{"models-key",access.Change{Key:keys[1].ID,Models:[]string{"prewalk/route"}}},
		{"limit-key",access.Change{Key:keys[0].ID,Limit:&access.Limit{Period:"day",Tokens:1000000}}},
	}{if _,err:=access.Update(c.action,c.change);err!=nil{t.Fatal(err)}}
	one,two,zero:=1.0,2.0,0.0
	prices:=settings.Load()
	prices.ModelPrices=map[string]settings.ModelPrice{
		"real/planner":{Input:&one,Output:&two,CacheRead:&zero,CacheWrite:&zero},
		"real/executor":{Input:&one,Output:&two,CacheRead:&zero,CacheWrite:&zero},
		"prewalk/route":{Input:&zero,Output:&zero,CacheRead:&zero,CacheWrite:&zero},
	}
	if err:=settings.Save(prices);err!=nil{t.Fatal(err)}
	installed,err:=plugin.Add(t.Context(),pluginDir);if err!=nil{t.Fatal(err)}
	f.installed=installed.Spec
	if err:=plugin.SetOptions(f.installed,map[string]any{"providerID":"prewalk","modelID":"route","planner":"real/planner","executor":"real/executor"});err!=nil{t.Fatal(err)}
	f.gw=httptest.NewServer(lanGuard(New().Handler()));t.Cleanup(f.gw.Close)
	t.Setenv("MAGPIE_ADDR",strings.TrimPrefix(f.gw.URL,"http://"))
	return f
}

func (f *billingFixture) signIn(serviceSecret string){
	f.t.Helper()
	plugin.Settle()
	if _,err:=plugin.Providers(f.t.Context());err!=nil{f.t.Fatal(err)}
	if _,err:=plugin.APIKey(f.t.Context(),"prewalk",0,nil,serviceSecret,"");err!=nil{f.t.Fatal(err)}
}

type probeResult struct {
	code int
	body string
}

func (f *billingFixture) send(text string)(int,string){
	f.t.Helper()
	ctx:=f.t.Context()
	cancel:=func(){}
	if text=="cancel-probe"{var c context.CancelFunc;ctx,c=context.WithCancel(ctx);cancel=c}
	r,err:=http.NewRequestWithContext(ctx,"POST",f.gw.URL+"/v1/chat/completions",strings.NewReader(`{"model":"prewalk/route","stream":true,"messages":[{"role":"user","content":"`+text+`"}]}`));if err!=nil{f.t.Fatal(err)}
	r.Header.Set("Authorization","Bearer "+f.entrySecret);r.Header.Set("Content-Type","application/json")
	done:=make(chan probeResult,1)
	go func(){res,err:=f.gw.Client().Do(r);if err!=nil{done<-probeResult{0,err.Error()};return};defer res.Body.Close();b,_:=io.ReadAll(res.Body);done<-probeResult{res.StatusCode,string(b)}}()
	if text=="cancel-probe"{
		select{case <-f.cancelStarted:cancel();case <-time.After(6*time.Second):cancel();f.t.Fatal("inner cancel probe never started")}
	}
	out:=<-done
	if text=="cancel-probe"{select{case <-f.cancelSeen:case <-time.After(6*time.Second):f.t.Fatal("cancellation did not reach inner upstream")}}
	return out.code,out.body
}

func (f *billingFixture) calls()int{f.mu.Lock();defer f.mu.Unlock();return f.upstreamCalls}

func (f *billingFixture) classifyCount()int{f.mu.Lock();defer f.mu.Unlock();return f.classifyCalls}

func (f *billingFixture) healthCount()int{f.mu.Lock();defer f.mu.Unlock();return f.healthCalls}

func (f *billingFixture) lastBusinessBody()string{
	f.mu.Lock();defer f.mu.Unlock()
	if len(f.businessBodies)==0{return ""}
	return f.businessBodies[len(f.businessBodies)-1]
}

func (f *billingFixture) businessBodiesMatching(model string)[]string{
	f.mu.Lock();defer f.mu.Unlock()
	out:=[]string{}
	for _,body:=range f.businessBodies{
		var parsed struct{Model string `json:"model"`}
		if json.Unmarshal([]byte(body),&parsed)==nil&&parsed.Model==model{out=append(out,body)}
	}
	return out
}

func (f *billingFixture) judgmentBodiesSnapshot()[]string{
	f.mu.Lock();defer f.mu.Unlock()
	return append([]string{},f.judgmentBodies...)
}

func (f *billingFixture) lastServed()string{
	f.mu.Lock();defer f.mu.Unlock()
	if len(f.served)==0{return ""}
	return f.served[len(f.served)-1]
}

// sendState posts a Chat body with an optional session and returns the
// response headers, which carry the chosen phase and reason.
func (f *billingFixture) sendState(session, messages string)(int,string,http.Header){
	f.t.Helper()
	r,err:=http.NewRequestWithContext(f.t.Context(),"POST",f.gw.URL+"/v1/chat/completions",strings.NewReader(`{"model":"prewalk/route","stream":true,"messages":`+messages+`}`))
	if err!=nil{f.t.Fatal(err)}
	r.Header.Set("Authorization","Bearer "+f.entrySecret);r.Header.Set("Content-Type","application/json")
	if session!=""{r.Header.Set("X-Magpie-Session",session)}
	res,err:=f.gw.Client().Do(r);if err!=nil{f.t.Fatal(err)}
	defer res.Body.Close()
	b,_:=io.ReadAll(res.Body)
	return res.StatusCode,string(b),res.Header.Clone()
}

// sendWithTools posts a Chat body that also carries tools, so a test can prove
// the provider leaves the client's original request intact.
func (f *billingFixture) sendWithTools(session,messages,tools string)(int,http.Header){
	f.t.Helper()
	body:=`{"model":"prewalk/route","stream":true,"messages":`+messages+`,"tools":`+tools+`}`
	r,err:=http.NewRequestWithContext(f.t.Context(),"POST",f.gw.URL+"/v1/chat/completions",strings.NewReader(body))
	if err!=nil{f.t.Fatal(err)}
	r.Header.Set("Authorization","Bearer "+f.entrySecret)
	r.Header.Set("Content-Type","application/json")
	r.Header.Set("X-Magpie-Session",session)
	res,err:=f.gw.Client().Do(r);if err!=nil{f.t.Fatal(err)}
	defer res.Body.Close()
	_,_=io.ReadAll(res.Body)
	return res.StatusCode,res.Header.Clone()
}

func chatPlan(ref string)string{
	body,_:=json.Marshal(map[string]any{"role":"assistant","content":"prewalk plan:"+ref+"\n1. do it"})
	return string(body)
}

func chatEdit(id string, ok bool)string{
	call,_:=json.Marshal(map[string]any{"role":"assistant","tool_calls":[]map[string]any{{"id":id,"type":"function","function":map[string]any{"name":"Edit","arguments":"{}"}}}})
	text:="ok";if !ok{text="Error: failed"}
	result,_:=json.Marshal(map[string]any{"role":"tool","tool_call_id":id,"content":text})
	return string(call)+","+string(result)
}

func chatMessages(parts ...string)string{
	return "["+strings.Join(append([]string{`{"role":"user","content":"task"}`},parts...),",")+"]"
}

// handoffScope mirrors the provider contract: SHA256 over the session and the
// configured target identity.
func handoffScope(session string)string{
	raw,_:=json.Marshal([]string{session,"prewalk","route","real/planner","real/executor"})
	sum:=sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func stateNumber(state map[string]any,key string)int{
	if value,ok:=state[key].(float64);ok{return int(value)}
	return -1
}

func chatReadFile(id,path,text string)string{
	args,_:=json.Marshal(map[string]string{"file_path":path})
	call,_:=json.Marshal(map[string]any{"role":"assistant","tool_calls":[]map[string]any{{"id":id,"type":"function","function":map[string]any{"name":"Read","arguments":string(args)}}}})
	result,_:=json.Marshal(map[string]any{"role":"tool","tool_call_id":id,"content":text})
	return string(call)+","+string(result)
}

func chatWrite(id,path,content,result string,paired bool)string{
	args,_:=json.Marshal(map[string]string{"file_path":path,"content":content})
	call,_:=json.Marshal(map[string]any{"role":"assistant","tool_calls":[]map[string]any{{"id":id,"type":"function","function":map[string]any{"name":"Write","arguments":string(args)}}}})
	if !paired{return string(call)}
	res,_:=json.Marshal(map[string]any{"role":"tool","tool_call_id":id,"content":result})
	return string(call)+","+string(res)
}

const (
	handoffObserved = "src/task.txt: observable implementation detail"
	evidenceIndexMarker = "Prewalk evidence index"
	handoffFeedbackMarker = "Prewalk handoff feedback"
)

type handoffTurn struct{
	readID string
	parts []string
}

// handoffTurn builds a paired Read observation, a plan marker and the dedicated
// JSON Write for the session's current stateVersion and next planRevision.
func (f *billingFixture) handoffTurn(session,ref string)handoffTurn{
	return f.handoffAttempt(session,ref,nil,"File written successfully",true)
}

func (f *billingFixture) handoffAttempt(session,ref string,mutate func(map[string]any),writeResult string,paired bool)handoffTurn{
	f.t.Helper()
	readID:="read-"+ref
	path,content:=f.handoffPacket(session,ref,mutate)
	return handoffTurn{
		readID:readID,
		parts:[]string{chatReadFile(readID,"src/task.txt",handoffObserved),chatPlan(ref),chatWrite("write-"+ref,path,content,writeResult,paired)},
	}
}

// handoffPacket builds the package for the session's current binding so a test
// can mutate it or reuse the same binding under a different Write id.
func (f *billingFixture) handoffPacket(session,ref string,mutate func(map[string]any))(string,string){
	f.t.Helper()
	state:=f.sessionState(session)
	if state==nil{f.t.Fatalf("handoff for %s without session state",session)}
	scope:=handoffScope(session)
	revision:=stateNumber(state,"planRevision")+1
	version:=stateNumber(state,"stateVersion")
	path:=fmt.Sprintf(".prewalk/handoff-%s-r%d.json",scope[:16],revision)
	packet:=map[string]any{
		"version":1,"scope":scope,"stateVersion":version,"planRevision":revision,"planRef":ref,
		"goal":"Apply the requested task using the observed structure",
		"constraints":[]string{"Keep the existing public behavior"},
		"evidence":[]map[string]any{{"ref":"tool:read-"+ref,"quote":handoffObserved,"fact":"Read the current source"}},
		"decisions":[]map[string]any{{"choice":"Reuse the observed structure","reason":"It matches the workspace","rejected":"Rewrite from scratch"}},
		"steps":[]map[string]any{{"id":"s1","files":[]string{"src/task.txt"},"action":"Apply the requested change","evidenceRefs":[]string{"tool:read-"+ref},"doneWhen":"The requested change is present"}},
		"checks":[]map[string]any{{"command":"true","expected":"The check passes","guardsAgainst":"An unverified change"}},
		"completedWork":[]string{},
		"boundaries":[]string{"Necessary reads and result checks remain required"},
		"blockedBy":[]string{},
		"nextStep":"s1",
	}
	if mutate!=nil{mutate(packet)}
	raw,_:=json.Marshal(packet)
	return path,string(raw)
}

// planningSection reads the marker line and the JSON on the next line from the
// planning overlay the upstream planner actually received.
func planningSection(t *testing.T, body, marker string)map[string]any{
	t.Helper()
	var doc struct{Messages []struct{Role string `json:"role"`;Content json.RawMessage `json:"content"`} `json:"messages"`}
	if err:=json.Unmarshal([]byte(body),&doc);err!=nil{t.Fatalf("planner body: %v",err)}
	if len(doc.Messages)==0{t.Fatal("planner body has no messages")}
	last:=doc.Messages[len(doc.Messages)-1]
	var content string
	if err:=json.Unmarshal(last.Content,&content);err!=nil{t.Fatalf("planning overlay content: %v",err)}
	if last.Role!="system"||!strings.HasPrefix(content,"Prewalk plan marker"){t.Fatalf("planning overlay is not the last system message: %q",last.Role)}
	lines:=strings.Split(content,"\n")
	for i,line:=range lines{
		if line!=marker{continue}
		if i+1>=len(lines){t.Fatalf("%s has no JSON line",marker)}
		var out map[string]any
		if err:=json.Unmarshal([]byte(lines[i+1]),&out);err!=nil{t.Fatalf("%s JSON: %v",marker,err)}
		return out
	}
	t.Fatalf("%s missing from the planning overlay: %s",marker,content)
	return nil
}

// indexEntry returns the upstream-published ref/quote/tool for a real tool id,
// so repair packages are built from what the planner actually saw.
func indexEntry(t *testing.T, index map[string]any, id string)(string,string,string){
	t.Helper()
	entries,ok:=index["entries"].([]any)
	if !ok{t.Fatalf("evidence index entries: %+v",index)}
	for _,item:=range entries{
		entry,ok:=item.(map[string]any)
		if !ok||entry["ref"]!="tool:"+id{continue}
		ref,_:=entry["ref"].(string)
		quote,_:=entry["quote"].(string)
		tool,_:=entry["tool"].(string)
		return ref,quote,tool
	}
	t.Fatalf("evidence index has no entry for tool:%s: %+v",id,index)
	return "","",""
}

func hasIssue(feedback map[string]any, want string)bool{
	issues,ok:=feedback["issues"].([]any)
	if !ok{return false}
	for _,issue:=range issues{if issue==want{return true}}
	return false
}

func containsMarker(body string)bool{
	return strings.Contains(body,evidenceIndexMarker)||strings.Contains(body,handoffFeedbackMarker)
}

// plannerBinding asserts the planning prompt gives the exact scope/version
// binding used by the dedicated JSON package.
func (f *billingFixture) plannerBinding(session string, state map[string]any) {
	f.t.Helper()
	revision := stateNumber(state, "planRevision") + 1
	for _, body := range f.businessBodiesMatching("planner") {
		if strings.Contains(body, "scope="+handoffScope(session)) &&
			strings.Contains(body, fmt.Sprintf("stateVersion=%d", stateNumber(state, "stateVersion"))) &&
			strings.Contains(body, fmt.Sprintf("planRevision=%d", revision)) {
			return
		}
	}
	f.t.Fatalf("planner business bodies lack the exact scope/stateVersion/planRevision binding for %s r%d", session, revision)
}

// sent appends one request's message parts without sharing the caller's array.
func sent(parts ...[]string)[]string{
	out:=[]string{}
	for _,group:=range parts{out=append(out,group...)}
	return out
}

// sessionState reads the persisted state; the gateway does not forward
// custom response headers, so the file is the observable evidence.
func (f *billingFixture) sessionState(session string)map[string]any{
	f.t.Helper()
	b,err:=os.ReadFile(filepath.Join(f.stateDir,"sessions.json"))
	if os.IsNotExist(err){return nil}
	if err!=nil{f.t.Fatal(err)}
	var doc struct{Sessions map[string]map[string]any `json:"sessions"`}
	if err:=json.Unmarshal(b,&doc);err!=nil{f.t.Fatal(err)}
	key:=base64.RawURLEncoding.EncodeToString([]byte(session))
	return doc.Sessions[key]
}

func (f *billingFixture) expectState(session, phase string, replans int){
	f.t.Helper()
	state:=f.sessionState(session)
	if state==nil{f.t.Fatalf("no state for %s",session)}
	if got:=state["phase"];got!=phase{f.t.Fatalf("%s phase=%v want %s",session,got,phase)}
	if got:=state["replanCount"];got!=float64(replans){f.t.Fatalf("%s replanCount=%v want %d",session,got,replans)}
}

// clientUsage reads the usage event the client received, not the ledger.
func clientUsage(t *testing.T, stream string) (int, int) {
	t.Helper()
	for _, line := range strings.Split(stream, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data: ") || line == "data: [DONE]" {
			continue
		}
		var event struct {
			Usage *struct {
				Prompt     int `json:"prompt_tokens"`
				Completion int `json:"completion_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
			t.Fatalf("client stream event: %v", err)
		}
		if event.Usage != nil {
			return event.Usage.Prompt, event.Usage.Completion
		}
	}
	t.Fatal("client stream carried no usage")
	return 0, 0
}

func TestProviderPackagePlannerPromptInjection(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	code,_,_:=f.sendState("prompt",chatMessages())
	if code!=200||f.lastServed()!="planner"{t.Fatalf("new session: %d served=%s",code,f.lastServed())}
	planningBodies:=f.businessBodiesMatching("planner")
	if len(planningBodies)!=1{t.Fatalf("planner business bodies=%d",len(planningBodies))}
	if !strings.Contains(planningBodies[0],"Prewalk plan marker"){t.Fatalf("planner prompt marker missing: %s",planningBodies[0])}
	f.plannerBinding("prompt",f.sessionState("prompt"))
	// A short plan plus a business Edit is not a handoff package.
	code,_,_=f.sendState("prompt",chatMessages(chatPlan("prompt-1"),chatEdit("a1",true)))
	if code!=200||f.lastServed()!="planner"{t.Fatalf("business edit: %d served=%s",code,f.lastServed())}
	f.expectState("prompt","planning",0)
	if got:=f.businessBodiesMatching("executor");len(got)!=0{t.Fatalf("business Edit reached executor: %d bodies",len(got))}
	turn:=f.handoffTurn("prompt","prompt-1")
	history:=sent([]string{chatPlan("prompt-1"),chatEdit("a1",true)},turn.parts)
	sourceMessages:=chatMessages(history...)
	code,_,_=f.sendState("prompt",sourceMessages)
	if code!=200||f.lastServed()!="executor"{t.Fatalf("handoff: %d served=%s",code,f.lastServed())}
	executorBodies:=f.businessBodiesMatching("executor")
	if len(executorBodies)!=1{t.Fatalf("executor business bodies=%d",len(executorBodies))}
	executorContract(t,f,turn)
	if strings.Contains(executorBodies[0],"Prewalk plan marker"){t.Fatal("plan prompt leaked to executor")}
	if !strings.Contains(executorBodies[0],"Prewalk execution contract"){t.Fatalf("executor contract missing: %s",executorBodies[0])}
	if !strings.Contains(executorBodies[0],"Apply the requested task using the observed structure"){t.Fatalf("executor lacks packet goal")}
	if !strings.Contains(executorBodies[0],handoffObserved){t.Fatalf("executor lacks packet evidence quote")}
	if !strings.Contains(executorBodies[0],"tool:"+turn.readID){t.Fatalf("executor lacks packet evidence ref")}
	if !strings.Contains(executorBodies[0],`"content":"task"`){t.Fatalf("executor lacks the user message")}
	for _,judgment:=range f.judgmentBodiesSnapshot(){
		if strings.Contains(judgment,"Prewalk plan marker"){t.Fatalf("plan prompt leaked to judgment: %s",judgment)}
	}
	if f.classifyCount()!=1{t.Fatalf("classify calls=%d",f.classifyCount())}
	if got:=len(f.businessBodiesMatching("planner"));got!=2{t.Fatalf("planner business bodies=%d",got)}
	t.Log("bounded plan prompt reached planner only; the evidence-backed package carried the executor contract")
}

// executorContract verifies the appended system overlay carries the current
// package JSON while the original user message remains in its original position.
func executorContract(t *testing.T, f *billingFixture, turn handoffTurn) {
	t.Helper()
	body := f.lastBusinessBody()
	var doc struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(body), &doc); err != nil { t.Fatalf("executor body: %v", err) }
	if len(doc.Messages) < 2 { t.Fatalf("executor messages=%d", len(doc.Messages)) }
	if doc.Messages[0].Role != "user" || doc.Messages[0].Content != "task" { t.Fatalf("original user message changed: %+v", doc.Messages[0]) }
	last := doc.Messages[len(doc.Messages)-1]
	if last.Role != "system" || !strings.HasPrefix(last.Content, "Prewalk execution contract") { t.Fatalf("contract is not the appended system message: %q", last.Role) }
	if !strings.Contains(last.Content, `"goal":"Apply the requested task using the observed structure"`) { t.Fatal("contract lacks current package goal") }
	if !strings.Contains(last.Content, "tool:"+turn.readID) { t.Fatal("contract lacks current package evidence ref") }
}

// The installed package must give the planner a copyable index of the real
// observations while leaving the client request untouched.
func TestProviderPackagePlannerEvidenceIndex(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	if code,_,_:=f.sendState("evidence-index",chatMessages());code!=200||f.lastServed()!="planner"{t.Fatalf("new session: %d served=%s",code,f.lastServed())}
	tools:=`[{"type":"function","function":{"name":"Write","parameters":{"type":"object"}}}]`
	history:=chatMessages(chatReadFile("read-live-index","src/task.txt",handoffObserved),chatPlan("plan-1"))
	code,_:=f.sendWithTools("evidence-index",history,tools)
	if code!=200||f.lastServed()!="planner"{t.Fatalf("investigation: %d served=%s",code,f.lastServed())}
	var upstream struct{Messages []any `json:"messages"`;Tools any `json:"tools"`}
	if err:=json.Unmarshal([]byte(f.lastBusinessBody()),&upstream);err!=nil{t.Fatal(err)}
	var original []any
	if err:=json.Unmarshal([]byte(history),&original);err!=nil{t.Fatal(err)}
	if len(upstream.Messages)!=len(original)+1{t.Fatalf("upstream messages=%d original=%d",len(upstream.Messages),len(original))}
	if !reflect.DeepEqual(upstream.Messages[:len(original)],original){t.Fatal("planning overlay changed the original messages")}
	var expectedTools any
	if err:=json.Unmarshal([]byte(tools),&expectedTools);err!=nil{t.Fatal(err)}
	if !reflect.DeepEqual(upstream.Tools,expectedTools){t.Fatalf("planning overlay changed tools: %v",upstream.Tools)}
	body:=f.lastBusinessBody()
	index:=planningSection(t,body,evidenceIndexMarker)
	entries,ok:=index["entries"].([]any)
	if !ok||len(entries)!=1{t.Fatalf("evidence index entries=%v want the single real Read",index["entries"])}
	if omitted:=index["omitted"];omitted!=float64(0){t.Fatalf("evidence index omitted=%v want 0",omitted)}
	ref,quote,tool:=indexEntry(t,index,"read-live-index")
	if ref!="tool:read-live-index"||quote!=handoffObserved||tool!="Read"{t.Fatalf("evidence index entry ref=%q tool=%q quote=%q",ref,tool,quote)}
	if feedback:=planningSection(t,body,handoffFeedbackMarker);feedback["status"]!="not_submitted"{t.Fatalf("no package feedback status=%v",feedback["status"])}
	f.expectState("evidence-index","planning",0)
	if got:=f.businessBodiesMatching("executor");len(got)!=0{t.Fatalf("planning request reached executor: %d bodies",len(got))}
	t.Log("planner received the exact real ref/quote index with original messages/tools intact")
}

func TestProviderPackageStructuredToolEvidence(t *testing.T) {
	f := newBillingFixture(t, providerPackageDir(t))
	f.signIn(f.serviceSecret)
	if code, _, _ := f.sendState("structured-evidence", chatMessages()); code != 200 { t.Fatalf("new session: %d", code) }
	call, _ := json.Marshal(map[string]any{"role":"assistant", "tool_calls":[]map[string]any{{"id":"read-structured", "type":"function", "function":map[string]any{"name":"Read", "arguments":`{"file_path":"src/task.txt"}`}}}})
	for _, tc := range []struct { name string; parts []map[string]any; want string }{
		{"failed", []map[string]any{{"type":"text", "text":"Error: permission denied", "cache_control":map[string]string{"type":"ephemeral"}}}, ""},
		{"multi-text", []map[string]any{{"type":"text", "text":"alpha", "cache_control":map[string]string{"type":"ephemeral"}}, {"type":"text", "text":"beta"}}, "alpha"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, _ := json.Marshal(map[string]any{"role":"tool", "tool_call_id":"read-structured", "content":tc.parts})
			code, _, _ := f.sendState("structured-evidence", chatMessages(string(call), string(result)))
			if code != 200 || f.lastServed() != "planner" { t.Fatalf("structured evidence: %d served=%s", code, f.lastServed()) }
			index := planningSection(t, f.lastBusinessBody(), evidenceIndexMarker)
			entries, ok := index["entries"].([]any)
			if !ok { t.Fatalf("index entries=%v", index["entries"]) }
			if tc.want == "" {
				if len(entries) != 0 { t.Fatalf("failed structured result became evidence: %v", entries) }
			} else {
				ref, quote, tool := indexEntry(t, index, "read-structured")
				if len(entries) != 1 || ref != "tool:read-structured" || quote != tc.want || tool != "Read" { t.Fatalf("structured quote: ref=%s quote=%q tool=%s entries=%v", ref, quote, tool, entries) }
			}
			f.expectState("structured-evidence", "planning", 0)
			if got := len(f.businessBodiesMatching("executor")); got != 0 { t.Fatalf("structured observation reached executor: %d", got) }
		})
	}
}

// A package whose evidence uses the tool name twice is rejected with a
// bounded, structured reason and a copyable index; the same session can then
// hand off a repaired package built from that upstream index.
func TestProviderPackageRejectedEvidenceFeedbackAndRepair(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	session:="evidence-feedback"
	if code,_,_:=f.sendState(session,chatMessages());code!=200||f.lastServed()!="planner"{t.Fatalf("new session: %d served=%s",code,f.lastServed())}
	bad:=f.handoffAttempt(session,"plan-1",func(packet map[string]any){
		packet["evidence"]=[]map[string]any{
			{"ref":"tool:functions.Read","quote":handoffObserved,"fact":"first claim"},
			{"ref":"tool:functions.Read","quote":handoffObserved,"fact":"second claim"},
		}
		packet["steps"]=[]map[string]any{{"id":"s1","files":[]string{"src/task.txt"},"action":"Apply the requested change","evidenceRefs":[]string{"tool:functions.Read"},"doneWhen":"The requested change is present"}}
	},"File written successfully",true)
	history:=sent(bad.parts)
	if code,_,_:=f.sendState(session,chatMessages(history...));code!=200||f.lastServed()!="planner"{t.Fatalf("tool-name package: %d served=%s",code,f.lastServed())}
	if got:=f.businessBodiesMatching("executor");len(got)!=0{t.Fatalf("rejected package reached executor: %d bodies",len(got))}
	f.expectState(session,"planning",0)
	body:=f.lastBusinessBody()
	feedback:=planningSection(t,body,handoffFeedbackMarker)
	if feedback["status"]!="rejected"||feedback["reason"]!="handoff_binding"{t.Fatalf("feedback status=%v reason=%v",feedback["status"],feedback["reason"])}
	if !hasIssue(feedback,"duplicate_evidence_refs")||!hasIssue(feedback,"unknown_evidence_refs"){t.Fatalf("feedback issues=%v lack duplicate/unknown refs",feedback["issues"])}
	index:=planningSection(t,body,evidenceIndexMarker)
	ref,quote,tool:=indexEntry(t,index,"read-plan-1")
	if quote!=handoffObserved||tool!="Read"{t.Fatalf("index entry ref=%q tool=%q quote=%q",ref,tool,quote)}
	if got,ok:=index["entries"].([]any);!ok||len(got)!=1{t.Fatalf("feedback turn index=%v want the single real Read",index["entries"])}
	t.Logf("rejected tool-name package kept planner with feedback status=%v reason=%v ref=%s",feedback["status"],feedback["reason"],ref)

	path,content:=f.handoffPacket(session,"plan-1",func(packet map[string]any){
		packet["evidence"]=[]map[string]any{{"ref":ref,"quote":quote,"fact":"Read the current source"}}
		packet["steps"]=[]map[string]any{{"id":"s1","files":[]string{"src/task.txt"},"action":"Apply the requested change","evidenceRefs":[]string{ref},"doneWhen":"The requested change is present"}}
	})
	history=sent(history,[]string{chatWrite("write-repaired-evidence",path,content,"File written successfully",true)})
	if code,_,_:=f.sendState(session,chatMessages(history...));code!=200||f.lastServed()!="executor"{t.Fatalf("repaired package: %d served=%s",code,f.lastServed())}
	executorBodies:=f.businessBodiesMatching("executor")
	if len(executorBodies)!=1{t.Fatalf("executor bodies=%d",len(executorBodies))}
	executorContract(t,f,handoffTurn{readID:"read-plan-1"})
	if !strings.Contains(f.lastBusinessBody(),quote)||!strings.Contains(f.lastBusinessBody(),ref){t.Fatalf("executor lacks the indexed ref/quote ref=%s",ref)}
	if containsMarker(f.lastBusinessBody()){t.Fatalf("executor body contains a planning marker: %s",f.lastBusinessBody())}
	f.expectState(session,"executing",0)

	history=sent(history,[]string{chatEdit("repaired-failure",false)})
	if code,_,_:=f.sendState(session,chatMessages(history...));code!=200||f.lastServed()!="planner"{t.Fatalf("health after repair: %d served=%s",code,f.lastServed())}
	if f.healthCount()<1{t.Fatal("repair package did not trigger a health judgment")}
	for _,judgment:=range f.judgmentBodiesSnapshot(){
		if containsMarker(judgment){t.Fatalf("classification/health request contains a planning marker: %s",judgment)}
	}
	f.expectState(session,"replanning",1)
	t.Log("a repaired package built from the upstream index handed off; judgment requests stayed marker-free")
}

// A plan followed by a successful business Edit is the old, insufficient
// handoff signal; only the dedicated JSON package may reach the executor.
func TestProviderPackageBusinessEditDoesNotHandoff(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	code,_,_:=f.sendState("plain-edit",chatMessages())
	if code!=200||f.lastServed()!="planner"{t.Fatalf("new: %d served=%s",code,f.lastServed())}
	f.plannerBinding("plain-edit", f.sessionState("plain-edit"))
	code,_,_=f.sendState("plain-edit",chatMessages(chatPlan("plan-1"),chatEdit("a1",true)))
	if code!=200||f.lastServed()!="planner"{t.Fatalf("business edit: %d served=%s",code,f.lastServed())}
	f.expectState("plain-edit","planning",0)
	if got:=f.businessBodiesMatching("executor");len(got)!=0{t.Fatalf("business Edit reached executor: %d bodies",len(got))}
	if !strings.Contains(f.lastBusinessBody(),"Prewalk plan marker"){t.Fatal("planner did not receive the plan prompt")}
	t.Log("a short plan and a successful Edit kept the planner; no executor request was made")
}

func TestProviderPackageInvalidHandoffKeepsPlanner(t *testing.T) {
	override:=func(key string,value any)func(map[string]any){return func(packet map[string]any){packet[key]=value}}
	cases:=[]struct{name string;attempt func(f *billingFixture)handoffTurn}{
		{"wrong scope",func(f *billingFixture)handoffTurn{return f.handoffAttempt("bad-packet","plan-1",override("scope",strings.Repeat("b",64)),"File written successfully",true)}},
		{"wrong state version",func(f *billingFixture)handoffTurn{return f.handoffAttempt("bad-packet","plan-1",override("stateVersion",999),"File written successfully",true)}},
		{"wrong plan ref",func(f *billingFixture)handoffTurn{return f.handoffAttempt("bad-packet","plan-1",override("planRef","plan-other"),"File written successfully",true)}},
		{"forged evidence ref",func(f *billingFixture)handoffTurn{return f.handoffAttempt("bad-packet","plan-1",override("evidence",[]map[string]any{{"ref":"tool:missing","quote":handoffObserved,"fact":"never observed"}}),"File written successfully",true)}},
		{"forged quote",func(f *billingFixture)handoffTurn{return f.handoffAttempt("bad-packet","plan-1",override("evidence",[]map[string]any{{"ref":"tool:read-plan-1","quote":"invented output","fact":"not the observed text"}}),"File written successfully",true)}},
		{"failed write",func(f *billingFixture)handoffTurn{return f.handoffAttempt("bad-packet","plan-1",nil,"Error: denied",true)}},
		// Magpie mends an unanswered tool call with an "unavailable" tool
		// result before relaying; that placeholder must stay non-authorizing.
		{"unanswered write",func(f *billingFixture)handoffTurn{return f.handoffAttempt("bad-packet","plan-1",nil,"File written successfully",false)}},
	}
	for _,tc:=range cases{
		t.Run(tc.name,func(t *testing.T){
			f:=newBillingFixture(t,providerPackageDir(t))
			f.signIn(f.serviceSecret)
			if code,_,_:=f.sendState("bad-packet",chatMessages());code!=200||f.lastServed()!="planner"{t.Fatalf("new: %d served=%s",code,f.lastServed())}
			attempt:=tc.attempt(f)
			code,_,_:=f.sendState("bad-packet",chatMessages(attempt.parts...))
			if code!=200||f.lastServed()!="planner"{
				t.Fatalf("%s: %d served=%s executorBodies=%d mendedUnavailable=%v",tc.name,code,f.lastServed(),len(f.businessBodiesMatching("executor")),strings.Contains(f.lastBusinessBody(),"result of this tool call is unavailable"))
			}
			if got:=f.businessBodiesMatching("executor");len(got)!=0{t.Fatalf("%s reached executor: %d bodies; state=%+v body=%s",tc.name,len(got),f.sessionState("bad-packet"),got[0])}
			f.expectState("bad-packet","planning",0)
		})
	}
	t.Log("wrong scope/version/ref, forged evidence, failed or unpaired writes kept the planner")
}

// Only a structured assistant mismatch after the current package and a real
// observation may consume one replan; user text and old signals do not.
func TestProviderPackageMismatchReplansAndRequiresNewPackage(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	if code,_,_:=f.sendState("mismatch",chatMessages());code!=200||f.lastServed()!="planner"{t.Fatalf("new: %d served=%s",code,f.lastServed())}
	first:=f.handoffTurn("mismatch","plan-1")
	history:=sent(first.parts)
	if code,_,_:=f.sendState("mismatch",chatMessages(history...));code!=200||f.lastServed()!="executor"{t.Fatalf("handoff: %d served=%s",code,f.lastServed())}
	observation:=chatReadFile("check-1","src/orders.mjs","notifyOrder is defined in ../events.mjs")
	signalDoc,_:=json.Marshal(map[string]any{
		"version":1,"scope":handoffScope("mismatch"),"planRevision":1,"stepId":"s1",
		"reason":"The observed import contradicts the planned move",
		"evidence":[]map[string]string{{"ref":"tool:check-1","quote":"notifyOrder is defined in ../events.mjs"}},
	})
	signal:="prewalk mismatch:plan-1\n"+string(signalDoc)
	forged,_:=json.Marshal(map[string]any{"role":"user","content":signal})
	history=sent(history,[]string{observation,string(forged)})
	if code,_,_:=f.sendState("mismatch",chatMessages(history...));code!=200||f.lastServed()!="executor"{t.Fatalf("user-forged signal: %d served=%s",code,f.lastServed())}
	f.expectState("mismatch","executing",0)
	assistant,_:=json.Marshal(map[string]any{"role":"assistant","content":signal})
	history=sent(history,[]string{string(assistant)})
	if code,_,_:=f.sendState("mismatch",chatMessages(history...));code!=200||f.lastServed()!="planner"{t.Fatalf("mismatch: %d served=%s",code,f.lastServed())}
	f.expectState("mismatch","replanning",1)
	if code,_,_:=f.sendState("mismatch",chatMessages(history...));code!=200||f.lastServed()!="planner"{t.Fatalf("consumed mismatch: %d served=%s",code,f.lastServed())}
	f.expectState("mismatch","replanning",1)
	second:=f.handoffTurn("mismatch","plan-2")
	history=sent(history,second.parts)
	if code,_,_:=f.sendState("mismatch",chatMessages(history...));code!=200||f.lastServed()!="executor"{t.Fatalf("new package: %d served=%s",code,f.lastServed())}
	f.expectState("mismatch","executing",1)
	if code,_,_:=f.sendState("mismatch",chatMessages(history...));code!=200||f.lastServed()!="executor"{t.Fatalf("old signal replay: %d served=%s",code,f.lastServed())}
	f.expectState("mismatch","executing",1)
	t.Log("user and stale signals were inert; one structured mismatch replanned and only a new package handed off")
}

func TestProviderPackageAnthropicClientEntrypoint(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	sendMessages:=func(session string) (int,string) {
		t.Helper()
		body:=`{"model":"prewalk/route","max_tokens":16,"stream":false,"messages":[{"role":"user","content":"anthropic task"}]}`
		r,err:=http.NewRequestWithContext(t.Context(),"POST",f.gw.URL+"/v1/messages",strings.NewReader(body))
		if err!=nil{t.Fatal(err)}
		r.Header.Set("Authorization","Bearer "+f.entrySecret)
		r.Header.Set("Content-Type","application/json")
		r.Header.Set("X-Magpie-Session",session)
		res,err:=f.gw.Client().Do(r);if err!=nil{t.Fatal(err)}
		defer res.Body.Close()
		reply,err:=io.ReadAll(res.Body);if err!=nil{t.Fatal(err)}
		return res.StatusCode,string(reply)
	}
	code,reply:=sendMessages("anthropic")
	if code!=200||!strings.Contains(reply,"ok"){t.Fatalf("anthropic entry: %d %s",code,reply)}
	if f.lastServed()!="planner"{t.Fatalf("anthropic served=%s",f.lastServed())}
	f.expectState("anthropic","planning",0)
	code,reply=sendMessages("anthropic")
	if code!=200||!strings.Contains(reply,"ok"){t.Fatalf("anthropic second: %d %s",code,reply)}
	if f.lastServed()!="planner"{t.Fatalf("anthropic second served=%s",f.lastServed())}
	if !strings.Contains(f.lastBusinessBody(),"Prewalk plan marker"){t.Fatalf("anthropic planner prompt missing: %s",f.lastBusinessBody())}
	if f.classifyCount()!=1{t.Fatalf("anthropic classified %d times",f.classifyCount())}
}

// Claude Code uses Messages; the original gateway translates its tool results
// to the plugin's Chat protocol, where is_error is not retained for Prewalk.
func TestProviderPackageMessagesCommandFailureHealth(t *testing.T) {
	cases := []struct {
		name, tool, output, verdict, wantTarget, wantPhase string
		failed bool
		wantHealth, wantReplans int
	}{
		{"nonzero replans", "Bash", "Exit code 1\nassertion: notify must precede audit", "replan", "planner", "replanning", true, 1, 1},
		{"ordinary failure continues", "Bash", "Exit code 2\ntransient local command error", "continue", "executor", "executing", true, 1, 0},
		{"tool error envelope", "Edit", "<tool_use_error>No changes to make</tool_use_error>", "replan", "planner", "replanning", true, 1, 1},
		{"zero succeeds", "Bash", "Exit code 0\nall tests passed", "replan", "executor", "executing", false, 0, 0},
		{"ordinary mention succeeds", "Bash", "The docs mention Exit code 1 as an example", "replan", "executor", "executing", false, 0, 0},
		{"file quotes full status line", "Read", "Exit code 1\nmeans a command failed", "replan", "executor", "executing", false, 0, 0},
		{"search quotes full status line", "Grep", "Exit code 1\nmeans a command failed", "replan", "executor", "executing", false, 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newBillingFixture(t, providerPackageDir(t))
			f.signIn(f.serviceSecret)
			seed := seedExecuting(t, f, "messages-failure")
			beforeVersion := stateNumber(f.sessionState("messages-failure"), "stateVersion")
			beforeExecutor := len(f.businessBodiesMatching("executor"))
			f.healthVerdict = tc.verdict
			prefix := `{"model":"prewalk/route","max_tokens":256,"stream":true,"messages":` + chatMessages(seed.parts...) + `}`
			req, err := parseChat([]byte(prefix))
			if err != nil { t.Fatal(err) }
			tool := tc.tool
			args := json.RawMessage(`{"command":"node --test tests/*.test.mjs"}`)
			switch tool {
			case "Edit":
				args = json.RawMessage(`{"file_path":"src/task.txt","old_string":"same","new_string":"same"}`)
			case "Read", "Grep":
				args = json.RawMessage(`{"file_path":"src/task.txt","pattern":"Exit code"}`)
			}
			req.Messages = append(req.Messages,
				Message{Role:"assistant", Parts:[]Part{
					{Kind:ToolCall, ID:"messages-command-failed", Name:tool, Args:args},
					{Kind:ToolCall, ID:"messages-parallel-read", Name:"Read", Args:json.RawMessage(`{"file_path":"src/task.txt"}`)},
				}},
				Message{Role:"user", Parts:[]Part{
					{Kind:ToolResult, CallID:"messages-command-failed", Text:tc.output, IsError:tc.failed},
					{Kind:ToolResult, CallID:"messages-parallel-read", Text:"current source is visible"},
				}},
			)
			body := buildAnthropic(req, "prewalk/route")
			r, err := http.NewRequestWithContext(t.Context(), "POST", f.gw.URL+"/v1/messages", bytes.NewReader(body))
			if err != nil { t.Fatal(err) }
			r.Header.Set("Authorization", "Bearer "+f.entrySecret)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-Claude-Code-Session-Id", "messages-failure")
			res, err := f.gw.Client().Do(r)
			if err != nil { t.Fatal(err) }
			defer res.Body.Close()
			reply, err := io.ReadAll(res.Body)
			if err != nil { t.Fatal(err) }
			if res.StatusCode != 200 || f.lastServed() != tc.wantTarget {
				t.Fatalf("Messages result: %d served=%s body=%s", res.StatusCode, f.lastServed(), reply)
			}
			if f.healthCount() != tc.wantHealth { t.Fatalf("health calls=%d want %d", f.healthCount(), tc.wantHealth) }
			f.expectState("messages-failure", tc.wantPhase, tc.wantReplans)
			wantVersion := beforeVersion
			if tc.wantReplans > 0 { wantVersion++ }
			if stateNumber(f.sessionState("messages-failure"), "stateVersion") != wantVersion { t.Fatal("unexpected state version") }
			wantExecutor := beforeExecutor
			if tc.wantTarget == "executor" { wantExecutor++ }
			if len(f.businessBodiesMatching("executor")) != wantExecutor { t.Fatal("unexpected executor business request") }
			if tc.wantHealth > 0 {
				found := false
				for _, judgment := range f.judgmentBodiesSnapshot() {
					var document struct { Messages []struct { Role, Content string } }
					if err := json.Unmarshal([]byte(judgment), &document); err != nil { t.Fatal(err) }
					for _, message := range document.Messages {
						if message.Role != "user" { continue }
						var question struct {
							Question string `json:"question"`
							Evidence []string `json:"evidence"`
							Failures []struct { Ref, Text string } `json:"failures"`
						}
						if json.Unmarshal([]byte(message.Content), &question) != nil || question.Question != "execution_health" { continue }
						if len(question.Evidence) != 1 || question.Evidence[0] != "group:group:messages-command-failed" { t.Fatalf("unexpected failure evidence: %+v", question.Evidence) }
						for _, failure := range question.Failures {
							if failure.Ref == question.Evidence[0] && failure.Text == "Error: "+tc.output { found = true }
						}
					}
				}
				if !found { t.Fatal("health did not receive the actual failed group and exact failure summary") }
			}
		})
	}
}

func TestProviderPackageAuthorizationAndBilling(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	before:=f.calls();code,reply:=f.send("synthetic")
	if code!=200||!strings.Contains(reply,"ok")||f.calls()!=before+1{t.Fatalf("delivered package: %d %s upstream=%d",code,reply,f.calls())}
	if prompt,completion:=clientUsage(t,reply);prompt!=7||completion!=3{t.Fatalf("client usage: %d/%d",prompt,completion)}
	f.mu.Lock();last:=f.served[len(f.served)-1];authHeader:=f.seenHeader.Get("Authorization");marker:=f.seenHeader.Get("X-Magpie-Page-Port");f.mu.Unlock()
	if last!="planner"||authHeader!="Bearer upstream-only"||marker!=""{t.Fatalf("upstream identity last=%s auth=%s marker=%q",last,authHeader,marker)}
	rows:=usage.Load(time.Time{});attributed:=false
	for _,r:=range rows{if r.Provider=="real"&&r.CallerKeyID==f.service.ID&&r.Status==200{attributed=true}}
	if !attributed{t.Fatal("inner usage not attributed to service identity")}
	t.Log("delivered package: planner, forced authentication, marker removed, inner usage attributed")
	if err:=plugin.SetOptions(f.installed,map[string]any{"providerID":"prewalk","modelID":"route","planner":"real/outside","executor":"real/executor"});err!=nil{t.Fatal(err)}
	f.signIn(f.serviceSecret)
	before=f.calls();code,reply=f.send("outside")
	if code!=403||f.calls()!=before||!strings.Contains(reply,"real/outside"){t.Fatalf("outside service models: %d %s upstream=%d",code,reply,f.calls()-before)}
	t.Log("target outside service models: 403, zero upstream")
	if err:=plugin.SetOptions(f.installed,map[string]any{"providerID":"prewalk","modelID":"route","planner":"real/planner","executor":"real/executor"});err!=nil{t.Fatal(err)}
	f.signIn(f.serviceSecret)
	// Deleting the service key must leave the plugin without a valid identity.
	if _,err:=access.Update("remove-key",access.Change{Key:f.service.ID});err!=nil{t.Fatal(err)}
	plugin.Settle()
	if _,err:=plugin.Providers(t.Context());err!=nil{t.Fatal(err)}
	before=f.calls();code,reply=f.send("after-delete")
	if code!=401||f.calls()!=before||!strings.Contains(reply,"not an enabled magpie gateway key"){t.Fatalf("deleted secret: %d %s upstream=%d",code,reply,f.calls()-before)}
	t.Log("deleted service credential: gateway 401, zero upstream")
}

func TestProviderPackageBillingAndCancellation(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	for range 2{code,reply:=f.send("synthetic");if code!=200{t.Fatalf("billing call: %d %s",code,reply)};if prompt,completion:=clientUsage(t,reply);prompt!=7||completion!=3{t.Fatalf("client usage: %d/%d",prompt,completion)}}
	_,realTotal,_:=usage.Ledger(usage.All,usage.Filter{Provider:"real"})
	_,wrapperTotal,_:=usage.Ledger(usage.All,usage.Filter{Provider:"prewalk"})
	_,whole,_:=usage.Ledger(usage.All,usage.Filter{})
	if realTotal.Calls!=2||realTotal.Input!=14||realTotal.Output!=6||realTotal.Cost<0.00002599||realTotal.Cost>0.00002601{t.Fatalf("real ledger: %+v",realTotal)}
	if wrapperTotal.Calls!=2||wrapperTotal.Input!=14||wrapperTotal.Output!=6||wrapperTotal.Cost!=0||wrapperTotal.Unpriced!=0{t.Fatalf("wrapper ledger: %+v",wrapperTotal)}
	if whole.Cost!=realTotal.Cost||whole.Input!=28||whole.Output!=12{t.Fatalf("combined ledger: %+v",whole)}
	t.Logf("explicit zero surcharge: real=%g wrapper=%g total=%g; tokens intentionally double",realTotal.Cost,wrapperTotal.Cost,whole.Cost)
	before:=f.calls();code,reply:=f.send("cancel-probe")
	if code!=0||!strings.Contains(reply,"canceled")||f.calls()!=before+1{t.Fatalf("cancellation: %d %s upstream=%d",code,reply,f.calls()-before)}
	if _,err:=access.Update("off-key",access.Change{Key:f.service.ID});err!=nil{t.Fatal(err)}
	plugin.Settle();if _,err:=plugin.Providers(t.Context());err!=nil{t.Fatal(err)}
	before=f.calls();code,reply=f.send("disabled")
	if code!=401||f.calls()!=before||!strings.Contains(reply,"not an enabled magpie gateway key"){t.Fatalf("disabled key: %d %s upstream=%d",code,reply,f.calls()-before)}
	if _,err:=access.Update("on-key",access.Change{Key:f.service.ID});err!=nil{t.Fatal(err)}
	if _,err:=access.Update("rotate-key",access.Change{Key:f.service.ID});err!=nil{t.Fatal(err)}
	plugin.Settle();if _,err:=plugin.Providers(t.Context());err!=nil{t.Fatal(err)}
	before=f.calls();code,reply=f.send("rotated")
	if code!=401||f.calls()!=before||!strings.Contains(reply,"not an enabled magpie gateway key"){t.Fatalf("rotated key: %d %s upstream=%d",code,reply,f.calls()-before)}
	t.Log("cancellation reached inner; disabled and rotated keys 401, zero upstream")
}

func TestProviderPackageExpiredServiceKeyIsRejected(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	issued,err:=access.IssueKey(access.Issue{Name:"Prewalk expiring",TTL:time.Hour,Models:[]string{"real/planner"}})
	if err!=nil{t.Fatal(err)}
	f.signIn(issued.Key)
	code,reply:=f.send("synthetic")
	if code!=200{t.Fatalf("fresh issued key: %d %s",code,reply)}
	original:=access.Now
	access.Now=func()time.Time{return time.Now().Add(2*time.Hour)}
	t.Cleanup(func(){access.Now=original})
	plugin.Settle();if _,err:=plugin.Providers(t.Context());err!=nil{t.Fatal(err)}
	before:=f.calls();code,reply=f.send("expired")
	if code!=401||f.calls()!=before||!strings.Contains(reply,"expired"){t.Fatalf("expired key: %d %s upstream=%d",code,reply,f.calls()-before)}
	t.Log("expired service key: 401, zero upstream")
}

func TestProviderPackageRejectsUnsharedGateway(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	s:=settings.Load();s.LAN=false;if err:=settings.Save(s);err!=nil{t.Fatal(err)}
	f.signIn(f.serviceSecret)
	before:=f.calls();code,reply:=f.send("unshared")
	if code!=403||f.calls()!=before||(!strings.Contains(reply,"isn't shared")&&!strings.Contains(reply,"Share on local network")){t.Fatalf("unshared gateway: %d %s upstream=%d",code,reply,f.calls()-before)}
	t.Log("unshared gateway: forced-authentication refusal, zero upstream")
}

func TestProviderPackageMissingAuthenticationMarkerIsRejected(t *testing.T) {
	dir:=t.TempDir()
	copyPackage(t,providerPackageDir(t),dir)
	patchFile(t,filepath.Join(dir,"provider","index.ts"),`"x-magpie-page-port": "1",`,"")
	f:=newBillingFixture(t,dir)
	f.signIn(access.Prefix + "not-a-real-key")
	before:=f.calls();code,reply:=f.send("negative")
	if code!=200||f.calls()!=before+1{t.Fatalf("negative control did not reproduce local bypass: %d %s upstream=%d",code,reply,f.calls()-before)}
	t.Log("target error made observable: without forced marker unknown key reaches upstream")
}

func TestProviderPackageServiceBudgetAndModelBoundary(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	if _,err:=access.Update("models-key",access.Change{Key:f.service.ID,Models:[]string{"real/planner"}});err!=nil{t.Fatal(err)}
	f.signIn(f.serviceSecret)
	before:=f.calls();code,reply:=f.send("synthetic")
	if code!=200||f.calls()!=before+1{t.Fatalf("planner: %d %s upstream=%d",code,reply,f.calls()-before)}
	second:=provider.KeyID("second-only")
	if _,err:=access.Update("accounts-key",access.Change{Key:f.service.ID,Accounts:[]string{"real/"+second}});err!=nil{t.Fatal(err)}
	if err:=provider.SetAccountModels("real",second,[]string{"executor"});err!=nil{t.Fatal(err)}
	t.Cleanup(func(){_ = provider.SetAccountModels("real",second,nil)})
	before=f.calls();code,reply=f.send("synthetic")
	if code!=403||f.calls()!=before||!strings.Contains(reply,"not allowed to use the accounts behind"){tt:=reply;if len(tt)>200{tt=tt[:200]};t.Fatalf("outside service account: %d %s upstream=%d",code,tt,f.calls()-before)}
	t.Logf("target on a service account that does not serve it: %d, zero upstream",code)
	if _,err:=access.Update("accounts-key",access.Change{Key:f.service.ID});err!=nil{t.Fatal(err)}
	if _,err:=access.Update("limit-key",access.Change{Key:f.service.ID,Limit:&access.Limit{Period:"day",Tokens:1}});err!=nil{t.Fatal(err)}
	before=f.calls();code,reply=f.send("synthetic")
	if code!=429||f.calls()!=before||!strings.Contains(reply,"Prewalk service"){t.Fatalf("exhausted budget: %d %s upstream=%d",code,reply,f.calls()-before)}
	t.Log("service budget exhausted: 429, zero upstream")
}

// The installed package must be the current source, not a stale copy.
func TestProviderPackageMatchesSource(t *testing.T) {
	root:=projectRoot(t)
	for _,pair:=range [][2]string{
		{"provider/index.ts","provider/index.ts"},
		{"provider/internals.ts","provider/internals.ts"},
		{"provider/state.ts","provider/state.ts"},
		{"provider/store.ts","provider/store.ts"},
		{"provider/classifier.ts","provider/classifier.ts"},
		{"provider/handoff.ts","provider/handoff.ts"},
		{"provider/prompts.ts","provider/prompts.ts"},
		{"provider/page/index.html","page/index.html"},
		{"provider/page/app.js","page/app.js"},
		{"provider/page/model.js","page/model.js"},
		{"provider/page/style.css","page/style.css"},
		{"provider/page/icon.svg","page/icon.svg"},
		{"history.ts","history.ts"},
		{"policy.ts","policy.ts"},
		{"judgment.ts","judgment.ts"},
	}{
		srcPath:=filepath.Join(root,"src",pair[0])
		distPath:=filepath.Join(providerPackageDir(t),pair[1])
		src,err:=os.ReadFile(srcPath);if err!=nil{t.Fatal(err)}
		dist,err:=os.ReadFile(distPath);if err!=nil{t.Fatal(err)}
		if !bytes.Equal(src,dist){t.Fatalf("%s differs from src; run scripts/build-provider-package.sh",pair[0])}
	}
}

// The installed provider also contributes a window page; its read/write form
// is served from the package and the host parses the page manifest.
func TestProviderPackageWindowPage(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	w,only:=plugin.Window(f.installed)
	if w==nil||w.Page==nil||only{t.Fatalf("page manifest: w=%+v only=%v",w,only)}
	if !strings.HasSuffix(filepath.ToSlash(w.Page.File),"page/index.html"){t.Fatalf("page file=%s",w.Page.File)}
	if w.Page.Title!="Prewalk"||w.Page.Titles["zh"]!="Prewalk 配置"{t.Fatalf("page title=%q titles=%v",w.Page.Title,w.Page.Titles)}
	if len(w.Reads)==0||w.Reads[0]!="usage:day"{t.Fatalf("page reads=%v",w.Reads)}
	pkg,err:=os.ReadFile(filepath.Join(f.installed,"package.json"));if err!=nil{t.Fatal(err)}
	if !strings.Contains(string(pkg),`"groups:list"`){t.Fatalf("package does not ask for groups:list: %s",pkg)}
	html,err:=os.ReadFile(w.Page.File);if err!=nil{t.Fatal(err)}
	if !strings.Contains(string(html),"_magpie/bridge.js")||!strings.Contains(string(html),"Prewalk 配置"){t.Fatalf("page html missing bridge or title")}
	app,err:=os.ReadFile(filepath.Join(filepath.Dir(w.Page.File),"app.js"));if err!=nil{t.Fatal(err)}
	if !strings.Contains(string(app),"magpie.options.get()")||!strings.Contains(string(app),"magpie.options.set(")||!strings.Contains(string(app),`magpie.read("groups:list"`){t.Fatalf("page app does not read/write options or groups")}
	t.Log("provider page manifest, bridge and option form parsed by the host")
}

// With options validation bypassed, the fetch guard must still refuse a target
// that loops back to this provider.
func TestProviderPackageRejectsRecursiveTarget(t *testing.T) {
	dir:=t.TempDir()
	copyPackage(t,providerPackageDir(t),dir)
	patchFile(t,filepath.Join(dir,"provider","internals.ts"),` || value.startsWith(providerID + "/")`,"")
	f:=newBillingFixture(t,dir)
	if err:=plugin.SetOptions(f.installed,map[string]any{"providerID":"prewalk","modelID":"route","planner":"prewalk/route","executor":"real/executor"});err!=nil{t.Fatal(err)}
	f.signIn(f.serviceSecret)
	before:=f.calls();code,reply:=f.send("recursive")
	if code!=403||f.calls()!=before||!strings.Contains(reply,"prewalk cannot target itself"){t.Fatalf("recursive target: %d %s upstream=%d",code,reply,f.calls()-before)}
	t.Log("recursive target: 403 at fetch guard, zero upstream")
}

// A real provider 401 must not make the wrapper account unusable afterwards.
func TestProviderPackageSurvivesInner401(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	f.refuse.Store(true)
	code,reply:=f.send("refused")
	if code!=401||!strings.Contains(reply,"real provider refused"){t.Fatalf("inner 401: %d %s",code,reply)}
	f.refuse.Store(false)
	before:=f.calls();code,reply=f.send("after-401")
	if code!=200||f.calls()!=before+1||!strings.Contains(reply,"ok"){t.Fatalf("wrapper unusable after inner 401: %d %s upstream=%d",code,reply,f.calls()-before)}
	if prompt,completion:=clientUsage(t,reply);prompt!=7||completion!=3{t.Fatalf("client usage: %d/%d",prompt,completion)}
	t.Log("inner 401 kept wrapper sign-in usable; next request reached upstream")
}

func TestProviderPackagePhaseStateMachine(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	if code,_,_:=f.sendState("state-1",chatMessages());code!=200||f.lastServed()!="planner"{t.Fatalf("new session: %d served=%s",code,f.lastServed())}
	f.expectState("state-1","planning",0)
	f.plannerBinding("state-1",f.sessionState("state-1"))
	business:=[]string{chatPlan("plan-1"),chatEdit("a1",true)}
	if code,_,_:=f.sendState("state-1",chatMessages(business...));code!=200||f.lastServed()!="planner"{t.Fatalf("business edit: %d served=%s",code,f.lastServed())}
	f.expectState("state-1","planning",0)

	first:=f.handoffTurn("state-1","plan-1")
	history:=sent(business,first.parts)
	if code,_,_:=f.sendState("state-1",chatMessages(history...));code!=200||f.lastServed()!="executor"{t.Fatalf("handoff: %d served=%s",code,f.lastServed())}
	if strings.Contains(f.lastBusinessBody(),"Prewalk plan marker"){t.Fatal("plan prompt reached executor in phase sequence")}
	if !strings.Contains(f.lastBusinessBody(),"Prewalk execution contract"){t.Fatal("execution contract missing on first handoff")}
	f.expectState("state-1","executing",0)
	if got:=f.sessionState("state-1")["planRef"];got!="plan-1"{t.Fatalf("planRef=%v",got)}

	history=sent(history,[]string{chatEdit("a2",false)})
	if code,_,_:=f.sendState("state-1",chatMessages(history...));code!=200||f.lastServed()!="planner"{t.Fatalf("first failure: %d served=%s",code,f.lastServed())}
	if !strings.Contains(f.lastBusinessBody(),"new plan ref"){t.Fatalf("replan prompt missing: %s",f.lastBusinessBody())}
	f.expectState("state-1","replanning",1)

	second:=f.handoffTurn("state-1","plan-2")
	history=sent(history,second.parts)
	if code,_,_:=f.sendState("state-1",chatMessages(history...));code!=200||f.lastServed()!="executor"{t.Fatalf("second handoff: %d served=%s",code,f.lastServed())}
	f.expectState("state-1","executing",1)
	if got:=f.sessionState("state-1")["planRef"];got!="plan-2"{t.Fatalf("planRef=%v",got)}

	history=sent(history,[]string{chatEdit("b2",false)})
	if code,_,_:=f.sendState("state-1",chatMessages(history...));code!=200||f.lastServed()!="planner"{t.Fatalf("second failure: %d served=%s",code,f.lastServed())}
	f.expectState("state-1","replanning",2)

	third:=f.handoffTurn("state-1","plan-3")
	history=sent(history,third.parts)
	if code,_,_:=f.sendState("state-1",chatMessages(history...));code!=200||f.lastServed()!="executor"{t.Fatalf("third handoff: %d served=%s",code,f.lastServed())}
	f.expectState("state-1","executing",2)

	history=sent(history,[]string{chatEdit("c2",false)})
	if code,_,_:=f.sendState("state-1",chatMessages(history...));code!=200||f.lastServed()!="planner"{t.Fatalf("limit failure: %d served=%s",code,f.lastServed())}
	f.expectState("state-1","blocked",2)

	fourth:=f.handoffTurn("state-1","plan-4")
	history=sent(history,fourth.parts)
	if code,_,_:=f.sendState("state-1",chatMessages(history...));code!=200||f.lastServed()!="planner"{t.Fatalf("blocked handoff: %d served=%s",code,f.lastServed())}
	f.expectState("state-1","blocked",2)
	t.Log("phase sequence: planning -> executing -> replanning -> executing -> replanning -> executing -> blocked; each handoff used a new package")
}

func TestProviderPackageStateSurvivesHostRestart(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	if code,_,_:=f.sendState("persist",chatMessages());code!=200{t.Fatalf("new: %d",code)}
	turn:=f.handoffTurn("persist","plan-1")
	if code,_,_:=f.sendState("persist",chatMessages(turn.parts...));code!=200||f.lastServed()!="executor"{t.Fatalf("handoff: %d served=%s",code,f.lastServed())}
	plugin.Settle()
	if _,err:=plugin.Providers(t.Context());err!=nil{t.Fatal(err)}
	code,_,_:=f.sendState("persist",chatMessages(turn.parts...))
	if code!=200||f.lastServed()!="executor"{t.Fatalf("after restart: %d served=%s",code,f.lastServed())}
	if !strings.Contains(f.lastBusinessBody(),"Prewalk execution contract"){t.Fatal("persisted package was not reused after restart")}
	if !strings.Contains(f.lastBusinessBody(),"Apply the requested task using the observed structure"){t.Fatal("executor lost the packet goal after restart")}
	f.expectState("persist","executing",0)
	t.Log("session phase and verified package survived a plugin host restart")
}

// An executing session written by the previous plugin version has no verified
// package; it must not stay on the executor or spend replan budget.
func TestProviderPackageLegacyExecutingWithoutPackageReturnsToPlanner(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	if err:=os.MkdirAll(f.stateDir,0o700);err!=nil{t.Fatal(err)}
	key:=base64.RawURLEncoding.EncodeToString([]byte("legacy"))
	state,_:=json.Marshal(map[string]any{"version":1,"sessions":map[string]any{key:map[string]any{
		"phase":"executing","mode":"plan_then_execute","planRef":"plan-old","planRevision":1,
		"replanCount":0,"stateVersion":2,"updatedAt":1,
	}}})
	if err:=os.WriteFile(filepath.Join(f.stateDir,"sessions.json"),state,0o600);err!=nil{t.Fatal(err)}
	code,_,_:=f.sendState("legacy",chatMessages(chatPlan("plan-old"),chatEdit("a1",true)))
	if code!=200||f.lastServed()!="planner"{t.Fatalf("legacy executing: %d served=%s",code,f.lastServed())}
	if got:=f.sessionState("legacy")["replanCount"];got!=float64(0){t.Fatalf("legacy executing spent replan budget: %v",got)}
	if got:=f.sessionState("legacy")["phase"];got!="planning"{t.Fatalf("legacy executing phase=%v want planning",got)}
	if got:=f.sessionState("legacy")["stateVersion"];got!=float64(3){t.Fatalf("legacy executing stateVersion=%v want 3",got)}
	if got:=f.businessBodiesMatching("executor");len(got)!=0{t.Fatalf("legacy executing reached executor: %d bodies",len(got))}
	t.Log("executing state without a verified package returned to the planner without spending budget")
}

func TestProviderPackageSessionIsolation(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	if code,_,_:=f.sendState("alpha",chatMessages());code!=200{t.Fatalf("alpha new: %d",code)}
	alpha:=f.handoffTurn("alpha","plan-1")
	if code,_,_:=f.sendState("alpha",chatMessages(alpha.parts...));code!=200||f.lastServed()!="executor"{t.Fatalf("alpha handoff: %d served=%s",code,f.lastServed())}
	if code,_,_:=f.sendState("beta",chatMessages());code!=200||f.lastServed()!="planner"{t.Fatalf("beta new: %d served=%s",code,f.lastServed())}
	f.expectState("beta","planning",0)
	if code,_,_:=f.sendState("alpha",chatMessages(alpha.parts...));code!=200||f.lastServed()!="executor"{t.Fatalf("alpha continue: %d served=%s",code,f.lastServed())}
	f.expectState("alpha","executing",0)
	if handoffScope("alpha")==handoffScope("beta"){t.Fatal("session scope did not separate sessions")}
	t.Log("sessions keep independent phases and package scopes")
}

func TestProviderPackageModesAndMissingSession(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	if err:=plugin.SetOptions(f.installed,map[string]any{"providerID":"prewalk","modelID":"route","planner":"real/planner","executor":"real/executor","defaultMode":"strong_only"});err!=nil{t.Fatal(err)}
	f.signIn(f.serviceSecret)
	plan,edit:=chatPlan("plan-1"),chatEdit("a1",true)
	code,_,_:=f.sendState("strong",chatMessages())
	if code!=200||f.lastServed()!="planner"{t.Fatalf("strong_only new: %d served=%s",code,f.lastServed())}
	f.expectState("strong","strong_only",0)
	if code,_,_:=f.sendState("strong",chatMessages(plan,edit));code!=200||f.lastServed()!="planner"{t.Fatalf("strong_only write: %d served=%s",code,f.lastServed())}
	f.expectState("strong","strong_only",0)
	strongTurn:=f.handoffTurn("strong","plan-2")
	if code,_,_:=f.sendState("strong",chatMessages(sent([]string{plan,edit},strongTurn.parts)...));code!=200||f.lastServed()!="planner"{t.Fatalf("strong_only package: %d served=%s",code,f.lastServed())}
	f.expectState("strong","strong_only",0)
	if got:=f.businessBodiesMatching("executor");len(got)!=0{t.Fatalf("strong_only fabricated handoff: %d executor bodies",len(got))}

	if err:=plugin.SetOptions(f.installed,map[string]any{"providerID":"prewalk","modelID":"route","planner":"real/planner","executor":"real/executor","defaultMode":"direct"});err!=nil{t.Fatal(err)}
	f.signIn(f.serviceSecret)
	code,_,_=f.sendState("direct",chatMessages())
	if code!=200||f.lastServed()!="executor"{t.Fatalf("direct new: %d served=%s",code,f.lastServed())}
	f.expectState("direct","executing",0)
	if got:=f.sessionState("direct")["mode"];got!="direct"{t.Fatalf("direct mode=%v",got)}
	if code,_,_:=f.sendState("direct",chatMessages(plan,edit));code!=200||f.lastServed()!="executor"{t.Fatalf("direct continue: %d served=%s",code,f.lastServed())}
	plugin.Settle()
	if _,err:=plugin.Providers(t.Context());err!=nil{t.Fatal(err)}
	if code,_,_:=f.sendState("direct",chatMessages(plan,edit));code!=200||f.lastServed()!="executor"{t.Fatalf("direct after restart: %d served=%s",code,f.lastServed())}
	if got:=f.sessionState("direct")["mode"];got!="direct"{t.Fatalf("direct mode after restart=%v",got)}

	code,_,_=f.sendState("",chatMessages())
	if code!=200||f.lastServed()!="planner"{t.Fatalf("no session: %d served=%s",code,f.lastServed())}
	if f.sessionState("")!=nil{t.Fatal("missing session wrote state")}
	t.Log("strong_only, direct and missing-session paths honored")
}

func TestProviderPackageCorruptStateKeepsPlanner(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	if err:=os.MkdirAll(f.stateDir,0o700);err!=nil{t.Fatal(err)}
	for _,doc:=range []string{"{not json",`{"version":1,"sessions":{"eA":{}}}`} {
		file:=filepath.Join(f.stateDir,"sessions.json")
		if err:=os.WriteFile(file,[]byte(doc),0o600);err!=nil{t.Fatal(err)}
		code,_,_:=f.sendState("corrupt",chatMessages())
		if code!=200||f.lastServed()!="planner"{t.Fatalf("corrupt state: %d served=%s",code,f.lastServed())}
		after,err:=os.ReadFile(file);if err!=nil{t.Fatal(err)}
		if string(after)!=doc{t.Fatal("corrupt state file was modified")}
	}
	t.Log("corrupt state kept planner and was left untouched")
}

func TestProviderPackageMissingSessionDoesNotTouchState(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	code,_,_:=f.sendState("",chatMessages())
	if code!=200||f.lastServed()!="planner"{t.Fatalf("no session: %d served=%s",code,f.lastServed())}
	if _,err:=os.Stat(f.stateDir);!os.IsNotExist(err){t.Fatalf("missing session created state dir: %v",err)}
	t.Log("missing session never created or read state")
}

func TestProviderPackageAutoClassification(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	code,_,_:=f.sendState("auto",chatMessages())
	if code!=200||f.lastServed()!="planner"{t.Fatalf("classified new: %d served=%s",code,f.lastServed())}
	f.expectState("auto","planning",0)
	if f.classifyCount()!=1{t.Fatalf("classify calls=%d",f.classifyCount())}
	rows:=usage.Load(time.Time{});attributed:=false
	for _,r:=range rows{if r.Provider=="real"&&r.CallerKeyID==f.service.ID&&r.Status==200{attributed=true}}
	if !attributed{t.Fatal("classification not attributed to service identity")}
	turn:=f.handoffTurn("auto","plan-1")
	if code,_,_:=f.sendState("auto",chatMessages(turn.parts...));code!=200||f.lastServed()!="executor"{t.Fatalf("handoff: %d served=%s",code,f.lastServed())}
	if f.classifyCount()!=1{t.Fatalf("reclassified: %d",f.classifyCount())}
	t.Log("new session classified once, then handed off with an evidence package without reclassification")
}

func TestProviderPackageClassificationVerdicts(t *testing.T) {
	for _,tc:=range []struct{verdict,target,phase string}{
		{"direct","executor","executing"},
		{"strong_only","planner","strong_only"},
		{"uncertain","planner","strong_only"},
		{"bogus","planner","strong_only"},
	}{
		f:=newBillingFixture(t,providerPackageDir(t))
		f.classifyVerdict=tc.verdict
		f.signIn(f.serviceSecret)
		code,_,_:=f.sendState("v",chatMessages())
		if code!=200||f.lastServed()!=tc.target{t.Fatalf("%s: %d served=%s want %s",tc.verdict,code,f.lastServed(),tc.target)}
		f.expectState("v",tc.phase,0)
		if f.classifyCount()!=1{t.Fatalf("%s classify calls=%d",tc.verdict,f.classifyCount())}
	}
	t.Log("direct, strong_only, uncertain and invalid verdicts honored")
}

func TestProviderPackageInvalidClassificationAnswers(t *testing.T) {
	for _,raw:=range []string{
		`{}`,
		`{"templateVersion":2,"verdict":"direct","evidence":["history:0"]}`,
		`{"templateVersion":1,"verdict":"direct","evidence":["not-supplied"]}`,
		`not json`,
		`{"templateVersion":1,"verdict":"direct"}`,
	}{
		f:=newBillingFixture(t,providerPackageDir(t))
		f.classifyRaw=raw
		f.signIn(f.serviceSecret)
		code,_,_:=f.sendState("bad",chatMessages())
		if code!=200||f.lastServed()!="planner"{t.Fatalf("invalid answer %q: %d served=%s",raw,code,f.lastServed())}
		f.expectState("bad","strong_only",0)
	}
	t.Log("missing fields, wrong version, bad evidence and malformed answers kept strong")
}

func seedExecuting(t *testing.T, f *billingFixture, session string) handoffTurn {
	t.Helper()
	if code,_,_:=f.sendState(session,chatMessages());code!=200{t.Fatalf("seed new: %d",code)}
	turn:=f.handoffTurn(session,"plan-1")
	if code,_,_:=f.sendState(session,chatMessages(turn.parts...));code!=200||f.lastServed()!="executor"{t.Fatalf("seed handoff: %d served=%s",code,f.lastServed())}
	return turn
}

func TestProviderPackageHealthContinueCaches(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	seed:=seedExecuting(t,f,"h")
	f.healthVerdict="continue"
	message:=chatMessages(sent(seed.parts,[]string{chatEdit("a2",false)})...)
	code,_,_:=f.sendState("h",message)
	if code!=200||f.lastServed()!="executor"{t.Fatalf("continue: %d served=%s",code,f.lastServed())}
	f.expectState("h","executing",0)
	if f.healthCount()!=1{t.Fatalf("health calls=%d",f.healthCount())}
	if code,_,_:=f.sendState("h",message);code!=200||f.lastServed()!="executor"{t.Fatalf("cached continue: %d served=%s",code,f.lastServed())}
	if f.healthCount()!=1{t.Fatalf("rejudged: %d",f.healthCount())}
	t.Log("continue kept executor and the same evidence was judged once")
}

func TestProviderPackageHealthNewFailureAndOldHistory(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	seed:=seedExecuting(t,f,"fresh-failure")
	f.healthVerdict="continue"
	if code,_,_:=f.sendState("fresh-failure",chatMessages(sent(seed.parts,[]string{chatEdit("same-id",false)})...));code!=200||f.healthCount()!=1{t.Fatalf("first judgment: %d calls=%d",code,f.healthCount())}
	f.healthVerdict="external_block"
	changed:=strings.Replace(chatEdit("same-id",false),"Error: failed","Error: permission denied",1)
	if code,_,_:=f.sendState("fresh-failure",chatMessages(sent(seed.parts,[]string{changed})...));code!=200{t.Fatalf("changed failure: %d",code)}
	if f.healthCount()!=2{t.Fatalf("changed failure reused cached verdict: %d",f.healthCount())}
	f.expectState("fresh-failure","blocked",0)
}

func TestProviderPackageHealthOldFailureIsNotJudged(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	seed:=seedExecuting(t,f,"old-failure")
	f.healthVerdict="replan"
	history:=sent(seed.parts,[]string{chatEdit("failure",false)})
	if code,_,_:=f.sendState("old-failure",chatMessages(history...));code!=200{t.Fatalf("replan: %d",code)}
	f.expectState("old-failure","replanning",1)
	second:=f.handoffTurn("old-failure","plan-2")
	history=sent(history,second.parts)
	if code,_,_:=f.sendState("old-failure",chatMessages(history...));code!=200||f.lastServed()!="executor"{t.Fatalf("handoff: %d served=%s",code,f.lastServed())}
	before:=f.healthCount()
	if code,_,_:=f.sendState("old-failure",chatMessages(history...));code!=200||f.lastServed()!="executor"{t.Fatalf("continue: %d served=%s",code,f.lastServed())}
	if f.healthCount()!=before{t.Fatal("old failure triggered another judgment")}
}

func TestProviderPackageHealthConcurrentSameEvidence(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	seed:=seedExecuting(t,f,"health-concurrent")
	f.healthVerdict="continue"
	f.healthDelay=500*time.Millisecond
	message:=chatMessages(sent(seed.parts,[]string{chatEdit("failure",false)})...)
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func(){defer wg.Done();code,_,_:=f.sendState("health-concurrent",message);if code!=200{t.Errorf("concurrent status=%d",code)}}()
	}
	wg.Wait()
	if got:=f.healthCount();got!=1{t.Fatalf("same-evidence judgment calls=%d",got)}
	f.expectState("health-concurrent","executing",0)
}

func TestProviderPackageHealthExcessEvidenceKeepsPlanner(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	seed:=seedExecuting(t,f,"excess-evidence")
	parts:=sent(seed.parts)
	for i:=0;i<9;i++ {
		id:=fmt.Sprintf("failure-%d",i)
		args,_:=json.Marshal(map[string]string{"file_path":fmt.Sprintf("file-%d",i)})
		call,_:=json.Marshal(map[string]any{"role":"assistant","tool_calls":[]map[string]any{{"id":id,"type":"function","function":map[string]any{"name":"Edit","arguments":string(args)}}}})
		result,_:=json.Marshal(map[string]any{"role":"tool","tool_call_id":id,"content":"Error: failed"})
		parts=append(parts,string(call)+","+string(result))
	}
	before:=f.healthCount()
	code,_,_:=f.sendState("excess-evidence",chatMessages(parts...))
	if code!=200||f.lastServed()!="planner"{t.Fatalf("excess evidence: %d served=%s",code,f.lastServed())}
	if f.healthCount()!=before{t.Fatal("excess evidence unexpectedly sent to judgment")}
	f.expectState("excess-evidence","replanning",1)
}

func TestProviderPackageHealthSurvivesRestart(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	seed:=seedExecuting(t,f,"health-restart")
	f.healthVerdict="continue"
	message:=chatMessages(sent(seed.parts,[]string{chatEdit("failure",false)})...)
	if code,_,_:=f.sendState("health-restart",message);code!=200||f.healthCount()!=1{t.Fatalf("first: %d calls=%d",code,f.healthCount())}
	plugin.Settle()
	if _,err:=plugin.Providers(t.Context());err!=nil{t.Fatal(err)}
	if code,_,_:=f.sendState("health-restart",message);code!=200||f.lastServed()!="executor"{t.Fatalf("after restart: %d served=%s",code,f.lastServed())}
	if f.healthCount()!=1{t.Fatalf("rejudged after restart: %d",f.healthCount())}
	if !strings.Contains(f.lastBusinessBody(),"Prewalk execution contract"){t.Fatal("restart lost the execution contract")}
}

func TestProviderPackageHealthNewStateRejudgesSameEvidence(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	first:=seedExecuting(t,f,"rejudge")
	f.healthVerdict="continue"
	history:=sent(first.parts,[]string{chatEdit("same-id",false)})
	if code,_,_:=f.sendState("rejudge",chatMessages(history...));code!=200||f.healthCount()!=1{t.Fatalf("continue: %d calls=%d",code,f.healthCount())}
	t.Logf("h1 calls=%d state=%+v",f.healthCount(),f.sessionState("rejudge"))
	f.healthVerdict="replan"
	history=sent(history,[]string{chatEdit("other",false)})
	if code,_,_:=f.sendState("rejudge",chatMessages(history...));code!=200||f.healthCount()!=2{t.Fatalf("replan: %d calls=%d",code,f.healthCount())}
	t.Logf("h2 calls=%d state=%+v",f.healthCount(),f.sessionState("rejudge"))
	second:=f.handoffTurn("rejudge","plan-2")
	history=sent(history,second.parts)
	if code,_,_:=f.sendState("rejudge",chatMessages(history...));code!=200||f.lastServed()!="executor"{t.Fatalf("handoff: %d served=%s",code,f.lastServed())}
	t.Logf("h3 calls=%d state=%+v",f.healthCount(),f.sessionState("rejudge"))
	f.healthVerdict="external_block"
	history=sent(history,[]string{chatEdit("same-id",false)})
	if code,_,_:=f.sendState("rejudge",chatMessages(history...));code!=200||f.lastServed()!="planner"{t.Fatalf("rejudge: %d served=%s",code,f.lastServed())}
	if f.healthCount()!=3{t.Fatalf("same evidence across states reused cache: %d",f.healthCount())}
	f.expectState("rejudge","blocked",1)
}

func TestProviderPackageHealthVerdicts(t *testing.T) {
	for _,tc:=range []struct{verdict,target,phase string;replans int}{
		{"replan","planner","replanning",1},
		{"external_block","planner","blocked",0},
	}{
		f:=newBillingFixture(t,providerPackageDir(t))
		f.signIn(f.serviceSecret)
		seed:=seedExecuting(t,f,"v")
		f.healthVerdict=tc.verdict
		code,_,_:=f.sendState("v",chatMessages(sent(seed.parts,[]string{chatEdit("a2",false)})...))
		if code!=200||f.lastServed()!=tc.target{t.Fatalf("%s: %d served=%s",tc.verdict,code,f.lastServed())}
		f.expectState("v",tc.phase,tc.replans)
		if f.healthCount()!=1{t.Fatalf("%s health calls=%d",tc.verdict,f.healthCount())}
	}
	t.Log("replan and external_block verdicts honored")
}

func TestProviderPackageHealthInvalidAndFailure(t *testing.T) {
	for _,raw:=range []string{`{}`,`{"templateVersion":2,"verdict":"continue","evidence":[]}`,`{"templateVersion":1,"verdict":"replan","evidence":[]}`} {
		f:=newBillingFixture(t,providerPackageDir(t))
		f.signIn(f.serviceSecret)
		seed:=seedExecuting(t,f,"bad")
		f.healthRaw=raw
		code,_,_:=f.sendState("bad",chatMessages(sent(seed.parts,[]string{chatEdit("a2",false)})...))
		if code!=200||f.lastServed()!="planner"{t.Fatalf("invalid %q: %d served=%s",raw,code,f.lastServed())}
		f.expectState("bad","replanning",1)
	}
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	seed:=seedExecuting(t,f,"fail")
	f.healthFail=true
	code,_,_:=f.sendState("fail",chatMessages(sent(seed.parts,[]string{chatEdit("a2",false)})...))
	if code!=200||f.lastServed()!="planner"{t.Fatalf("health failure: %d served=%s",code,f.lastServed())}
	f.expectState("fail","replanning",1)
	if f.healthCount()<1{t.Fatal("health failure did not reach upstream")}
	t.Log("invalid answers and HTTP failure conservatively replanned")
}

func TestProviderPackageHealthTimeout(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.healthDelay=3*time.Second
	if err:=plugin.SetOptions(f.installed,map[string]any{"providerID":"prewalk","modelID":"route","planner":"real/planner","executor":"real/executor","classifyTimeoutMs":120000,"healthTimeoutMs":1000});err!=nil{t.Fatal(err)}
	f.signIn(f.serviceSecret)
	seed:=seedExecuting(t,f,"slow")
	start:=time.Now()
	code,_,_:=f.sendState("slow",chatMessages(sent(seed.parts,[]string{chatEdit("a2",false)})...))
	if code!=200||f.lastServed()!="planner"{t.Fatalf("timeout: %d served=%s",code,f.lastServed())}
	if elapsed:=time.Since(start);elapsed>2*time.Second||elapsed<900*time.Millisecond{t.Fatalf("timeout not enforced: %s",elapsed)}
	if f.healthCount()!=1{t.Fatalf("health timeout calls=%d",f.healthCount())}
	select{case <-f.healthCancelled:case <-time.After(time.Second):t.Fatal("health judgment was not interrupted")}
	f.expectState("slow","replanning",1)
	t.Log("health timeout conservatively replanned within the bound")
}

func TestProviderPackageHealthLimitSkipsJudgment(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.signIn(f.serviceSecret)
	seed:=seedExecuting(t,f,"limit")
	f.healthVerdict="replan"
	history:=sent(seed.parts,[]string{chatEdit("a2",false)})
	if code,_,_:=f.sendState("limit",chatMessages(history...));code!=200{t.Fatalf("replan1: %d",code)}
	second:=f.handoffTurn("limit","plan-2")
	history=sent(history,second.parts)
	if code,_,_:=f.sendState("limit",chatMessages(history...));code!=200||f.lastServed()!="executor"{t.Fatalf("handoff2: %d",code)}
	history=sent(history,[]string{chatEdit("b2",false)})
	if code,_,_:=f.sendState("limit",chatMessages(history...));code!=200{t.Fatalf("replan2: %d",code)}
	third:=f.handoffTurn("limit","plan-3")
	history=sent(history,third.parts)
	if code,_,_:=f.sendState("limit",chatMessages(history...));code!=200||f.lastServed()!="executor"{t.Fatalf("handoff3: %d",code)}
	before:=f.healthCount()
	history=sent(history,[]string{chatEdit("c2",false)})
	code,_,_:=f.sendState("limit",chatMessages(history...))
	if code!=200||f.lastServed()!="planner"{t.Fatalf("limit: %d served=%s",code,f.lastServed())}
	f.expectState("limit","blocked",2)
	if f.healthCount()!=before{t.Fatalf("judged at limit: %d -> %d",before,f.healthCount())}
	t.Log("replan limit blocked without another judgment")
}

func TestProviderPackageHealthCancelPropagates(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.healthDelay=3*time.Second
	f.signIn(f.serviceSecret)
	seed:=seedExecuting(t,f,"cancel")
	statePath:=filepath.Join(f.stateDir,"sessions.json")
	beforeState,err:=os.ReadFile(statePath)
	if err!=nil{t.Fatal(err)}
	f.mu.Lock();businessBefore:=f.businessCalls;f.mu.Unlock()
	ctx,cancel:=context.WithCancel(f.t.Context())
	r,err:=http.NewRequestWithContext(ctx,"POST",f.gw.URL+"/v1/chat/completions",strings.NewReader(`{"model":"prewalk/route","stream":true,"messages":`+chatMessages(sent(seed.parts,[]string{chatEdit("a2",false)})...)+`}`))
	if err!=nil{t.Fatal(err)}
	r.Header.Set("Authorization","Bearer "+f.entrySecret);r.Header.Set("Content-Type","application/json");r.Header.Set("X-Magpie-Session","cancel")
	done:=make(chan error,1)
	go func(){res,err:=f.gw.Client().Do(r);if err==nil{res.Body.Close()};done<-err}()
	select{case <-f.healthStarted:cancel();case <-time.After(3*time.Second):cancel();t.Fatal("health judgment never started")}
	select{case <-f.healthCancelled:case <-time.After(3*time.Second):t.Fatal("health context was not cancelled")}
	select{case <-done:case <-time.After(3*time.Second):t.Fatal("cancelled health judgment did not finish")}
	plugin.Settle()
	afterState,err:=os.ReadFile(statePath)
	if err!=nil{t.Fatal(err)}
	if !bytes.Equal(beforeState,afterState){t.Fatal("cancelled request changed the persisted state")}
	f.expectState("cancel","executing",0)
	f.mu.Lock();businessAfter:=f.businessCalls;f.mu.Unlock()
	if businessAfter!=businessBefore{t.Fatalf("cancelled request continued to business model")}
	t.Log("client cancellation reached the health judgment and wrote no state")
}

func TestProviderPackageClassificationFailureKeepsStrong(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.classifyFail=true
	f.signIn(f.serviceSecret)
	code,_,_:=f.sendState("fail",chatMessages())
	if code!=200||f.lastServed()!="planner"{t.Fatalf("classify failure: %d served=%s",code,f.lastServed())}
	f.expectState("fail","strong_only",0)
	if f.classifyCount()<1{t.Fatalf("classify calls=%d",f.classifyCount())}
	t.Log("classification failure kept strong")
}

func TestProviderPackageSlowClassificationUsesConfiguredDeadline(t *testing.T) {
	for _, tc := range []struct {
		name string
		deadline int
	}{
		{name: "new-default"},
		{name: "explicit-long", deadline: 120000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newBillingFixture(t, providerPackageDir(t))
			f.classifyDelay = 11 * time.Second
			if tc.deadline != 0 {
				if err := plugin.SetOptions(f.installed, map[string]any{"providerID":"prewalk", "modelID":"route", "planner":"real/planner", "executor":"real/executor", "classifyTimeoutMs":tc.deadline}); err != nil { t.Fatal(err) }
			}
			f.signIn(f.serviceSecret)
			start := time.Now()
			code, _, _ := f.sendState("slow-valid", chatMessages())
			if code != 200 || f.lastServed() != "planner" { t.Fatalf("slow classification: %d served=%s", code, f.lastServed()) }
			if elapsed := time.Since(start); elapsed < 10500*time.Millisecond || elapsed > 20*time.Second { t.Fatalf("unexpected classification duration: %s", elapsed) }
			if f.classifyCount() != 1 { t.Fatalf("classification calls=%d", f.classifyCount()) }
			select { case <-f.classifyCancelled: t.Fatal("slow valid classification was cancelled"); default: }
			f.expectState("slow-valid", "planning", 0)
			if !strings.Contains(f.lastBusinessBody(), "Prewalk plan marker") { t.Fatal("valid classification never reached the planner contract") }
		})
	}
}

func TestProviderPackageClassificationTimeoutKeepsStrong(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.classifyDelay=3*time.Second
	if err:=plugin.SetOptions(f.installed,map[string]any{"providerID":"prewalk","modelID":"route","planner":"real/planner","executor":"real/executor","classifyTimeoutMs":1000});err!=nil{t.Fatal(err)}
	f.signIn(f.serviceSecret)
	start:=time.Now()
	code,_,_:=f.sendState("slow",chatMessages())
	if code!=200||f.lastServed()!="planner"{t.Fatalf("timeout: %d served=%s",code,f.lastServed())}
	if elapsed:=time.Since(start);elapsed>2*time.Second||elapsed<900*time.Millisecond{t.Fatalf("timeout not enforced: %s",elapsed)}
	select{case <-f.classifyCancelled:case <-time.After(time.Second):t.Fatal("delayed classification was not interrupted")}
	f.expectState("slow","strong_only",0)
	if f.classifyCount()!=1{t.Fatalf("classify calls=%d",f.classifyCount())}
	t.Log("classification timeout kept strong within the configured bound")
}

func TestProviderPackageClassificationOnceUnderConcurrency(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.classifyDelay=300*time.Millisecond
	f.signIn(f.serviceSecret)
	var wg sync.WaitGroup
	for range 4{
		wg.Add(1)
		go func(){defer wg.Done();code,_,_:=f.sendState("race",chatMessages());if code!=200{t.Errorf("concurrent: %d",code)}}()
	}
	wg.Wait()
	if f.classifyCount()!=1{t.Fatalf("concurrent classify calls=%d",f.classifyCount())}
	f.expectState("race","planning",0)
	t.Log("concurrent new-session requests classified once")
}

func TestProviderPackageClassificationCancelPropagates(t *testing.T) {
	f:=newBillingFixture(t,providerPackageDir(t))
	f.classifyDelay=3*time.Second
	f.signIn(f.serviceSecret)
	ctx,cancel:=context.WithCancel(f.t.Context())
	r,err:=http.NewRequestWithContext(ctx,"POST",f.gw.URL+"/v1/chat/completions",strings.NewReader(`{"model":"prewalk/route","stream":true,"messages":`+chatMessages()+`}`))
	if err!=nil{t.Fatal(err)}
	r.Header.Set("Authorization","Bearer "+f.entrySecret);r.Header.Set("Content-Type","application/json");r.Header.Set("X-Magpie-Session","cancel-classify")
	done:=make(chan error,1)
	go func(){res,err:=f.gw.Client().Do(r);if err==nil{res.Body.Close()};done<-err}()
	select{case <-f.classifyStarted:cancel();case <-time.After(3*time.Second):cancel();t.Fatal("classification never started")}
	select{case <-f.classifyCancelled:case <-time.After(3*time.Second):t.Fatal("classification context was not cancelled")}
	select{case <-done:case <-time.After(3*time.Second):t.Fatal("cancelled classification did not finish")}
	if f.classifyCount()!=1{t.Fatalf("classify calls=%d",f.classifyCount())}
	if f.sessionState("cancel-classify")!=nil{t.Fatal("cancelled request persisted state")}
	f.mu.Lock();business:=f.businessCalls;f.mu.Unlock()
	if business!=0{t.Fatalf("cancelled request continued to business model: %d",business)}
	t.Log("client cancellation reached the classification call and wrote no state")
}


func TestProviderPackageGroupTargetRoutesToMember(t *testing.T) {
	f := newBillingFixture(t, providerPackageDir(t))
	if err := provider.SaveGroup(provider.Group{ID: "canary", Name: "Canary", Members: []string{"real/planner"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := access.Update("models-key", access.Change{Key: f.service.ID, Models: []string{"real/planner", "real/executor", "group/canary"}}); err != nil {
		t.Fatal(err)
	}
	f.signIn(f.serviceSecret)
	if err := plugin.SetOptions(f.installed, map[string]any{"providerID": "prewalk", "modelID": "route", "planner": "group/canary", "executor": "real/executor", "defaultMode": "strong_only"}); err != nil {
		t.Fatal(err)
	}
	code, reply, _ := f.sendState("group-target", `[{"role":"user","content":"task"}]`)
	if code != 200 || !strings.Contains(f.lastServed(), "planner") {
		t.Fatalf("group target: %d served=%q body=%s", code, f.lastServed(), reply)
	}
	t.Log("group/canary routed to its real/planner member")
}

func TestProviderPackageGroupLoopRefused(t *testing.T) {
	f := newBillingFixture(t, providerPackageDir(t))
	if err := provider.SaveGroup(provider.Group{ID: "loop", Name: "Loop", Members: []string{"prewalk/route"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := access.Update("models-key", access.Change{Key: f.service.ID, Models: []string{"real/executor", "group/loop", "prewalk/route"}}); err != nil {
		t.Fatal(err)
	}
	f.signIn(f.serviceSecret)
	if err := plugin.SetOptions(f.installed, map[string]any{"providerID": "prewalk", "modelID": "route", "planner": "group/loop", "executor": "real/executor", "defaultMode": "strong_only"}); err != nil {
		t.Fatal(err)
	}
	before := f.calls()
	code, reply := f.send("loop-probe")
	if code != 403 || f.calls() != before || !strings.Contains(reply, "cannot target itself") {
		t.Fatalf("group loop: %d upstream=%d body=%s", code, f.calls()-before, reply)
	}
	t.Log("group that routes back to prewalk: 403, zero upstream")
}
