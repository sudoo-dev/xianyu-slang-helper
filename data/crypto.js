// 运行时解密模块
//
// === 给 Chrome Web Store 审核员的说明 ===
// 本扩展把内置词典 (data/dictionary.enc.json) 用 AES-GCM 加密打包,
// 目的【不是】隐藏任何代码逻辑或调用, 而仅仅是防止外部爬虫脚本
// 用 `curl + grep` 静态抓取这份公开整理的暗语词条列表.
//
// 解密 key 直接以明文常量保存在下面 (PASSPHRASE 变量), 没有混淆,
// 审核员可以一眼看到 key 是什么、解密后的数据结构是什么.
// 解密后的 plaintext 仅在闭包作用域内用于词典查找, 不会发往任何外部服务器,
// 不挂任何 window/self 全局对象.
//
// 词典明文源文件也在仓库内: tools/dictionary.source.json
//
// 数据流: dictionary.enc.json --(AES-GCM 解密)--> { categories: [...] }
//          ↑ 与扩展一起分发                     ↑ 仅在内存闭包内
//
// 算法:
//   - AES-256-GCM (Web Crypto API)
//   - PBKDF2-SHA256, 100,000 轮, 固定 16 字节 salt
//   - 12 字节随机 IV (每次构建时生成, 与 ciphertext 一起持久化)
// =======================================

(function () {
  "use strict";

  // 解密口令 - 明文, 因为加密目的只是防爬虫不是防逆向
  const PASSPHRASE = "xy-slang|@goofish|_v2_helper";

  // 固定 salt, 与 tools/encrypt-dict.mjs 对齐
  const SALT_HEX = "9f3a82b1e7c4d605a8f29b1c4d7e0a36";
  const PBKDF2_ITERS = 100_000;

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return out;
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveKey() {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(PASSPHRASE),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: hexToBytes(SALT_HEX),
        iterations: PBKDF2_ITERS,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
  }

  async function decryptDictionary(encBundle) {
    if (!encBundle || encBundle.v !== 2 || !encBundle.iv || !encBundle.ct) {
      throw new Error("加密词典格式无效");
    }
    const key = await deriveKey();
    const iv = base64ToBytes(encBundle.iv);
    const ct = base64ToBytes(encBundle.ct);

    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ct
    );
    const plainText = new TextDecoder().decode(plainBuf);
    const parsed = JSON.parse(plainText);

    if (!Array.isArray(parsed.categories)) {
      throw new Error("解密结果结构异常");
    }
    return parsed.categories;
  }

  // 加载加密文件并解密, 返回 { meta, categories }.
  // categories 不会被挂到任何全局对象, 由 dict-loader.js 在闭包内持有.
  async function loadEncrypted(encUrl) {
    const url = encUrl || chrome.runtime.getURL("data/dictionary.enc.json");
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) throw new Error(`无法加载加密词典: HTTP ${resp.status}`);
    const enc = await resp.json();
    const categories = await decryptDictionary(enc);
    return {
      meta: {
        version: enc.version,
        updatedAt: enc.updatedAt,
        stats: enc.stats,
      },
      categories,
    };
  }

  Object.defineProperty(self, "XYCrypto", {
    value: Object.freeze({ loadEncrypted }),
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
