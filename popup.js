// Popup logic - 全部走 XYDict 受控 API
(function () {
  "use strict";

  let META = null;
  let CATEGORIES = []; // [{id, name, icon, entryCount}]
  let CACHED_BROWSE = null; // 懒加载: 仅在词典页第一次切入时获取
  let activeCategory = "__all__";

  // Built-in AI (Gemini Nano) 状态: 'available' | 'downloadable' | 'downloading' | 'unavailable' | null
  let AI_STATUS = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ============ Tab switching ============
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      panels.forEach((p) => p.classList.toggle("active", p.id === `panel-${target}`));
      if (target === "dict") ensureDictRendered();
      if (target === "custom") renderCustomPanel();
    });
  });

  // ============ Translate panel ============
  const input = document.getElementById("translate-input");
  const clearBtn = document.getElementById("clear-btn");
  const resultArea = document.getElementById("result-area");

  input.addEventListener("input", () => {
    clearBtn.style.display = input.value ? "flex" : "none";
  });
  clearBtn.addEventListener("click", () => {
    input.value = "";
    clearBtn.style.display = "none";
    resultArea.innerHTML = '<div class="empty-state">输入文本后点击上方按钮</div>';
    input.focus();
  });

  document.getElementById("btn-to-slang").addEventListener("click", async () => {
    const text = input.value.trim();
    if (!text) {
      resultArea.innerHTML = '<div class="empty-state">请先输入要转换的关键词</div>';
      return;
    }
    const matches = await self.XYDict.suggestSlangsFor(text);
    if (matches.length === 0) {
      resultArea.innerHTML = renderEmptyWithAI(
        `词典中没有找到 "${escapeHtml(text)}" 的黑话`,
        "试试更通用的词，或在\"词典\"页浏览所有分类",
        text,
        "to-slang"
      );
      bindAIButton(text, "to-slang");
      return;
    }
    let html = "";
    matches.forEach(({ normal, slangs, exact }) => {
      html += `
        <div class="result-group">
          <div class="result-normal">${exact ? "✓ 精确匹配: " : ""}<strong>${escapeHtml(normal)}</strong></div>
          <div class="result-tags">
            ${slangs.map((s) => `<span class="result-tag" data-copy="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join("")}
          </div>
        </div>`;
    });
    resultArea.innerHTML = html;
    bindCopyTags(resultArea, ".result-tag");
  });

  document.getElementById("btn-to-normal").addEventListener("click", async () => {
    const text = input.value.trim();
    if (!text) {
      resultArea.innerHTML = '<div class="empty-state">请先粘贴要解读的文本</div>';
      return;
    }
    const found = await self.XYDict.decodeText(text);
    if (found.length === 0) {
      resultArea.innerHTML = renderEmptyWithAI(
        "未在文本中检测到已知黑话",
        "可能是新词或词典暂未收录",
        text,
        "to-normal"
      );
      bindAIButton(text, "to-normal");
      return;
    }
    let html = "";
    found.forEach(({ slang, meanings }) => {
      html += `
        <div class="result-group">
          <div class="result-normal">黑话: <strong>${escapeHtml(slang)}</strong></div>
          <div class="result-tags">
            ${meanings.map((s) => `<span class="result-tag" data-copy="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join("")}
          </div>
        </div>`;
    });
    resultArea.innerHTML = html;
    bindCopyTags(resultArea, ".result-tag");
  });

  // ============ Built-in AI fallback ============
  function renderEmptyWithAI(title, hint, text, direction) {
    const base = `
      <div class="empty-state">
        ${title}<br/>
        <small style="color:#bbb">${hint}</small>
      </div>`;
    if (AI_STATUS === "available") {
      return base + `
        <div class="ai-fallback">
          <button class="btn btn-ai" id="btn-ai-try">
            🤖 用本地 AI 试试解读
          </button>
          <div class="ai-hint">本地运行 · 无需联网 · 推测结果仅供参考</div>
        </div>`;
    }
    if (AI_STATUS === "downloadable" || AI_STATUS === "downloading") {
      return base + `
        <div class="ai-fallback">
          <button class="btn btn-ai" id="btn-ai-try">
            🤖 ${AI_STATUS === "downloading" ? "AI 模型下载中..." : "下载本地 AI 模型"}
          </button>
          <div class="ai-hint">首次需下载 ~4GB Gemini Nano 模型, 之后离线可用</div>
        </div>`;
    }
    return base;
  }

  function bindAIButton(text, direction) {
    const btn = document.getElementById("btn-ai-try");
    if (!btn) return;
    btn.addEventListener("click", () => runAIFallback(text, direction));
  }

  async function runAIFallback(text, direction) {
    if (typeof LanguageModel === "undefined") return;

    // 清空结果区, 显示 AI 处理中
    resultArea.innerHTML = `
      <div class="result-group ai-group" id="ai-result">
        <div class="ai-badge">🤖 AI 推测 (Gemini Nano · 本地)</div>
        <div class="ai-text" id="ai-text"><span class="ai-cursor">▌</span></div>
        <div class="ai-disclaimer">⚠️ AI 推测仅供参考, 准确度低于词典</div>
      </div>`;
    const textEl = document.getElementById("ai-text");

    try {
      const status = await LanguageModel.availability();
      AI_STATUS = status;
      if (status === "unavailable") {
        textEl.innerHTML = '<span style="color:#c62828">当前设备不支持 Built-in AI</span>';
        return;
      }

      // 拼接词典上下文 (相关条目 + 风格样本)
      const ctx = await self.XYDict.getAIContext(text);
      const fmtRow = (e) => `${e.normal} = ${e.slangs.slice(0, 5).join("/")}  [${e.category}]`;
      const ctxBlock = [
        ctx.related.length ? "【与输入相关的词典条目】\n" + ctx.related.map(fmtRow).join("\n") : "",
        "【词典样例 (学习这种风格)】\n" + ctx.samples.slice(0, 24).map(fmtRow).join("\n"),
      ].filter(Boolean).join("\n\n");

      const sysPrompt = direction === "to-slang"
        ? `你是闲鱼二手交易平台的黑话翻译助手。用户给你一个正常关键词, 参考下面的内置词典, 给出在闲鱼上卖家会用到的 1-5 个隐晦同义词/谐音/缩写, 用顿号分隔, 不要解释。如果词典里已有, 优先复用词典里的写法; 没有时按词典风格扩展。\n\n${ctxBlock}`
        : `你是闲鱼二手交易平台的黑话解读助手。用户给你一段商品文字或黑话词, 参考下面的内置词典, 用一句话指出其中可疑/隐晦词的真实含义。如果词典里有, 直接引用词典释义; 词典里没有但风格相似, 按词典逻辑推测。完全是正常用语就回答"没有可疑黑话"。\n\n${ctxBlock}`;

      const session = await LanguageModel.create({
        temperature: 0.4,
        topK: 3,
        initialPrompts: [{ role: "system", content: sysPrompt }],
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            textEl.innerHTML = `<span style="color:#888">模型下载中 ${(e.loaded * 100).toFixed(0)}%...</span>`;
          });
        },
      });

      const userPrompt = direction === "to-slang"
        ? `关键词: ${text}`
        : `请解读: ${text}`;

      textEl.innerHTML = '<span class="ai-cursor">▌</span>';
      let buffer = "";
      const stream = session.promptStreaming(userPrompt);
      for await (const chunk of stream) {
        buffer += chunk;
        textEl.innerHTML = escapeHtml(buffer) + '<span class="ai-cursor">▌</span>';
      }
      textEl.innerHTML = escapeHtml(buffer);
      session.destroy();
    } catch (err) {
      textEl.innerHTML = `<span style="color:#c62828">调用失败: ${escapeHtml(err.message || String(err))}</span>`;
    }
  }

  async function probeAIStatus() {
    try {
      if (typeof LanguageModel === "undefined") {
        AI_STATUS = "unavailable";
        return;
      }
      AI_STATUS = await LanguageModel.availability();
    } catch {
      AI_STATUS = "unavailable";
    }
  }

  function bindCopyTags(container, selector) {
    container.querySelectorAll(selector).forEach((tag) => {
      tag.addEventListener("click", () => {
        const text = tag.dataset.copy || tag.textContent;
        navigator.clipboard.writeText(text).then(() => {
          tag.classList.add("copied");
          setTimeout(() => tag.classList.remove("copied"), 1200);
        });
      });
    });
  }

  // ============ Dict panel ============
  const dictList = document.getElementById("dict-list");
  const dictSearch = document.getElementById("dict-search");
  const dictStats = document.getElementById("dict-stats");
  const categoryChips = document.getElementById("category-chips");
  let dictRendered = false;

  async function ensureDictRendered() {
    if (!dictRendered) {
      // 懒加载分类全量数据
      CACHED_BROWSE = await self.XYDict.getAllForBrowse();
      renderCategoryChips();
      dictRendered = true;
    }
    renderDict();
  }

  function renderCategoryChips() {
    let html = `<span class="cat-chip ${activeCategory === "__all__" ? "active" : ""}" data-cat="__all__">全部 <span class="chip-count">${
      CACHED_BROWSE.reduce((s, c) => s + c.entries.length, 0)
    }</span></span>`;
    CACHED_BROWSE.forEach((cat) => {
      html += `<span class="cat-chip ${activeCategory === cat.id ? "active" : ""}" data-cat="${cat.id}">${cat.icon} ${escapeHtml(cat.name)} <span class="chip-count">${cat.entries.length}</span></span>`;
    });
    categoryChips.innerHTML = html;
    categoryChips.querySelectorAll(".cat-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        activeCategory = chip.dataset.cat;
        categoryChips.querySelectorAll(".cat-chip").forEach((c) =>
          c.classList.toggle("active", c === chip)
        );
        renderDict();
      });
    });
  }

  function renderDict() {
    const filter = dictSearch.value.trim().toLowerCase();
    let html = "";
    let total = 0, shown = 0;

    const cats = activeCategory === "__all__"
      ? CACHED_BROWSE
      : CACHED_BROWSE.filter((c) => c.id === activeCategory);

    cats.forEach((cat) => {
      const matched = cat.entries.filter((e) => {
        total++;
        if (!filter) return true;
        return (
          e.normal.toLowerCase().includes(filter) ||
          e.slangs.some((s) => s.toLowerCase().includes(filter))
        );
      });
      if (matched.length === 0) return;
      shown += matched.length;
      if (activeCategory === "__all__") {
        html += `<div class="dict-cat-header">${cat.icon} ${escapeHtml(cat.name)} · ${matched.length}</div>`;
      }
      matched.forEach((e) => {
        html += `
          <div class="dict-entry">
            <div class="dict-entry-normal">${escapeHtml(e.normal)}</div>
            <div class="dict-entry-slangs">
              ${e.slangs.map((s) => `<span class="dict-entry-slang" data-copy="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join("")}
            </div>
          </div>`;
      });
    });

    dictList.innerHTML = html || '<div class="empty-state">没有匹配的词条</div>';
    dictStats.textContent = filter
      ? `显示 ${shown} / ${total} 条`
      : `共 ${total} 条`;
    bindCopyTags(dictList, ".dict-entry-slang");
  }

  dictSearch.addEventListener("input", () => {
    if (dictRendered) renderDict();
  });

  // ============ About panel - meta ============
  async function renderMeta() {
    META = await self.XYDict.getMeta();
    document.getElementById("meta-version").textContent = META.version || "-";
    document.getElementById("meta-updated").textContent = META.updatedAt || "-";
    document.getElementById("meta-categories").textContent = META.stats?.categories ?? "-";
    document.getElementById("meta-entries").textContent =
      `${META.stats?.entries ?? "-"} (${META.stats?.slangs ?? "-"} 个变体)`;
    document.getElementById("title-sub").textContent =
      `v${META.version} · ${META.stats?.entries ?? "?"} 条`;
  }

  // ============ Decode toggle ============
  const decodeToggle = document.getElementById("setting-decode");
  chrome.storage.local.get(["decodeEnabled"], (data) => {
    decodeToggle.checked = data.decodeEnabled !== false;
  });
  decodeToggle.addEventListener("change", () => {
    chrome.storage.local.set({ decodeEnabled: decodeToggle.checked });
  });

  // ============ Custom dict panel ============
  const customNormal = document.getElementById("custom-normal");
  const customSlangs = document.getElementById("custom-slangs");
  const customAddBtn = document.getElementById("btn-custom-add");
  const customCancelBtn = document.getElementById("btn-custom-cancel");
  const customMsg = document.getElementById("custom-form-msg");
  const customStats = document.getElementById("custom-stats");
  const customList = document.getElementById("custom-list");
  const customImportFile = document.getElementById("custom-import-file");
  let editingKey = null; // null = adding, string = editing this normal

  function parseSlangs(raw) {
    return raw
      .split(/[,，\s、；;|]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function showCustomMsg(text, kind) {
    customMsg.textContent = text;
    customMsg.className = "custom-form-msg " + (kind || "");
    if (text) setTimeout(() => { if (customMsg.textContent === text) customMsg.textContent = ""; }, 2500);
  }

  function resetCustomForm() {
    customNormal.value = "";
    customSlangs.value = "";
    customNormal.disabled = false;
    customAddBtn.textContent = "+ 添加";
    customCancelBtn.style.display = "none";
    editingKey = null;
  }

  function startEditing(normal, slangs) {
    editingKey = normal;
    customNormal.value = normal;
    customNormal.disabled = true; // normal 是 key, 编辑时不允许改
    customSlangs.value = slangs.join(", ");
    customAddBtn.textContent = "保存修改";
    customCancelBtn.style.display = "";
    customNormal.scrollIntoView({ behavior: "smooth", block: "nearest" });
    customSlangs.focus();
  }

  customCancelBtn.addEventListener("click", () => {
    resetCustomForm();
    showCustomMsg("已取消", "info");
  });

  customAddBtn.addEventListener("click", async () => {
    const normal = customNormal.value.trim();
    const slangs = parseSlangs(customSlangs.value);
    if (!normal) {
      showCustomMsg("请填写正常词", "error");
      customNormal.focus();
      return;
    }
    if (slangs.length === 0) {
      showCustomMsg("请填写至少一个黑话变体", "error");
      customSlangs.focus();
      return;
    }
    try {
      await self.XYDict.upsertCustomEntry(normal, slangs);
      showCustomMsg(editingKey ? "已保存修改" : `已添加 ${slangs.length} 个变体`, "success");
      resetCustomForm();
      await renderCustomPanel();
    } catch (err) {
      showCustomMsg("保存失败: " + (err.message || err), "error");
    }
  });

  // Enter 触发添加
  [customNormal, customSlangs].forEach((el) => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        customAddBtn.click();
      }
    });
  });

  // 导出
  document.getElementById("btn-custom-export").addEventListener("click", async () => {
    const dict = await self.XYDict.getCustomDict();
    const count = Object.keys(dict.entries).length;
    if (count === 0) {
      showCustomMsg("词典为空, 无可导出", "info");
      return;
    }
    const payload = {
      type: "xianyu-slang-helper-custom",
      version: 1,
      exportedAt: new Date().toISOString(),
      entries: dict.entries,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `xianyu-custom-dict-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showCustomMsg(`已导出 ${count} 条`, "success");
  });

  // 导入
  document.getElementById("btn-custom-import").addEventListener("click", () => {
    customImportFile.value = "";
    customImportFile.click();
  });

  customImportFile.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      let entries;
      if (data && typeof data === "object") {
        entries = data.entries || data;
      }
      if (!entries || typeof entries !== "object") {
        throw new Error("JSON 格式应为 {entries: {...}} 或直接的 {正常词: [黑话]} 对象");
      }
      const existing = (await self.XYDict.getCustomDict()).entries;
      const hasExisting = Object.keys(existing).length > 0;
      let merged;
      if (hasExisting) {
        const choice = confirm("已存在自定义词条。\n确认 = 合并 (相同正常词的黑话取并集)\n取消 = 不导入");
        if (!choice) return;
        merged = { ...existing };
        for (const [k, v] of Object.entries(entries)) {
          const cur = merged[k] || [];
          merged[k] = [...new Set([...cur, ...(Array.isArray(v) ? v : [])])];
        }
      } else {
        merged = entries;
      }
      await self.XYDict.setCustomDict({ entries: merged });
      const count = Object.keys(merged).length;
      showCustomMsg(`导入成功, 共 ${count} 条`, "success");
      await renderCustomPanel();
    } catch (err) {
      showCustomMsg("导入失败: " + (err.message || err), "error");
    }
  });

  // 清空
  document.getElementById("btn-custom-clear").addEventListener("click", async () => {
    const dict = await self.XYDict.getCustomDict();
    const count = Object.keys(dict.entries).length;
    if (count === 0) {
      showCustomMsg("已经是空的", "info");
      return;
    }
    if (!confirm(`确认清空全部 ${count} 条自定义词条? 此操作不可撤销 (建议先导出备份)`)) return;
    await self.XYDict.clearCustomDict();
    resetCustomForm();
    showCustomMsg("已清空", "success");
    await renderCustomPanel();
  });

  async function renderCustomPanel() {
    const dict = await self.XYDict.getCustomDict();
    const entries = Object.entries(dict.entries);
    customStats.textContent = `${entries.length} 条`;

    if (entries.length === 0) {
      customList.innerHTML = `
        <div class="empty-state">
          还没有自定义词条<br/>
          <small style="color:#bbb">在上方表单添加，例如 "<b>路由器</b>" → "<b>路油器, 网卡子</b>"</small>
        </div>`;
      return;
    }

    customList.innerHTML = entries.map(([normal, slangs]) => `
      <div class="custom-entry" data-normal="${escapeHtml(normal)}">
        <div class="custom-entry-head">
          <span class="custom-entry-normal">${escapeHtml(normal)}</span>
          <div class="custom-entry-actions">
            <button class="btn-mini" data-action="edit">编辑</button>
            <button class="btn-mini btn-danger" data-action="delete">删除</button>
          </div>
        </div>
        <div class="custom-entry-slangs">
          ${slangs.map((s) => `<span class="custom-chip">${escapeHtml(s)}</span>`).join("")}
        </div>
      </div>
    `).join("");

    customList.querySelectorAll(".custom-entry").forEach((row) => {
      const normal = row.dataset.normal;
      const slangs = dict.entries[normal] || [];
      row.querySelector('[data-action="edit"]').addEventListener("click", () => {
        startEditing(normal, slangs);
      });
      row.querySelector('[data-action="delete"]').addEventListener("click", async () => {
        if (!confirm(`删除 "${normal}" 及其 ${slangs.length} 个变体?`)) return;
        await self.XYDict.deleteCustomEntry(normal);
        if (editingKey === normal) resetCustomForm();
        await renderCustomPanel();
        showCustomMsg(`已删除 "${normal}"`, "success");
      });
    });
  }

  // 监听 storage 变化, 自动刷新词典面板和我的面板
  chrome.storage.onChanged?.addListener((changes) => {
    if (changes.customDict) {
      // 词典页 (浏览全部) 也要重新拉
      dictRendered = false;
      CACHED_BROWSE = null;
      // 如果当前在显示这两个面板, 立刻刷新
      const activePanel = document.querySelector(".panel.active")?.id;
      if (activePanel === "panel-custom") renderCustomPanel();
      if (activePanel === "panel-dict") ensureDictRendered();
    }
  });

  // ============ Init ============
  (async function init() {
    try {
      await Promise.all([renderMeta(), probeAIStatus()]);
    } catch (err) {
      console.warn("[xianyu-slang] popup 初始化失败", err);
      document.getElementById("title-sub").textContent = "词典加载失败";
    }
    input.focus();
  })();
})();
