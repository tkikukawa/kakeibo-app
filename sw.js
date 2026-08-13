// オフラインでもアプリが開けるようにする。
// アプリ本体だけをキャッシュし、GitHub API は絶対にキャッシュしない
// （古い残高を正しい残高として見せてしまうため）。

const VERSION = 'kakeibo-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './model.js',
  './store.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // API は素通し
  if (e.request.method !== 'GET') return;

  // アプリ本体は「キャッシュを返しつつ裏で更新」。
  // オフラインでも即座に開き、オンラインなら次回に最新が入る。
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const fresh = fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || fresh;
    })
  );
});
