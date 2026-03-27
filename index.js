import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import axios from "axios";
import { rimrafSync } from "rimraf";

/**
 * NPM 安全审计 MCP 主类
 * 功能：临时目录管理、工程解析、锁文件生成、安全审计、结果渲染、目录清理
 */
class NpmAuditMCP {
  constructor(options = {}) {
    this.outputDir = options.outputDir || process.cwd();
    this.writeFiles = options.writeFiles !== false;
    this.silent = options.silent === true;
    this.projectName = options.projectName;

    // 生成时间戳用于区分结果文件，格式如: 2026-03-27_10-30-00
    const timestamp = new Date()
      .toISOString()
      .replace(/T/, "_")
      .replace(/:/g, "-")
      .split(".")[0];

    // 临时工作目录（系统临时目录下生成）
    this.tempDir = path.join(os.tmpdir(), `npm-audit-${Date.now()}`);
    // 结果输出文件
    this.resultFile = path.join(
      this.outputDir,
      `npm-audit-result-${timestamp}.md`,
    );
    this.htmlResultFile = path.join(
      this.outputDir,
      `npm-audit-result-${timestamp}.html`,
    );
  }

  log(message) {
    if (!this.silent) {
      console.log(message);
    }
  }

  warn(message) {
    if (!this.silent) {
      console.warn(message);
    }
  }

  error(message) {
    if (!this.silent) {
      console.error(message);
    }
  }

  /**
   * 步骤1：创建临时工作目录
   */
  async createTempDir() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
      this.log(`✅ 临时目录创建成功：${this.tempDir}`);
    } catch (error) {
      throw new Error(`创建临时目录失败：${error.message}`);
    }
  }

  /**
   * 步骤2：解析工程（本地/远程），获取 package.json
   * @param {string} source 本地路径/远程仓库 raw 链接
   */
  async parseProject(source) {
    let packageJsonContent;

    // 判断是远程链接还是本地路径
    if (source.startsWith("http")) {
      this.log(`🔗 正在拉取远程 package.json：${source}`);
      const response = await axios.get(source);
      packageJsonContent = response.data;
    } else {
      this.log(`📂 正在读取本地 package.json：${source}`);
      const filePath = path.resolve(source, "package.json");
      const content = await fs.readFile(filePath, "utf8");
      packageJsonContent = JSON.parse(content);
    }

    // 校验 package.json 合法性
    if (!packageJsonContent.name || !packageJsonContent.version) {
      throw new Error("package.json 格式不合法，缺少 name/version 字段");
    }

    this.log("✅ package.json 解析完成");
    return packageJsonContent;
  }

  /**
   * 步骤3：生成 package-lock.json
   * @param {object} packageJson 解析后的 package.json 对象
   * @param {string} source 本地工程路径，用于复制 .npmrc
   */
  async generateLockFile(packageJson, source) {
    try {
      // 写入 package.json 到临时目录
      const pkgPath = path.join(this.tempDir, "package.json");
      await fs.writeFile(pkgPath, JSON.stringify(packageJson, null, 2), "utf8");

      // 如果是本地路径，尝试复制 .npmrc 到临时目录，确保能够读取私有源或特殊配置
      if (!source.startsWith("http")) {
        try {
          const npmrcPath = path.resolve(source, ".npmrc");
          const npmrcContent = await fs.readFile(npmrcPath, "utf8");
          await fs.writeFile(
            path.join(this.tempDir, ".npmrc"),
            npmrcContent,
            "utf8",
          );
        } catch (e) {
          // 如果没有 .npmrc 或者读取失败，忽略此步骤
        }
      }

      // 临时移除私有依赖（以 @oray/ 开头的包），避免找不到包导致生成 lockfile 失败
      if (packageJson.dependencies) {
        for (const dep in packageJson.dependencies) {
          if (dep.startsWith("@oray/")) {
            delete packageJson.dependencies[dep];
          }
        }
      }
      if (packageJson.devDependencies) {
        for (const dep in packageJson.devDependencies) {
          if (dep.startsWith("@oray/")) {
            delete packageJson.devDependencies[dep];
          }
        }
      }
      await fs.writeFile(pkgPath, JSON.stringify(packageJson, null, 2), "utf8");

      // 执行 npm install --package-lock-only 生成锁文件（不安装依赖）
      this.log("🔧 正在生成 package-lock.json...");

      // 使用用户的原工程目录的 npmrc 或者显式指定 registry，并加上 --legacy-peer-deps 避免依赖冲突
      execSync(
        "npm install --package-lock-only --legacy-peer-deps --no-audit",
        {
          cwd: this.tempDir,
          stdio: "pipe", // 改为 pipe 以便在出错时捕获输出
          timeout: 60000,
        },
      );

      this.log("✅ 锁文件生成成功");
    } catch (error) {
      let errorMsg = error.message;
      if (error.stderr || error.stdout) {
        errorMsg += `\nOutput: ${error.stderr?.toString() || ""} ${error.stdout?.toString() || ""}`;
      }
      throw new Error(`生成锁文件失败：${errorMsg}`);
    }
  }

  /**
   * 步骤4：执行 npm audit 安全审计并规范化结果
   */
  async runSecurityAudit() {
    try {
      this.log("🔍 正在执行 npm audit 安全审计...");
      // 执行 npm audit --json 获取 JSON 格式结果，强制使用官方源避免部分镜像源不支持 audit
      const auditResult = execSync(
        "npm audit --json --registry=https://registry.npmjs.org/",
        {
          cwd: this.tempDir,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120000,
        },
      );

      // 解析 JSON 结果
      const parsedResult = JSON.parse(auditResult.toString());

      // 规范化结果
      const normalizedResult = this.normalizeAuditResult(parsedResult);
      this.log("✅ 安全审计完成，结果已规范化");
      return normalizedResult;
    } catch (error) {
      // npm audit 发现漏洞时会退出码非0，需要捕获并解析结果
      if (error.stdout) {
        try {
          const parsedResult = JSON.parse(error.stdout.toString());
          return this.normalizeAuditResult(parsedResult);
        } catch (parseError) {
          if (parseError.message.includes("NPM 审计请求失败")) {
            throw parseError;
          }
          // 如果解析失败，继续抛出原来的 error
        }
      }
      throw new Error(`安全审计失败：${error.message}`);
    }
  }

  /**
   * 规范化审计结果（提取核心信息，兼容 npm v6 和 v7/v8+）
   */
  normalizeAuditResult(result) {
    if (result.error) {
      const errMsg =
        result.error.summary ||
        result.error.message ||
        result.error.code ||
        JSON.stringify(result.error);
      throw new Error(`NPM 审计请求失败: ${errMsg}`);
    }

    // 兼容 npm v6 和 npm v7/v8+ 的 summary 结构
    const metaVulns = result.metadata?.vulnerabilities || {};
    const summary = {
      critical: metaVulns.critical || 0,
      high: metaVulns.high || 0,
      moderate: metaVulns.moderate || 0,
      low: metaVulns.low || 0,
      total:
        metaVulns.total ||
        (metaVulns.critical || 0) +
          (metaVulns.high || 0) +
          (metaVulns.moderate || 0) +
          (metaVulns.low || 0) +
          (metaVulns.info || 0),
    };

    let vulnerabilities = [];

    // 严重程度映射，用于排序 (由高到低)
    const severityMap = {
      critical: 4,
      high: 3,
      moderate: 2,
      low: 1,
      info: 0,
    };

    if (result.vulnerabilities) {
      // npm v7/v8+ 格式
      vulnerabilities = Object.values(result.vulnerabilities).map((item) => ({
        name: item.name,
        severity: item.severity,
        // npm v7+ 的 version 可能在 nodes 里面，这里取 range 作为参考
        version: item.nodes?.[0] || item.range || "未知",
        title: item.via?.[0]?.title || item.name || "依赖存在漏洞",
        url: item.via?.[0]?.url || "",
        fixAvailable: item.fixAvailable ? "是" : "否",
        cause: item.via?.[0]?.title || "暂无详细原因", // npm v7+ 暂用 title 作为原因
        recommendation:
          typeof item.fixAvailable === "object"
            ? `更新到 ${item.fixAvailable.name}@${item.fixAvailable.version}`
            : item.fixAvailable
              ? "可通过 npm audit fix 修复"
              : "暂无直接修复方案，建议手动更新或替换依赖",
      }));
    } else if (result.advisories) {
      // npm v6 格式
      vulnerabilities = Object.values(result.advisories).map((item) => ({
        name: item.module_name,
        severity: item.severity,
        version: item.findings?.[0]?.version || "未知",
        title: item.title,
        url: item.url,
        fixAvailable: item.patched_versions !== "<0.0.0" ? "是" : "否",
        cause: item.overview || "暂无详细原因",
        recommendation: item.recommendation || "暂无修复建议",
      }));
    }

    // 根据漏洞等级排序（由高到低）
    vulnerabilities.sort((a, b) => {
      const scoreA = severityMap[a.severity?.toLowerCase()] || 0;
      const scoreB = severityMap[b.severity?.toLowerCase()] || 0;
      return scoreB - scoreA;
    });

    return {
      projectName:
        result.metadata?.projectName || this.projectName || "未知项目",
      auditTime: new Date().toLocaleString(),
      summary,
      vulnerabilities,
    };
  }

  /**
   * 步骤5：渲染 Markdown 报告并保存
   */
  async renderMarkdownReport(auditResult) {
    const { summary, vulnerabilities, projectName, auditTime } = auditResult;

    // 构建 Markdown 内容
    let markdown = `# 项目依赖安全审计报告\n\n`;
    markdown += `**项目名称**：${projectName}\n\n`;
    markdown += `**审计时间**：${auditTime}\n\n`;
    markdown += `## 漏洞统计\n\n`;
    markdown += `| 漏洞等级 | 数量 |\n| -------- | ---- |\n`;
    markdown += `| 致命(Critical) | ${summary.critical} |\n`;
    markdown += `| 高危(High) | ${summary.high} |\n`;
    markdown += `| 中危(Moderate) | ${summary.moderate} |\n`;
    markdown += `| 低危(Low) | ${summary.low} |\n`;
    markdown += `| **总计** | **${summary.total}** |\n\n`;

    if (vulnerabilities.length > 0) {
      markdown += `## 漏洞详情\n\n`;
      markdown += `| 依赖包 | 漏洞等级 | 版本 | 漏洞描述 | 漏洞原因 | 修复建议 | 是否可自动修复 |\n| ------ | -------- | ---- | -------- | -------- | -------- | -------------- |\n`;
      vulnerabilities.forEach((item) => {
        const cause = item.cause.replace(/\n/g, "<br>");
        const recommendation = item.recommendation.replace(/\n/g, "<br>");
        markdown += `| ${item.name} | ${item.severity} | ${item.version} | [${item.title}](${item.url}) | ${cause} | ${recommendation} | ${item.fixAvailable} |\n`;
      });
    } else {
      markdown += `✅ **未发现任何依赖安全漏洞**\n\n`;
    }

    // 写入文件
    if (this.writeFiles && this.resultFile) {
      await fs.writeFile(this.resultFile, markdown, "utf8");
      this.log(`📄 Markdown 审计报告已生成：${this.resultFile}`);
    }

    return markdown;
  }

  /**
   * 步骤5.1：渲染 HTML 报告并保存
   * @param {object} auditResult 审计结果
   */
  async renderHtmlReport(auditResult) {
    const { summary, vulnerabilities, projectName, auditTime } = auditResult;

    const escapeHtml = (value) =>
      String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    const formatMultiline = (value) =>
      escapeHtml(value).replace(/\n/g, "<br>").replace(/\r/g, "");

    const severityRank = {
      critical: 4,
      high: 3,
      moderate: 2,
      low: 1,
      info: 0,
    };

    const severityText = (sev) => {
      const s = String(sev || "").toLowerCase();
      if (s === "critical") return "致命";
      if (s === "high") return "高危";
      if (s === "moderate") return "中危";
      if (s === "low") return "低危";
      if (s === "info") return "提示";
      return String(sev || "未知");
    };

    const fixed = (url) => {
      const u = String(url || "").trim();
      return u ? u : "about:blank";
    };

    const infoCount = vulnerabilities.filter(
      (v) => String(v.severity || "").toLowerCase() === "info",
    ).length;

    const totalCount =
      summary.total ??
      summary.critical +
        summary.high +
        summary.moderate +
        summary.low +
        infoCount;

    // 构建 HTML 内容
    let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>依赖安全审计报告 - ${escapeHtml(projectName)}</title>
  <style>
    :root {
      --bg: #f6f8fb;
      --card: rgba(255,255,255,0.85);
      --text: #0f172a;
      --muted: #475569;
      --border: rgba(15, 23, 42, 0.10);
      --shadow: 0 10px 30px rgba(2, 6, 23, 0.08);
      --shadow-sm: 0 6px 18px rgba(2, 6, 23, 0.06);
      --ring: 0 0 0 4px rgba(59, 130, 246, 0.20);
      --primary: #2563eb;

      --critical: #b91c1c;
      --high: #dc2626;
      --moderate: #d97706;
      --low: #16a34a;
      --info: #0ea5e9;

      --critical-bg: rgba(185, 28, 28, 0.10);
      --high-bg: rgba(220, 38, 38, 0.10);
      --moderate-bg: rgba(217, 119, 6, 0.12);
      --low-bg: rgba(22, 163, 74, 0.10);
      --info-bg: rgba(14, 165, 233, 0.10);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b1020;
        --card: rgba(15, 23, 42, 0.72);
        --text: #e5e7eb;
        --muted: #94a3b8;
        --border: rgba(148, 163, 184, 0.18);
        --shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
        --shadow-sm: 0 10px 26px rgba(0, 0, 0, 0.28);
        --primary: #60a5fa;

        --critical-bg: rgba(248, 113, 113, 0.16);
        --high-bg: rgba(248, 113, 113, 0.14);
        --moderate-bg: rgba(251, 191, 36, 0.14);
        --low-bg: rgba(34, 197, 94, 0.14);
        --info-bg: rgba(56, 189, 248, 0.14);
      }
    }

    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
      background:
        radial-gradient(1200px 600px at 10% -20%, rgba(37, 99, 235, 0.18), transparent 70%),
        radial-gradient(900px 500px at 95% 10%, rgba(217, 119, 6, 0.10), transparent 60%),
        radial-gradient(900px 500px at 50% 120%, rgba(34, 197, 94, 0.10), transparent 55%),
        var(--bg);
      color: var(--text);
      line-height: 1.55;
    }

    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .container {
      max-width: 1120px;
      margin: 0 auto;
      padding: 28px 18px 60px;
    }

    .header {
      display: flex;
      gap: 18px;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      padding: 18px 18px 16px;
      border: 1px solid var(--border);
      background: var(--card);
      backdrop-filter: blur(10px);
      border-radius: 16px;
      box-shadow: var(--shadow);
    }

    .title {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 260px;
    }

    .title h1 {
      font-size: 18px;
      letter-spacing: 0.2px;
      margin: 0;
    }
    .sub {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 14px;
      color: var(--muted);
      font-size: 13px;
    }
    .sub span { display: inline-flex; gap: 6px; align-items: center; }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: flex-end;
    }

    .search {
      display: flex;
      gap: 10px;
      align-items: center;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(255,255,255,0.6);
      min-width: 260px;
    }
    @media (prefers-color-scheme: dark) {
      .search { background: rgba(15, 23, 42, 0.62); }
    }
    .search input {
      width: 100%;
      border: none;
      outline: none;
      background: transparent;
      color: var(--text);
      font-size: 13px;
    }
    .search input::placeholder { color: rgba(100, 116, 139, 0.9); }

    .filters { display: flex; flex-wrap: wrap; gap: 8px; }

    .chip {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: rgba(255,255,255,0.65);
      font-size: 12px;
      color: var(--text);
      user-select: none;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
    }
    @media (prefers-color-scheme: dark) {
      .chip { background: rgba(15, 23, 42, 0.62); }
    }
    .chip:hover { box-shadow: var(--shadow-sm); }
    .chip[aria-pressed="true"] { box-shadow: var(--ring); border-color: rgba(59, 130, 246, 0.45); }

    .grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 12px;
      margin-top: 14px;
    }

    .card {
      grid-column: span 3;
      border: 1px solid var(--border);
      background: var(--card);
      backdrop-filter: blur(10px);
      border-radius: 16px;
      padding: 14px 14px 12px;
      box-shadow: var(--shadow-sm);
      min-height: 78px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 8px;
    }

    @media (max-width: 980px) {
      .card { grid-column: span 6; }
    }
    @media (max-width: 560px) {
      .card { grid-column: span 12; }
      .search { min-width: 0; width: 100%; }
    }

    .card .k { color: var(--muted); font-size: 12px; }
    .card .v { font-size: 22px; font-weight: 700; letter-spacing: 0.2px; }
    .card .hint { font-size: 12px; color: var(--muted); }

    .k-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid var(--border);
      white-space: nowrap;
    }
    .badge-critical { color: var(--critical); background: var(--critical-bg); border-color: rgba(185, 28, 28, 0.25); }
    .badge-high { color: var(--high); background: var(--high-bg); border-color: rgba(220, 38, 38, 0.22); }
    .badge-moderate { color: var(--moderate); background: var(--moderate-bg); border-color: rgba(217, 119, 6, 0.24); }
    .badge-low { color: var(--low); background: var(--low-bg); border-color: rgba(22, 163, 74, 0.24); }
    .badge-info { color: var(--info); background: var(--info-bg); border-color: rgba(14, 165, 233, 0.22); }

    .section {
      margin-top: 16px;
      border: 1px solid var(--border);
      background: var(--card);
      backdrop-filter: blur(10px);
      border-radius: 16px;
      box-shadow: var(--shadow-sm);
      overflow: hidden;
    }

    .section-hd {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
    }

    .section-hd h2 { font-size: 14px; margin: 0; letter-spacing: 0.2px; }
    .section-hd .meta { font-size: 12px; color: var(--muted); }

    .table-wrap { width: 100%; overflow: auto; }

    table { width: 100%; border-collapse: separate; border-spacing: 0; min-width: 860px; }
    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: rgba(255,255,255,0.92);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
      color: var(--muted);
      font-size: 12px;
      text-transform: none;
      letter-spacing: 0.3px;
    }
    @media (prefers-color-scheme: dark) {
      thead th { background: rgba(15, 23, 42, 0.86); }
    }

    th, td { padding: 12px 14px; text-align: left; vertical-align: top; }
    tbody tr { border-bottom: 1px solid var(--border); }
    tbody tr:nth-child(2n) td { background: rgba(2, 6, 23, 0.02); }
    @media (prefers-color-scheme: dark) {
      tbody tr:nth-child(2n) td { background: rgba(226, 232, 240, 0.04); }
    }
    tbody tr:hover td { background: rgba(37, 99, 235, 0.06); }
    @media (prefers-color-scheme: dark) {
      tbody tr:hover td { background: rgba(96, 165, 250, 0.10); }
    }

    .pkg { font-weight: 700; }
    .title-link { display: inline-block; max-width: 560px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }

    details { margin-top: 10px; }
    details summary {
      cursor: pointer;
      user-select: none;
      color: var(--primary);
      font-size: 12px;
      list-style: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    details summary::-webkit-details-marker { display: none; }
    details[open] summary { text-decoration: underline; }

    .detail-box {
      margin-top: 10px;
      padding: 12px 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(255,255,255,0.55);
      color: var(--text);
    }
    @media (prefers-color-scheme: dark) {
      .detail-box { background: rgba(15, 23, 42, 0.58); }
    }
    .detail-box .h { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    .detail-box .b { font-size: 12px; color: var(--text); }
    .detail-box .b + .h { margin-top: 12px; }

    .empty {
      padding: 18px 16px;
      color: var(--muted);
      font-size: 13px;
    }

    .footer {
      margin-top: 14px;
      color: var(--muted);
      font-size: 12px;
      text-align: center;
    }

    @media print {
      body { background: #fff; }
      .header, .card, .section { box-shadow: none !important; background: #fff !important; backdrop-filter: none !important; }
      .chip, .search { display: none !important; }
      table { min-width: 0 !important; }
      thead th { position: static !important; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">
        <h1>项目依赖安全审计报告</h1>
        <div class="sub">
          <span>项目：<span class="mono">${escapeHtml(projectName)}</span></span>
          <span>时间：<span class="mono">${escapeHtml(auditTime)}</span></span>
        </div>
      </div>
      <div class="controls">
        <div class="search" role="search">
          <input id="search" type="search" placeholder="搜索依赖 / 漏洞标题…" />
        </div>
        <div class="filters" aria-label="漏洞等级筛选">
          <button class="chip" type="button" data-filter="all" aria-pressed="true"><span>全部</span><span class="mono">${escapeHtml(totalCount)}</span></button>
          <button class="chip" type="button" data-filter="critical" aria-pressed="false"><span>致命</span><span class="mono">${escapeHtml(summary.critical)}</span></button>
          <button class="chip" type="button" data-filter="high" aria-pressed="false"><span>高危</span><span class="mono">${escapeHtml(summary.high)}</span></button>
          <button class="chip" type="button" data-filter="moderate" aria-pressed="false"><span>中危</span><span class="mono">${escapeHtml(summary.moderate)}</span></button>
          <button class="chip" type="button" data-filter="low" aria-pressed="false"><span>低危</span><span class="mono">${escapeHtml(summary.low)}</span></button>
          <button class="chip" type="button" data-filter="info" aria-pressed="false"><span>提示</span><span class="mono">${escapeHtml(infoCount)}</span></button>
        </div>
      </div>
    </div>

    <div class="grid" aria-label="漏洞统计卡片">
      <div class="card">
        <div class="k-row"><div class="k">致命</div><span class="badge badge-critical">Critical</span></div>
        <div class="v">${escapeHtml(summary.critical)}</div>
        <div class="hint">需要立刻处理</div>
      </div>
      <div class="card">
        <div class="k-row"><div class="k">高危</div><span class="badge badge-high">High</span></div>
        <div class="v">${escapeHtml(summary.high)}</div>
        <div class="hint">优先升级或替换</div>
      </div>
      <div class="card">
        <div class="k-row"><div class="k">中危</div><span class="badge badge-moderate">Moderate</span></div>
        <div class="v">${escapeHtml(summary.moderate)}</div>
        <div class="hint">尽快修复，评估影响</div>
      </div>
      <div class="card">
        <div class="k-row"><div class="k">低危</div><span class="badge badge-low">Low</span></div>
        <div class="v">${escapeHtml(summary.low)}</div>
        <div class="hint">可排期处理</div>
      </div>
    </div>

    <div class="section">
      <div class="section-hd">
        <h2>漏洞详情（按严重程度由高到低）</h2>
        <div class="meta">共 <span class="mono" id="visibleCount">${escapeHtml(vulnerabilities.length)}</span> 条</div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width: 180px;">依赖包</th>
              <th style="width: 120px;">等级</th>
              <th style="width: 160px;">版本</th>
              <th>漏洞</th>
              <th style="width: 140px;">修复</th>
            </tr>
          </thead>
          <tbody id="vulnTbody">
`;

    if (vulnerabilities.length > 0) {
      vulnerabilities.forEach((item) => {
        const sev = String(item.severity || "").toLowerCase();
        const sevClass =
          sev === "critical"
            ? "badge-critical"
            : sev === "high"
              ? "badge-high"
              : sev === "moderate"
                ? "badge-moderate"
                : sev === "low"
                  ? "badge-low"
                  : "badge-info";

        const fixText =
          item.fixAvailable === "是" ? "可自动修复" : "需手动处理";
        const fixClass =
          item.fixAvailable === "是" ? "badge-low" : "badge-info";

        const title = escapeHtml(item.title);
        const url = escapeHtml(fixed(item.url));
        const pkg = escapeHtml(item.name);
        const version = escapeHtml(item.version);
        const cause = formatMultiline(item.cause);
        const recommendation = formatMultiline(item.recommendation);
        const searchable = escapeHtml(
          `${item.name} ${item.title} ${item.severity} ${item.version}`.toLowerCase(),
        );
        const rank = severityRank[sev] ?? -1;

        html += `            <tr data-severity="${escapeHtml(sev)}" data-search="${searchable}" data-rank="${escapeHtml(rank)}">
              <td><span class="pkg mono">${pkg}</span></td>
              <td><span class="badge ${sevClass}">${severityText(sev)}<span class="mono">${escapeHtml(String(item.severity || "").toUpperCase())}</span></span></td>
              <td><span class="mono">${version}</span></td>
              <td>
                <a class="title-link" href="${url}" target="_blank" rel="noreferrer">${title}</a>
                <details>
                  <summary>查看原因与修复建议</summary>
                  <div class="detail-box">
                    <div class="h">漏洞原因</div>
                    <div class="b">${cause || "暂无详细原因"}</div>
                    <div class="h">修复建议</div>
                    <div class="b">${recommendation || "暂无修复建议"}</div>
                  </div>
                </details>
              </td>
              <td><span class="badge ${fixClass}">${escapeHtml(fixText)}</span></td>
            </tr>
`;
      });
    } else {
      html += `            <tr><td colspan="5" class="empty">未发现任何依赖安全漏洞</td></tr>\n`;
    }

    html += `          </tbody>
        </table>
      </div>
    </div>

    <div class="footer">由 npm-audit-mcp 生成</div>
  </div>

  <script>
    (function () {
      const tbody = document.getElementById('vulnTbody');
      const search = document.getElementById('search');
      const chips = Array.from(document.querySelectorAll('[data-filter]'));
      const visibleCount = document.getElementById('visibleCount');

      let currentFilter = 'all';
      let query = '';

      function setPressed(target) {
        chips.forEach((btn) => btn.setAttribute('aria-pressed', btn === target ? 'true' : 'false'));
      }

      function apply() {
        const rows = Array.from(tbody.querySelectorAll('tr[data-severity]'));
        let visible = 0;
        rows.forEach((row) => {
          const sev = row.getAttribute('data-severity') || '';
          const hay = row.getAttribute('data-search') || '';
          const passFilter = currentFilter === 'all' ? true : sev === currentFilter;
          const passQuery = !query ? true : hay.includes(query);
          const show = passFilter && passQuery;
          row.style.display = show ? '' : 'none';
          if (show) visible += 1;
        });
        if (visibleCount) visibleCount.textContent = String(visible);
      }

      chips.forEach((btn) => {
        btn.addEventListener('click', () => {
          currentFilter = btn.getAttribute('data-filter') || 'all';
          setPressed(btn);
          apply();
        });
      });

      if (search) {
        search.addEventListener('input', () => {
          query = String(search.value || '').trim().toLowerCase();
          apply();
        });
      }
    })();
  </script>
</body>
</html>`;

    // 写入文件
    if (this.writeFiles) {
      await fs.writeFile(this.htmlResultFile, html, "utf8");
      this.log(`📄 HTML 审计报告已生成：${this.htmlResultFile}`);
    }

    return html;
  }

  /**
   * 步骤6：删除临时工作目录
   */
  deleteTempDir() {
    try {
      rimrafSync(this.tempDir);
      this.log(`🗑️ 临时目录已删除：${this.tempDir}`);
    } catch (error) {
      this.warn(`⚠️ 临时目录删除失败：${error.message}`);
    }
  }

  /**
   * 主执行流程
   * @param {string} source 本地工程路径 / 远程 package.json 链接
   */
  async start(source) {
    try {
      this.log("🚀 启动 NPM 安全审计 MCP...\n");

      // 1. 创建临时目录
      await this.createTempDir();

      // 2. 解析工程
      const packageJson = await this.parseProject(source);
      this.projectName = packageJson.name;

      // 3. 生成锁文件
      await this.generateLockFile(packageJson, source);

      // 4. 安全审计
      const auditResult = await this.runSecurityAudit();

      // 5. 渲染报告
      const markdown = await this.renderMarkdownReport(auditResult);
      const html = await this.renderHtmlReport(auditResult);

      this.log("\n🎉 安全审计全流程执行完成！");
      return { markdown, html, auditResult };
    } catch (error) {
      this.error(`❌ 执行失败：${error.message}`);
      throw error;
    } finally {
      // 6. 无论成功失败，都清理临时目录
      this.deleteTempDir();
    }
  }
}

export default NpmAuditMCP;
