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
  constructor() {
    // 临时工作目录（系统临时目录下生成）
    this.tempDir = path.join(os.tmpdir(), `npm-audit-${Date.now()}`);
    // 结果输出文件
    this.resultFile = path.join(process.cwd(), "npm-audit-result.md");
  }

  /**
   * 步骤1：创建临时工作目录
   */
  async createTempDir() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
      console.log(`✅ 临时目录创建成功：${this.tempDir}`);
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
      console.log(`🔗 正在拉取远程 package.json：${source}`);
      const response = await axios.get(source);
      packageJsonContent = response.data;
    } else {
      console.log(`📂 正在读取本地 package.json：${source}`);
      const filePath = path.resolve(source, "package.json");
      const content = await fs.readFile(filePath, "utf8");
      packageJsonContent = JSON.parse(content);
    }

    // 校验 package.json 合法性
    if (!packageJsonContent.name || !packageJsonContent.version) {
      throw new Error("package.json 格式不合法，缺少 name/version 字段");
    }

    console.log("✅ package.json 解析完成");
    return packageJsonContent;
  }

  /**
   * 步骤3：生成 package-lock.json
   * @param {object} packageJson 解析后的 package.json 对象
   */
  async generateLockFile(packageJson) {
    try {
      // 写入 package.json 到临时目录
      const pkgPath = path.join(this.tempDir, "package.json");
      await fs.writeFile(pkgPath, JSON.stringify(packageJson, null, 2), "utf8");

      // 执行 npm install --package-lock-only 生成锁文件（不安装依赖）
      console.log("🔧 正在生成 package-lock.json...");
      execSync("npm install --package-lock-only", {
        cwd: this.tempDir,
        stdio: "ignore",
        timeout: 60000,
      });

      console.log("✅ 锁文件生成成功");
    } catch (error) {
      throw new Error(`生成锁文件失败：${error.message}`);
    }
  }

  /**
   * 步骤4：执行 npm audit 安全审计并规范化结果
   */
  async runSecurityAudit() {
    try {
      console.log("🔍 正在执行 npm audit 安全审计...");
      // 执行 npm audit --json 获取 JSON 格式结果
      const auditResult = execSync("npm audit --json", {
        cwd: this.tempDir,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120000,
      });

      // 解析 JSON 结果
      const parsedResult = JSON.parse(auditResult.toString());

      // 规范化结果
      const normalizedResult = this.normalizeAuditResult(parsedResult);
      console.log("✅ 安全审计完成，结果已规范化");
      return normalizedResult;
    } catch (error) {
      // npm audit 发现漏洞时会退出码非0，需要捕获并解析结果
      if (error.stdout) {
        const parsedResult = JSON.parse(error.stdout.toString());
        return this.normalizeAuditResult(parsedResult);
      }
      throw new Error(`安全审计失败：${error.message}`);
    }
  }

  /**
   * 规范化审计结果（提取核心信息）
   */
  normalizeAuditResult(result) {
    return {
      projectName: result.metadata?.projectName || "未知项目",
      auditTime: new Date().toLocaleString(),
      summary: {
        critical: result.metadata?.vulnerabilities?.critical || 0,
        high: result.metadata?.vulnerabilities?.high || 0,
        moderate: result.metadata?.vulnerabilities?.moderate || 0,
        low: result.metadata?.vulnerabilities?.low || 0,
        total: result.metadata?.vulnerabilities?.total || 0,
      },
      vulnerabilities: Object.values(result.vulnerabilities || {}).map(
        (item) => ({
          name: item.name,
          severity: item.severity,
          version: item.version,
          title: item.title,
          url: item.url,
          fixAvailable: item.fixAvailable ? "是" : "否",
        }),
      ),
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
      markdown += `| 依赖包 | 漏洞等级 | 版本 | 漏洞描述 | 修复方案 |\n| ------ | -------- | ---- | -------- | -------- |\n`;
      vulnerabilities.forEach((item) => {
        markdown += `| ${item.name} | ${item.severity} | ${item.version} | [${item.title}](${item.url}) | ${item.fixAvailable} |\n`;
      });
    } else {
      markdown += `✅ **未发现任何依赖安全漏洞**\n\n`;
    }

    // 写入文件
    await fs.writeFile(this.resultFile, markdown, "utf8");
    console.log(`📄 审计报告已生成：${this.resultFile}`);
  }

  /**
   * 步骤6：删除临时工作目录
   */
  deleteTempDir() {
    try {
      rimrafSync(this.tempDir);
      console.log(`🗑️ 临时目录已删除：${this.tempDir}`);
    } catch (error) {
      console.warn(`⚠️ 临时目录删除失败：${error.message}`);
    }
  }

  /**
   * 主执行流程
   * @param {string} source 本地工程路径 / 远程 package.json 链接
   */
  async start(source) {
    try {
      console.log("🚀 启动 NPM 安全审计 MCP...\n");

      // 1. 创建临时目录
      await this.createTempDir();

      // 2. 解析工程
      const packageJson = await this.parseProject(source);

      // 3. 生成锁文件
      await this.generateLockFile(packageJson);

      // 4. 安全审计
      const auditResult = await this.runSecurityAudit();

      // 5. 渲染报告
      await this.renderMarkdownReport(auditResult);

      console.log("\n🎉 安全审计全流程执行完成！");
    } catch (error) {
      console.error(`❌ 执行失败：${error.message}`);
    } finally {
      // 6. 无论成功失败，都清理临时目录
      this.deleteTempDir();
    }
  }
}

// ============== 启动程序 ==============
const mcp = new NpmAuditMCP();

// 使用方式1：审计本地项目（传入项目根目录）
mcp.start(process.cwd());

// 使用方式2：审计远程项目（传入 GitHub raw 链接）
// mcp.start('https://raw.githubusercontent.com/xxx/xxx/main/package.json');
