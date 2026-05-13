// 加密词典构建脚本
// 用法: node tools/encrypt-dict.mjs
// 输入: tools/dictionary.source.json (plaintext, 人类可读)
// 输出: data/dictionary.enc.json (AES-GCM 密文 base64)
//
// 加密目的: 防止外部爬虫脚本静态抓取黑话词条列表.
// 注意这不是代码混淆, 解密 key 在 data/crypto.js 是明文常量,
// 审核员可以直接读到. 词典明文源在 tools/dictionary.source.json.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, createCipheriv, pbkdf2Sync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const SRC_PATH = join(ROOT, "tools", "dictionary.source.json");
const OUT_PATH = join(ROOT, "data", "dictionary.enc.json");

// ============ Key derivation ============
// 与 data/crypto.js 中的 PASSPHRASE 完全一致
const PASSPHRASE = "xy-slang|@goofish|_v2_helper";

// 固定 salt: 16 字节, 与 crypto.js 对齐
const SALT_HEX = "9f3a82b1e7c4d605a8f29b1c4d7e0a36";
const SALT = Buffer.from(SALT_HEX, "hex");

const PBKDF2_ITERS = 100_000;
const KEY_LEN = 32; // AES-256

function deriveKey() {
  return pbkdf2Sync(PASSPHRASE, SALT, PBKDF2_ITERS, KEY_LEN, "sha256");
}

// ============ Encrypt ============
function encrypt(plaintextStr) {
  const key = deriveKey();
  const iv = randomBytes(12); // AES-GCM 推荐 12 字节
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintextStr, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // WebCrypto 的格式: ciphertext + auth tag 拼接
  const combined = Buffer.concat([ct, tag]);
  return {
    iv: iv.toString("base64"),
    ct: combined.toString("base64"),
  };
}

// ============ Build ============
function build() {
  const sourceRaw = readFileSync(SRC_PATH, "utf8");
  const source = JSON.parse(sourceRaw);

  // 校验结构
  if (!Array.isArray(source.categories)) {
    throw new Error("source.categories 必须是数组");
  }

  let entryCount = 0;
  let slangCount = 0;
  for (const cat of source.categories) {
    if (!cat.id || !cat.name || typeof cat.entries !== "object") {
      throw new Error(`分类 "${cat.id || cat.name || "?"}" 结构不完整`);
    }
    for (const [normal, slangs] of Object.entries(cat.entries)) {
      if (!Array.isArray(slangs) || slangs.length === 0) {
        throw new Error(`词条 "${normal}" (分类 ${cat.id}) 的值必须是非空数组`);
      }
      entryCount++;
      slangCount += slangs.length;
    }
  }

  // 加密 categories 部分 (meta 部分明文, 方便调试)
  const payload = JSON.stringify({
    categories: source.categories,
  });
  const { iv, ct } = encrypt(payload);

  // 内容哈希 (校验完整性)
  const checksum = createHash("sha256").update(payload).digest("hex").slice(0, 16);

  const out = {
    v: 2,
    version: source.version,
    updatedAt: source.updatedAt,
    alg: "AES-256-GCM",
    kdf: "PBKDF2-SHA256-100000",
    stats: {
      categories: source.categories.length,
      entries: entryCount,
      slangs: slangCount,
    },
    checksum,
    iv,
    ct,
  };

  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");

  console.log(`✓ 加密成功`);
  console.log(`  版本: ${out.version} (${out.updatedAt})`);
  console.log(`  分类: ${out.stats.categories}`);
  console.log(`  词条: ${out.stats.entries} (${out.stats.slangs} 个黑话变体)`);
  console.log(`  输出: ${OUT_PATH}`);
  console.log(`  校验: ${checksum}`);
}

build();
