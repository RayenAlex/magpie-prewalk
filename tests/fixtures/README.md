# Claude Code 离线客户端夹具

W0 为 W1 提供真实协议输入，不实现调度策略。原始客户端固定为 **Claude Code 2.1.323**，执行模式是隔离 `--bare -p`，不是交互 TUI。2026-11-15 用户批准版本偏差后，另采集了 `claude-code-2.1.325/` 供 W5/W6 真链使用；旧 2.1.323 夹具保留，不混淆证据。

## 来源与边界

`claude-code-2.1.323/manifest.json` 列出六个真实采集场景。每份夹具包含：

- `source`：实际版本、启动参数、UTC 采集时间、用途提示开关和采集来源。
- `requests`：真实客户端 Messages 请求的完整 JSON body、路径及选定协议头。
- `response`：本地 fake 返回的 body、SSE 事件和响应类型；不冒充真实模型输出。
- `cli_result`、文件最终内容和进程／服务清理证据。

只采集协议与用途头，不保存认证、Cookie、机器 User-Agent 等无关头。临时根路径统一为 `/fixture/root`，CLI 路径为 `/fixture/bin/claude`；session、prompt、device 和结果 UUID 做一致映射。替换标识值，不手补用途头或修改消息语义。新临时 HOME、不继承真实密钥、不读取 transcript、不加载用户插件、hooks 或 MCP。

六个场景：

- `successful-edit`：真实 Read 后 Edit 成功，文件从 `PREWALK_BEFORE` 变为 `PREWALK_OFFLINE_OK`；三次主请求完成自然续轮。
- `failed-edit`：旧字符串 `NOT_PRESENT` 不存在；`is_error=true`，具体原因是 `String to replace not found in file.`，文件不变。
- `parallel-tools`：同一响应发出两个 Read；下一请求含两个唯一配对结果，分别携带两份文件内容。**结果顺序可变，按 ID 配对，不按位置配对。**
- `no-hints`：不设置用途提示开关，真实请求有 session，但无 request-class；不得用它证明主循环身份。
- `stopped`：fake 直接返回纯文本 `end_turn`；客户端结束，文件不变，没有第二次请求。无需为观测再等待固定时长。
- `cancelled`：只开始 SSE，在观察到流建立后发 SIGINT；连接关闭，客户端结果为 `terminal_reason=aborted_streaming`、`is_error=true`。**本版本退出码为 0，不能单凭退出码判成功。**

客户端将 Edit 的 `replace_all: false` 默认值补入回传历史，夹具保留该变化。验证允许这个已观察的默认值补全，其余工具名、ID 和参数仍须匹配。

## 2.1.325 版本偏差补采

用户单独批准用 `2.1.325` 重采后，`tests/fixtures/claude-code-2.1.325/` 保存了同样六场景。采集器以 `PREWALK_CLIENT_VERSION=2.1.325` 指定版本；默认仍为 `2.1.323`。六份新夹具通过同一 `validate_case`，旧夹具未改。新旧请求数、路径、白名单头、工具集合、消息数和 stop_reason 形状一致；仅部分工具续轮多出 `x-claude-code-prev-tool-durations`，不在 W1 身份白名单内。该补采只服务已承认版本偏差的 W5/W6，不证明 2.1.323 或 2.1.325 以外的客户端。

## 复现与回归

离线回归不启动 CLI、不联网：

```sh
python3 -I -m unittest discover -s "tests" -p 'test_*.py' -v
```

24 项纯离线测试不启动 CLI、不联网。另显式运行 2 项本机生命周期检查，只连接自己创建的 loopback fake，验证不完整 header/body 的连接关闭，不调用 CLI 或远程服务：

```sh
python3 -I -m unittest discover -s "tests" -p 'capture_cleanup_checks.py' -v
```

显式重新采集，只连接 loopback fake，不调用付费模型：

```sh
python3 -I "tests/client_capture.py" --output "$(mktemp -d)/capture"
```

要求本机 CLI 恰好为 2.1.323；不匹配时在任务采集与落盘前拒绝。可使用 `--case failed-edit` 采单个场景，建议写新目录，避免把部分 manifest 覆盖为完整集合。默认目标是本夹具目录。

采集最多六次 Messages 请求／场景、六个客户端回合、单请求 2MiB、客户端等待 45 秒。子进程标准输入显式设为 DEVNULL，防止继承管道中的调用脚本。清理原进程组时不依赖组长是否存活：TERM 后等待排空，超时才 KILL，整个组已结束则容忍不存在。服务器停止接收后先 shutdown 已接入连接，再等待 handler 线程，避免未完整 header/body 阻塞关闭。所有场景验证后才写输出。

## 派生反例

测试只对内存副本修改：错误成功标记、遗漏／重复并行结果、互换 ID 但不换内容、未知工具、缺 session、错误文件副作用。合法结果乱序保持通过。原始采集文件不被改写。每个反例必须命中对应拒绝原因，不把 JSON 格式错误或无关校验失败当作目标失败证据。

## 可消费范围与缺口

可进入 **W1 的离线路由合同**：带 main/session/prompt-id 的主请求、Read/Edit 成功与失败、并行结果、停止和取消。夹具验证器仅保护测试输入，不是生产路由或降级守卫。

以下仍未支持：**Write、真实子代理、auxiliary、compaction、交互 TUI、图像和长上下文容量边界**。没有采到对应真实用途，不生成伪造报文填补。后续合同对用途缺失、未知或冲突保持强模型且不推进；不得声称这些场景已经验收。

W0 文件副作用证明隔离客户端执行了 fake 指定动作，不证明模型规划质量。CPA 的合成双模型结果是另一层证据；这些夹具不运行 CPA、不消耗额度，也不证明插件的 W5 自动交接或 W6 代码交付。
