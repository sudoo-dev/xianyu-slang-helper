// 词典加载器 (加密版)
// 流程: data/dictionary.enc.json -> crypto.js 解密 -> 闭包内构建索引 -> 暴露受控查询 API
//
// 关键点:
//   - 解密后的明文 categories 只保存在闭包变量, 不挂 window
//   - 反向索引也只在闭包内
//   - 外部只能通过 API 单次查询, 无法一次性 dump 全部
//   - meta (版本/分类计数) 是允许公开的

(function () {
  "use strict";

  let _categories = null; // [{id, name, icon, entries: {normal: [slangs...]}}]
  let _flatDict = null;   // {normal: [slangs...]} 合并自所有分类
  let _reverse = null;    // {slang: [normal...]}
  let _slangRegex = null; // 用于扫描页面
  let _meta = null;
  let _loadPromise = null;

  // 自定义词典 (来自 chrome.storage.local.customDict)
  let _customEntries = null; // {normal: [slangs]}
  let _customSlangSet = new Set(); // 用于内容脚本视觉区分

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildIndexes(categories) {
    const flat = {};
    const reverse = {};
    for (const cat of categories) {
      for (const [normal, slangs] of Object.entries(cat.entries)) {
        // 同一个 normal 在不同分类下合并(理论上分类隔离, 实际罕见)
        if (!flat[normal]) flat[normal] = [];
        for (const s of slangs) {
          if (!flat[normal].includes(s)) flat[normal].push(s);
          if (!reverse[s]) reverse[s] = [];
          if (!reverse[s].includes(normal)) reverse[s].push(normal);
        }
      }
    }
    const keys = Object.keys(reverse).sort((a, b) => b.length - a.length);
    const regex = keys.length
      ? new RegExp(keys.map(escapeRegex).join("|"), "gi")
      : null;
    return { flat, reverse, regex };
  }

  // 开发期: tools/dictionary.source.json 存在 → 直接读明文(免加密)
  // 发布期: 打包脚本会删掉 source, 加载器自动回落到加密 .enc.json
  async function tryLoadPlaintext() {
    try {
      const url = chrome.runtime.getURL("tools/dictionary.source.json");
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) return null;
      const src = await resp.json();
      if (!Array.isArray(src?.categories)) return null;
      return {
        meta: {
          version: src.version,
          updatedAt: src.updatedAt,
          stats: computeStats(src.categories),
        },
        categories: src.categories,
      };
    } catch {
      return null;
    }
  }

  function computeStats(categories) {
    let entries = 0, slangs = 0;
    for (const cat of categories) {
      for (const list of Object.values(cat.entries || {})) {
        entries++;
        slangs += list.length;
      }
    }
    return { categories: categories.length, entries, slangs };
  }

  async function loadCustomEntries() {
    return new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        _customEntries = null;
        _customSlangSet = new Set();
        resolve();
        return;
      }
      chrome.storage.local.get(["customDict"], (data) => {
        const raw = data.customDict;
        if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") {
          _customEntries = { ...raw.entries };
        } else {
          _customEntries = null;
        }
        _customSlangSet = new Set();
        if (_customEntries) {
          for (const slangs of Object.values(_customEntries)) {
            for (const s of slangs) _customSlangSet.add(s);
          }
        }
        resolve();
      });
    });
  }

  async function ensureLoaded() {
    if (_categories) return;
    if (!_loadPromise) {
      _loadPromise = (async () => {
        // 1) 开发期: 明文 source
        const plain = await tryLoadPlaintext();
        let baseCategories;
        if (plain) {
          _meta = plain.meta;
          baseCategories = plain.categories;
        } else {
          // 2) 发布期: 加密 enc.json
          if (typeof self.XYCrypto?.loadEncrypted !== "function") {
            throw new Error("crypto.js 未加载, 且未找到明文 source");
          }
          const { meta, categories } = await self.XYCrypto.loadEncrypted();
          _meta = meta;
          baseCategories = categories;
        }

        // 3) 合并自定义词典
        await loadCustomEntries();
        if (_customEntries && Object.keys(_customEntries).length > 0) {
          baseCategories = [...baseCategories, {
            id: "custom",
            name: "我的词典",
            icon: "📝",
            entries: { ..._customEntries },
            isCustom: true,
          }];
        }
        _categories = baseCategories;

        const idx = buildIndexes(_categories);
        _flatDict = idx.flat;
        _reverse = idx.reverse;
        _slangRegex = idx.regex;
      })();
    }
    return _loadPromise;
  }

  // 监听 customDict 变化 -> 失效缓存
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.customDict) {
        _categories = null;
        _loadPromise = null;
        _flatDict = null;
        _reverse = null;
        _slangRegex = null;
        _customEntries = null;
        _customSlangSet = new Set();
      }
    });
  }

  // ============ 受控查询 API ============
  // 这些 API 设计成"按需查询", 而不是返回整本字典, 减少明文一次性流出风险

  async function getMeta() {
    await ensureLoaded();
    return { ..._meta, categoryCount: _categories.length };
  }

  async function getCategorySummaries() {
    await ensureLoaded();
    return _categories.map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      entryCount: Object.keys(c.entries).length,
    }));
  }

  async function getCategoryEntries(categoryId) {
    await ensureLoaded();
    const cat = _categories.find((c) => c.id === categoryId);
    if (!cat) return null;
    return {
      id: cat.id,
      name: cat.name,
      icon: cat.icon,
      entries: Object.entries(cat.entries).map(([normal, slangs]) => ({
        normal,
        slangs: [...slangs],
      })),
    };
  }

  async function suggestSlangsFor(query) {
    await ensureLoaded();
    const lower = query.trim().toLowerCase();
    if (!lower) return [];

    const seen = new Set();
    const out = [];
    const pushOnce = (normal, exact, viaSlang) => {
      if (seen.has(normal)) return;
      const slangs = _flatDict[normal];
      if (!slangs) return;
      const entry = { normal, slangs: [...slangs], exact };
      if (viaSlang) entry.viaSlang = viaSlang;
      out.push(entry);
      seen.add(normal);
    };

    // 1) normal 精确匹配
    for (const normal of Object.keys(_flatDict)) {
      if (normal.toLowerCase() === lower) pushOnce(normal, true);
    }

    // 2) 用户输入正好是某个暗语 → 返回其归属的所有 normal
    for (const slang of Object.keys(_reverse)) {
      if (slang.toLowerCase() === lower) {
        for (const normal of _reverse[slang]) pushOnce(normal, false, slang);
      }
    }

    // 3) normal 含输入 / 输入含 normal
    for (const normal of Object.keys(_flatDict)) {
      const ln = normal.toLowerCase();
      if (ln.includes(lower) || (lower.length >= 2 && lower.includes(ln))) {
        pushOnce(normal, false);
      }
    }

    // 4) 任何暗语含输入 / 输入含某暗语 → 关联到对应 normal
    for (const slang of Object.keys(_reverse)) {
      const sl = slang.toLowerCase();
      if (sl.includes(lower) || (lower.length >= 2 && lower.includes(sl))) {
        for (const normal of _reverse[slang]) pushOnce(normal, false, slang);
      }
    }

    return out.slice(0, 12);
  }

  async function decodeSlang(slang) {
    await ensureLoaded();
    return _reverse[slang] || _reverse[slang.toLowerCase()] || null;
  }

  async function decodeText(text) {
    await ensureLoaded();
    if (!_slangRegex || !text) return [];
    _slangRegex.lastIndex = 0;
    const found = new Map();
    let m;
    while ((m = _slangRegex.exec(text)) !== null) {
      const key = m[0];
      const meanings = _reverse[key] || _reverse[key.toLowerCase()];
      if (meanings && !found.has(key)) {
        found.set(key, [...meanings]);
      }
    }
    return [...found.entries()].map(([slang, meanings]) => ({ slang, meanings }));
  }

  // 给 content script 扫描整页用: 返回 regex + reverse 快照
  // 注意: 这里仍然要把数据暴露给页面 DOM, 但被限制在 content script 闭包内
  async function getScanIndexes() {
    await ensureLoaded();
    return {
      regex: _slangRegex,
      reverse: _reverse,
      customSlangs: new Set(_customSlangSet), // 副本, 防外部修改
    };
  }

  // 给 AI 用: 抽取与 query 相关的条目 + 每分类 1-2 个代表条目作为风格样本
  async function getAIContext(query, maxRelated = 8) {
    await ensureLoaded();
    const lower = String(query || "").trim().toLowerCase();

    // 1) 与输入相关 (normal 或 slang 任意一边包含)
    const related = [];
    const seen = new Set();
    if (lower) {
      for (const cat of _categories) {
        for (const [normal, slangs] of Object.entries(cat.entries)) {
          if (seen.has(normal)) continue;
          const allTokens = [normal, ...slangs].map((t) => t.toLowerCase());
          if (
            allTokens.some(
              (t) => t.includes(lower) || lower.includes(t)
            )
          ) {
            related.push({ category: cat.name, normal, slangs: [...slangs] });
            seen.add(normal);
            if (related.length >= maxRelated) break;
          }
        }
        if (related.length >= maxRelated) break;
      }
    }

    // 2) 每分类前 2 个条目作为风格样本
    const samples = [];
    for (const cat of _categories) {
      const ents = Object.entries(cat.entries).slice(0, 2);
      for (const [normal, slangs] of ents) {
        if (seen.has(normal)) continue;
        samples.push({ category: cat.name, normal, slangs: [...slangs] });
      }
    }

    return { related, samples };
  }

  // 全词典浏览(仅 popup 内部用)
  async function getAllForBrowse() {
    await ensureLoaded();
    return _categories.map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      entries: Object.entries(c.entries).map(([normal, slangs]) => ({
        normal,
        slangs: [...slangs],
      })),
    }));
  }

  // ============ 自定义词典 CRUD ============
  async function getCustomDict() {
    await ensureLoaded();
    return {
      entries: _customEntries ? { ..._customEntries } : {},
    };
  }

  function sanitize(newDict) {
    const clean = { entries: {} };
    if (!newDict || typeof newDict.entries !== "object") return clean;
    for (const [rawNormal, rawSlangs] of Object.entries(newDict.entries)) {
      const normal = String(rawNormal).trim();
      if (!normal) continue;
      const slangs = (Array.isArray(rawSlangs) ? rawSlangs : [])
        .map((s) => String(s).trim())
        .filter((s) => s.length > 0);
      const unique = [...new Set(slangs)];
      if (unique.length === 0) continue;
      clean.entries[normal] = unique;
    }
    return clean;
  }

  function setCustomDict(newDict) {
    return new Promise((resolve, reject) => {
      const clean = sanitize(newDict);
      chrome.storage.local.set({ customDict: clean }, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(clean);
      });
    });
  }

  async function upsertCustomEntry(normal, slangs) {
    const dict = await getCustomDict();
    dict.entries[normal] = slangs;
    return setCustomDict(dict);
  }

  async function deleteCustomEntry(normal) {
    const dict = await getCustomDict();
    delete dict.entries[normal];
    return setCustomDict(dict);
  }

  async function clearCustomDict() {
    return setCustomDict({ entries: {} });
  }

  function isSlangCustom(slang) {
    return _customSlangSet.has(slang);
  }

  Object.defineProperty(self, "XYDict", {
    value: Object.freeze({
      getMeta,
      getCategorySummaries,
      getCategoryEntries,
      suggestSlangsFor,
      decodeSlang,
      decodeText,
      getScanIndexes,
      getAllForBrowse,
      getAIContext,
      getCustomDict,
      setCustomDict,
      upsertCustomEntry,
      deleteCustomEntry,
      clearCustomDict,
      isSlangCustom,
    }),
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
