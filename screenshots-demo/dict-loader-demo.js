// 截图用的 dict-loader: 同款 XYDict API, 但跳过加密直接读 window.__DEMO_DICT
(function () {
  "use strict";

  let _categories = null;
  let _flatDict = null;
  let _reverse = null;
  let _slangRegex = null;
  let _meta = null;
  let _customSlangSet = new Set();
  let _customEntries = null;
  let _loadPromise = null;

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildIndexes(categories) {
    const flat = {};
    const reverse = {};
    for (const cat of categories) {
      for (const [normal, slangs] of Object.entries(cat.entries)) {
        if (!flat[normal]) flat[normal] = [];
        for (const s of slangs) {
          if (!flat[normal].includes(s)) flat[normal].push(s);
          if (!reverse[s]) reverse[s] = [];
          if (!reverse[s].includes(normal)) reverse[s].push(normal);
        }
      }
    }
    const keys = Object.keys(reverse).sort((a, b) => b.length - a.length);
    const regex = keys.length ? new RegExp(keys.map(escapeRegex).join("|"), "gi") : null;
    return { flat, reverse, regex };
  }

  function loadCustom() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["customDict"], (data) => {
        const raw = data.customDict;
        _customEntries = (raw && raw.entries) ? { ...raw.entries } : null;
        _customSlangSet = new Set();
        if (_customEntries) {
          for (const ss of Object.values(_customEntries)) for (const s of ss) _customSlangSet.add(s);
        }
        resolve();
      });
    });
  }

  async function ensureLoaded() {
    if (_categories) return;
    if (!_loadPromise) {
      _loadPromise = (async () => {
        const src = window.__DEMO_DICT;
        if (!src) throw new Error("__DEMO_DICT 没有载入");
        _meta = src.meta;
        let cats = src.categories;
        await loadCustom();
        if (_customEntries && Object.keys(_customEntries).length > 0) {
          cats = [...cats, {
            id: "custom", name: "我的词典", icon: "📝",
            entries: { ..._customEntries }, isCustom: true,
          }];
        }
        _categories = cats;
        const idx = buildIndexes(cats);
        _flatDict = idx.flat;
        _reverse = idx.reverse;
        _slangRegex = idx.regex;
      })();
    }
    return _loadPromise;
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.customDict) {
      _categories = null;
      _loadPromise = null;
      _flatDict = null;
      _reverse = null;
      _slangRegex = null;
      _customEntries = null;
      _customSlangSet = new Set();
    }
  });

  async function getMeta() {
    await ensureLoaded();
    return { ..._meta, categoryCount: _categories.length };
  }
  async function getCategorySummaries() {
    await ensureLoaded();
    return _categories.map((c) => ({
      id: c.id, name: c.name, icon: c.icon,
      entryCount: Object.keys(c.entries).length,
    }));
  }
  async function getCategoryEntries(id) {
    await ensureLoaded();
    const cat = _categories.find((c) => c.id === id);
    if (!cat) return null;
    return {
      id: cat.id, name: cat.name, icon: cat.icon,
      entries: Object.entries(cat.entries).map(([n, s]) => ({ normal: n, slangs: [...s] })),
    };
  }
  async function suggestSlangsFor(query) {
    await ensureLoaded();
    const lower = query.trim().toLowerCase();
    if (!lower) return [];
    const seen = new Set();
    const out = [];
    const push = (n, exact, via) => {
      if (seen.has(n)) return;
      const sl = _flatDict[n];
      if (!sl) return;
      const e = { normal: n, slangs: [...sl], exact };
      if (via) e.viaSlang = via;
      out.push(e); seen.add(n);
    };
    for (const n of Object.keys(_flatDict)) if (n.toLowerCase() === lower) push(n, true);
    for (const s of Object.keys(_reverse)) if (s.toLowerCase() === lower) for (const n of _reverse[s]) push(n, false, s);
    for (const n of Object.keys(_flatDict)) {
      const ln = n.toLowerCase();
      if (ln.includes(lower) || (lower.length >= 2 && lower.includes(ln))) push(n, false);
    }
    for (const s of Object.keys(_reverse)) {
      const sl = s.toLowerCase();
      if (sl.includes(lower) || (lower.length >= 2 && lower.includes(sl))) for (const n of _reverse[s]) push(n, false, s);
    }
    return out.slice(0, 12);
  }
  async function decodeSlang(s) {
    await ensureLoaded();
    return _reverse[s] || _reverse[s.toLowerCase()] || null;
  }
  async function decodeText(text) {
    await ensureLoaded();
    if (!_slangRegex || !text) return [];
    _slangRegex.lastIndex = 0;
    const found = new Map();
    let m;
    while ((m = _slangRegex.exec(text)) !== null) {
      const k = m[0];
      const meanings = _reverse[k] || _reverse[k.toLowerCase()];
      if (meanings && !found.has(k)) found.set(k, [...meanings]);
    }
    return [...found.entries()].map(([slang, meanings]) => ({ slang, meanings }));
  }
  async function getScanIndexes() {
    await ensureLoaded();
    return { regex: _slangRegex, reverse: _reverse, customSlangs: new Set(_customSlangSet) };
  }
  async function getAllForBrowse() {
    await ensureLoaded();
    return _categories.map((c) => ({
      id: c.id, name: c.name, icon: c.icon,
      entries: Object.entries(c.entries).map(([n, s]) => ({ normal: n, slangs: [...s] })),
    }));
  }
  async function getAIContext() { return { related: [], samples: [] }; }
  async function getCustomDict() {
    await ensureLoaded();
    return { entries: _customEntries ? { ..._customEntries } : {} };
  }
  function setCustomDict(d) {
    return new Promise((res) => {
      const clean = { entries: {} };
      if (d && d.entries) {
        for (const [n, ss] of Object.entries(d.entries)) {
          const cn = String(n).trim(); if (!cn) continue;
          const cs = (Array.isArray(ss) ? ss : []).map((s) => String(s).trim()).filter(Boolean);
          if (cs.length) clean.entries[cn] = [...new Set(cs)];
        }
      }
      chrome.storage.local.set({ customDict: clean }, () => res(clean));
    });
  }
  async function upsertCustomEntry(n, ss) { const d = await getCustomDict(); d.entries[n] = ss; return setCustomDict(d); }
  async function deleteCustomEntry(n) { const d = await getCustomDict(); delete d.entries[n]; return setCustomDict(d); }
  async function clearCustomDict() { return setCustomDict({ entries: {} }); }
  function isSlangCustom(s) { return _customSlangSet.has(s); }

  Object.defineProperty(self, "XYDict", {
    value: Object.freeze({
      getMeta, getCategorySummaries, getCategoryEntries, suggestSlangsFor,
      decodeSlang, decodeText, getScanIndexes, getAllForBrowse, getAIContext,
      getCustomDict, setCustomDict, upsertCustomEntry, deleteCustomEntry,
      clearCustomDict, isSlangCustom,
    }),
    writable: false, configurable: false, enumerable: false,
  });
})();
