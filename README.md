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
node .\chatgpt-ask.mjs --json --conversation '<conversation-id>' '继续追问：请展开解释上一条回答'
node .\chatgpt-ask.mjs --json --list 10
```

也可以使用 `npm.cmd run ask -- '你的问题'`。

| 参数 | 用途 |
| --- | --- |
| `--json` | 向标准输出写入 JSON 结果 |
| `--timeout <秒>` | 等待结果的时间，默认 240 秒；0 表示检查一次 |
| `--no-wait` | 发送后返回会话 ID |
| `--conversation <id>` | 不带问题时读取最后一轮回答；带问题（也可用 `--file` 或 `-`）时在原会话继续追问。支持会话 ID 或 ChatGPT 会话链接 |
| `--list [数量]` | 列出最近会话，默认 15 条 |
| `--file <路径>` | 从 UTF-8 文件读取问题 |
| `-` | 从标准输入读取问题 |
| `--keep-tab` | 保留脚本创建的标签页 |
| `--port <端口>` | Chrome 调试端口，默认 9333 |
| `--profile <目录>` | 自动启动 Chrome 时使用的配置目录 |

`--profile` 只影响自动启动；指定端口已有 Chrome 时会直接连接该实例。

CLI 退出码：`0` 为完成、已发送或已列出，`2` 为仍在等待，`3` 为未登录或页面未就绪，`1` 为其他错误。

## MCP 接入

### 使用范围

联网搜索和确有必要的独立第二意见优先使用本工具；日常本机操作、常规编码与排障自主完成，不按任务、阶段或失败次数固定咨询。

工具支持规划咨询；是否优先委托规划遵循各客户端的全局指令，不统一强制。

提问附必要上下文和具体问题，联网搜索要求来源；GPT 看不到本机文件，建议需核验。实际模型沿用网页当前选择，不固定假设某个型号优于本机代理。


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

若现有 MCP 配置仍指向旧的 `.oracle` 脚本，可以将旧入口改为转发到本仓库，后续修改便会由实际调用使用。此命令覆盖目标目录中的两个同名入口脚本，浏览器 profile 和登录数据保持原位；先加 `-Preview` 可查看将写入的内容：

```powershell
pwsh -NoProfile -NonInteractive -File .\install-runtime.ps1 -RuntimeDirectory "$env:USERPROFILE\.oracle"
```

已经运行的 MCP 服务会在下一次发送时使用新的 CLI；新增的工具参数仍需重启或重新连接 MCP 服务才能加载。

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `chatgpt_ask` | `prompt`，可选 `conversation_id`、`wait_sec` | 发送问题并等待；指定会话 ID 或 ChatGPT 会话链接时继续原对话，省略时新建；超时返回会话 ID |
| `chatgpt_result` | `conversation_id`，可选 `wait_sec` | 等待或读取已有会话的回答 |
| `chatgpt_recent` | 可选 `limit` | 找回最近会话的 ID |

`chatgpt_ask` 默认等待 240 秒，范围为 30–300 秒；`chatgpt_result` 默认等待 420 秒，范围为 180–420 秒。页面初始化可能另需时间。

收到 `pending` 后，使用原会话 ID 读取结果，避免重复发送问题。深度研究可能需要 10–15 分钟或更久。MCP 层目前沿用浏览器当前选中的模型和思考设置，不提供文件访问或附件上传。

如果读取进程超时或被中断，MCP 返回明确的进程错误和研究状态未知的提示；有会话 ID 时附上链接，可通过 `chatgpt_result` 读取同一会话。若发送后没有取得 ID，先检查浏览器或使用 `chatgpt_recent` 找回会话，再决定是否重试，避免重复提交。CDP 请求和连接有超时限制，断开时会报告读取失败。

读取到明确完成的回答后立即返回，不再额外请求一次来确认稳定性。普通轮询从 5 秒开始，无进展时逐步延长到 20 秒；提交确认也使用这套读取逻辑。HTTP 429 按限流处理，遵守 `Retry-After`（秒数或 HTTP 日期），并采用带抖动的指数退避，连续读取失败最多重试 3 次，始终受本次等待时限约束。401、403、404、服务端错误和网络读取失败分别报告，不会冒充研究中的 `pending`。

限流尚未恢复时，MCP 返回错误状态 `rate_limited`，结构化字段包含 `httpStatus`、`retryable`、`retryAfterSec` 和原 `conversationId`。等待提示的时间后继续读取同一会话，不要重发原问题；若发送后仅提交确认读取失败，也应先检查该会话，避免重复发送。MCP 错误字段和工具说明的更新需重新连接服务加载。

在同一对话中连续提问：第一次调用 `chatgpt_ask` 后，保留返回的 `structuredContent.conversationId`；等该轮回答完成，再将它作为下一次调用的 `conversation_id`：

```json
{
  "prompt": "请根据上一条回答，再给出一个具体例子",
  "conversation_id": "6ad9d8b3-93c8-83ea-bf24-31f0ab25001d"
}
```

追问会使用原会话已有的上下文，只返回新一轮的回答。若上一轮仍在生成，发送会被拒绝，应先用 `chatgpt_result` 等待完成。修改 MCP 服务后需重启或重新连接服务，让客户端重新读取工具参数。

发送前会选中当前草稿并替换为本次问题，避免新标签页恢复的旧草稿拼接到请求中。发送兼容新版按钮标识和中文名称，使用浏览器原生鼠标事件；按钮无法识别且完整草稿就绪时尝试 Enter。禁用、隐藏或被遮挡的按钮不会被点击。点击或按键后会确认后端已保存新消息，再返回结果；提交未确认时返回错误并保留草稿标签页，先检查该页再重试，以免重复发送。

多段文本按编辑器 DOM 的逻辑段落和显式换行读取，避免 `innerText` 为段落显示间距插入额外换行，导致输入正确却被误判为 `draft_changed`。原有空行、缩进和文字仍参与一致性检查。

## 项目结构与检查

```text
chatgpt-ask.mjs       命令行、Chrome CDP 连接、发送与结果提取
chatgpt-ask-mcp.mjs   MCP stdio 入口、请求排队和结果格式化
chatgpt-composer.mjs  页面输入状态、发送按钮定位与可用性检查
chatgpt-read.mjs      只读轮询、HTTP 错误分类与限流退避
chatgpt-cdp.mjs       CDP 连接、请求超时及断连处理
chatgpt-process.mjs   子进程监控与中断后的会话恢复提示
install-runtime.ps1  将旧运行入口转发到仓库源码
package.json         项目元数据与运行命令
```

```powershell
npm.cmd run check
npm.cmd test
```

`check` 检查入口和辅助模块的 JavaScript 语法；`test` 通过模拟浏览器及子进程运行回归测试，覆盖连续追问、读取失败、进程中断、CDP 断连、按钮变化和发送失败等情况，不会向真实 ChatGPT 发送消息。完整提问流程仍需在已登录的浏览器上验证。

## 当前维护边界

- 发送依赖 ChatGPT 网页，读取依赖其网页会话接口；页面与响应格式变化需要跟进维护。
- 浏览器路径、MCP 浏览器配置、CDP 超时与断连处理仍需完善。
- MCP 发送队列和等待去重仅在当前进程内有效，多客户端之间尚无跨进程协调。
- 读取退避限于当前进程；多个客户端之间尚无共享限流冷却时间。
- 任务状态尚未独立持久化；可通过会话 ID 或最近会话列表恢复读取。

浏览器 profile 内含登录资料，应保存在仓库外；不要把调试端口开放到公网。
