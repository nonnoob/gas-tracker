# Gas Tracker

Costco 油价：**实时查询**（问一次就走，不留痕）与**历史走势**（每天两次采样，存进这个仓库）。

站点：https://nonnoob.github.io/gas-tracker

## 为什么是这个结构

页面是 GitHub Pages 上的静态页，本身没有后端。有两件事它自己做不到：

**一、实时价。** Costco 的价格接口返回
`access-control-allow-origin: https://my.costco.ca`，
浏览器会拒收来自任何其他域的响应。所以由 Cloudflare Worker 在服务端取回，再换上我们自己的 CORS 头。

**二、历史采样。** Worker 的 Cron Trigger 每天在 America/Los_Angeles 的 11:00 和 17:00 醒来，读一次价，用 GitHub Contents API 追加进 `data/history.json`。**仓库就是数据库**，页面直接从同源读这个文件，不需要 Worker 参与。

实时那条路**刻意不写任何东西**——查一个站的价，不应该动到历史序列。

```
浏览器 ──/live────▶ Worker ──▶ Costco        (实时，不入库)
   │
   └───data/history.json（同源读）
                     ▲
                     │ Contents API
       Cron 11:00/17:00 ─▶ Worker ──▶ Costco  (采样，入库)
```

## 部署

### 1. GitHub Pages

Settings → Pages → Source 选 `main` / `/ (root)`。

### 2. Cloudflare Worker

需要一个 GitHub 细粒度 PAT，**只给这一个仓库**、权限 Repository permissions → Contents: Read and write。令牌自己建、自己贴进 Cloudflare，不要经手任何人。

```bash
npx wrangler login       # 浏览器里授权，凭据只留在你本机
npx wrangler deploy      # 按 wrangler.toml 部署，含 cron
npx wrangler secret put GH_TOKEN      # 粘贴 PAT
npx wrangler secret put COLLECT_KEY   # 随便一串，用来手动触发采集
```

也可以完全不用 CLI：Cloudflare 面板 → Workers & Pages → Create Worker → 把 `worker/worker.js` 整个粘进去 → Deploy，然后在 Settings 里加 Variables/Secrets 和 Cron Triggers。具体值见 `worker/worker.js` 顶部注释。

部署完把 Worker 地址填进 `config.js` 的 `WORKER`。

### 3. 验一下

```bash
curl "$WORKER/live?ids=454"                                  # 应返回价格
curl -X POST "$WORKER/collect" -H "x-collect-key: $KEY"      # 手动采一次
git pull && tail -20 data/history.json                       # 应看到新样本
```

## 加一个跟踪的站

历史采集的名单是 `data/stations.json`。实时查询不受它限制——页面上搜邮编、点「查价」可以看任意 Costco，只是不记录。

要把某个站加进历史采集：

```bash
npx wrangler dev --port 8788          # 另开一个终端
curl "http://127.0.0.1:8788/search?zip=92618" | python3 -m json.tool
# 把想要的那条 {id, city, state, address, lat, lon} 加进 data/stations.json
git commit -am "track: #690 Laguna Niguel" && git push
```

下一次 cron 就会带上它。

## 数据格式

`data/history.json` —— 每个站、每种油品一串 `[UTC 时间, 价格]`，按时间升序：

```json
{
  "updated": "2026-09-21T18:00Z",
  "series": {
    "454": { "regular": [["2026-09-21T18:00Z", 6.099]], "premium": [["2026-09-21T18:00Z", 6.499]] }
  }
}
```

挂牌价在下次调整前一直有效，所以曲线画成**阶梯**而不是斜线——斜线会造出根本不存在的中间价。

油品等级不写死，Costco 返回什么就存什么。尔湾一带只有 regular 和 premium；别处有 diesel 或 0% ethanol 的话会自动带上。

## 本地开发

```bash
npx wrangler dev --port 8788     # Worker
python3 -m http.server 8000      # 静态页；config.js 在 localhost 下自动指向 8788
```

## 几个踩过的坑

- **Costco 的价格接口对并发返回 429。** `/live` 是串行加间隔的，不是 `Promise.all`。
- **带 `sec-fetch-mode: cors` 的请求一律 429。** Node 的 undici 会强制加这个头且改不掉，所以 worker 代码不能用 node 直接跑通验证；workerd（`wrangler dev`）不加，所以线上没问题。
- **Costco 的仓库搜索接口不认邮编**，只认经纬度；邮编先经 `api.zippopotam.us` 换算。
- **一次价格请求只能查一个店**，不支持批量。
