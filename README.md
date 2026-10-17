# 站点导航 · Cloudflare Worker 版

个人站点导航 / GitHub Pages 索引，一个 Worker 全包：静态托管 + 数据 API + 管理后台 + 每日定时扫描。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pengyuyan29/nav-worker)

## 一键部署

点击上面的按钮，登录 Cloudflare 并授权 GitHub 后确认即可。部署过程会自动创建 KV 存储并完成全部绑定，得到一个 `https://site-nav.<你的子域>.workers.dev` 地址。

## 部署后 3 步配置（全部在网页上点，无需命令行）

1. **设置管理密码**：打开 `<worker 地址>/admin` → 首次访问会要求创建管理密码（只存在你自己的 KV 里）
2. **填入扫描令牌**（可选但强烈建议，实现 100% 全量扫描）：
   - 打开 [Fine-grained PAT 创建页](https://github.com/settings/personal-access-tokens/new)
   - Repository access 选 **All repositories**，权限只勾 **Metadata: Read-only**（只读令牌，泄露无害）
   - 后台「扫描设置」里粘贴保存
3. **绑定自定义域名**（可选）：
   - Cloudflare 控制台 → Workers 和 Pages → `site-nav` → 设置 → 域和路由 → 添加自定义域 `88.202991001.xyz`
   - 若提示 DNS 记录冲突，先删掉旧的指向 `*.github.io` 的 CNAME 记录再添加

每日定时扫描已默认开启（北京时间每天 08:30），管理后台可随时「立即扫描」。

## 功能

- **自动扫描**：枚举各账号名下所有开启了 GitHub Pages 的仓库（用仓库列表接口全量枚举，不依赖滞后的搜索索引；配合只读 PAT 可覆盖私有仓库，做到 100%）
- **扫描账号管理**：后台可视化增删，新账号即刻纳入扫描
- **站点管理**：隐藏/恢复自动收录的站点；手动补充自动发现不了的「幽灵站」（仓库已删除但 Pages 自定义域名跳转仍在的情况）
- **收藏夹 / 自建站**：手动添加外部网站收藏和自建服务，分类展示
- **在线状态探测**：每个站点实时检查在线/离线，自动识别自定义域名
- **三主题**：深色 / 浅色 / 跟随系统，分类标签页吸顶

## 架构

```text
Worker (src/worker.js)
├─ 静态资源  public/index.html 导航站 · public/admin.html 管理后台
├─ 公开 API  GET /api/sites        站点数据（KV 直读）
├─ 管理 API  /api/admin/*          密码登录 + 会话（KV，7 天有效）
└─ Cron      每天 00:30 UTC        runScan()：枚举仓库 → 探测在线状态 → 写 KV
```

KV 数据键：`sites`（站点数据）、`config`（账号/手动站点/排除名单/令牌）、`scan_log`（最近日志）、`session:*`。

## 本地开发

```bash
npx wrangler dev     # 本地起服务（需要 wrangler v4）
```
