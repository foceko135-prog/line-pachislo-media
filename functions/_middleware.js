/**
 * アクセス記録(2026-08-03新設・谷川氏指示「アクセスされたIPが何回アクセスしていたか
 * IPごとにまとめる」)。
 *
 * なぜ自前で書くか:
 *   Cloudflareの標準のアクセス解析(Web Analytics)はプライバシー設計上、
 *   IP単位の内訳を出さない。今回知りたいのは「知っているはずの2人以外が
 *   開いていないか」なので、IPごとの回数が要る。だから自分で数える。
 *
 * 数え方:
 *   ページを開いた時だけ1回。app.js・app.css・last7.data.js・アイコン等の
 *   取得は数えない(1回の閲覧で何十件も増えて意味が無くなるため)。
 *   保存先はKV(バインディング名 HITS)。1つのIPにつき1つのキー。
 *
 * 失敗しても表示は絶対に止めない:
 *   記録は waitUntil で応答の後ろへ回し、全体を try/catch で囲う。
 *   HITS が結び付いていない環境(ローカル等)では何もしない。
 */

const PAGE_EXT = /\.(js|css|json|png|jpg|jpeg|webp|svg|ico|map|txt|xml|woff2?)$/i;

export async function onRequest(context) {
  const { request, env, next, waitUntil } = context;
  const res = await next();
  try {
    if (request.method === "GET" && env && env.HITS) {
      const url = new URL(request.url);
      // 拡張子付き=部品の取得。それ以外と .html だけを「ページを開いた」とみなす。
      const isPage = !PAGE_EXT.test(url.pathname) || /\.html$/i.test(url.pathname);
      // /hit は PULSE のアクセス記録の受け口(functions/hit.js)。人がシマヒートを
      // 開いた回数ではないので、ここでは数えない(数えると両方に二重で入る)。
      const isHit = url.pathname === "/hit" || url.pathname === "/hit/";
      if (isPage && !isHit) waitUntil(record(request, env, url));
    }
  } catch (e) {
    // 記録の失敗で画面を壊さない。
  }
  return res;
}

/** 日本時間の YYYY-MM-DD。UTCのままだと朝9時前が前日になり、日別が1日ずれる。 */
function jstDate(d) {
  const t = new Date(d.getTime() + 9 * 3600 * 1000);
  return t.toISOString().slice(0, 16).replace("T", " ");
}

async function record(request, env, url) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua = (request.headers.get("User-Agent") || "").slice(0, 160);
  const cf = request.cf || {};
  const now = new Date();
  const stamp = jstDate(now);          // "2026-08-03 04:55"
  const day = stamp.slice(0, 10);

  // 巡回ロボットは分けて数える(消さない。誰が来ているかの手掛かりになるため)。
  const bot = /bot|crawler|spider|slurp|facebookexternalhit|discordbot|line\/|preview|curl|python|headless/i
    .test(ua);

  const key = "ip:" + ip;
  let v;
  try {
    v = await env.HITS.get(key, { type: "json" });
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
  v.ua = ua;                                   // 端末を変えたら分かるよう最新で上書き
  v.bot = v.bot || bot;
  v.country = cf.country || v.country;
  v.city = cf.city || v.city;
  v.asn = cf.asOrganization || v.asn;
  v.days[day] = (v.days[day] || 0) + 1;
  const p = url.pathname.slice(0, 60);
  v.paths[p] = (v.paths[p] || 0) + 1;

  await env.HITS.put(key, JSON.stringify(v));
}
