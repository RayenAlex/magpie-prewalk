# magpie-prewalk

PreWalk 是 Magpie 的任务路由插件。本快照包含独立的 Provider 插件和可选的 `route-v1` 策略插件，两种交付方式不应同时用于同一入口。

## Provider 插件

管理员配置 `planner` 和 `executor`。新会话可先做一次有限的任务分类；需要规划时，`planner` 交付包含依据、步骤和验收标准的实施包，通过校验后由 `executor` 接手。执行失败时可以继续、重规划或阻塞。详细配置、最小权限和计费边界见 [Provider 文档](src/provider/README.md)。

用 Bun 构建并安装到本地 Magpie。远端部署时，将构建产物放到目标主机可访问的路径后再安装：

```sh
sh scripts/build-provider-package.sh
magpie plugin add "$PWD/dist/magpie-prewalk-provider"
```

`route-v1` 策略插件需要支持该协议的宿主，可通过 `bun run build:package` 单独构建。普通 Provider 安装不需要它。

## 本地检查

```sh
bun test
bun run typecheck
python3 -I -m unittest discover -s tests -p 'test_*.py' -v
```

- `typecheck` 是现有的 Bun 构建检查，不是独立 TypeScript 类型检查。
- 网关集成：设置 `MAGPIE_SRC` 指向兼容的 Magpie 源码，运行 `bun run test:provider-gateway`。需要 Go、本地已准备的 Go 依赖和 Bun 1.4.2 或以上；`GO_BIN` 和 `BUN_DIR` 可覆盖默认工具路径。
- 配置页集成：在本地 Python 环境安装 Playwright 及其 Chromium，运行 `bun run test:provider-page`。也可用 `PREWALK_CHROMIUM` 指定已有浏览器可执行文件。
- 测试目录只含归一化的离线协议夹具与假上游，不需要生产配置、密钥或会话。

## 快照边界

只包含已提交的源码、构建脚本、测试与必要说明。不包含原始 Git 历史、内部笔记、生产数据、部署记录或未提交功能。此版本没有 Scout 采样、采样修复、历史训练或 Devin 审查接入。
