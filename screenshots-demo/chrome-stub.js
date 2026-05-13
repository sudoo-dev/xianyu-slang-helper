// 在 file:// 环境下伪造 chrome.* 必要的 API
// 让真实的 dict-loader/content/popup 代码能跑起来用作截图
(function () {
  const listeners = [];
  const storage = { decodeEnabled: true, customDict: {
    entries: {
      "路由器": ["路油器", "网卡子", "光猫弟弟"],
      "机械键盘": ["敲蛋", "机键", "薅羊毛盘"],
    }
  }};

  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {
    id: "demo-extension-id",
    getURL: (p) => p, // 相对路径直接返回, file:// 下相当于相对当前 HTML
    onMessage: { addListener: () => {} },
    lastError: null,
  };
  // 支持 callback 和 promise 两种调用方式 (MV3 API)
  function asyncish(work) {
    return new Promise((resolve) => Promise.resolve().then(() => resolve(work())));
  }

  window.chrome.storage = window.chrome.storage || {
    local: {
      get: (keys, cb) => {
        const work = () => {
          const k = keys == null ? Object.keys(storage)
                  : Array.isArray(keys) ? keys
                  : typeof keys === "string" ? [keys]
                  : Object.keys(keys);
          const out = {};
          for (const key of k) if (key in storage) out[key] = JSON.parse(JSON.stringify(storage[key]));
          return out;
        };
        const p = asyncish(work);
        if (cb) p.then(cb);
        return p;
      },
      set: (obj, cb) => {
        const p = asyncish(() => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: storage[k], newValue: v };
            storage[k] = v;
          }
          listeners.forEach((fn) => fn(changes, "local"));
        });
        if (cb) p.then(cb);
        return p;
      },
      remove: (keys, cb) => {
        const p = asyncish(() => {
          const k = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const key of k) {
            changes[key] = { oldValue: storage[key], newValue: undefined };
            delete storage[key];
          }
          listeners.forEach((fn) => fn(changes, "local"));
        });
        if (cb) p.then(cb);
        return p;
      },
    },
    onChanged: {
      addListener: (fn) => listeners.push(fn),
    },
  };
})();
