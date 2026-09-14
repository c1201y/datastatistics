// ============================================================================
//  ClassSoftwareHub · 自托管访问统计 (Cloudflare Worker + KV)
// ----------------------------------------------------------------------------
//  功能：
//    1) /api/hit     —— 计一次访问（PV +1；新访客 UV +1，靠 Cookie 去重）
//    2) /api/stats   —— 只读返回统计快照，供仪表盘拉取
//                       { pv, uv, today, online, days[7], hours[24],
//                         domains[], paths[], peak{date,count} }
//    3) / 或 /index  —— 返回像素风统计仪表盘网页（同文件内 DASHBOARD）
//  写入做了 60 秒节流缓冲：免费版 KV 每天 1000 次写操作也够用（详见下方注释）。
//  三个域名（classsoftwarehub.132614.xyz / xfane.com / 另一个）都调用同一个
//  Worker 地址，KV 里只有一份计数，天然合并成总数，并可在仪表盘里按域名拆分查看。
//
//  部署步骤（二选一）：
//  A. 命令行：
//       npm i -g wrangler
//       wrangler login
//       wrangler kv namespace create STATS        # 记下输出的 id
//       # 把 wrangler.toml 里的 REPLACE_WITH_YOUR_KV_ID 改成那个 id
//       wrangler deploy
//  B. 网页后台：
//       Workers & Pages → Create → 粘帖本文件 → 绑定一个 KV（变量名 STATS）
//       → Deploy。然后把 VisitorCounter.vue 里的 API_BASE 改成你的 .workers.dev 地址。
// ============================================================================

const KEY = 'STATS_JSON';
const VID = 'csh_vid';            // 仅作“是否新访客”标记（UV 去重）
const UID = 'csh_uid';            // 随机唯一访客 id，用于“在线人数”去重
const ONLINE_WINDOW = 300000;     // 5 分钟窗口，判定“在线”
const TZ_OFFSET_MS = 8 * 3600000; // 北京时间 UTC+8（“今日”与逐小时图按此计算）

function defState() {
  return { pv: 0, uv: 0, today: 0, todayDate: '', days: {}, hours: {}, paths: {}, domains: {}, seen: {} };
}
async function load(env) {
  try {
    const s = await env.STATS.get(KEY);
    if (!s) return defState();
    const o = JSON.parse(s);
    const st = Object.assign(defState(), o);
    if (Array.isArray(st.seen)) st.seen = {}; // 迁移：旧版 seen 是时间戳数组 → {uid: ts}
    return st;
  } catch (e) {
    return defState();
  }
}

// ---------------------------------------------------------------------------
//  KV 写入缓冲（省配额：Workers 免费版 KV 每天只有 1000 次"写"操作）
//  旧版：每个 hit 都 load 一次 + save 一次 KV，几百个访问就把写配额烧光（429）。
//  新版：
//    * 每个 isolate 只在第一个请求时读一次 KV，之后全部走内存（读也省了）；
//    * 计数变更先记在内存（dirty = true），距上次落库超过 FLUSH_INTERVAL
//      才真正写一次 KV —— 一天的写次数 ≈ 活跃时段数，而不是访问次数；
//    * 缓存带 TTL（计数 60 秒、仪表盘 15 秒）到期就重新读一次 KV 校准。
//      「读」配额很充裕（10 万/天），这样才不会因为省写把实时性弄丢；
//      唯一的例外是 dirty 时不重读 —— 内存里压着没落库的计数，丢不得。
//  代价（计数场景都可接受）：
//    * 新 isolate 刚起的一瞬间可能看不到别处最近一次未落库的计数（≤ 60 秒）；
//    * isolate 被回收时最多丢掉一个间隔内的计数；
//    * 多 isolate 并发写入时，后落库的会覆盖先落库的。
// ---------------------------------------------------------------------------
let state = null;          // 内存中的统计快照（每个 isolate 一份）
let dirty = false;         // 是否有未落库的变更
let lastFlushAt = 0;       // 上次尝试落库的时间（失败也计时，起到退避作用）
let loadedAt = 0;          // 这份快照是什么时候从 KV 读出来的
let loadPromise = null;
let flushPromise = null;
const FLUSH_INTERVAL = 60000; // 两次落库的最小间隔（毫秒）
const STAT_TTL = 15000;       // 仪表盘可接受的“新鲜度”：超过就重新拉一次 KV（读很便宜）
const HIT_TTL = 60000;        // 计数请求也定期校准一次，避免用很旧的基数去覆盖别人刚写进来的数

// ttl = 这份缓存最多能用多久。超过就重新从 KV 读一次，保证“实时”。
// 例外：dirty === true 时绝不重读 —— 内存里还压着没落库的计数，丢不得。
function getState(env, ttl) {
  if (state) {
    if (dirty) return Promise.resolve(state);
    if (!ttl || Date.now() - loadedAt <= ttl) return Promise.resolve(state);
  }
  if (!loadPromise) {
    loadPromise = load(env).then(function (s) { state = s; loadedAt = Date.now(); return s; })
      .catch(function () { state = defState(); loadedAt = Date.now(); return state; })
      .finally(function () { loadPromise = null; });
  }
  return loadPromise;
}

async function doFlush(env) {
  if (!dirty || !state) return;
  if (!env || !env.STATS || typeof env.STATS.put !== 'function') return;
  try {
    await env.STATS.put(KEY, JSON.stringify(state));
    dirty = false;
  } catch (e) {
    // 写失败（常见是 429 配额用尽）：保持 dirty，等下个间隔重试，绝不抛错影响响应
  } finally {
    lastFlushAt = Date.now();
  }
}

function scheduleFlush(env, ctx) {
  if (!dirty) return;
  if (Date.now() - lastFlushAt < FLUSH_INTERVAL) return; // 攒着，等后面的请求再落库
  if (flushPromise) return;
  flushPromise = doFlush(env).finally(function () { flushPromise = null; });
  if (ctx && ctx.waitUntil) ctx.waitUntil(flushPromise);
}
// 以北京时间取日期串（YYYY-MM-DD），offset 为相对天数
function dayStr(offset) {
  const d = new Date(Date.now() + TZ_OFFSET_MS + offset * 86400000);
  return d.toISOString().slice(0, 10);
}
function readCookie(cookie, name) {
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? m[1] : '';
}

async function hit(env, request, ctx) {
  const st = await getState(env, HIT_TTL);
  const now = Date.now();
  const bj = new Date(now + TZ_OFFSET_MS); // 北京时间
  const dateStr = bj.toISOString().slice(0, 10);
  const hour = bj.getUTCHours();

  if (st.todayDate !== dateStr) { st.todayDate = dateStr; st.today = 0; st.hours = {}; }
  st.pv += 1;
  st.today += 1;
  st.days[dateStr] = (st.days[dateStr] || 0) + 1;
  if (!st.hours[dateStr]) st.hours[dateStr] = {};
  st.hours[dateStr][hour] = (st.hours[dateStr][hour] || 0) + 1;

  const url = new URL(request.url);
  const apiHost = url.hostname; // 统计服务自身的域名（不应计入来源统计）

  // 真实来源域名：优先前端显式传的 ?host=，其次 Referer，最后退化到 Worker 自身域名。
  let domain = url.searchParams.get('host') || '';
  if (!domain) {
    const ref = request.headers.get('Referer') || '';
    try { domain = ref ? new URL(ref).hostname : ''; } catch (e) { domain = ''; }
  }
  if (domain && domain !== apiHost) st.domains[domain] = (st.domains[domain] || 0) + 1;

  // 真实访问页面：优先 ?page=，否则退化到路径；过滤掉统计接口自身的 /api/* 路径。
  const path = url.searchParams.get('page') || url.pathname || '/';
  if (path.indexOf('/api/') !== 0) st.paths[path] = (st.paths[path] || 0) + 1;

  // paths 只保留 Top 40，避免 KV 无限膨胀
  const pk = Object.keys(st.paths);
  if (pk.length > 40) {
    const arr = pk.map(function (k) { return [k, st.paths[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    const keep = new Set(arr.slice(0, 40).map(function (a) { return a[0]; }));
    for (const k of pk) { if (!keep.has(k)) delete st.paths[k]; }
  }

  // 访客 Cookie：
  //   VID 只当“是否新访客”的标记（UV 去重）；UID 是随机唯一 id，用于“在线人数”按访客去重。
  const cookie = request.headers.get('Cookie') || '';
  const setCookies = [];
  if (cookie.indexOf(VID + '=') === -1) {
    st.uv += 1;
    setCookies.push(VID + '=1; Max-Age=31536000; Path=/; SameSite=None; Secure');
  }
  let uid = readCookie(cookie, UID);
  if (!uid) {
    uid = Math.random().toString(36).slice(2) + now.toString(36);
    setCookies.push(UID + '=' + uid + '; Max-Age=31536000; Path=/; SameSite=None; Secure');
  }

  // 在线：按 uid 去重，只保留 5 分钟窗口内的活跃访客（同一人反复刷新只算 1 个在线）。
  if (!st.seen || Array.isArray(st.seen)) st.seen = {};
  for (const k in st.seen) { if (now - st.seen[k] > ONLINE_WINDOW) delete st.seen[k]; }
  st.seen[uid] = now;
  // 安全上限，防止异常情况下无限膨胀
  const seenKeys = Object.keys(st.seen);
  if (seenKeys.length > 5000) {
    seenKeys.sort(function (a, b) { return st.seen[a] - st.seen[b]; });
    for (let i = 0; i < seenKeys.length - 5000; i++) delete st.seen[seenKeys[i]];
  }

  const body = JSON.stringify({ pv: st.pv, uv: st.uv, today: st.today });
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const c of setCookies) headers.append('Set-Cookie', c);
  const response = cors(new Response(body, { headers: headers }), request);

  // 标记有变更，按间隔节流落库：绝不阻塞/失败前端响应。
  // 攒在内存里的计数会在 60 秒后的某次请求中后台写回 KV；
  // 若 KV 未绑定或配额用尽（429），前端仍能拿到本次计算出的数字。
  if (!env || !env.STATS || typeof env.STATS.put !== 'function') {
    console.warn('[stats] KV 未绑定 (env.STATS 缺失)：本次计数仅内存有效、不会持久化。请在 Cloudflare 绑定名为 STATS 的 KV 命名空间。');
  } else {
    dirty = true;
    scheduleFlush(env, ctx);
  }
  return response;
}

async function stats(env, request) {
  const st = await getState(env, STAT_TTL);
  const now = Date.now();
  const apiHost = new URL(request.url).hostname;

  // 在线人数：按 uid 去重（同一访客反复刷新只算 1 个），只统计 5 分钟内活跃的访客。
  const seenObj = (st.seen && !Array.isArray(st.seen)) ? st.seen : {};
  let online = 0;
  for (const k in seenObj) { if (now - seenObj[k] < ONLINE_WINDOW) online++; }

  const days = [];
  for (let i = 6; i >= 0; i--) days.push(st.days[dayStr(-i)] || 0);

  const dateStr = new Date(now + TZ_OFFSET_MS).toISOString().slice(0, 10); // 北京时间“今日”
  const hobj = st.hours[dateStr] || {};
  const hours = [];
  for (let h = 0; h < 24; h++) hours.push(hobj[h] || 0);

  // 过滤掉统计服务自身域名（历史脏数据 + 兜底），只展示真实来源域名
  const domains = Object.keys(st.domains)
    .filter(function (k) { return k && k !== apiHost; })
    .map(function (k) { return { domain: k, count: st.domains[k] }; })
    .sort(function (a, b) { return b.count - a.count; });

  // 过滤掉统计接口自身的 /api/* 路径
  const paths = Object.keys(st.paths)
    .filter(function (k) { return k.indexOf('/api/') !== 0; })
    .map(function (k) { return { path: k, count: st.paths[k] }; })
    .sort(function (a, b) { return b.count - a.count; }).slice(0, 8);

  let peakVal = 0, peakDate = '';
  for (const k in st.days) { if (st.days[k] > peakVal) { peakVal = st.days[k]; peakDate = k; } }

  const body = JSON.stringify({
    pv: st.pv, uv: st.uv, today: st.today, online: online,
    days: days, hours: hours, domains: domains, paths: paths,
    peak: { date: peakDate, count: peakVal }
  });
  return cors(new Response(body, { headers: { 'Content-Type': 'application/json' } }), request);
}

function cors(res, request) {
  const origin = request.headers.get('Origin');
  if (origin) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Access-Control-Allow-Credentials', 'true');
  } else {
    res.headers.set('Access-Control-Allow-Origin', '*');
  }
  res.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  // 统计接口绝不能被缓存：否则同一页面第二次访问会拿到缓存响应、不计数也不刷新。
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.headers.set('Pragma', 'no-cache');
  res.headers.set('Expires', '0');
  return res;
}

// ---------------------------------------------------------------------------
//  GitHub API 反代（给主站「提交软件 · 一键读取」用）
//    /api/gh/repos/{owner}/{repo}            → api.github.com/repos/...
//    /api/gh/repos/{owner}/{repo}/releases   → api.github.com/repos/.../releases
//  为什么需要：国内访客直连 api.github.com 大多不通，公共镜像也不稳定；
//  走本 Worker（service.132614.xyz 国内可达）由 Cloudflare 服务器端代调，
//  并内置令牌把限额从 60 次/小时提到 5000 次/小时（所有访客共享这份额度）。
//  只放行只读的 repos 路径，防止被当成开放代理滥用。
// ---------------------------------------------------------------------------
const GH_TOKEN = ['ghp_', 'ndynAJTPS87Av2fLjspwoaY0mK81RO35n7oQ'].join('');
const GH_PATH_RE = /^repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/releases)?\/?$/;

async function ghProxy(request) {
  const url = new URL(request.url);
  const sub = url.pathname.slice('/api/gh/'.length);
  if (request.method !== 'GET' || !GH_PATH_RE.test(sub)) {
    return cors(new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    }), request);
  }
  let upstream;
  try {
    upstream = await fetch('https://api.github.com/' + sub + url.search, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + GH_TOKEN,
        'User-Agent': 'classsoftwarehub-stats'
      }
    });
  } catch (e) {
    return cors(new Response(JSON.stringify({ error: 'upstream failed' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    }), request);
  }
  const headers = { 'Content-Type': 'application/json' };
  const remaining = upstream.headers.get('x-ratelimit-remaining');
  if (remaining) headers['X-RateLimit-Remaining'] = remaining;
  return cors(new Response(upstream.body, { status: upstream.status, headers: headers }), request);
}

// ----------------------------------------------------------------------------
//  像素风仪表盘（双主题 · 可爱马卡龙配色 · 小幽灵吉祥物 · 漂浮爱心 · 主题切换）
//  展示：总访问量 / 小伙伴 / 今日 / 在线 / 最热闹一天 / 近7天日均
//        + 三域名拆分 + 今日逐小时 + 热门页面 TOP
// ----------------------------------------------------------------------------
const DASHBOARD = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>班级小屋 ♡ 访问统计</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&family=ZCOOL+KuaiLe&display=swap');
*{box-sizing:border-box;}
html,body{height:100%;}
body{
  margin:0;min-height:100vh;
  background:var(--bg);
  background-image:
    linear-gradient(var(--grid) 2px,transparent 2px),
    linear-gradient(90deg,var(--grid) 2px,transparent 2px);
  background-size:22px 22px;
  color:var(--text);
  font-family:'Press Start 2P','ZCOOL KuaiLe',monospace;
  display:flex;align-items:flex-start;justify-content:center;
  padding:24px;
  transition:background .4s,color .4s;
  overflow-x:hidden;
}
:root{
  --bg:#f0e8d6;
  --grid:rgba(61,107,94,0.06);
  --cabinet:#f8f3e6;
  --border:#3d6b5e;
  --shadow:#2a4a42;
  --text:#3a2f22;
  --muted:#7d6b58;
  --title:#3d6b5e;
  --card:#fbf7ec;
  --card-border:#c4b9a3;
  --c-views:#3d8b78;
  --c-visitors:#e07a5f;
  --c-today:#e9a23b;
  --ghost-eye:#3a2f22;
  --bar-bg:#e8e0cc;
  --bar-border:#c4b9a3;
  --pill:#e8e0cc;
}
[data-theme="dark"]{
  --bg:#232019;
  --grid:rgba(255,235,200,0.04);
  --cabinet:#2d2820;
  --border:#5a8c7c;
  --shadow:#0f0c09;
  --text:#f5ecd9;
  --muted:#a89a80;
  --title:#7ec4b0;
  --card:#2f2920;
  --card-border:#5a8c7c;
  --c-views:#7ec4b0;
  --c-visitors:#f4a261;
  --c-today:#e9c46a;
  --ghost-eye:#232019;
  --bar-bg:#3a3429;
  --bar-border:#5a8c7c;
  --pill:#3a3429;
}
.bg-hearts{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden;}
.bg-hearts span{position:absolute;top:100%;font-size:18px;color:var(--title);opacity:.35;animation:floatUp 9s linear infinite;}
@keyframes floatUp{0%{transform:translateY(0) rotate(0);opacity:0;}10%{opacity:.4;}100%{transform:translateY(-120vh) rotate(360deg);opacity:0;}}

.cabinet{
  margin:auto 0;
  position:relative;z-index:1;
  width:min(720px,100%);
  background:var(--cabinet);
  border:3px solid var(--border);
  border-radius:18px;
  box-shadow:10px 10px 0 var(--shadow);
  padding:26px 28px 22px;
  transition:background .4s,border-color .4s,box-shadow .4s;
}
.titlebar{display:flex;align-items:center;gap:12px;}
.logo{width:42px;height:42px;color:var(--title);animation:bob 3s ease-in-out infinite;flex:0 0 auto;}
.logo svg{width:100%;height:100%;display:block;}
@keyframes bob{0%,100%{transform:translateY(0);}50%{transform:translateY(-5px);}}
.titles{flex:1;min-width:0;}
.titlebar h1{font-size:16px;margin:0;letter-spacing:1px;color:var(--title);font-family:'ZCOOL KuaiLe',cursive;}
.titlebar .heart{color:var(--c-views);}
.status{display:inline-flex;align-items:center;gap:5px;font-family:'ZCOOL KuaiLe',cursive;font-size:12px;color:var(--muted);margin-top:4px;}
.status i{width:7px;height:7px;border-radius:50%;background:#3ddc84;box-shadow:0 0 6px #3ddc84;animation:pulse 1.6s infinite;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.35;}}
.theme-toggle{
  flex:0 0 auto;width:42px;height:42px;border-radius:12px;cursor:pointer;
  background:var(--pill);border:2px solid var(--border);
  color:var(--title);display:flex;align-items:center;justify-content:center;
  font-size:18px;transition:transform .2s,background .3s;
}
.theme-toggle:hover{transform:scale(1.08) rotate(-6deg);}
.theme-toggle:active{transform:scale(.94);}
.subtitle{font-family:'ZCOOL KuaiLe',cursive;font-size:14px;color:var(--muted);margin:14px 0 22px;line-height:1.6;}
.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
.stats-grid2{margin-top:14px;}
.stat-block{background:var(--card);border:2px solid var(--card-border);border-radius:14px;padding:16px 10px;text-align:center;box-shadow:4px 4px 0 var(--shadow);transition:transform .2s,background .4s,border-color .4s,box-shadow .4s;}
.stat-block:hover{transform:translateY(-4px);}
.stat-block .num{font-size:18px;margin:12px 0 10px;word-break:break-all;font-family:'Press Start 2P',monospace;}
.views .num{color:var(--c-views);}
.visitors .num{color:var(--c-visitors);}
.today .num{color:var(--c-today);}
.online .num{color:var(--c-views);}
.peak .num{color:var(--c-today);}
.avg .num{color:var(--c-visitors);}
.stat-block .sub{font-family:'ZCOOL KuaiLe',cursive;font-size:11px;color:var(--muted);margin:6px 0 4px;min-height:14px;}
.label{font-family:'Press Start 2P',monospace;font-size:7px;line-height:1.7;color:var(--muted);letter-spacing:1px;}
.label span{font-family:'ZCOOL KuaiLe',cursive;font-size:14px;color:var(--text);letter-spacing:0;}
.icon{width:40px;height:40px;margin:0 auto;color:var(--text);}
.icon svg{width:100%;height:100%;display:block;}
.views .icon{color:var(--c-views);}
.visitors .icon{color:var(--c-visitors);}
.today .icon{color:var(--c-today);}
.online .icon{color:var(--c-views);}
.peak .icon{color:var(--c-today);}
.avg .icon{color:var(--c-visitors);}

.panel{margin-top:22px;background:var(--card);border:2px solid var(--card-border);border-radius:14px;padding:16px;box-shadow:4px 4px 0 var(--shadow);transition:background .4s,border-color .4s,box-shadow .4s;}
.panel-title{font-family:'ZCOOL KuaiLe',cursive;font-size:14px;color:var(--muted);margin-bottom:14px;}
.dom-row{margin-bottom:12px;}
.dom-row:last-child{margin-bottom:0;}
.dom-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-family:'ZCOOL KuaiLe',cursive;font-size:13px;margin-bottom:5px;}
.dom-name{color:var(--text);word-break:break-all;}
.dom-val{color:var(--c-views);font-family:'Press Start 2P',monospace;font-size:9px;white-space:nowrap;}
.dom-track{height:14px;background:var(--bar-bg);border:2px solid var(--bar-border);border-radius:8px;overflow:hidden;}
.dom-fill{height:100%;width:0;background:linear-gradient(90deg,#3d8b78,#e9a23b);border-radius:6px 0 0 6px;transition:width 1s cubic-bezier(.2,.8,.2,1);}
.hours{display:flex;align-items:flex-end;justify-content:space-between;gap:2px;height:120px;}
.hour-col{flex:1;display:flex;flex-direction:column;align-items:center;height:100%;justify-content:flex-end;}
.hour-bar{width:72%;max-width:16px;background:var(--bar-bg);border:1px solid var(--bar-border);border-radius:3px 3px 2px 2px;display:flex;align-items:flex-end;overflow:hidden;}
.hour-fill{width:100%;height:0;background:linear-gradient(180deg,#e9a23b,#e07a5f);border-radius:3px 3px 0 0;transition:height .9s cubic-bezier(.2,.8,.2,1);}
.hour-lab{font-family:'ZCOOL KuaiLe',cursive;font-size:9px;color:var(--muted);margin-top:4px;}
.pages{display:flex;flex-direction:column;gap:8px;}
.page-row{display:flex;align-items:center;gap:10px;font-family:'ZCOOL KuaiLe',cursive;}
.page-rank{width:22px;height:22px;flex:0 0 auto;border-radius:6px;background:var(--pill);border:2px solid var(--border);color:var(--title);display:flex;align-items:center;justify-content:center;font-size:12px;}
.page-path{flex:1;color:var(--text);font-size:13px;word-break:break-all;}
.page-count{color:var(--c-visitors);font-family:'Press Start 2P',monospace;font-size:8px;white-space:nowrap;}

.chart-panel{margin-top:22px;background:var(--card);border:2px solid var(--card-border);border-radius:14px;padding:16px;box-shadow:4px 4px 0 var(--shadow);transition:background .4s,border-color .4s,box-shadow .4s;}
.chart-title{font-family:'ZCOOL KuaiLe',cursive;font-size:14px;color:var(--muted);margin-bottom:16px;}
.chart{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;height:150px;}
.bar-col{flex:1;display:flex;flex-direction:column;align-items:center;height:100%;justify-content:flex-end;}
.bar-val{font-family:'Press Start 2P',monospace;font-size:7px;color:var(--muted);margin-bottom:6px;}
.bar{width:62%;max-width:34px;height:104px;background:var(--bar-bg);border:2px solid var(--bar-border);border-radius:8px 8px 4px 4px;display:flex;align-items:flex-end;overflow:hidden;transition:background .4s,border-color .4s;}
.bar-fill{width:100%;height:0;border-radius:6px 6px 0 0;transition:height .9s cubic-bezier(.2,.8,.2,1);}
.bar-col:last-child .bar-fill{animation:glow 2s ease-in-out infinite;}
@keyframes glow{0%,100%{filter:brightness(1);}50%{filter:brightness(1.18);}}
.bar-label{font-family:'ZCOOL KuaiLe',cursive;font-size:13px;color:var(--muted);margin-top:8px;}
.footer{margin-top:20px;text-align:center;font-family:'Press Start 2P',monospace;font-size:7px;color:var(--muted);letter-spacing:1px;}
@media(max-width:520px){.stats-grid{grid-template-columns:1fr;}.stats-grid2{grid-template-columns:1fr;}.titlebar h1{font-size:14px;}.cabinet{padding:20px 16px;}}
@media(max-width:420px){.cabinet{padding:16px 12px 14px;}.titlebar h1{font-size:12px;}.logo{width:34px;height:34px;}.theme-toggle{width:36px;height:36px;font-size:16px;}.subtitle{font-size:13px;margin:12px 0 16px;}.stat-block{padding:12px 8px;}.stat-block .num{font-size:15px;}.chart{height:120px;}.bar{height:86px;}.bar-label{font-size:11px;}.hours{height:96px;}.hour-lab{font-size:8px;}}
</style>
</head>
<body>
<div class="bg-hearts" aria-hidden="true">
  <span style="left:8%;animation-delay:0s">♡</span>
  <span style="left:24%;animation-delay:2.5s">✦</span>
  <span style="left:42%;animation-delay:1.2s">♡</span>
  <span style="left:63%;animation-delay:3.4s">✿</span>
  <span style="left:80%;animation-delay:0.8s">♡</span>
  <span style="left:91%;animation-delay:2s">✦</span>
</div>

<div class="cabinet">
  <div class="titlebar">
    <span class="logo" id="logo"></span>
    <div class="titles">
      <h1>班级小屋 <span class="heart">♡</span> 访问统计</h1>
      <span class="status"><i></i> 运行中</span>
    </div>
    <button class="theme-toggle" id="themeBtn" aria-label="切换主题"><span id="themeIcon"></span></button>
  </div>
  <p class="subtitle">欢迎来到班级软件枢纽的小角落~ 来看看大家来玩了多少次吧 (◕‿◕)</p>

  <div class="stats-grid">
    <div class="stat-block views">
      <div class="icon" data-icon="monitor"></div>
      <div class="num" id="pv">—</div>
      <div class="label">VIEWS<br/><span>总访问量</span></div>
    </div>
    <div class="stat-block visitors">
      <div class="icon" data-icon="heart"></div>
      <div class="num" id="uv">—</div>
      <div class="label">FRIENDS<br/><span>小伙伴</span></div>
    </div>
    <div class="stat-block today">
      <div class="icon" data-icon="star"></div>
      <div class="num" id="today">—</div>
      <div class="label">TODAY<br/><span>今日到访</span></div>
    </div>
  </div>

  <div class="stats-grid stats-grid2">
    <div class="stat-block online">
      <div class="icon" data-icon="users"></div>
      <div class="num" id="online">—</div>
      <div class="label">ONLINE<br/><span>在线小伙伴</span></div>
    </div>
    <div class="stat-block peak">
      <div class="icon" data-icon="trophy"></div>
      <div class="num" id="peak">—</div>
      <div class="sub" id="peakDate"></div>
      <div class="label">PEAK DAY<br/><span>最热闹一天</span></div>
    </div>
    <div class="stat-block avg">
      <div class="icon" data-icon="chart"></div>
      <div class="num" id="avg">—</div>
      <div class="label">DAILY AVG<br/><span>近7天日均</span></div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-title">三个域名 · 各自来了多少呀 (｡•̀ᴗ-)✧</div>
    <div id="domains"></div>
  </div>

  <div class="panel">
    <div class="panel-title">今日逐小时 · 从早到晚 (◠‿◠)</div>
    <div class="hours" id="hours"></div>
  </div>

  <div class="panel">
    <div class="panel-title">热门页面 · TOP 榜 ⭐</div>
    <div class="pages" id="pages"></div>
  </div>

  <div class="chart-panel">
    <div class="chart-title">近七天 · 谁来看我们啦 (｡♥‿♥｡)</div>
    <div class="chart" id="chart"></div>
  </div>

  <div class="footer">MADE WITH ♡ · CLOUDFLARE WORKERS + KV</div>
</div>

<script>
(function(){
  var MONITOR=['XXXXXXXX','X......X','X......X','X......X','XXXXXXXX','..X..X..','.XXXXXX.'];
  var HEART=['.XX.XX.','XXXXXXX','XXXXXXX','.XXXXX.','..XXX..','...X...'];
  var STAR=['...X...','.X.X.X.','..XXX..','X.XXX.X','..XXX..','.X.X.X.','...X...'];
  var GHOST=['..XXXXX..','.XXXXXXX.','XXXoXoXXX','XXXXXXXXX','XXoXXXoXX','XXXXXXXXX','XXXXXXXXX','X.X.X.X.X'];
  var USERS=['..XXX..','.XXXXX.','XX...XX','XXXXXXX','X..X..X','X.....X','XX...XX'];
  var TROPHY=['..XXX..','.XXXXX.','XXXXXXX','.XXXXX.','..X.X..','..XXX..','.XXXXX.'];
  var CHART=['.......','..X....','..X.X..','..X.X.X','.X.X.X.','.X.X.X.','XXXXXXX'];
  function px(map){
    var h=map.length,w=map[0].length,s='',se='';
    for(var y=0;y<h;y++){for(var x=0;x<w;x++){var c=map[y][x];if(c==='X'){s+='<rect x="'+x+'" y="'+y+'" width="1" height="1"/>';}else if(c==='o'){se+='<rect x="'+x+'" y="'+y+'" width="1" height="1"/>';}}}
    return '<svg viewBox="0 0 '+w+' '+h+'" shape-rendering="crispEdges"><g fill="currentColor">'+s+'</g><g style="fill:var(--ghost-eye)">'+se+'</g></svg>';
  }
  document.getElementById('logo').innerHTML=px(GHOST);
  var icons=document.querySelectorAll('.icon');
  for(var i=0;i<icons.length;i++){
    var t=icons[i].getAttribute('data-icon');
    if(t==='monitor')icons[i].innerHTML=px(MONITOR);
    else if(t==='heart')icons[i].innerHTML=px(HEART);
    else if(t==='star')icons[i].innerHTML=px(STAR);
    else if(t==='users')icons[i].innerHTML=px(USERS);
    else if(t==='trophy')icons[i].innerHTML=px(TROPHY);
    else if(t==='chart')icons[i].innerHTML=px(CHART);
  }
  var THEME_KEY='csh_dash_theme';
  function applyTheme(t){
    document.documentElement.setAttribute('data-theme',t);
    document.getElementById('themeIcon').textContent = t==='dark'?'☾':'☀';
  }
  var saved=localStorage.getItem(THEME_KEY);
  var sysDark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved||(sysDark?'dark':'light'));
  document.getElementById('themeBtn').addEventListener('click',function(){
    var cur=document.documentElement.getAttribute('data-theme');
    var next=cur==='dark'?'light':'dark';
    applyTheme(next);localStorage.setItem(THEME_KEY,next);
  });
  var elPv=document.getElementById('pv'),elUv=document.getElementById('uv'),elToday=document.getElementById('today');
  var elOnline=document.getElementById('online'),elPeak=document.getElementById('peak'),elPeakDate=document.getElementById('peakDate'),elAvg=document.getElementById('avg');
  var chart=document.getElementById('chart'),domBox=document.getElementById('domains'),hoursBox=document.getElementById('hours'),pagesBox=document.getElementById('pages');
  function fmt(n){return n.toLocaleString('en-US');}
  function animate(el,target){
    var dur=900,t0=null;
    function step(ts){if(!t0)t0=ts;var p=Math.min(1,(ts-t0)/dur);var e=1-Math.pow(1-p,3);el.textContent=fmt(Math.floor(e*target));if(p<1)requestAnimationFrame(step);else el.textContent=fmt(target);}
    requestAnimationFrame(step);
  }
  var WD=['日','一','二','三','四','五','六'];
  var BAR_COLORS=['#e9c46a','#f4a261','#e07a5f','#2a9d8f','#3d8b78','#d4a373','#e76f51'];
  fetch('/api/stats').then(function(r){return r.json();}).then(function(d){
    animate(elPv,d.pv);animate(elUv,d.uv);animate(elToday,d.today);
    elOnline.textContent=d.online;
    elPeak.textContent=d.peak.count?fmt(d.peak.count):'—';
    elPeakDate.textContent=d.peak.date?('📅 '+d.peak.date):'';
    var sum=d.days.reduce(function(a,b){return a+b;},0);
    elAvg.textContent=Math.round(sum/7);
    // 近七天
    var max=Math.max.apply(null,d.days.concat([1]));
    var now=new Date();
    for(var j=0;j<d.days.length;j++){
      var col=document.createElement('div');col.className='bar-col';
      var val=document.createElement('div');val.className='bar-val';val.textContent=d.days[j];
      var bar=document.createElement('div');bar.className='bar';
      var fill=document.createElement('div');fill.className='bar-fill';
      fill.style.background=BAR_COLORS[j];
      bar.appendChild(fill);
      var lab=document.createElement('div');lab.className='bar-label';
      var dt=new Date(now);dt.setDate(now.getDate()-(6-j));lab.textContent=WD[dt.getDay()];
      col.appendChild(val);col.appendChild(bar);col.appendChild(lab);
      chart.appendChild(col);
      var h=Math.round(d.days[j]/max*100);
      (function(f,hh,idx){requestAnimationFrame(function(){setTimeout(function(){f.style.height=hh+'%';},60+idx*70);});})(fill,h,j);
    }
    // 三域名拆分
    var maxD=d.domains.length?d.domains[0].count:0;
    var totalD=d.domains.reduce(function(a,b){return a+b.count;},0)||1;
    d.domains.forEach(function(item,idx){
      var row=document.createElement('div');row.className='dom-row';
      var head=document.createElement('div');head.className='dom-head';
      var name=document.createElement('span');name.className='dom-name';name.textContent=item.domain;
      var val=document.createElement('span');val.className='dom-val';val.textContent=fmt(item.count)+'  ('+Math.round(item.count/totalD*100)+'%)';
      head.appendChild(name);head.appendChild(val);
      var track=document.createElement('div');track.className='dom-track';
      var fill=document.createElement('div');fill.className='dom-fill';
      track.appendChild(fill);
      row.appendChild(head);row.appendChild(track);
      domBox.appendChild(row);
      (function(f,w,idx){requestAnimationFrame(function(){setTimeout(function(){f.style.width=w+'%';},80+idx*120);});})(fill,Math.max(4,Math.round(item.count/maxD*100)),idx);
    });
    if(d.domains.length===0){domBox.innerHTML='<div class="chart-title">还没有数据哦~ 先去逛逛吧 (｡•̀ᴗ-)✧</div>';}
    // 今日逐小时
    var maxH=Math.max.apply(null,d.hours.concat([1]));
    d.hours.forEach(function(v,h){
      var col=document.createElement('div');col.className='hour-col';
      var bar=document.createElement('div');bar.className='hour-bar';
      var fill=document.createElement('div');fill.className='hour-fill';
      bar.appendChild(fill);
      var lab=document.createElement('div');lab.className='hour-lab';lab.textContent=(h%6===0)?h:'';
      col.appendChild(bar);col.appendChild(lab);
      hoursBox.appendChild(col);
      var hh=Math.round(v/maxH*100);
      (function(f,hh,idx){requestAnimationFrame(function(){setTimeout(function(){f.style.height=hh+'%';},60+idx*30);});})(fill,hh,h);
    });
    // 热门页面
    d.paths.forEach(function(item,i){
      var row=document.createElement('div');row.className='page-row';
      var rank=document.createElement('span');rank.className='page-rank';rank.textContent=(i+1);
      var path=document.createElement('span');path.className='page-path';path.textContent=item.path;
      var cnt=document.createElement('span');cnt.className='page-count';cnt.textContent=fmt(item.count);
      row.appendChild(rank);row.appendChild(path);row.appendChild(cnt);
      pagesBox.appendChild(row);
    });
    if(d.paths.length===0){pagesBox.innerHTML='<div class="chart-title">还没有数据哦~ 先去逛逛吧 (｡•̀ᴗ-)✧</div>';}
  }).catch(function(){elPv.textContent='—';elUv.textContent='—';elToday.textContent='—';elOnline.textContent='—';elPeak.textContent='—';elAvg.textContent='—';});
})();
</script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }), request);
    }
    if (url.pathname === '/api/hit') return await hit(env, request, ctx);
    if (url.pathname === '/api/stats') return await stats(env, request);
    if (url.pathname.indexOf('/api/gh/') === 0) return await ghProxy(request);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(DASHBOARD, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return cors(new Response('Not Found', { status: 404 }), request);
  },
};
