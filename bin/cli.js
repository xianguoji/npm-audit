#!/usr/bin/env node

import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import NpmAuditMCP from "../index.js";

const args = process.argv.slice(2);
const targetPath = args[0] || process.cwd();

// CLI 模式下，默认输出文件到当前执行命令的目录，且打印日志
const mcp = new NpmAuditMCP({
  outputDir: process.cwd(),
  writeFiles: true,
  silent: false,
});

// 解析为绝对路径（如果是本地路径的话）
const source = targetPath.startsWith("http") ? targetPath : path.resolve(process.cwd(), targetPath);

function openInBrowser(filePath) {
  if (!process.stdout.isTTY) return;
  if (!filePath) return;
  if (!fs.existsSync(filePath)) return;

  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const cmdArgs =
    platform === "win32" ? ["/c", "start", "", filePath] : [filePath];

  const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
  child.unref();
}

mcp
  .start(source)
  .then(() => openInBrowser(mcp.htmlResultFile))
  .catch((err) => {
    console.error("CLI 执行失败:", err);
    process.exit(1);
  });
