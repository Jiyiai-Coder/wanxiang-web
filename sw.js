/* 万象幻境 · 极简 Service Worker（支持"添加到主屏幕"） */
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("fetch", () => {});
