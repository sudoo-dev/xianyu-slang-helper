// 从 search-sharp.com 抓取众包暗语, 质量/政策过滤后并入本项目词典
// 用法:
//   node tools/fetch-searchsharp.mjs                 # 预览: 只抓取+过滤+暂存, 不改 source
//   node tools/fetch-searchsharp.mjs --apply         # 把过滤后的新词并入 dictionary.source.json
//   node tools/fetch-searchsharp.mjs --max-pages 2   # 只抓前 2 页 (调试/限流)
//   node tools/fetch-searchsharp.mjs --min-score 3   # 提高保留门槛 (净赞数, 默认 1)
//
// 设计:
//   - search-sharp.com 是一个 React SPA, 数据来自公开只读 API:
//       GET /api/products?q=&sort=new&offset=<N>  ->  { products:[{name, aliases[], keywords[{text,up,down}]}], hasMore }
//     offset 以"记录"为单位 (页大小 20), hasMore=false 时停止.
//   - 它是众包站点 (投票 / 待审核 / Google 登录提交), 所以数据里混着玩梗与违规词,
//     不能直接照搬. 本脚本做三层过滤: 质量(净赞) -> 政策(违规黑名单) -> 去重(本地已有).
//   - 默认只"暂存"到 tools/searchsharp.staged.json + 打印报告, 不动 source;
//     人工/Claude 审过报告后再 --apply 或手工归类. (政策命中项永远不会被 --apply 写入.)
//
// 数据流: search-sharp.com/api --(抓取)--> 归一化 --(过滤)--> staged.json --(--apply)--> dictionary.source.json

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SOURCE_PATH = join(ROOT, "tools", "dictionary.source.json");
const STAGED_PATH = join(ROOT, "tools", "searchsharp.staged.json");

const BASE = "https://search-sharp.com";
const PAGE_SIZE = 20;
const REQUEST_DELAY_MS = 400; // 礼貌限流: 站点在 Cloudflare 后面, 别打太猛

// 投放到 source.json 的"新概念"落脚分类 (SearchSharp 没有可用分类, 全是"用户添加").
// 先统一进这个分类, 之后可在 source.json 内手工细分到 15 个正式分类。
const COMMUNITY_CATEGORY = { id: "community", name: "社区补充", icon: "🌐" };

// 保持 source.json 的手写格式 (对象多行/2空格, 字符串数组单行 ["a", "b"]),
// 这样 --apply 后 git diff 只显示真正新增的行, 而不是整文件重排.
function stringifyDict(obj) {
  const ser = (v, ind) => {
    const pad = "  ".repeat(ind), pad1 = "  ".repeat(ind + 1);
    if (Array.isArray(v)) {
      if (v.every((x) => x === null || typeof x !== "object"))
        return "[" + v.map((x) => JSON.stringify(x)).join(", ") + "]";
      return "[\n" + v.map((x) => pad1 + ser(x, ind + 1)).join(",\n") + "\n" + pad + "]";
    }
    if (v && typeof v === "object") {
      const ks = Object.keys(v);
      if (!ks.length) return "{}";
      return "{\n" + ks.map((k) => pad1 + JSON.stringify(k) + ": " + ser(v[k], ind + 1)).join(",\n") + "\n" + pad + "}";
    }
    return JSON.stringify(v);
  };
  return ser(obj, 0) + "\n";
}

// ============ CLI 参数 ============
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagVal = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APPLY = hasFlag("--apply");
const MAX_PAGES = parseInt(flagVal("--max-pages", "0"), 10) || Infinity;
const MIN_SCORE = parseInt(flagVal("--min-score", "1"), 10);

// ============ 政策黑名单 ============
// Chrome Web Store 内容政策 + 项目已知敏感主题 (见 tools/dictionary.grey-area.json).
// 命中产品名或任一变体, 整条产品被排除并单列到报告, 由人决定是否手工收录.
// 取向: 宁可错杀 — 漏网的违规词进了发布包代价远大于误杀一个正经词.
const POLICY_RULES = [
  { label: "色情/特殊服务", re: /色情|约炮|约啪|裸聊|援交|楼凤|小姐|性服务|一夜情|同城约|上门服务|特殊服务|可骑|骑\s*\d|贴身衣物|私密物品|原味|穿过的|esc(?:ort)?|啪啪/i },
  { label: "毒品/管制药", re: /大麻|可卡因|冰毒|摇头丸|迷药|listen水|听话水|笑气|飞叶子|嗑药|kush|weed|\bmdma\b|\blsd\b|特殊货|外烟特殊/i },
  { label: "武器弹药", re: /枪支|手枪|步枪|弹药|子弹|管制刀具|甩棍|电棍|弩箭|爆炸物/i },
  { label: "赌博", re: /赌博|博彩|私彩|六合彩|外围盘|时时彩/i },
  { label: "外挂/黑产/盗号", re: /外挂|辅助器|破解器|盗号|社工库|黑客服务|四件套|洗钱|发卡网|秒u|跑分/i },
  { label: "涉未成年/年龄硬币", re: /未成年|萝莉|幼\s*女|稚嫩|硬币年份|\d{2}年硬币|年份硬币/i },
];

function policyHit(tokens) {
  for (const rule of POLICY_RULES) {
    if (tokens.some((t) => rule.re.test(t))) return rule.label;
  }
  return null;
}

// ============ 抓取 ============
async function fetchAll() {
  if (typeof fetch !== "function") {
    throw new Error("需要 Node 18+ (内置 fetch)");
  }
  const products = [];
  const seenIds = new Set(); // 去重兜底, 防 offset 抖动
  let offset = 0;
  let page = 0;
  while (page < MAX_PAGES) {
    const url = `${BASE}/api/products?q=&sort=new&offset=${offset}`;
    const resp = await fetch(url, { headers: { accept: "application/json" } });
    if (!resp.ok) throw new Error(`抓取失败 HTTP ${resp.status} @ offset=${offset}`);
    const data = await resp.json();
    const batch = Array.isArray(data.products) ? data.products : [];
    let added = 0;
    for (const p of batch) {
      if (p && p.id != null && !seenIds.has(p.id)) {
        seenIds.add(p.id);
        products.push(p);
        added++;
      }
    }
    page++;
    process.stdout.write(`\r  已抓取 ${products.length} 条 (第 ${page} 页)...`);
    if (!data.hasMore || batch.length === 0) break;
    offset += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  }
  process.stdout.write("\n");
  return products;
}

// 把一条 SearchSharp 产品的变体收集出来 (aliases + keywords), 应用质量门槛.
// keyword 形如 {text, up, down}; alias 可能是字符串或 {text,...}. 二者都并入"暗语".
function collectVariants(product) {
  const out = [];
  const lowScore = [];
  const pushVariant = (text, up, down) => {
    const t = String(text || "").trim();
    if (!t) return;
    const score = (up || 0) - (down || 0);
    if (up == null && down == null) {
      out.push({ text: t, score: null }); // alias 无投票 -> 视为已审, 保留
    } else if (score >= MIN_SCORE && (up || 0) > (down || 0)) {
      out.push({ text: t, score });
    } else {
      lowScore.push({ text: t, score });
    }
  };
  for (const a of product.aliases || []) {
    if (typeof a === "string") pushVariant(a, null, null);
    else pushVariant(a.text, a.up, a.down);
  }
  for (const k of product.keywords || []) pushVariant(k.text, k.up, k.down);
  return { variants: out, lowScore };
}

// ============ 与本地词典对比, 分类暂存 ============
function buildLocalIndex(source) {
  const normalIndex = new Map(); // lower(normal) -> {catId, normalKey}
  const known = new Set(); // lower(所有 normal + 所有 slang)
  for (const cat of source.categories) {
    for (const [normal, slangs] of Object.entries(cat.entries)) {
      normalIndex.set(normal.toLowerCase(), { catId: cat.id, normalKey: normal });
      known.add(normal.toLowerCase());
      for (const s of slangs) known.add(String(s).toLowerCase());
    }
  }
  return { normalIndex, known };
}

function categorize(products, source) {
  const { normalIndex, known } = buildLocalIndex(source);
  const newEntries = [];
  const newVariantsForExisting = [];
  const filteredForPolicy = [];
  let droppedLowScore = 0;
  let alreadyHave = 0;

  for (const p of products) {
    const name = String(p.name || "").trim();
    if (!name) continue;
    const { variants, lowScore } = collectVariants(p);
    droppedLowScore += lowScore.length;

    // 政策检查: 产品名 + 全部变体 (含被低分淘汰的, 以免漏判)
    const allTokens = [name, ...variants.map((v) => v.text), ...lowScore.map((v) => v.text)];
    const hit = policyHit(allTokens);
    if (hit) {
      filteredForPolicy.push({ name, reason: hit, variants: variants.map((v) => v.text) });
      continue;
    }

    // 只保留本地还没有的变体
    const fresh = variants.filter((v) => !known.has(v.text.toLowerCase()));

    const match = normalIndex.get(name.toLowerCase());
    if (match) {
      if (fresh.length) {
        newVariantsForExisting.push({
          existingNormal: match.normalKey,
          category: match.catId,
          newVariants: fresh,
        });
      } else {
        alreadyHave++;
      }
    } else if (fresh.length) {
      // 全新概念: 名字本地没有, 且至少有一个新变体才值得收
      newEntries.push({ name, ssCategory: p.category || null, variants: fresh });
    } else {
      // 名字是新的, 但变体本地都已有 -> 没有新信息, 跳过
      alreadyHave++;
    }
  }

  return {
    newEntries,
    newVariantsForExisting,
    filteredForPolicy,
    stats: {
      productsFetched: products.length,
      newEntries: newEntries.length,
      newVariantsForExisting: newVariantsForExisting.length,
      variantsAddedToExisting: newVariantsForExisting.reduce((s, e) => s + e.newVariants.length, 0),
      productsFilteredPolicy: filteredForPolicy.length,
      variantsDroppedLowScore: droppedLowScore,
      productsAlreadyHave: alreadyHave,
    },
  };
}

// ============ --apply: 写回 source.json ============
function applyToSource(source, result) {
  // 1) 给已有词条补充变体 (并集去重, 保序)
  for (const item of result.newVariantsForExisting) {
    const cat = source.categories.find((c) => c.id === item.category);
    if (!cat) continue;
    const arr = cat.entries[item.existingNormal];
    if (!arr) continue;
    const seen = new Set(arr.map((s) => s.toLowerCase()));
    for (const v of item.newVariants) {
      if (!seen.has(v.text.toLowerCase())) {
        arr.push(v.text);
        seen.add(v.text.toLowerCase());
      }
    }
  }

  // 2) 新概念统一进"社区补充"分类 (之后可手工细分)
  if (result.newEntries.length) {
    let community = source.categories.find((c) => c.id === COMMUNITY_CATEGORY.id);
    if (!community) {
      community = { ...COMMUNITY_CATEGORY, entries: {} };
      source.categories.push(community);
    }
    for (const e of result.newEntries) {
      const existing = community.entries[e.name] || [];
      const seen = new Set(existing.map((s) => s.toLowerCase()));
      for (const v of e.variants) {
        if (!seen.has(v.text.toLowerCase())) {
          existing.push(v.text);
          seen.add(v.text.toLowerCase());
        }
      }
      if (existing.length) community.entries[e.name] = existing;
    }
  }

  // 3) 更新日期 (version 不动 — 发布前由人工显式 bump, 保持 manifest 同步)
  source.updatedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(SOURCE_PATH, stringifyDict(source), "utf8");
}

// ============ 报告 ============
function printReport(result, applied) {
  const s = result.stats;
  console.log("\n================ SearchSharp 同步报告 ================");
  console.log(`抓取产品总数      : ${s.productsFetched}`);
  console.log(`新概念 (待归类)    : ${s.newEntries}`);
  console.log(`给已有词条补变体    : ${s.newVariantsForExisting} 个词条 / ${s.variantsAddedToExisting} 个变体`);
  console.log(`本地已收录(跳过)   : ${s.productsAlreadyHave}`);
  console.log(`质量过滤(低赞丢弃)  : ${s.variantsDroppedLowScore} 个变体  (门槛 净赞≥${MIN_SCORE})`);
  console.log(`⚠️  政策过滤(已排除) : ${s.productsFilteredPolicy} 个产品  (绝不写入发布包)`);

  if (result.filteredForPolicy.length) {
    console.log("\n  被政策黑名单排除的产品 (人工复核, 默认不收录):");
    for (const f of result.filteredForPolicy.slice(0, 30)) {
      console.log(`    [${f.reason}] ${f.name}  ${f.variants.slice(0, 4).join("、")}`);
    }
    if (result.filteredForPolicy.length > 30) {
      console.log(`    ... 其余 ${result.filteredForPolicy.length - 30} 个见 staged.json`);
    }
  }

  if (result.newVariantsForExisting.length) {
    console.log("\n  给已有词条新增的变体 (样例):");
    for (const e of result.newVariantsForExisting.slice(0, 12)) {
      console.log(`    ${e.existingNormal} (${e.category}) += ${e.newVariants.map((v) => v.text).join("、")}`);
    }
  }

  if (result.newEntries.length) {
    console.log("\n  全新概念 (样例, --apply 后进入「社区补充」分类待细分):");
    for (const e of result.newEntries.slice(0, 15)) {
      console.log(`    ${e.name}  →  ${e.variants.map((v) => v.text).slice(0, 6).join("、")}`);
    }
    if (result.newEntries.length > 15) {
      console.log(`    ... 其余 ${result.newEntries.length - 15} 个见 staged.json`);
    }
  }

  console.log("\n=====================================================");
  if (applied) {
    console.log("✅ 已写入 tools/dictionary.source.json");
    console.log("   下一步: git diff 复核 → (发布则 bump manifest+source 的 version) → node tools/package.mjs");
  } else {
    console.log(`📋 已暂存到 ${STAGED_PATH} (未改动 source)`);
    console.log("   复核无误后, 重跑加 --apply 写入词典; 或据 staged.json 手工归类。");
  }
}

// ============ 主流程 ============
async function main() {
  if (!existsSync(SOURCE_PATH)) {
    throw new Error(`找不到 ${SOURCE_PATH} — 请在项目根目录运行`);
  }
  const source = JSON.parse(readFileSync(SOURCE_PATH, "utf8"));

  console.log(`抓取 ${BASE} ...`);
  const products = await fetchAll();
  const result = categorize(products, source);

  // 暂存产物 (无论是否 apply 都写, 便于审计/手工归类)
  const staged = {
    fetchedAt: new Date().toISOString(),
    source: BASE,
    params: { minScore: MIN_SCORE, maxPages: MAX_PAGES === Infinity ? null : MAX_PAGES },
    stats: result.stats,
    newVariantsForExisting: result.newVariantsForExisting,
    newEntries: result.newEntries,
    filteredForPolicy: result.filteredForPolicy,
  };
  writeFileSync(STAGED_PATH, JSON.stringify(staged, null, 2) + "\n", "utf8");

  if (APPLY) applyToSource(source, result);
  printReport(result, APPLY);
}

main().catch((err) => {
  console.error("\n❌ " + (err.stack || err.message || err));
  process.exit(1);
});
