# ClassSoftwareHub 访问统计（自托管）

Cloudflare Workers + KV 实现的站点访问统计。三个域名共用同一个 Worker 地址，
KV 里只有一份计数，天然合并成总访问量。

## 文件
- `worker.js` —— Worker 本体（计数 + 像素风仪表盘网页）
- `wrangler.toml` —— 部署配置（KV binding: `STATS`）
- `dashboard-preview.html` —— 本地预览页（内置示例数据，可直接双击打开看效果）

## 统计指标
- 总访问量（PV）、小伙伴（UV，靠 Cookie 跨域名去重）、今日到访
- 在线小伙伴（近 5 分钟活跃）、最热闹一天（峰值单日）、近 7 天日均
- **三域名拆分**：各域名分别计数，仪表盘里按域名展示占比
- 今日逐小时曲线、热门页面 TOP 榜

`/api/stats` 返回：`{ pv, uv, today, online, days[7], hours[24], domains[], paths[], peak{date,count} }`
三个域名（如 `classsoftwarehub.132614.xyz` / `xfane.com` / 另一个）都调用同一地址，KV 只有一份计数，
天然合并成总数，并可在仪表盘里按域名拆分查看。

## 部署（Cloudflare 连 Git）
1. Cloudflare 控制台 → Workers & Pages → 创建 → 连接 Git 仓库，选中本仓库。
2. 构建命令留空 / 用默认；Worker 入口为 `worker.js`（由 `wrangler.toml` 指定）。
3. **创建 KV 命名空间**：Workers & Pages → KV → 新建，命名为 `STATS`。
4. 把命名空间 ID 填入本仓库 `wrangler.toml` 里的 `REPLACE_WITH_YOUR_KV_ID`，
   提交并推送（会触发 Cloudflare 重新部署）。
5. 部署完成后，把站点里 `VisitorCounter.vue` 的 `API_BASE` 改成你的 `*.workers.dev` 地址。

> 本地预览仪表盘：直接打开 `dashboard-preview.html` 即可，无需部署。
