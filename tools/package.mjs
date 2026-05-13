// 发布打包脚本
// 用法: node tools/package.mjs
//
// 流程:
//   1. 重新加密 dictionary.source.json -> data/dictionary.enc.json
//   2. 复制扩展文件到 dist/xianyu-slang-helper/
//   3. 跳过 tools/ (开发用) 和 dist/, node_modules/, 隐藏文件
//   4. 校验 dist 中不含明文 source
//
// 用户开发期: 直接编辑 tools/dictionary.source.json, 浏览器 chrome://extensions 刷新即生效 (loader 优先读明文).
// 用户发布期: 跑此脚本生成 dist/, 然后压缩 dist/ 上传 Chrome Web Store.

import {
  readFileSync, readdirSync, mkdirSync,
  copyFileSync, rmSync, existsSync, statSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const PKG_NAME = "xianyu-slang-helper";

// 顶层排除目录
const EXCLUDE_TOP = new Set([
  "tools",
  "dist",
  "node_modules",
  ".git",
  ".github",
  ".vscode",
  "store-assets",      // 截图 / listing 文案 / 隐私政策, 不属于扩展运行时
  "screenshots-demo",  // 截图脚手架 (chrome stub + 明文 dict), 不应上传
]);
// 文件名后缀/前缀排除
const isHidden = (n) => n.startsWith(".");

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (isHidden(e.name)) continue;
    const full = join(dir, e.name);
    const rel = relative(ROOT, full);
    const top = rel.split("/")[0];
    if (EXCLUDE_TOP.has(top)) continue;
    if (e.isDirectory()) {
      out.push(...walk(full));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function step(n, total, msg) {
  console.log(`\n[${n}/${total}] ${msg}`);
}

// ============ 1. 加密 ============
step(1, 4, "加密词典");
execSync(`node "${join(__dirname, "encrypt-dict.mjs")}"`, {
  stdio: "inherit",
  cwd: ROOT,
});

// ============ 2. 校验 manifest / source 版本对齐 ============
step(2, 4, "校验版本");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const source = JSON.parse(readFileSync(join(__dirname, "dictionary.source.json"), "utf8"));
if (manifest.version !== source.version) {
  console.error(
    `❌ manifest.version (${manifest.version}) 与 source.version (${source.version}) 不一致`
  );
  console.error(`   请在两个文件里同步 version`);
  process.exit(1);
}
console.log(`  manifest: v${manifest.version}`);
console.log(`  source  : v${source.version}`);
console.log(`  ✓ 版本一致`);

// ============ 3. 复制到 dist ============
step(3, 4, "复制文件到 dist/");
if (existsSync(DIST)) rmSync(DIST, { recursive: true });
const pkgDir = join(DIST, PKG_NAME);
mkdirSync(pkgDir, { recursive: true });

const files = walk(ROOT);
let totalBytes = 0;
for (const f of files) {
  const rel = relative(ROOT, f);
  const dest = join(pkgDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(f, dest);
  totalBytes += statSync(f).size;
}
console.log(`  复制 ${files.length} 个文件 (${(totalBytes / 1024).toFixed(1)} KB)`);

// ============ 4. 校验 dist 内容 ============
step(4, 4, "安全检查");
const distFiles = walk(pkgDir).map((f) => relative(pkgDir, f));

// 4a. tools/ 不应出现在 dist
const leakedTools = distFiles.filter((f) => f.startsWith("tools/") || f.startsWith("tools\\"));
if (leakedTools.length > 0) {
  console.error("❌ dist/ 中残留 tools/ 文件: " + leakedTools.join(", "));
  process.exit(1);
}

// 4b. 不应有 source.json
const leakedSource = distFiles.filter((f) => f.includes("dictionary.source.json"));
if (leakedSource.length > 0) {
  console.error("❌ dist/ 中残留 source.json: " + leakedSource.join(", "));
  process.exit(1);
}

// 4c. 抽样 grep: 几个高频黑话不应出现在任何 dist 文件里
const SAMPLE_KEYWORDS = ["茅台", "iPhone", "猫腻", "屠龙刀", "白菜价", "走咸鱼"];
const leakedKeywords = [];
for (const rel of distFiles) {
  if (rel.endsWith(".png") || rel.endsWith(".jpg") || rel.endsWith(".ico")) continue;
  const content = readFileSync(join(pkgDir, rel), "utf8");
  for (const kw of SAMPLE_KEYWORDS) {
    if (content.includes(kw)) {
      leakedKeywords.push({ rel, kw });
    }
  }
}
if (leakedKeywords.length > 0) {
  console.error("❌ dist/ 文件含明文词条:");
  for (const { rel, kw } of leakedKeywords) {
    console.error(`   ${rel} <- "${kw}"`);
  }
  process.exit(1);
}

console.log(`  ✓ 无 tools/ 残留`);
console.log(`  ✓ 无 source.json 残留`);
console.log(`  ✓ 抽样 ${SAMPLE_KEYWORDS.length} 个关键词均无明文泄漏`);

// ============ 完成 ============
console.log(`\n✅ 打包完成: ${pkgDir}`);
console.log(`   版本: v${manifest.version}`);
console.log(`   文件: ${files.length}`);
console.log(`   词条: ${source.categories.reduce(
  (s, c) => s + Object.keys(c.entries).length, 0
)} (跨 ${source.categories.length} 分类)`);
console.log(`\n下一步: cd dist && zip -r ${PKG_NAME}-v${manifest.version}.zip ${PKG_NAME}`);
