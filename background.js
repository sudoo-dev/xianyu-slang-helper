// Background service worker
// 词典已打包加密在 dictionary.enc.json, 跟随插件版本更新, 无需远端拉取

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.storage.local.set({ decodeEnabled: true });
  }
});
