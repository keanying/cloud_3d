# cloud_3d

加密市场实时 3D 看板 · 数据源 Gate.io 公开 API（现货 + USDT 永续），中 / 英文切换。
A real-time 3D crypto-market HUD fed by Gate.io public data (spot + USDT perpetuals), with a Chinese / English toggle.

纯静态页面，无构建步骤、无后端、无需 API Key。Three.js 已内置在 `vendor/`，不依赖 CDN。
Pure static page: no build step, no backend, no API key. Three.js is vendored in `vendor/`, no CDN needed.

## 运行 / Run

```bash
python3 -m http.server 8080
```

然后打开 / then open <http://localhost:8080>。也可以直接部署到任何静态托管（GitHub Pages、Cloudflare Pages、Nginx 等）。
ES modules 需要通过 http(s) 打开，不能直接双击 `file://`。
Any static host works (GitHub Pages, Cloudflare Pages, Nginx…). ES modules need http(s); opening via `file://` will not work.

> 浏览器需要能访问 `api.gateio.ws` 与 `fx-ws.gateio.ws`（部分地区需要代理）。
> The browser must be able to reach `api.gateio.ws` and `fx-ws.gateio.ws`.

## 面板与数据 / Panels & data

| 面板 Panel | 内容 | Gate.io 数据 |
|---|---|---|
| 顶栏 Header | 选中币种价格、24H 涨跌、上涨占比、现货总成交、永续总持仓、UTC 时钟、连接状态 | `/spot/tickers`, `/futures/usdt/tickers`, `/spot/time` |
| 市场总览 Market overview | 全部 USDT 交易对的成交额、涨跌家数、平均/加权涨跌、领涨领跌、永续持仓与加权资金费率 | REST 每 15s / 30s 轮询 |
| 盘口阶梯 Book ladder | 前 5 档买卖盘 + 近 40 分钟收盘价迷你图 | WS `spot.order_book` |
| 现货 Spot | 1m K 线（含现价标签与量柱）、8 档深度与累计量 | REST `/spot/candlesticks` + WS `spot.candlesticks` |
| 延迟与基差 Latency & basis | 永续-现货基差、标记-指数溢价、现货/永续推送延迟 | WS `futures.tickers`, `spot/futures.trades` |
| 数据流检查器 Wire inspector | WS 原始消息流、消息速率、流量、订阅数 | 全部 WS |
| 神经壳 Neural shell (3D) | 成交额前 40 的币种，每个币一簇针刺：针长 = 24H 涨跌幅，密度 = 成交额，颜色 = 涨跌，亮度 = 实时成交脉冲。拖拽旋转、悬停看详情、点击切换币种 | WS `spot.tickers` / `spot.trades` / `futures.trades` |
| 输入卡片 Input cards | BTC / ETH / SOL 实时走势，选中币种的基差、资金费率历史、多空人数比 | `/futures/usdt/funding_rate`, `/futures/usdt/contract_stats` |
| 巨鲸成交 Whale fills | 现货 ≥ $10K、永续 ≥ $50K 的大单（同一时刻同方向的成交合并为一笔主动单），每秒成交笔数直方图 | WS trades |
| 逐笔成交 Execution tape | 选中币种的现货 + 永续逐笔成交、60s 买卖力量 | WS trades |
| 波动锥 · 爆仓漏斗 Vol cone | 近 60 分钟价格 → 未来 30 分钟 ±1σ / ±2σ 实现波动率锥；选中合约的爆仓以火花落入漏斗；全市场实时爆仓列表；资金费结算倒计时、多空比、近 2H 爆仓额 | WS `futures.public_liquidates` (`!all`), `/futures/usdt/contracts/{c}` |

## 结构 / Layout

```
index.html          页面骨架 / page skeleton
css/app.css         HUD 样式与响应式布局 / styles, responsive layout
js/main.js          数据状态、订阅、渲染循环 / state, subscriptions, render loop
js/gate.js          REST + 自动重连、引用计数订阅的 WebSocket 客户端 / REST + reconnecting WS client
js/shell3d.js       Three.js 神经壳（自定义着色器）+ 连线叠加层 / Three.js shell + overlay wires
js/funnel.js        波动锥 / 爆仓漏斗（Canvas 2D 伪 3D）/ vol cone (2D pseudo-3D)
js/charts.js        K 线、迷你图、柱状图等 / small chart helpers
js/i18n.js          中英文字典 / zh-en dictionary
js/fmt.js           数字、价格、时间格式化 / formatting
vendor/             three.js r170 (MIT)
```

## 可调参数 / Tuning

`js/main.js` 顶部：`FOCUS_N`（3D 壳上的币种数）、`TRADE_N` / `PERP_N`（订阅逐笔的币种数）、
`SPOT_WHALE` / `PERP_WHALE`（巨鲸阈值）、`INPUTS`（左侧输入卡片）。
Top of `js/main.js`: `FOCUS_N`, `TRADE_N`, `PERP_N`, `SPOT_WHALE`, `PERP_WHALE`, `INPUTS`.

## 说明 / Notes

- "全市场"指 Gate.io 一家交易所的 USDT 交易对；稳定币与杠杆代币（如 `BTC3L`）不计入统计。总市值、市占率需要流通量数据，Gate 不提供，未包含。
  "Whole market" means Gate.io USDT pairs only; stablecoins and leveraged tokens are excluded. Market cap / dominance are not available from Gate.
- 延迟 = 本地接收时间 − 服务器推送时间（`time_ms`），取近 60 条的中位数，只用成交 / 盘口频道；本地时钟仅在明显偏差时按服务器时间校准。
  Latency is the median of (receive time − server `time_ms`) over trades / book frames.
- 爆仓方向：`futures.public_liquidates` 中 size < 0（强平卖单）记为多头爆仓。
  Liquidation side: negative size (forced sell) is treated as a long liquidation.
- 仅供展示，不构成投资建议。For display only; not investment advice.
