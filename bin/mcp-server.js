#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import NpmAuditMCP from "../index.js";

// 创建 MCP Server 实例
const server = new Server(
  {
    name: "npm-audit-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// 注册工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "audit_project",
        description:
          "运行 npm audit 安全审计npm依赖。传入项目的本地绝对路径或 package.json 的 raw 链接，返回包含审计结果和漏洞详情的 Markdown 报告。",
        inputSchema: {
          type: "object",
          properties: {
            targetPath: {
              type: "string",
              description: "需要审计的本地绝对路径或远程 package.json 链接",
            },
          },
          required: ["targetPath"],
        },
      },
    ],
  };
});

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "audit_project") {
    const { targetPath } = request.params.arguments;

    // MCP 模式下，不输出文件，不打印常规日志（避免干扰 stdio 协议）
    const mcp = new NpmAuditMCP({
      writeFiles: false,
      silent: true,
    });

    try {
      const source = targetPath.startsWith("http")
        ? targetPath
        : path.resolve(process.cwd(), targetPath);
      const result = await mcp.start(source);

      return {
        content: [
          {
            type: "text",
            text: result.markdown,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `审计执行失败: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  throw new Error(`未知工具: ${request.params.name}`);
});

// 启动服务器
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("NPM Audit MCP Server running on stdio");
}

run().catch((error) => {
  console.error("启动 MCP Server 失败:", error);
  process.exit(1);
});
