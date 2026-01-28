# 股票价格监控服务

一个基于 Node.js 的实时股票价格监控服务，支持 A股、港股、美股的价格查询。

## 功能特性

- ✅ 实时监控多只股票价格
- ✅ 支持 A股、港股、美股
- ✅ 自动选择最佳数据源
- ✅ 可配置更新间隔
- ✅ 显示涨跌幅、成交量等详细信息
- ✅ 在终端展示 MACD、KDJ、RSI、DK 等技术指标信息（美股/港股/A股）
- ✅ 每轮更新自动将行情写入本地 `watchprice.db`（SQLite，可用于后续查询）

## 安装

```bash
npm install
```

## 配置

编辑 `config.json` 文件来配置你要监控的股票：

```json
{
  "stocks": [
    {
      "name": "股票名称",
      "code": "股票代码",
      "source": "auto"
    }
  ],
  "updateInterval": 5000
}
```

### 股票代码格式

- **A股**: 
  - 上海: `sh600000` (浦发银行)
  - 深圳: `sz000001` (平安银行)
  
- **港股**: `hk00700` (腾讯控股)

- **美股**: `AAPL` (苹果), `TSLA` (特斯拉)

### 数据源选项

- `auto`: 自动选择最佳数据源（推荐）
- `sina`: 使用新浪财经API（A股）
- `tencent`: 使用腾讯财经API（A股、港股）
- `yahoo`: 使用Yahoo Finance API（美股）

## 技术指标（美股）

服务会在获取美股定价后顺带从 Yahoo Finance 拉取日 K 数据，依赖 `technicalindicators` 计算 MACD、RSI、KDJ、DK，终端会直接输出这些指标的当前值及信号（超买/超卖、多头/空头）。KDJ 的信号现在同时参考 K 与 J 的交叉阈值，以避免单一线抖动导致的误报；只要 `config.json` 中是 `sh`, `sz` 或 `hk` 开头的代码，就可以同步看到 MACD、RSI、KDJ 和 DK，无需额外登录。
新版已经将 A 股/港股也纳入技术指标计算，先调用雪球/东方财富历史 K 线接口（`push2his.eastmoney.com`）再算指标，而且每只股票的日K只在本地 cache 四小时，避免频繁请求；只要 `config.json` 中是 `sh`, `sz` 或 `hk` 开头的代码，就可以同步看到 MACD、RSI、KDJ 和 DK，无需额外登录。

## 桌面提醒（macOS）

当某只股票价格涨跌幅超过 `config.json` 中 `alertThresholdPercent` 配置后，服务会调用 macOS 的 `osascript` 发送系统通知，默认阈值为 `1%`。你可以在 `config.json` 中调整这个值（例如 `0.5` 会更灵敏），通知内容会附带当前价格与 RSI/MACD 信号。

## 运行

```bash
# 启动服务
npm start

# 开发模式（自动重启）
npm run dev
```

## 数据持久化

每次拉取时都会把价格和技术指标写入根目录的 `watchprice.db`（SQLite3），可以用 `sqlite3 watchprice.db` 或任意客户端查询历史数据，例如：

```sql
SELECT * FROM price_records WHERE code = 'sh601288' ORDER BY timestamp DESC LIMIT 20;
```

### 导出脚本

项目包含 `scripts/export-history.js`，通过 `better-sqlite3` 读取 `watchprice.db` 并输出某支股票最近几条记录：

```bash
node scripts/export-history.js --code=sh601288 --limit=5 --format=table
node scripts/export-history.js --code=AAPL --format=json
node scripts/export-history.js --code=TSLA --limit=20 --format=csv
```

可选参数：

- `--code`: 股票代码（默认 `sh601288`）  
- `--limit`: 返回条数（默认 10）  
- `--format`: 输出格式，`table/json/csv`（默认 `table`）  

你也可以把这些命令包在 npm script 里，例如：

```bash
npm run export:history -- --code=sh601288 --limit=5
```

如果想一次性导出某支股票（或全库）所有记录，可以运行全量脚本：

```bash
npm run export:all -- --code=sh601288 --since=2026-01-01 --format=json
npm run export:all --format=csv
```

可选参数：

- `--code`: 限定代码  
- `--since` / `--to`: 时间范围（ISO 格式或类似 `20260124`）  
- `--format`: `json` 或 `csv`（默认 `csv`）

### RSI 分析脚本

脚本 `scripts/analyze-rsi.js` 读取 `watchprice.db` 并按 5 分钟窗口计算每支股票的 RSI 平均值与窗口内 RSI 变化（最后一条减去第一条），可以用来检测超买/超卖的趋势：

```bash
npm run analyze:rsi -- --code=sh601288
npm run analyze:rsi --code=AAPL
```

### 分时分析脚本

新增脚本 `scripts/export-timeseries.js` 会把指定股票的最新分时窗口（默认 1 分钟）按时间聚合成 OHLC、均价、成交量/振幅/涨幅等字段，支持 `json`/`csv`/`table` 输出：

```bash
npm run export:timeseries -- --code=sh601288 --limit=120
npm run export:timeseries -- --code=AAPL --interval=5 --format=csv
npm run export:timeseries -- --code=TSLA --limit=40 --format=table
```

可选参数：

- `--code`: 股票代码，默认 `sh601288`
- `--limit`: 最多输出多少个窗口，默认 `240`
- `--interval`: 每个分时窗口的分钟数，默认 `1`
- `--format`: 所需格式，`json`（默认）、`csv` 或 `table`

该脚本依赖 `watchprice.db` 中的价格记录，适合在终端/脚本中导出分时数据对外部系统或研究做进一步分析。

### 指标检查脚本

如果只想查看哪些历史记录已经成功附带了 `indicators`，可以运行 `scripts/show-indicators.js`，它会列出最近几条带指标的记录（支持 `--code`、`--limit` 和 `--format=json/table`）：

```bash
npm run show:indicators -- --code=sh601288 --limit=15
npm run show:indicators -- --format=json
```

### 支撑/压力脚本

脚本 `scripts/show-support.js` 会读取最近若干条记录并直接给出当前支撑（最低价）、压力（最高价）以及当前是否突破，支持 `--code` 和 `--lookback`（默认 40 条）：

```bash
npm run show:support -- --code=sh601288 --lookback=60
npm run show:support --code=AAPL
```

### 简易买卖信号

`scripts/calc-signal.js` 将分析最近有指标的记录，结合 RSI、MACD、DK 和当前支撑/压力给出一句建议（如“考虑获利了结”或“考虑低吸”），可按需要调整：

```bash
npm run signal -- --code=sh601288 --lookback=20
npm run signal -- --code=AAPL
```


### 图形报告

有了 SQLite 数据可以直接生成本地图表，脚本 `scripts/generate-report.js` 会把最近若干条纪录输出成 HTML，包含 Chart.js 绘制的价格曲线和 RSI：

```bash
npm run report -- --code=sh601288 --limit=120
npm run report -- --code=AAPL
```

HTML 报告里还会附带当前最新的技术指标表（RSI、MACD、KDJ、DK），方便直接在浏览器里判断当前形态。

### 实时仪表板

如果希望用网页实时查看行情/指标，可以启动内置的 Dashboard（依赖 Express）：

```bash
npm run dashboard
```

打开浏览器访问 `http://localhost:3000/dashboard.html`，支持实时刷新、调整股票代码/显示长度，右侧还呈现最新的指标表；后台每 5 秒会自动拉取最新的价格和 RSI 数据。

页面右上角有“保存到 watchlist”按钮，会把当前代码写入 `config.json`（`stocks` 数组）继续由服务统一监控；只支持尚未存在的代码，操作后会在接口中看到 `added` 或 `already existed` 提示。

服务也会监控 `config.json`，发生变化后会自动重新加载配置并立即开始监控新加入的股票，无需重启。

生成的报告会保存为 `report-<code>.html`，可直接在浏览器打开查看。

仪表板新增分时统计区域，会在价格图上叠加分时均价，下面显示成交量柱状图，并附带“最新振幅 / 涨幅 / 成交”摘要。前端通过 `GET /api/timeseries?code=<code>&limit=<n>&interval=<minutes>` 获取聚合后的分时窗口（默认 1 分钟），服务器会返回对应的振幅/涨幅/量值供图表和摘要使用。

## 输出示例

```
🚀 股票价格监控服务启动中...

📊 监控股票数量: 4
⏱️  更新间隔: 1秒

============================================================

🔄 2024/1/1 15:00:00 - 更新价格信息...
============================================================

📈 浦发银行 (sh600000)
  当前价格: ¥12.40
  涨跌: 🟢 +0.05 (0.40%)
  今开: ¥12.35 | 昨收: ¥12.35
  最高: ¥12.45 | 最低: ¥12.30
  成交量: 1234.56万
  更新时间: 2024-01-01 15:00:00

============================================================
```

## 注意事项

1. 请合理设置更新间隔，避免过于频繁的请求
2. 部分API可能有访问频率限制
3. 股票代码格式必须正确，否则可能无法获取数据
4. 交易时间外可能无法获取实时数据

## 许可证

MIT
