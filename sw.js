// オフラインでもアプリが開けるようにする。
// アプリ本体だけをキャッシュし、GitHub API は絶対にキャッシュしない
// （古い残高を正しい残高として見せてしまうため）。

// 上げると activate で古いキャッシュが全部消える。
// アプリ本体を変えたら必ず上げること。
const VERSION = 'kakeibo-v15';
// 事前キャッシュはしない。サブリソースは ?v=版 付きで要求されるため、
// ここに固定パスを並べると版の食い違いを自分で作り込むことになる。
// ネットワーク優先の fetch ハンドラが、通った分だけキャッシュを育てる。

self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
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

  // オンラインなら常に最新を取りに行き、失敗したらキャッシュに落ちる。
  // 「キャッシュ優先で裏で更新」にすると、更新した直後の1回は古い画面が出て
  // 「直したのに変わらない」ことになるため、正しさを優先する。
  // アプリ本体は数十KBなので取得コストは無視できる。
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || Promise.reject(new Error('offline'))))
  );
});
