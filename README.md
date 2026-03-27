# npm-audit-mcp

`npm-audit-mcp` 是一个基于 Node.js 的模型上下文协议 (Model Context Protocol, MCP) 服务，专为大语言模型（如 Claude、Trae 等）设计，用于自动化执行项目的 NPM 依赖安全审计。

## 🌟 功能特性

- **自动化审计**：只需提供本地项目路径或远程 `package.json` 的链接，即可自动完成安全审计全流程。
- **环境隔离**：在系统临时目录中创建独立工作区，不污染、不修改原工程的任何代码和状态。
- **私有依赖兼容**：智能识别本地 `.npmrc` 配置，并能自动剔除特定的私有依赖（如 `@oray/`）以防生成 Lock 文件时报错中断。
- **多版本适配**：兼容 NPM v6 和 NPM v7/v8+ 不同的审计结果数据结构。
- **详尽报告生成**：自动生成清晰的 HTML 和 Markdown 格式的审计报告，包含：
  - 漏洞总览与分级统计（Critical, High, Moderate, Low）
  - 漏洞依赖详细列表（包含：当前版本、漏洞原因、是否可自动修复、官方修复建议）
  - 根据严重程度高低智能排序，突出重点高危漏洞。

## 🚀 工作流程

1. **创建临时工作区**：在系统临时目录中创建唯一标识的目录。
2. **解析工程信息**：读取目标项目的 `package.json`（支持本地路径和远程 raw URL），提取包名和依赖信息。
3. **生成锁文件**：在临时目录下执行 `npm install --package-lock-only` 生成依赖关系树（不会实际下载包，速度快），并自动过滤可能导致报错的私有包。
4. **执行安全审计**：使用官方源强制执行 `npm audit --json` 获取最准确的已知漏洞数据。
5. **规范化与输出**：将原始 JSON 数据解析为结构化对象，并在当前目录下生成带有时间戳的 `.html` 和 `.md` 审计报告。
6. **自动清理**：任务结束后自动删除临时目录，不留痕迹。

## 🛠️ 使用方式

### 方式一：集成到主流 AI Agent 客户端 (作为 MCP Server)

本工具原生支持 Model Context Protocol (MCP)，可以直接作为 Server 接入到支持 MCP 的智能编程客户端（如 Cursor、Trae 等）中。

#### 在 Cursor 中添加：

1. 打开 Cursor 设置 (`Cmd + ,` 或 `Ctrl + ,`)
2. 导航到 **Features** -> **MCP Servers**
3. 点击 **+ Add New MCP Server**
4. 填写配置：
   - **Name**: `npm-audit-mcp` (或任意名称)
   - **Type**: `command`
   - **Command**: `node`
   - **Args**: `/绝对路径/到/你的/npm-audit/bin/mcp-server.js` (请替换为实际路径)

#### 在 Trae 中添加：

1. 点击左侧活动栏的齿轮图标进入设置
2. 找到 **MCP Servers** 配置项
3. 添加一个本地 Server，配置与上述 Cursor 类似，指定 `node` 和 `bin/mcp-server.js` 的绝对路径。

配置完成后，你可以直接在聊天框中让 AI 助手：“帮我审计一下当前项目的 NPM 依赖漏洞”，AI 就会自动调用该工具。

### 方式二：作为全局 CLI 命令使用 (推荐手动执行)

如果你希望在任何目录下都能快速运行该审计工具，可以通过 `npm link` 将其注册为全局命令。

1. 在当前项目根目录下执行：
   ```bash
   npm link
   ```
2. 然后你就可以在任何其他前端项目的根目录下，直接执行以下命令进行安全审计：
   ```bash
   npm-audit-mcp
   ```
   _(注：该命令会自动审计当前终端所在的目录，并在当前目录下生成报告)_

### 方式三：作为代码模块引入

该项目也可作为独立的 Node.js 模块引入并调用：

```javascript
import NpmAuditMCP from "./index.js";

// 初始化 MCP 实例
const mcp = new NpmAuditMCP({
  silent: false, // 是否关闭控制台输出日志
  outputDir: process.cwd(), // 报告文件输出的目录
});

// 传入目标工程路径启动审计
await mcp.start("/path/to/your/project");
```
