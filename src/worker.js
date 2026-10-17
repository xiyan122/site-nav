/**
 * 站点导航 · Cloudflare Worker 版
 * 静态托管 + 数据 API + 管理后台 + 定时扫描，一个 Worker 全包。
 *
 * KV 键：
 *   config   -> { owners:[], extraSites:[], exclude:[], ghToken:"", adminPassword:"" }
 *   sites    -> { updated_at, sites:[...] }
 *   scan_log -> { time, trigger, lines:[], summary }
 *   session:{token} -> { exp }
 */

const UA = "site-nav-worker";
const SESSION_TTL = 7 * 24 * 3600; // 7 天

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

// ---------- KV 工具 ----------
async function kvGetJSON(env, key, fallback) {
  const v = await env.NAV_KV.get(key);
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
async function kvPut(env, key, value) {
  await env.NAV_KV.put(key, JSON.stringify(value));
}

function seedConfig(env) {
  let seedOwners = [];
  let seedSites = [];
  try { seedOwners = String(env.SEED_OWNERS || "").split(",").map(s => s.trim()).filter(Boolean); } catch { /* 忽略 */ }
  try { seedSites = JSON.parse(env.SEED_SITES || "[]"); } catch { /* 忽略 */ }
  return {
    owners: [env.OWNER, ...seedOwners.filter(o => o.toLowerCase() !== String(env.OWNER).toLowerCase())],
    extraSites: seedSites,
  };
}

async function getConfig(env) {
  const cfg = await kvGetJSON(env, "config", {});
  if (!cfg.__init) {
    // 首次运行：写入种子配置（wrangler.toml 的 SEED_* 变量），此后以 KV 中的配置为准
    const seed = seedConfig(env);
    if (!Array.isArray(cfg.owners)) cfg.owners = seed.owners;
    if (!Array.isArray(cfg.extraSites)) cfg.extraSites = seed.extraSites;
    if (!Array.isArray(cfg.exclude)) cfg.exclude = [];
    if (typeof cfg.ghToken !== "string") cfg.ghToken = "";
    if (typeof cfg.adminPassword !== "string") cfg.adminPassword = "";
    cfg.__init = true;
    await kvPut(env, "config", cfg);
  }
  return {
    owners: cfg.owners,
    extraSites: cfg.extraSites,
    exclude: cfg.exclude,
    ghToken: cfg.ghToken || "",
    adminPassword: cfg.adminPassword || "",
  };
}

// ---------- 探测工具 ----------
const GH = "https://api.github.com";

function ghHeaders(token) {
  const h = { "User-Agent": UA, Accept: "application/vnd.github+json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** 访问页面：手动跟随重定向（最多 3 跳），在线判定 + 识别自定义域名（最终地址） */
async function probe(url) {
  let current = url;
  for (let i = 0; i < 3; i++) {
    let r;
    try {
      r = await fetch(current, { redirect: "manual", headers: { "User-Agent": UA } });
    } catch {
      return { ok: false, final: current };
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return { ok: false, final: current };
      try { current = new URL(loc, current).href; } catch { return { ok: false, final: current }; }
      continue;
    }
    return { ok: r.status >= 200 && r.status < 400, final: current };
  }
  return { ok: false, final: current };
}

/** http:// 尝试升级 https://（加密页面的密码校验依赖安全上下文） */
async function tryHttps(url) {
  if (!url.startsWith("http://")) return url;
  const httpsUrl = url.replace(/^http:/, "https:");
  const { ok } = await probe(httpsUrl);
  return ok ? httpsUrl : url;
}

// ---------- 扫描 ----------
/**
 * 扫描所有账号的 GitHub Pages（100% 覆盖原理：使用 PAT 枚举 /users/{owner}/repos
 * 仓库列表接口——完整且稳定，不依赖滞后的搜索索引；无 PAT 时退化为匿名扫描）。
 */
async function runScan(env, trigger) {
  const cfg = await getConfig(env);
  const token = (env.GH_TOKEN || cfg.ghToken || "").trim();
  const H = ghHeaders(token);
  const lines = [];
  const log = (s) => { lines.push(s); };

  const api = async (path) => {
    try {
      const r = await fetch(GH + path, { headers: H });
      if (!r.ok) { log(`  [api] ${path} -> ${r.status}`); return null; }
      return r.json();
    } catch (e) {
      log(`  [api] ${path} -> ${e.message}`);
      return null;
    }
  };

  // 1) 枚举仓库：/users/{owner}/repos（分页全量）+ search 兜底
  const repos = new Map(); // full_name -> repo
  for (const owner of cfg.owners) {
    for (let page = 1; ; page++) {
      const batch = await api(`/users/${owner}/repos?per_page=100&page=${page}`);
      if (!Array.isArray(batch) || !batch.length) break;
      batch.forEach((r) => { if (r.full_name) repos.set(r.full_name, r); });
      if (batch.length < 100) break;
    }
    const s = await api(`/search/repositories?q=user:${encodeURIComponent(owner)}&per_page=100`);
    (s && s.items || []).forEach((r) => { if (r.full_name && !repos.has(r.full_name)) repos.set(r.full_name, r); });
    log(`账号 ${owner}：枚举完成`);
  }
  log(`共发现 ${repos.size} 个仓库`);

  // 2) 上一次数据（用于兜底保留 + 描述回填）
  const prevData = await kvGetJSON(env, "sites", { sites: [] });
  const prevByKey = new Map(
    (prevData.sites || []).filter((s) => s.status !== "custom")
      .map((s) => [`${(s.owner || "").toLowerCase()}/${s.repo}`, s])
  );

  const selfRepo = `${env.OWNER}.github.io`;
  const seen = new Set();
  const sites = [];

  // 3) 逐仓库构建条目（每个站点只发 1 次探测请求）
  const builds = [];
  for (const repo of repos.values()) {
    if (!repo.has_pages) continue;
    if (repo.name.toLowerCase() === selfRepo.toLowerCase()) continue;
    const owner = (repo.owner && repo.owner.login) || env.OWNER;
    const key = `${owner.toLowerCase()}/${repo.name}`;
    seen.add(key);
    builds.push(buildSite(repo, prevByKey.get(key) || {}));
  }
  const built = await Promise.all(builds);
  sites.push(...built);
  log(`识别出 ${built.length} 个 Pages 站点`);

  // 4) 兜底：上次存在但这次没扫到的（仓库转私有/删除等），保留并复查状态
  for (const [key, old] of prevByKey) {
    if (seen.has(key)) continue;
    if (old.manual) continue; // 手动站点随后台配置增删，不参与兜底
    const host = (() => { try { return new URL(old.url || "").hostname; } catch { return ""; } })();
    const inferred = host.endsWith(".github.io") ? host.split(".")[0] : null;
    const owner = old.owner || inferred || env.OWNER;
    seen.add(key);
    const { ok } = await probe(old.url || "");
    sites.push({ ...old, owner, status: ok ? "online" : "offline" });
    log(`  保留旧数据：${key} (${ok ? "online" : "offline"})`);
  }

  // 5) 手动补充站点（自动发现不了的幽灵站）
  for (const e of cfg.extraSites.filter((x) => !x.cat)) {
    const key = `${(e.owner || env.OWNER).toLowerCase()}/${e.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const url = await tryHttps(e.url);
    const { ok } = await probe(url);
    sites.push({
      repo: e.repo, owner: e.owner || env.OWNER, url,
      description: e.description || "", language: null, topics: [],
      pushed_at: null, status: ok ? "online" : "offline", manual: true,
    });
    log(`  手动站点：${key} -> ${url} (${ok ? "online" : "offline"})`);
  }

  // 6) 自定义收藏（手动管理，标记 custom）
  for (const c of cfg.extraSites.filter((x) => x.cat)) {
    sites.push({
      repo: c.repo, owner: c.owner || env.OWNER, url: c.url,
      description: c.description || "", language: null, topics: [],
      pushed_at: null, status: "custom", cat: c.cat || "collect",
    });
  }

  // 7) 排除名单 + 排序（收藏在前，其余按更新时间倒序）
  const exclude = new Set(cfg.exclude.map((e) => `${(e.owner || "").toLowerCase()}/${e.repo}`));
  const out = sites.filter((s) => !exclude.has(`${(s.owner || "").toLowerCase()}/${s.repo}`));
  out.sort((a, b) => (b.pushed_at || "").localeCompare(a.pushed_at || ""));
  out.sort((a, b) => (a.status === "custom" ? 0 : 1) - (b.status === "custom" ? 0 : 1));

  const data = {
    updated_at: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
    sites: out,
  };
  await kvPut(env, "sites", data);
  const summary = `共 ${out.length} 个站点（自动 ${out.filter((s) => s.status !== "custom").length} + 收藏 ${out.filter((s) => s.status === "custom").length}）`;
  log(summary);
  const logEntry = { time: new Date().toISOString(), trigger, lines, summary };
  await kvPut(env, "scan_log", logEntry);
  return logEntry;
}

async function buildSite(repo, prev) {
  const name = repo.name;
  const owner = (repo.owner && repo.owner.login) || "";
  const isUserSite = name.toLowerCase() === `${owner.toLowerCase()}.github.io`;
  let url = isUserSite ? `https://${owner}.github.io/` : `https://${owner}.github.io/${name}/`;
  const githubHost = `${owner.toLowerCase()}.github.io`;

  // 探测（跟随重定向）：在线状态 + 自定义域名识别一步完成
  const { ok, final } = await probe(url);
  if (ok && final) {
    try {
      const finalHost = new URL(final).hostname.toLowerCase();
      if (finalHost !== githubHost) url = final; // 站点绑定了自定义域名
    } catch { /* 忽略 */ }
  }
  url = await tryHttps(url);

  return {
    repo: name,
    owner,
    url,
    description: repo.description || prev.description || "",
    language: repo.language || null,
    topics: repo.topics || [],
    pushed_at: repo.pushed_at || null,
    status: ok ? "online" : "offline",
  };
}

// ---------- 管理后台鉴权 ----------
function parseCookies(req) {
  const out = {};
  (req.headers.get("Cookie") || "").split(/;\s*/).forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i)] = p.slice(i + 1);
  });
  return out;
}

async function getPassword(env) {
  const cfg = await getConfig(env);
  return env.ADMIN_PASSWORD || cfg.adminPassword || "";
}

async function isAuthed(req, env) {
  const t = parseCookies(req).nav_admin;
  if (!t) return false;
  const s = await kvGetJSON(env, `session:${t}`, null);
  return !!(s && s.exp > Date.now());
}

async function newSession(env) {
  const t = crypto.randomUUID().replace(/-/g, "");
  await env.NAV_KV.put(`session:${t}`, JSON.stringify({ exp: Date.now() + SESSION_TTL * 1000 }), { expirationTtl: SESSION_TTL });
  return t;
}

const AUTH_COOKIE = (t) => `nav_admin=${t}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}; Path=/`;

// ---------- 路由 ----------
async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;

  // 管理后台页面
  if (path === "/admin") {
    return env.ASSETS.fetch(new Request(new URL("/admin.html", url)));
  }

  if (path === "/api/sites" && req.method === "GET") {
    const data = await kvGetJSON(env, "sites", { updated_at: "", sites: [] });
    return json(data);
  }

  if (path === "/api/auth-state" && req.method === "GET") {
    return json({ initialized: !!(await getPassword(env)) });
  }

  if (path === "/api/setup" && req.method === "POST") {
    if (await getPassword(env)) return json({ error: "已初始化，请直接登录" }, 403);
    const { password } = await req.json().catch(() => ({}));
    if (!password || String(password).length < 6) return json({ error: "密码至少 6 位" }, 400);
    const cfg = await getConfig(env);
    cfg.adminPassword = String(password);
    await kvPut(env, "config", cfg);
    const t = await newSession(env);
    return json({ ok: true }, 200, { "Set-Cookie": AUTH_COOKIE(t) });
  }

  if (path === "/api/login" && req.method === "POST") {
    const { password } = await req.json().catch(() => ({}));
    if (!password || password !== (await getPassword(env))) return json({ error: "密码错误" }, 401);
    const t = await newSession(env);
    return json({ ok: true }, 200, { "Set-Cookie": AUTH_COOKIE(t) });
  }

  if (path === "/api/logout" && req.method === "POST") {
    const t = parseCookies(req).nav_admin;
    if (t) await env.NAV_KV.delete(`session:${t}`);
    return json({ ok: true }, 200, { "Set-Cookie": "nav_admin=; Max-Age=0; Path=/" });
  }

  if (path.startsWith("/api/admin/")) {
    if (!(await isAuthed(req, env))) return json({ error: "未登录" }, 401);
    return adminApi(req, env, path);
  }

  return json({ error: "not found" }, 404);
}

async function adminApi(req, env, path) {
  const cfg = await getConfig(env);
  const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
  const saveCfg = () => kvPut(env, "config", cfg);

  // 状态总览
  if (path === "/api/admin/state" && req.method === "GET") {
    const [data, logEntry] = await Promise.all([
      kvGetJSON(env, "sites", { updated_at: "", sites: [] }),
      kvGetJSON(env, "scan_log", null),
    ]);
    return json({
      owner: env.OWNER,
      hasToken: !!((env.GH_TOKEN || cfg.ghToken || "").trim()),
      config: { owners: cfg.owners, extraSites: cfg.extraSites, exclude: cfg.exclude },
      sites: data.sites,
      updated_at: data.updated_at,
      lastScan: logEntry,
    });
  }

  // 立即扫描
  if (path === "/api/admin/scan" && req.method === "POST") {
    const logEntry = await runScan(env, "manual");
    return json({ ok: true, log: logEntry });
  }

  // 扫描令牌
  if (path === "/api/admin/token" && req.method === "POST") {
    cfg.ghToken = String(body.token || "").trim();
    await saveCfg();
    return json({ ok: true });
  }

  // 扫描账号增删
  if (path === "/api/admin/owner" && req.method === "POST") {
    const name = String(body.name || "").trim().replace(/^@/, "");
    if (!name) return json({ error: "账号不能为空" }, 400);
    if (!cfg.owners.some((o) => o.toLowerCase() === name.toLowerCase())) cfg.owners.push(name);
    await saveCfg();
    return json({ ok: true, owners: cfg.owners });
  }
  if (path === "/api/admin/owner" && req.method === "DELETE") {
    const name = String(body.name || "").toLowerCase();
    cfg.owners = cfg.owners.filter((o) => o.toLowerCase() !== name);
    if (!cfg.owners.includes(env.OWNER)) cfg.owners.unshift(env.OWNER);
    await saveCfg();
    return json({ ok: true, owners: cfg.owners });
  }

  // 手动站点增删（含收藏：cat = collect | self；无 cat 为幽灵站补充）
  if (path === "/api/admin/manual" && req.method === "POST") {
    const e = {
      repo: String(body.repo || "").trim(),
      url: String(body.url || "").trim(),
      description: String(body.description || "").trim(),
      cat: body.cat === "self" ? "self" : body.cat === "collect" ? "collect" : "",
      owner: "",
    };
    if (!e.repo || !e.url) return json({ error: "名称和 URL 必填" }, 400);
    if (!/^https?:\/\//.test(e.url)) return json({ error: "URL 需以 http(s):// 开头" }, 400);
    if (!e.cat) e.owner = String(body.owner || env.OWNER).trim();
    cfg.extraSites = cfg.extraSites.filter(
      (x) => !(x.repo === e.repo && (e.cat ? x.cat === e.cat : !x.cat))
    );
    cfg.extraSites.push(e);
    await saveCfg();
    await runScan(env, "manual-edit");
    return json({ ok: true });
  }
  if (path === "/api/admin/manual" && req.method === "DELETE") {
    const repo = String(body.repo || "");
    const cat = body.cat === "self" || body.cat === "collect" ? body.cat : "";
    cfg.extraSites = cat
      ? cfg.extraSites.filter((x) => !(x.repo === repo && x.cat === cat))
      : cfg.extraSites.filter((x) => !(x.repo === repo && !x.cat));
    await saveCfg();
    await runScan(env, "manual-edit");
    return json({ ok: true });
  }

  // 隐藏/恢复自动收录的站点
  if (path === "/api/admin/exclude" && req.method === "POST") {
    const key = { repo: String(body.repo || ""), owner: String(body.owner || "") };
    const has = cfg.exclude.some((e) => e.repo === key.repo && e.owner.toLowerCase() === key.owner.toLowerCase());
    if (body.hide && !has) cfg.exclude.push(key);
    if (!body.hide) cfg.exclude = cfg.exclude.filter((e) => !(e.repo === key.repo && e.owner.toLowerCase() === key.owner.toLowerCase()));
    await saveCfg();
    await runScan(env, "manual-edit");
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req, env) {
    try {
      return await handle(req, env);
    } catch (e) {
      return json({ error: e.message || "internal error" }, 500);
    }
  },
  async scheduled(_event, env, _ctx) {
    await runScan(env, "cron");
  },
};
