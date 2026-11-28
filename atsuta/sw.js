/* シマヒートのService Worker(2026-08-01新設)。
 *
 * なぜ要るか: ホールの中は電波が弱いことがあり、いちばん見たい場所で
 * 待たされる/開けないことがある。固定URLは no-cache 指定なので、
 * 開くたびにサーバーへの問い合わせが要る=圏外では何も出せない。
 *
 * 方針(2026-08-01に変更): ページ本体とデータは **network-first**。
 *   1) まずネットワークへ取りに行く(最大2.5秒)
 *   2) 取れたらそれを返してキャッシュも更新する = 開けば必ず最新
 *   3) 取れない/遅すぎるときだけ保存済みを返す = 圏外でも開ける
 *
 * なぜ変えたか: 最初は stale-while-revalidate(保存済みを即返す)にしていたが、
 * 「更新を押しても新しくならない」ことになった(谷川氏報告)。**毎晩内容が変わる
 * 資料では、鮮度が体感速度より優先**される。アイコン等の変わらない物だけ
 * cache-firstのままにしてある。
 *
 * 注意:
 *  - HTML と last7.periods.json は必ず対で更新される。片方だけ新しいと
 *    盤面の貼り替え先が合わず壊れるので、**中身が変わったら知らせて
 *    読み込み直させる**(部分的に混ぜない)。
 *  - 日付フォルダ配下(履歴)はキャッシュしない。容量が際限なく増えるため。
 */
const VER = "shimaheat-v6";
/** 毎晩内容が変わる物(=必ず最新を取りに行く)。
 *  notice.json(新台入替の告知・2026-08-02新設)は毎日のチェックが書き換えるのでここへ。
 *  圏外でも前回の告知は出したいので保存はするが、優先はいつもネットワーク。 */
const FRESH = ["/atsuta/last7", "/atsuta/last7.html",
               "/atsuta/last7.data.js", "/atsuta/last7.periods.json",
               "/atsuta/notice.json",
               // 記念日の実績(2026-08-04新設)。毎日の差枚から作り直すので最新を取る。
               "/atsuta/kinenbi_result.json"];
/* データとUIの分離(2026-08-02)。app.js / app.css は **内容ハッシュ付きのURL**
 * (?v=xxxxxxxx)で読まれるので、中身が変われば必ずURLも変わる=保存済み優先でよい。
 * ただし照合は **完全一致** にすること。他と同じ ignoreSearch:true にすると
 * 古い ?v の保存分が新しい要求に当たり、UIを直しても端末に届かない。 */
const ASSETS = ["/atsuta/app.js", "/atsuta/app.css"];
const NET_TIMEOUT = 2500;   // これを超えたら保存済みを出す(ホール内の弱い電波を想定)
const CORE = [
  "/atsuta/last7",
  "/atsuta/last7.data.js",
  "/atsuta/last7.periods.json",
  "/atsuta/manifest.json",
  "/atsuta/icons/icon-192.png",
  "/atsuta/icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  // 1つでも取れないものがあっても止めない(アイコンの有無は環境差がある)。
  e.waitUntil(
    caches.open(VER).then((c) =>
      Promise.all(CORE.map((u) => c.add(u).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** 変わったことを開いている画面へ知らせる。 */
function tellClients() {
  return self.clients.matchAll({ type: "window" }).then((cs) => {
    cs.forEach((c) => c.postMessage({ type: "content-updated" }));
  });
}

/** 対象にするURLか(このアプリ本体のみ。履歴フォルダは含めない)。 */
function isTarget(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  if (/^\/atsuta\/\d{4}-\d{2}-\d{2}\//.test(p)) return false;   // 履歴は対象外
  return FRESH.indexOf(p) >= 0 || ASSETS.indexOf(p) >= 0
      || p === "/atsuta/manifest.json" || p.startsWith("/atsuta/icons/");
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (!isTarget(url)) return;

  const fresh = FRESH.indexOf(url.pathname) >= 0;
  // 内容ハッシュ付きのUI(app.js/app.css)だけは ?v= まで含めて照合する。
  const asset = ASSETS.indexOf(url.pathname) >= 0;
  e.respondWith(
    caches.open(VER).then((cache) =>
      cache.match(req, { ignoreSearch: !asset }).then((hit) => {
        // ネットワークから取り直す。取れたらキャッシュも更新する。
        const net = fetch(req, fresh ? { cache: "no-store" } : undefined)
          .then((res) => {
            if (!res || !res.ok) return null;
            cache.put(req, res.clone()).catch(() => null);
            return res;
          }).catch(() => null);

        if (!fresh) {
          // 変わらない物(アイコン・manifest)は保存済み優先=速い。
          if (hit) { e.waitUntil(net); return hit; }
          return net.then((r) => r || new Response("offline", { status: 504 }));
        }
        // 毎晩変わる物は「まずネットワーク・遅ければ保存済み」。
        if (!hit) {
          return net.then((r) => r || new Response("offline", { status: 504 }));
        }
        return new Promise((resolve) => {
          let done = false;
          const timer = setTimeout(() => {
            if (!done) { done = true; resolve(hit.clone()); e.waitUntil(net); }
          }, NET_TIMEOUT);
          net.then((r) => {
            clearTimeout(timer);
            if (done) return;          // すでに保存済みを返した後
            done = true;
            resolve(r || hit.clone());
          });
        });
      })
    )
  );
});

/** ページからの合図。
 *  - assets  … このページが実際に読んだ app.js / app.css の**版つきURL**を保存する
 *              (2026-08-02のデータとUIの分離。SWは登録が初回描画の後なので、
 *               最初の読み込みはSWを通っておらず保存されない=圏外で開けなくなる)
 *  - refresh … 更新ボタン。保存済みを捨てて取り直す。 */
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "assets" && Array.isArray(e.data.urls)) {
    e.waitUntil(
      caches.open(VER).then((cache) =>
        Promise.all(e.data.urls.map((u) => {
          let p;
          try { p = new URL(u, self.location.href).pathname; } catch (err) { return null; }
          if (ASSETS.indexOf(p) < 0 && FRESH.indexOf(p) < 0) return null;
          return cache.match(u, { ignoreSearch: false }).then((hit) =>
            hit ? null : fetch(u).then((r) => (r && r.ok ? cache.put(u, r) : null)));
        })).catch(() => null))
    );
    return;
  }
  if (!e.data || e.data.type !== "refresh") return;
  e.waitUntil(
    caches.open(VER).then((cache) =>
      Promise.all(FRESH.concat(CORE).map((u) =>
        fetch(u, { cache: "no-store" })
          .then((r) => (r && r.ok ? cache.put(u, r) : null))
          .catch(() => null)))
    ).then(() => {
      if (e.source && e.source.postMessage) e.source.postMessage({ type: "refreshed" });
    })
  );
});
