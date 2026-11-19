"""采集真实 Claude Code 请求；fake 响应不代表模型能力。仅监听 loopback。"""

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

EXPECTED_VERSION = os.environ.get("PREWALK_CLIENT_VERSION", "2.1.323")
FIXTURES = Path(__file__).parent / "fixtures" / ("claude-code-" + EXPECTED_VERSION)
CLIENT = shutil.which("claude")
CASE_NAMES = ("successful-edit", "failed-edit", "parallel-tools", "no-hints", "stopped", "cancelled")
UNSUPPORTED = ["Write", "subagent", "auxiliary", "compaction", "interactive-tui", "image", "long-context"]
MAX_BODY_BYTES = 2 * 1024 * 1024
CLIENT_TIMEOUT_SECONDS = 45
CLEANUP_TIMEOUT_SECONDS = 5


def require_version():
    if not CLIENT:
        raise SystemExit("claude executable not found")
    result = subprocess.run([CLIENT, "--version"], capture_output=True, text=True, check=True, timeout=10)
    version = result.stdout.split()[0]
    if version != EXPECTED_VERSION:
        raise SystemExit("refusing fixture set for version " + version)
    return version


def content_blocks(message):
    content = message.get("content", [])
    return [part for part in content if isinstance(part, dict)] if isinstance(content, list) else []


def tool_results(body):
    return [part for message in body.get("messages", []) for part in content_blocks(message)
            if part.get("type") == "tool_result"]


def tool_call(tool_id, name, **parameters):
    return {"type": "tool_use", "id": tool_id, "name": name, "input": parameters}


def response_for(name, turn, workspace):
    path = str(workspace / "probe.txt")
    if name == "successful-edit" and turn == 1:
        return [{"type": "text", "text": "Read probe.txt, replace the marker, then check the result."},
                tool_call("toolu_prewalk_read", "Read", file_path=path)], "tool_use"
    if name == "successful-edit" and turn == 2:
        return [tool_call("toolu_prewalk_edit", "Edit", file_path=path,
                          old_string="PREWALK_BEFORE", new_string="PREWALK_OFFLINE_OK")], "tool_use"
    if name == "failed-edit" and turn == 1:
        return [tool_call("toolu_prewalk_bad_edit", "Edit", file_path=path,
                          old_string="NOT_PRESENT", new_string="SHOULD_NOT_WRITE")], "tool_use"
    if name == "parallel-tools" and turn == 1:
        return [tool_call("toolu_prewalk_read_a", "Read", file_path=path),
                tool_call("toolu_prewalk_read_b", "Read", file_path=str(workspace / "other.txt"))], "tool_use"
    text = {"successful-edit": "PREWALK_OFFLINE_DONE", "failed-edit": "FAILED_EDIT_REPORTED",
            "parallel-tools": "PARALLEL_READS_DONE"}.get(name, "PLANNING_ONLY")
    return [{"type": "text", "text": text}], "end_turn"


def sse_events(response, partial=False):
    events = [("message_start", {"type": "message_start", "message": {
        **response, "content": [], "stop_reason": None,
    }})]
    for index, block in enumerate(response["content"]):
        if block["type"] == "text":
            initial, delta = {"type": "text", "text": ""}, {"type": "text_delta", "text": block["text"]}
        else:
            initial = {**block, "input": {}}
            delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
        events.extend([
            ("content_block_start", {"type": "content_block_start", "index": index, "content_block": initial}),
            ("content_block_delta", {"type": "content_block_delta", "index": index, "delta": delta}),
            ("content_block_stop", {"type": "content_block_stop", "index": index}),
        ])
    if not partial:
        events.extend([
            ("message_delta", {"type": "message_delta", "delta": {
                "stop_reason": response["stop_reason"], "stop_sequence": None}, "usage": {"output_tokens": 40}}),
            ("message_stop", {"type": "message_stop"}),
        ])
    return [{"event": kind, "data": data} for kind, data in events]


class CaptureServer(ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, name, workspace):
        super().__init__(("127.0.0.1", 0), CaptureHandler)
        self.case_name, self.workspace = name, workspace
        self.records, self.other_requests, self.errors = [], [], []
        self.stream_started = threading.Event()
        self.disconnected = threading.Event()
        self.release = threading.Event()
        self.connections = set()
        self.connections_lock = threading.Lock()

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(CLEANUP_TIMEOUT_SECONDS)
        with self.connections_lock:
            self.connections.add(connection)
        return connection, address

    def shutdown_request(self, connection):
        try:
            super().shutdown_request(connection)
        finally:
            with self.connections_lock:
                self.connections.discard(connection)

    def server_close(self):
        self.release.set()
        with self.connections_lock:
            connections = tuple(self.connections)
        for connection in connections:
            try:
                # 中断 header/body 的读取后再 join，不能用单次 recv 超时充当总期限。
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                # handler 可能在快照生成后已自行关闭连接。
                pass
        super().server_close()


class CaptureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send_json(self, data, status=200):
        raw = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        self.connection.settimeout(CLEANUP_TIMEOUT_SECONDS)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY_BYTES:
                return self.send_json({"error": "body_limit"}, 413)
            body = json.loads(self.rfile.read(length))
            path = self.path.split("?", 1)[0]
            headers = {key.lower(): value for key, value in self.headers.items()
                       if key.lower().startswith("x-claude-code-") or key.lower() in (
                           "anthropic-version", "anthropic-beta", "content-type", "accept",
                       )}
            record = {"path": self.path, "headers": headers, "body": body}
            if path == "/v1/messages/count_tokens":
                self.server.other_requests.append(record)
                record["response"] = {"input_tokens": 100}
                return self.send_json(record["response"])
            if path != "/v1/messages" or len(self.server.records) >= 6:
                self.server.errors.append("unexpected_request:" + path)
                return self.send_json({"error": "unexpected_request"}, 400)
            self.server.records.append(record)
            self.respond(record)
        except (ValueError, OSError) as error:
            if not self.server.release.is_set():
                self.server.errors.append(type(error).__name__ + ":" + str(error))

    def respond(self, record):
        partial = self.server.case_name == "cancelled"
        content, reason = response_for(self.server.case_name, len(self.server.records), self.server.workspace)
        response = {"id": "msg_probe_" + str(len(self.server.records)), "type": "message", "role": "assistant",
                    "model": "probe-main", "content": [] if partial else content,
                    "stop_reason": None if partial else reason, "stop_sequence": None,
                    "usage": {"input_tokens": 100, "output_tokens": 40}}
        is_stream = record["body"].get("stream", False)
        events = sse_events(response, partial) if is_stream else []
        media = "text/event-stream" if is_stream else "application/json"
        record["response"] = {"status": 200, "headers": {"content-type": media}, "body": response, "events": events}
        if not is_stream:
            return self.send_json(response)
        self.send_response(200)
        self.send_header("Content-Type", media)
        self.end_headers()
        for event in events:
            self.wfile.write(("event: " + event["event"] + "\ndata: " + json.dumps(event["data"]) + "\n\n").encode())
            self.wfile.flush()
        if partial:
            self.server.stream_started.set()
            self.wait_for_disconnect()

    def wait_for_disconnect(self):
        self.connection.settimeout(0.2)
        while not self.server.release.is_set():
            try:
                if not self.connection.recv(1):
                    self.server.disconnected.set()
                    return
            except socket.timeout:
                continue
            except ConnectionResetError:
                self.server.disconnected.set()
                return


def client_command(session_id):
    return [CLIENT, "--bare", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--disable-slash-commands", "--no-chrome", "--no-session-persistence", "--model", "probe-main",
            "--session-id", session_id, "--tools", "Read,Edit", "--allowedTools", "Read", "Edit",
            "--permission-mode", "dontAsk", "--max-turns", "6",
            "--system-prompt", "Only access this temporary workspace.", "--output-format", "json",
            "-p", "Follow the protocol response and report the result."]


def client_environment(folder, port, hints):
    env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG") if key in os.environ}
    env.update({"HOME": str(folder / "home"), "CLAUDE_CONFIG_DIR": str(folder / "home" / ".claude"),
                "ANTHROPIC_BASE_URL": "http://127.0.0.1:" + str(port), "ANTHROPIC_API_KEY": "offline-placeholder-key",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_AUTOUPDATER": "1",
                "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1"})
    if hints:
        env["CLAUDE_CODE_GATEWAY_HINT_HEADERS"] = "1"
    return env


def signal_group(process, group_signal):
    try:
        os.killpg(process.pid, group_signal)
    except ProcessLookupError:
        # 组长可能早已退出，整个组也可能已自然结束。
        pass


def terminate_group(process):
    if process is None:
        return
    # poll() 只描述组长；后代仍可能持有管道，必须清理原进程组。
    signal_group(process, signal.SIGTERM)
    try:
        process.communicate(timeout=CLEANUP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        signal_group(process, signal.SIGKILL)
        process.communicate(timeout=CLEANUP_TIMEOUT_SECONDS)


def execute_client(name, arguments, workspace, env, server):
    process = subprocess.Popen(arguments, cwd=workspace, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        if name == "cancelled":
            if not server.stream_started.wait(CLIENT_TIMEOUT_SECONDS):
                raise RuntimeError("cancel_stream_not_started")
            os.killpg(process.pid, signal.SIGINT)
        stdout, stderr = process.communicate(timeout=CLIENT_TIMEOUT_SECONDS)
        if name == "cancelled" and not server.disconnected.wait(CLEANUP_TIMEOUT_SECONDS):
            raise RuntimeError("cancel_stream_not_disconnected")
        result = json.loads(stdout) if stdout.strip() else {}
        return {"exit_code": process.returncode, "cli_result": result, "stderr": stderr}
    finally:
        terminate_group(process)


def run_case(name, version):
    with tempfile.TemporaryDirectory(prefix="prewalk-w0-") as temporary:
        folder = Path(temporary).resolve()
        workspace = folder / "workspace"
        workspace.mkdir()
        (folder / "home").mkdir()
        output, other = workspace / "probe.txt", workspace / "other.txt"
        output.write_text("PREWALK_BEFORE\n")
        other.write_text("SECOND_BEFORE\n")
        server = CaptureServer(name, workspace)
        thread = threading.Thread(target=server.serve_forever, name="prewalk-w0-server")
        thread.start()
        session_id, hints = str(uuid.uuid4()), name != "no-hints"
        arguments = client_command(session_id)
        try:
            result = execute_client(name, arguments, workspace,
                                    client_environment(folder, server.server_port, hints), server)
        finally:
            server.release.set()
            server.shutdown()
            server.server_close()
            thread.join(timeout=CLEANUP_TIMEOUT_SECONDS)
        return {"name": name, "source": {
                    "version": version, "client": CLIENT, "temporary_root": str(folder),
                    "arguments": arguments, "session_id": session_id, "hint_headers": hints,
                    "captured_at": datetime.now(timezone.utc).isoformat(), "origin": "real-client/local-fake"},
                **result, "requests": server.records, "other_requests": server.other_requests,
                "capture_errors": server.errors, "file_content": output.read_text(), "other_content": other.read_text(),
                "cleanup": {"client_exited": True, "server_closed": not thread.is_alive(),
                            "stream_disconnected": server.disconnected.is_set()}}


def sanitize(case):
    source = case["source"]
    replacements = {source["session_id"]: "00000000-0000-4000-8000-000000000000"}
    for original, normalized in ((source["temporary_root"], "/fixture/root"),
                                 (source["client"], "/fixture/bin/claude")):
        replacements[original] = normalized
    for request in case.get("requests", []) + case.get("other_requests", []):
        metadata = request["body"].get("metadata", {}).get("user_id")
        if isinstance(metadata, str):
            for key, value in json.loads(metadata).items():
                if key in ("device_id", "account_uuid") and value:
                    replacements[value] = "fixture-" + key
    # metadata 也可嵌在 JSON 字符串内；替换已观察到的标识值，不改变消息结构。
    serialized = json.dumps(case, ensure_ascii=False)
    for key, value in re.findall(r'\\"(device_id|account_uuid)\\":\\"([^"\\]+)', serialized):
        replacements[value] = "fixture-" + key
    identities = re.findall(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', serialized)
    for identity in identities:
        if identity not in replacements:
            replacements[identity] = "00000000-0000-4000-8000-" + f"{len(replacements):012d}"
    for original in sorted(replacements, key=len, reverse=True):
        serialized = serialized.replace(original, replacements[original])
    return json.loads(serialized)


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def validate_pairs(request, next_request):
    response_calls = [part for part in request["response"]["body"]["content"] if part.get("type") == "tool_use"]
    tool_names = {tool["name"] for tool in request["body"].get("tools", [])}
    require(all(call["name"] in tool_names for call in response_calls), "unknown_tool")
    if next_request is None:
        require(not response_calls, "tool_pairing:missing_next_request")
        return
    history = next_request["body"]["messages"]
    calls = [part for message in history for part in content_blocks(message) if part.get("type") == "tool_use"]
    results = tool_results(next_request["body"])
    ids, result_ids = [call["id"] for call in calls], [result["tool_use_id"] for result in results]
    require(len(ids) == len(set(ids)) and len(result_ids) == len(set(result_ids)) and set(ids) == set(result_ids),
            "tool_pairing:missing_or_duplicate")
    for call in response_calls:
        # 真实 2.1.323 会为 Edit 补全 replace_all=False；除此之外逐字段保持。
        expected_input = ({"replace_all": False, **call["input"]}
                          if call["name"] == "Edit" else call["input"])
        require(any(all(candidate.get(key) == call.get(key) for key in ("type", "id", "name"))
                    and candidate.get("input") == expected_input
                    for candidate in calls), "tool_pairing:changed_call")


def validate_case(case):
    name, source = case["name"], case["source"]
    require(name in CASE_NAMES and source["version"] == EXPECTED_VERSION, "version_or_case")
    require(source["origin"] == "real-client/local-fake", "provenance")
    require(case["requests"] and not case["capture_errors"], "capture_incomplete")
    require(case["cleanup"]["client_exited"] and case["cleanup"]["server_closed"], "cleanup")
    require(case["other_content"] == "SECOND_BEFORE\n", "file_effect:other")
    serialized = json.dumps(case, ensure_ascii=False)
    require(not any(marker in serialized for marker in (
        "/Users/", "/Volumes/", "/var/folders/", "/private/tmp/prewalk-", "Bearer ", "sk-ant-", "offline-placeholder-key",
    )), "unsanitized")
    prompts = set()
    for index, request in enumerate(case["requests"]):
        header, body = request["headers"], request["body"]
        require(header.get("x-claude-code-session-id") == source["session_id"], "session_identity")
        if source["hint_headers"]:
            require(header.get("x-claude-code-request-class") == "main", "request_class")
            require(bool(header.get("x-claude-code-prompt-id")), "prompt_identity")
            prompts.add(header["x-claude-code-prompt-id"])
        else:
            require("x-claude-code-request-class" not in header, "unexpected_hint")
        require(body["model"] == "probe-main" and body["messages"], "request_body")
        require({tool["name"] for tool in body["tools"]} == {"Read", "Edit"}, "tool_exposure")
        response = request["response"]
        require(response["status"] == 200 and response["events"], "response_missing")
        require(response["events"] == sse_events(response["body"], name == "cancelled"), "response_events")
        following = case["requests"][index + 1] if index + 1 < len(case["requests"]) else None
        validate_pairs(request, following)
    require(len(prompts) <= 1, "prompt_identity:changed")
    validate_effect(case)


def validate_effect(case):
    name = case["name"]
    expected_count = 3 if name == "successful-edit" else 2 if name in ("failed-edit", "parallel-tools") else 1
    require(len(case["requests"]) == expected_count, "request_count")
    expected_file = "PREWALK_OFFLINE_OK\n" if name == "successful-edit" else "PREWALK_BEFORE\n"
    require(case["file_content"] == expected_file, "file_effect:probe")
    if name == "cancelled":
        require(case["cleanup"]["stream_disconnected"] and case["cli_result"].get("is_error") is True and
                case["cli_result"].get("terminal_reason") == "aborted_streaming", "cancel_cleanup")
        return
    require(case["exit_code"] == 0 and not case["cli_result"].get("is_error"), "client_failed")
    results = tool_results(case["requests"][-1]["body"])
    if name == "failed-edit":
        require(len(results) == 1 and results[0].get("is_error") is True and
                "String to replace not found in file." in str(results[0]["content"]) and
                "NOT_PRESENT" in str(results[0]["content"]), "failed_edit_reason")
    else:
        require(all(not result.get("is_error", False) for result in results), "unexpected_tool_error")
    if name == "parallel-tools":
        by_id = {result["tool_use_id"]: str(result["content"]) for result in results}
        require(set(by_id) == {"toolu_prewalk_read_a", "toolu_prewalk_read_b"} and
                "PREWALK_BEFORE" in by_id["toolu_prewalk_read_a"] and
                "SECOND_BEFORE" not in by_id["toolu_prewalk_read_a"] and
                "SECOND_BEFORE" in by_id["toolu_prewalk_read_b"] and
                "PREWALK_BEFORE" not in by_id["toolu_prewalk_read_b"], "parallel_result_content")
    expected_text = {"successful-edit": "PREWALK_OFFLINE_DONE", "failed-edit": "FAILED_EDIT_REPORTED",
                     "parallel-tools": "PARALLEL_READS_DONE"}.get(name, "PLANNING_ONLY")
    require(case["cli_result"].get("result") == expected_text, "client_final_text")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=CASE_NAMES, help="只采指定场景，默认全部")
    parser.add_argument("--output", type=Path, default=FIXTURES)
    arguments = parser.parse_args()
    version = require_version()
    names = (arguments.case,) if arguments.case else CASE_NAMES
    cases = [sanitize(run_case(name, version)) for name in names]
    for case in cases:
        validate_case(case)
    arguments.output.mkdir(parents=True, exist_ok=True)
    for case in cases:
        (arguments.output / (case["name"] + ".json")).write_text(json.dumps(case, ensure_ascii=False, indent=2) + "\n")
    manifest = {"version": version, "captures": [case["name"] + ".json" for case in cases],
                "unsupported": UNSUPPORTED, "response_source": "local-fake", "request_source": "real-client"}
    (arguments.output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"captured": list(names), "validated": len(cases)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
