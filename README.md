# chatgpt-ask

通过本机已登录的 Chrome 向 ChatGPT 提问，提供命令行入口和 MCP stdio 服务。

当前版本从本机 `.oracle` 目录中的两个脚本独立整理而来，保留现有提问与结果读取行为。代码仓库不包含浏览器配置、登录凭据或会话记录。

## 环境要求

- Node.js 22.4 或更新版本，使用内置 `fetch` 和 `WebSocket`；当前整理环境为 Node.js 24.14.0。
- Windows 和 Google Chrome。自动启动 Chrome 的路径目前固定为 `C:\Program Files\Google\Chrome\Application\chrome.exe`。
- 专用 Chrome 配置目录中已登录 ChatGPT。默认配置目录为 `%USERPROFILE%\.oracle\browser-profile`，调试端口为 `9333`。
- 无 npm 运行时依赖，可以直接使用 Node.js 启动。

首次使用时，在该专用 Chrome 配置目录对应的窗口完成登录。已有 Oracle profile 可继续复用，无须把它复制进仓库。

## 命令行

在项目目录下运行：

```powershell
node .\chatgpt-ask.mjs '请简要解释事件循环'
node .\chatgpt-ask.mjs --json '请查找这个问题的公开资料并给出来源'
node .\chatgpt-ask.mjs --file '.\prompt.txt'
Get-Content -LiteralPath '.\prompt.txt' -Raw -Encoding utf8 | node .\chatgpt-ask.mjs -
```

长任务可以先取得会话 ID，再单独读取结果：

```powershell
node .\chatgpt-ask.mjs --json --no-wait '请深入研究这个问题'
node .\chatgpt-ask.mjs --json --conversation '<conversation-id>' --timeout 240
node .\chatgpt-ask.mjs --json --list 10
```

也可以使用 `npm.cmd run ask -- '你的问题'`。

| 参数 | 用途 |
| --- | --- |
| `--json` | 向标准输出写入 JSON 结果 |
| `--timeout <秒>` | 等待结果的时间，默认 240 秒；0 表示检查一次 |
| `--no-wait` | 发送后返回会话 ID |
| `--conversation <id>` | 读取已有会话最后一轮的回答 |
| `--list [数量]` | 列出最近会话，默认 15 条 |
| `--file <路径>` | 从 UTF-8 文件读取问题 |
| `-` | 从标准输入读取问题 |
| `--keep-tab` | 保留脚本创建的标签页 |
| `--port <端口>` | Chrome 调试端口，默认 9333 |
| `--profile <目录>` | 自动启动 Chrome 时使用的配置目录 |

`--profile` 只影响自动启动；指定端口已有 Chrome 时会直接连接该实例。

CLI 退出码：`0` 为完成、已发送或已列出，`2` 为仍在等待，`3` 为未登录或页面未就绪，`1` 为其他错误。

## MCP 接入

直接启动入口为：

```powershell
node .\chatgpt-ask-mcp.mjs
```

客户端应直接运行 Node.js，以保持标准输出为 MCP JSON-RPC 消息。Codex 的配置示例：

```toml
[mcp_servers.chatgpt-ask]
command = 'D:\Program Files\nodejs\node.exe'
args = ['D:\Mickey\VScode\else\chatgpt-ask\chatgpt-ask-mcp.mjs']
startup_timeout_sec = 30.0
tool_timeout_sec = 1800.0
```

这两个路径是当前机器的示例，其他机器需要调整。该配置示例不会自动修改客户端现有配置。

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `chatgpt_ask` | `prompt`，可选 `wait_sec` | 发送问题并等待；超时返回会话 ID |
| `chatgpt_result` | `conversation_id`，可选 `wait_sec` | 等待或读取已有会话的回答 |
| `chatgpt_recent` | 可选 `limit` | 找回最近会话的 ID |

`chatgpt_ask` 默认等待 240 秒，范围为 30–300 秒；`chatgpt_result` 默认等待 420 秒，范围为 180–420 秒。页面初始化可能另需时间。

收到 `pending` 后，使用原会话 ID 读取结果，避免重复发送问题。深度研究可能需要 10–15 分钟或更久。MCP 层目前沿用浏览器当前选中的模型和思考设置，不提供文件访问或附件上传。

## 项目结构与检查

```text
chatgpt-ask.mjs       命令行、Chrome CDP 连接、发送与结果提取
chatgpt-ask-mcp.mjs   MCP stdio 入口、请求排队和结果格式化
package.json         项目元数据与运行命令
```

```powershell
npm.cmd run check
```

该命令只检查两个入口的 JavaScript 语法。完整提问流程仍需在已登录的浏览器上验证。

## 当前维护边界

- 发送依赖 ChatGPT 网页，读取依赖其网页会话接口；页面与响应格式变化需要跟进维护。
- 浏览器路径、MCP 浏览器配置、CDP 超时与断连处理仍需完善。
- MCP 发送队列和等待去重仅在当前进程内有效，多客户端之间尚无跨进程协调。
- 部分读取错误可能被归为 `pending`，后续需要细分错误状态。
- 任务状态尚未独立持久化；可通过会话 ID 或最近会话列表恢复读取。

浏览器 profile 内含登录资料，应保存在仓库外；不要把调试端口开放到公网。
