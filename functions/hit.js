/**
 * PULSE のアクセス記録の受け口(2026-08-03新設)。
 *
 * なぜここに置くか:
 *   PULSE本体は GitHub Pages(foceko135-prog.github.io)にあり、サーバー側で数える
 *   手段が無い。本来は PULSE 専用の Worker(pulse-radio)に置きたかったが、
 *   手元のCloudflare APIトークンに Workers Scripts の編集権限が無く出せなかった。
 *   Pages(pachi-media)なら同じトークンで出せるので、当面ここで受ける。
 *   ※将来トークンに Workers Scripts:Edit を足したら、cf-pulse-worker 側の
 *     ?s=hit(実装済み・未デプロイ)へ移してよい。その時はここを消す。
 *
 * 数え方も保存の形も、シマヒート/トリノメの _middleware.js と同じ。
 * 1つのIPにつき1つのキー、回数/初回/最終/国/都市/回線/端末/日別/ページ別。
 * 保存先は KV バインディング PULSE_HITS(名前空間 pulse_hits)。
 *
 * 呼び出し方(PULSE側):
 *   fetch("https://pachi-media.pages.dev/hit?p=" + encodeURIComponent(location.pathname))
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
};

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  try {
    if (request.method === "GET" && env && env.PULSE_HITS) {
      waitUntil(record(request, env, new URL(request.url)));
    }
  } catch (e) {
    // 記録の失敗は無視する。呼び出し側には常に成功を返す。
  }
  return new Response('{"ok":true}', { status: 200, headers: CORS });
}

/** 日本時間の "YYYY-MM-DD HH:MM"。UTCのままだと朝9時前が前日になり日別が1日ずれる。 */
function jstStamp(d) {
  const t = new Date(d.getTime() + 9 * 3600 * 1000);
  return t.toISOString().slice(0, 16).replace("T", " ");
}

async function record(request, env, url) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua = (request.headers.get("User-Agent") || "").slice(0, 160);
  const cf = request.cf || {};
  const stamp = jstStamp(new Date());
  const day = stamp.slice(0, 10);

  const bot = /bot|crawler|spider|slurp|facebookexternalhit|discordbot|line\/|preview|curl|python|headless/i
    .test(ua);

  const key = "ip:" + ip;
  let v;
  try {
    v = await env.PULSE_HITS.get(key, { type: "json" });
  } catch (e) {
    v = null;
  }
  if (!v) {
    v = {
      ip,
      n: 0,
      first: stamp,
      last: stamp,
      bot,
      ua,
      country: cf.country || "",
      city: cf.city || "",
      asn: cf.asOrganization || "",
      days: {},
      paths: {},
    };
  }
  v.n += 1;
  v.last = stamp;
  v.ua = ua;
  v.bot = v.bot || bot;
  v.country = cf.country || v.country;
  v.city = cf.city || v.city;
  v.asn = cf.asOrganization || v.asn;
  v.days[day] = (v.days[day] || 0) + 1;
  const p = (url.searchParams.get("p") || "/").slice(0, 60);
  v.paths[p] = (v.paths[p] || 0) + 1;

  await env.PULSE_HITS.put(key, JSON.stringify(v));
}
