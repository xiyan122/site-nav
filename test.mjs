// 本地冒烟测试：mock fetch + KV，跑通 scan 与管理 API 全流程
import worker from './src/worker.js';

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const gh = 'https://api.github.com';
  const J = (d, status = 200) => new Response(JSON.stringify(d), { status });
  if (u.startsWith(gh)) {
    const path = u.slice(gh.length).split('?')[0];
    if (path === '/users/pengyuyan29/repos')
      return J([
        { name: 'blog', full_name: 'pengyuyan29/blog', has_pages: true, owner: { login: 'pengyuyan29' }, description: '博客', language: 'JS', topics: ['x'], pushed_at: '2026-10-01T00:00:00Z' },
        { name: 'nav-worker', full_name: 'pengyuyan29/nav-worker', has_pages: false, owner: { login: 'pengyuyan29' } },
        { name: 'qingqian.github.io', full_name: 'pengyuyan29/qingqian.github.io', has_pages: true, owner: { login: 'pengyuyan29' }, description: null, pushed_at: '2026-10-02T00:00:00Z' },
      ]);
    if (path === '/users/xiyan122/repos')
      return J([
        { name: 'xiyan122.github.io', full_name: 'xiyan122/xiyan122.github.io', has_pages: true, owner: { login: 'xiyan122' }, description: '主页', pushed_at: '2026-10-03T00:00:00Z' },
      ]);
    if (path === '/users/Qianshuy99/repos') return J([]);
    if (path.startsWith('/search/repositories')) return J({ items: [] });
    return J({}, 404);
  }
  // 站点探测
  if (u.includes('github.io/blog')) return new Response('', { status: 301, headers: { Location: 'https://blog.qingqian.com/' } });
  if (u.startsWith('https://blog.qingqian.com')) return new Response('ok', { status: 200 });
  if (u.includes('bilibili.com')) return new Response('ok', { status: 200 });
  if (u.includes('linxiz.loc.cc')) return new Response('', { status: 502 });
  return new Response('ok', { status: 200 });
};

const store = new Map();
const env = {
  OWNER: 'pengyuyan29',
  SEED_OWNERS: 'xiyan122,Qianshuy99',
  SEED_SITES: JSON.stringify([
    { repo: 'musicplayer', owner: 'xiyan122', url: 'http://linxiz.loc.cc/', description: '音乐播放器（原 xiyan122/musicplayer，已绑定自定义域名）' },
    { repo: '健康监控', url: 'https://tfa.qingqian.com/health/', description: '站点在线状态监控', cat: 'collect' },
  ]),
  NAV_KV: {
    get: async k => store.get(k) ?? null,
    put: async (k, v) => store.set(k, v),
    delete: async k => store.delete(k),
  },
  ASSETS: { fetch: async () => new Response('asset') },
};
const ctx = {};

const req = (path, method = 'GET', body, cookie) =>
  new Request('https://nav.test' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const getCookie = r => r.headers.get('Set-Cookie')?.split(';')[0];
const getState = async cookie =>
  await (await worker.fetch(req('/api/admin/state', 'GET', undefined, cookie), env, ctx)).json();

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log((cond ? '✓' : '✗ FAIL'), name); };

// 1. 初始化与登录
let r = await worker.fetch(req('/api/auth-state'), env, ctx);
ok((await r.json()).initialized === false, 'auth-state 初始为未初始化');
r = await worker.fetch(req('/api/setup', 'POST', { password: 'test123456' }), env, ctx);
ok(r.status === 200, 'setup 成功');
const cookie = getCookie(r);
r = await worker.fetch(req('/api/login', 'POST', { password: 'wrong' }), env, ctx);
ok(r.status === 401, '错误密码 401');
r = await worker.fetch(req('/api/admin/state'), env, ctx);
ok(r.status === 401, '未登录 401');

// 2. 种子配置生效的首次扫描
r = await worker.fetch(req('/api/admin/scan', 'POST', {}, cookie), env, ctx);
ok(r.status === 200, '手动扫描 200');
const d0 = await r.json();
console.log('   扫描日志:', d0.log.lines.join(' | '));
let state = await getState(cookie);
const byRepo = Object.fromEntries(state.sites.map(s => [`${s.owner}/${s.repo}`, s]));
ok(state.config.owners.join(',') === 'pengyuyan29,xiyan122,Qianshuy99', '种子账号已写入配置');
ok(byRepo['pengyuyan29/blog'].url === 'https://blog.qingqian.com/', 'blog 跟随重定向识别自定义域名: ' + byRepo['pengyuyan29/blog'].url);
ok(byRepo['pengyuyan29/blog'].status === 'online', 'blog online');
ok(byRepo['xiyan122/xiyan122.github.io'].url === 'https://xiyan122.github.io/', '用户主站根路径 URL');
ok(byRepo['xiyan122/musicplayer']?.status === 'offline', '种子幽灵站 musicplayer 收录且 502 -> offline');
ok(byRepo['pengyuyan29/健康监控']?.status === 'custom' && byRepo['pengyuyan29/健康监控'].cat === 'collect', '种子收藏 健康监控');
ok(!state.sites.some(s => s.repo === 'nav-worker'), '无 Pages 的仓库未收录');
ok(state.sites[0].status === 'custom', '收藏排在最前');

// 3. 公开数据接口
r = await worker.fetch(req('/api/sites'), env, ctx);
ok((await r.json()).sites.length === state.sites.length, '/api/sites 返回数据一致');

// 4. 添加收藏
r = await worker.fetch(req('/api/admin/manual', 'POST', { repo: 'B站', url: 'https://bilibili.com/', cat: 'collect', description: '视频' }, cookie), env, ctx);
ok(r.status === 200, '添加收藏');
state = await getState(cookie);
const customs = state.sites.filter(x => x.status === 'custom');
ok(state.sites[0].status === 'custom' && customs.some(x => x.repo === 'B站'), '新收藏进入自定义组');

// 5. 手动补充幽灵站（无 cat）
r = await worker.fetch(req('/api/admin/manual', 'POST', { repo: 'legacy', url: 'http://legacy.test/', owner: 'xiyan122' }, cookie), env, ctx);
ok(r.status === 200, '添加幽灵站');
state = await getState(cookie);
ok(state.sites.find(s => s.repo === 'legacy')?.owner === 'xiyan122', '幽灵站归属正确');

// 6. 账号管理
r = await worker.fetch(req('/api/admin/owner', 'POST', { name: '@Qianshuy99' }, cookie), env, ctx);
ok((await r.json()).owners.includes('Qianshuy99'), '添加账号（自动去 @，幂等）');
r = await worker.fetch(req('/api/admin/owner', 'DELETE', { name: 'qianshuy99' }, cookie), env, ctx);
ok(!(await r.json()).owners.includes('Qianshuy99'), '删除账号（大小写不敏感）');
r = await worker.fetch(req('/api/admin/owner', 'DELETE', { name: 'pengyuyan29' }, cookie), env, ctx);
ok((await r.json()).owners.includes('pengyuyan29'), '主账号不可删除');

// 7. 隐藏/恢复
await worker.fetch(req('/api/admin/exclude', 'POST', { repo: 'blog', owner: 'pengyuyan29', hide: true }, cookie), env, ctx);
state = await getState(cookie);
ok(!state.sites.some(s => s.repo === 'blog' && s.owner === 'pengyuyan29'), '隐藏后不出现在数据里');
await worker.fetch(req('/api/admin/exclude', 'POST', { repo: 'blog', owner: 'pengyuyan29', hide: false }, cookie), env, ctx);
state = await getState(cookie);
ok(state.sites.some(s => s.repo === 'blog'), '取消隐藏恢复');

// 8. 删除收藏与幽灵站
await worker.fetch(req('/api/admin/manual', 'DELETE', { repo: 'B站', cat: 'collect' }, cookie), env, ctx);
await worker.fetch(req('/api/admin/manual', 'DELETE', { repo: 'legacy' }, cookie), env, ctx);
state = await getState(cookie);
ok(!state.sites.some(s => s.repo === 'B站' || s.repo === 'legacy'), '删除收藏与幽灵站');
ok(state.sites.some(s => s.repo === 'musicplayer'), '种子幽灵站仍在');

// 9. 幂等 + cron 入口
r = await worker.fetch(req('/api/admin/scan', 'POST', {}, cookie), env, ctx);
ok(r.status === 200, '重复扫描幂等');
await worker.scheduled({}, env, ctx);
const kvSites = JSON.parse(store.get('sites'));
ok(kvSites.sites.length === state.sites.length, 'scheduled 扫描写入 KV，数量一致');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
