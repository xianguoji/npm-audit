# 分析与改造方案：npm-audit 全局工具与 MCP Server

## 1. 当前项目分析 (Current State Analysis)
当前项目是一个基于 Node.js 的安全审计脚本，核心功能已经实现，但在跨项目使用时存在以下不便：
1. **硬编码执行路径**：`index.js` 末尾硬编码了 `mcp.start(process.cwd())`，只能审计运行命令时的当前目录。
2. **硬编码输出路径**：报告直接输出在 `process.cwd()`（当前目录），可能会在被审计的项目中留下 `npm-audit-result.md` 和 `.html` 文件，污染被审计项目。
3. **缺乏标准执行入口**：`package.json` 没有配置 `bin`，用户无法通过全局命令调用，只能通过 `node index.js` 执行。
4. **未实现真正的 MCP 协议**：代码注释虽有“MCP 主类”，但实际只是一个普通的类封装，并未接入 Model Context Protocol 官方 SDK，AI 无法将其作为 Tool 动态调用。

## 2. 更好更方便的方案 (Proposed Changes)
为实现“不影响被审计项目”并做成“全局工具”，我们将项目重构为 **全局命令行工具 (CLI) + MCP Server 两用模式**：

### 2.1 将核心逻辑解耦并参数化
- **修改 `index.js`**：移除末尾自动执行的逻辑，将其导出为一个纯粹的服务类 `NpmAuditMCP`。
- **动态输出路径**：让报告文件的输出路径变为可配置的参数。CLI 模式下输出到执行命令的目录；MCP 模式下则直接返回字符串，不落盘。

### 2.2 增加全局命令行 (CLI) 支持
- **创建 `bin/cli.js`**：作为命令行的入口文件。
  - 读取命令行参数传入的“被审计项目路径”和“输出路径”：`npm-audit-mcp <target-path>`。
- **更新 `package.json`**：
  - 增加 `"bin": { "npm-audit-mcp": "./bin/cli.js", "npm-audit-server": "./bin/mcp-server.js" }`。
  - 用户可以通过 `npm install -g .` 全局安装后，随时在任何地方执行 `npm-audit-mcp /path/to/other-project`，报告将生成在执行命令的当前目录，从而**不污染被审计项目**。

### 2.3 增加 MCP Server 支持
- **创建 `bin/mcp-server.js`**：接入 `@modelcontextprotocol/sdk`。
  - 注册 `npm-audit` 工具，接收 `targetPath` 作为参数。
  - 当 AI（如 Trae/Claude）调用该工具时，执行审计并将 Markdown 结果直接作为文本返回给 AI，不生成物理文件，更加绿色环保。

## 3. 具体修改计划 (Implementation Steps)

1. **安装新依赖**
   - 运行 `npm install @modelcontextprotocol/sdk`
2. **重构 `index.js` (核心逻辑)**
   - 移除末尾的 `const mcp = new NpmAuditMCP(); mcp.start(...)`。
   - 在底部添加 `export default NpmAuditMCP;`。
   - 构造函数支持接收 `options = { outputDir: process.cwd(), writeFiles: true }`，从而解耦路径硬编码。
   - 修改 `renderMarkdownReport` 和 `renderHtmlReport`，当 `writeFiles` 为 false 时，只返回内容字符串而不写入文件系统。
3. **创建 `bin/cli.js`**
   - 解析 `process.argv` 获取 `targetPath`。
   - 实例化 `NpmAuditMCP`，调用 `start(targetPath)` 生成物理报告。
   - 顶层添加 `#!/usr/bin/env node`。
4. **创建 `bin/mcp-server.js`**
   - 引入 MCP SDK，创建基于 stdio 的 Server。
   - 注册 `npm_audit` 工具，在 handler 中配置 `writeFiles: false` 调用核心逻辑，将生成的 Markdown 返回给客户端。
   - 顶层添加 `#!/usr/bin/env node`。
5. **更新 `package.json`**
   - 增加 `"bin"` 字段映射 `cli.js` 和 `mcp-server.js`。
   - 修改 `"type": "module"` 保持不变，确保 ESM 模块可用。

## 4. 假设与决策 (Assumptions & Decisions)
- **输出文件策略**：CLI 模式下，默认将报告文件输出到**执行 CLI 命令的当前目录**，而被审计项目的路径由参数传入。这样即便审计其他项目，生成的报告也留在你当前的工作空间，实现了物理隔离。
- **MCP 模式不落盘**：MCP Server 调用时，主要为了向大模型提供上下文，所以仅返回 Markdown 内容，不生成物理文件。

## 5. 验证步骤 (Verification)
1. 运行 `npm link` 将工具临时链接到全局。
2. 切换到任意其他测试目录，执行 `npm-audit-mcp /Users/pcgz0007/pgy/npm-audit`，验证是否在测试目录生成了报告，并且 `/Users/pcgz0007/pgy/npm-audit` 目录保持干净。
3. 执行 `node bin/mcp-server.js`，通过检查输出或代码验证 MCP Server 的基本可用性。