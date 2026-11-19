# magpie-prewalk-provider（授权、计费、阶段状态机与有证据的实施交接）

原版 magpie 的纯 Provider 候选；实现显式受限服务身份转发、零附加费前提、按会话的 planner/executor 阶段切换、新会话一次受限自动分类，以及执行失败时的受限健康判断。

## 安装前置（管理员，原版既有功能；不改生产配置/镜像）

1. 创建独立 gateway key，仅允许配置中的 planner/executor 目标；按需设置账号和预算。
2. 网关允许共享，使 `X-Magpie-Page-Port: 1` 的强制鉴权生效；否则本插件拒绝服务，不自动开启共享。
3. 用该 key 作为本插件 provider 的 API key 登录；密钥存插件 auth store，不放 options/源码/日志。
4. 为精确 wrapper ref `<providerID>/<modelID>` 配置完整用户价格 `0/0/0/0`；必须四项齐全，否则零费率语义不成立。插件自身的全零 cost 不被原版视为明确价格。
5. 管理员在插件 options 中固定 `planner`、`executor`，可使用 `provider/model` 或宿主支持的 `group/<id>`；不接受客户端正文任意目标。
6. 可选 `defaultMode`：`plan_then_execute`（默认）、`direct`、`strong_only`。默认值启用新会话自动分类；显式 `direct`/`strong_only` 是管理员覆盖，跳过分类。
7. 可选 `classifyTimeoutMs`：分类总期限，1000–300000 毫秒，默认 120000（120 秒），覆盖排队和完整响应读取；120 秒是工程默认，不是实测最优值。
8. 可选 `healthTimeoutMs`：执行健康判断总期限，1000–30000 毫秒，默认 10000；与分类独立。

已有显式 `classifyTimeoutMs=10000` 会继续保持 10 秒，更新插件不会自动改写管理员配置。慢 planner 需另行把该值设为例如 `120000`，不要通过跳过分类或放松答案校验绕过超时。已经因分类超时进入 `strong_only` 的会话保持原状态；更改期限仅对后续新分类生效，不能证明新交接效果已通过。插件取消传播、分类失败保强和不主动重试规则不变；网关本身的重试仍计入同一等待期限。

## 窗口配置页

插件在 magpie 窗口的 Plugins 分组提供 `Prewalk 配置` 页，直接读写本插件 options：

- 可编辑：`planner`、`executor`、`defaultMode`、`classifyTimeoutMs`、`healthTimeoutMs`。分类与健康期限分别校验，不因延长分类同步延长健康判断。
- `planner`、`executor` 使用下拉选择，候选来自当前配置和今日实际使用的模型；不手输。页面排除 `prewalk/route` 自身，避免把入口当目标。
- 只读：入口 `providerID/modelID`，避免破坏客户端模型名与 wrapper 零价引用。
- 页面不显示服务密钥，也不编辑零价；这些仍按上面的安装前置配置。
- 页面声明 `usage:day` 和 `groups:list` 只读权限，用于构造模型和路由组候选；不读供应商密钥或其他插件数据。宿主不支持 `groups:list` 时仍可使用直接模型。
- 保存走原版 `magpie.options.set`；Provider 插件有宿主部分，保存会重启插件宿主，进行中的请求可能短暂失败。
- 页面校验与宿主 `parseProviderOptions` 对齐，但最终仍以宿主校验为准。
- 保存路径在服务端 `plugins.json` 的插件 options；不是浏览器本地存储。

## 自动分类

- 新会话向 planner 发送一次有界 `task_route` 判断（用户文本最多 4000 字符），复用受限服务身份。
- 答案必须通过严格 schema；`direct`/`plan_then_execute`/`strong_only` 生效，`uncertain` 与任何失败、超时均保持 `strong_only`。
- 同一会话只判断一次；并发新会话请求不会重复判断。客户端取消会传播到分类调用。

## 执行健康判断

- executing 阶段出现失败工具组且未达重规划上限时，向 planner 发送一次有界 `execution_health` 判断，证据为失败工具组引用（最多 8 个）和截断的失败文本。
- `continue` 保持 executor；`replan` 回 planner 重规划；`external_block` 进入 blocked；`uncertain`、非法答案、失败或超时保守按 replan 处理。
- 健康判断会向 planner 发送失败工具结果的截断文本（每组最多 512 字符），并对常见凭据形态尽力脱敏；未知格式的敏感内容仍可能通过，不能视为完整防泄漏。
- 判断结果随会话状态持久化：同会话、同状态版本、同请求与证据在宿主重启后仍复用；会话状态被 512 上限淘汰后可能重新判断。

## 阶段与状态

- 仅 `planning` / `replanning` 的 planner 业务请求收到有界交接合同：先调查，再输出 `prewalk plan:<ref>`，使用原有 Write 工具写入专用 `.prewalk/handoff-<scope前16位>-r<revision>.json`。提示给出当前会话与目标配置的 scope、状态版本和下一计划版本；不进入分类或健康判断。
- 交接包包含目标与约束、实际工具观察的 ref/quote/fact、已选方案与理由/排除项、逐文件步骤、验证命令/预期/判错目标、已完成工作、边界及下一步。包最多 24KiB，各数组最多16项，引用摘要最多512字符；关键阻塞未解决时不交接。
- planner 提示另给 `Prewalk evidence index`：从当前历史中成功、完整配对且调用ID唯一的 Read/Grep/Glob/Bash 观察提取真实 `ref/tool/quote`，可直接复制，不用猜调用ID或用工具名替代。索引最多16项、每quote最多512字符、JSON最多12KiB，优先最近观察，显示省略数量。它只重用当前历史，不读取客户端文件；引用文本仍是不可信数据，不是新指令或自动脱敏结果。
- `Prewalk handoff feedback` 反馈当前校验原因与修复方向，包括重复证据ref、未知ref、quote不匹配、错误binding、计划标记不符或Write结果不完整。反馈不会修包、放宽规则或消耗有效交接；无效包仍由planner处理。成功写完匹配包后不要再发新plan标记。
- 只有与当前会话/版本/ref 一致、引用匹配既有成功工具输出、Write 所在工具组结果完整且全部成功的包，才能进入执行阶段。普通业务 Edit、仅文字计划、失败写入、过期或错误会话包不再触发交接。
- executor 保留原有用户/assistant/tool 历史，另收同版本实施合同与已核对的包：沿用既有结论，不无故重复调查或重设计；编辑工具要求的必要读取、检查变化和指定验证仍必须执行。合同不得覆盖系统/用户约束或扩大工具权限。
- executor 发现方案前提被实际观察推翻时，输出带当前版本、stepId、ref/quote 的 `prewalk mismatch:<ref>`；在已有权限内配合只读工具使客户端自然续轮。插件在下一请求按既有上限回 planner 更新包；不能撤销已执行工具或唤醒停止客户端。
- 包随会话持久化；宿主重启后复用。旧 executing 会话无合格包、配置目标变更、交接文件被可见工具修改时回 planning，不按旧包继续执行；重规划必须新 ref/new revision。
- 这些校验只证明结构、身份和观察引用可对账，不证明方案语义正确、工作区文件没有变化或模型必定服从；真实弱模型沿用效果仍需单独验收。
- executor 阶段出现失败工具结果时按健康判断决定继续、重规划或阻塞；重规划最多 2 次，之后 blocked，保持强模型。
- 无会话、状态损坏或读取失败：planner，且不写状态。
- 状态存于 `PREWALK_STATE_DIR` 或 `XDG_STATE_HOME|~/.local/state` 下的 `magpie-prewalk/sessions.json`；0600、原子替换、拒绝符号链接、最多 512 会话。

## 已知边界

- 内层请求使用服务身份，不继承入口调用者的模型、账号及实际成本预算；仅限自用或同一授权范围。
- 原版账本保留内外两条可见记录，token/调用数双计；wrapper 明确零价只避免重复计费。客户端 usage 保持原样。
- 辅助请求与子代理只按会话标签处理，尚未区分主请求/辅助用途；可能与主请求共用阶段推进。
- 健康判断会向 planner 发送失败工具结果的截断文本，每组最多 512 字符；常见凭据形态会尽力脱敏，但未知格式仍可能包含敏感内容。分类失败会使该会话保持强模型。
- 真实模型价格未知时保持未定价，不宣称精确预算拦截。
