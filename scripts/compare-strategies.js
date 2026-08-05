/**
 * 主流量化策略对比回测 v2 —— 基于本地 watchprice.db 历史数据
 * 新增: 盈亏比 / 最大回撤 / 手续费模拟 / 资金曲线 / 持仓成本分析 / 情景回测
 * 用法:
 *   node scripts/compare-strategies.js                     # 全量对比
 *   node scripts/compare-strategies.js --code=sz001696     # 单只股票
 *   node scripts/compare-strategies.js --cost=15.61 --shares=1000   # 附带持仓分析
 *   node scripts/compare-strategies.js --scenario=sz001696 # 情景回测(反弹超买/MA20/距高点)
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../watchprice.db');
const db = new Database(dbPath, { readonly: true });

// ── CLI 参数 ──
const argv = process.argv.slice(2);
const args = {};
for (const t of argv) {
  if (!t.startsWith('--')) continue;
  const [k, v] = t.slice(2).split('=');
  args[k] = v === undefined ? true : v;
}

const CODES = args.code ? [args.code] : ['sz001696', 'sh601288', 'sz002639'];
const COST_PRICE = args.cost !== undefined ? Number(args.cost) : null;
const SHARES = args.shares !== undefined ? Number(args.shares) : null;

// A股交易成本: 佣金万2.5(双边,最低5元) + 印花税0.05%(仅卖出) + 过户费万0.1(双边)
const COMMISSION_RATE = 0.00025;
const STAMP_TAX = 0.0005;
const TRANSFER_FEE = 0.00001;

function dateKey(ts) {
  const p = new Date(ts);
  if (Number.isNaN(p.getTime())) return String(ts).slice(0, 10);
  return p.toISOString().slice(0, 10);
}

function loadDaily(code) {
  const rows = db.prepare(
    `SELECT timestamp, price, high, low, volume FROM price_records WHERE code = ? ORDER BY timestamp ASC`
  ).all(code);
  const byDate = new Map();
  for (const r of rows) {
    const price = Number(r.price);
    if (!Number.isFinite(price) || price <= 0) continue; // 过滤脏数据(负价/零价)
    const key = dateKey(r.timestamp);
    const d = byDate.get(key);
    if (!d) {
      byDate.set(key, {
        time: key, open: price, high: Number(r.high) || price,
        low: Number(r.low) || price, close: price, volume: Number(r.volume) || 0
      });
    } else {
      d.high = Math.max(d.high, Number(r.high) || price);
      d.low = Math.min(d.low, Number(r.low) || price);
      d.close = price;
      d.volume = Number(r.volume) || d.volume;
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.time.localeCompare(b.time));
}

function sma(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  if (loss === 0) return 100;
  const rs = (gain / n) / (loss / n);
  return 100 - 100 / (1 + rs);
}

function calcFee(amount, isSell) {
  const commission = Math.max(amount * COMMISSION_RATE, 5);
  const transfer = amount * TRANSFER_FEE;
  const stamp = isSell ? amount * STAMP_TAX : 0;
  return commission + transfer + stamp;
}

/**
 * 完整回测: 次日方向胜率 + 持仓模拟(资金曲线/盈亏比/最大回撤/年化)
 */
function runStrategy(code, klines, strat, initialCapital = 100000) {
  let total = 0, success = 0;
  const results = { buy: { n: 0, ok: 0 }, sell: { n: 0, ok: 0 } };

  // 持仓模拟状态
  let cash = initialCapital;
  let shares = 0;
  let entryPrice = 0;
  let equityPeak = initialCapital;
  let maxDrawdown = 0;
  const trades = []; // {entry, exit, pnl, pnlPct}

  for (let i = 40; i < klines.length - 1; i++) {
    const slice = klines.slice(0, i + 1);
    const closes = slice.map(k => k.close);
    const cur = klines[i];
    const next = klines[i + 1];
    const price = cur.close;

    let sig = null;
    const ma20 = sma(closes, 20);
    const ma5 = sma(closes, 5);
    const prevMa20 = sma(closes.slice(0, -1), 20);

    switch (strat) {
      case 'buyhold': {
        if (i === 40) sig = 'buy';
        break;
      }
      case 'doubleMA': {
        if (ma5 && ma20 && prevMa20) {
          const prevMa5 = sma(closes.slice(0, -1), 5);
          if (prevMa5 <= prevMa20 && ma5 > ma20) sig = 'buy';
          else if (prevMa5 >= prevMa20 && ma5 < ma20) sig = 'sell';
        }
        break;
      }
      case 'ma20trend': {
        if (ma20 && prevMa20) {
          const prevClose = closes[closes.length - 2];
          if (prevClose <= prevMa20 && cur.close > ma20) sig = 'buy';
          else if (prevClose >= prevMa20 && cur.close < ma20) sig = 'sell';
        }
        break;
      }
      case 'momentum': {
        const high20 = Math.max(...closes.slice(-20));
        const low20 = Math.min(...closes.slice(-20));
        const prevClose = closes[closes.length - 2];
        if (prevClose < high20 && cur.close >= high20) sig = 'buy';
        else if (prevClose > low20 && cur.close <= low20) sig = 'sell';
        break;
      }
      case 'rsiReversal': {
        const r = rsi(closes, 14);
        if (r !== null) {
          if (r < 30) sig = 'buy';
          else if (r > 70) sig = 'sell';
        }
        break;
      }
      case 'kdjReversal': {
        const r = rsi(closes, 9);
        if (r !== null) {
          if (r < 20) sig = 'buy';
          else if (r > 80) sig = 'sell';
        }
        break;
      }
      case 'bollinger': {
        if (closes.length >= 20) {
          const m = sma(closes, 20);
          const std = Math.sqrt(closes.slice(-20).reduce((a, c) => a + (c - m) ** 2, 0) / 20);
          if (cur.low <= m - 2 * std) sig = 'buy';
          else if (cur.high >= m + 2 * std) sig = 'sell';
        }
        break;
      }
    }

    // 方向胜率统计
    if (sig) {
      total++;
      const ok = sig === 'buy' ? next.close > price : next.close < price;
      if (ok) success++;
      results[sig].n++;
      if (ok) results[sig].ok++;
    }

    // 持仓模拟: 次日开盘价附近成交(用 next.close 近似, 加手续费)
    if (sig === 'buy' && shares === 0) {
      const exec = next.close;
      const buyAmt = cash; // 全仓
      const fee = calcFee(buyAmt, false);
      shares = Math.floor((buyAmt - fee) / exec / 100) * 100; // A股整手100股
      cash -= shares * exec + fee;
      entryPrice = exec;
    } else if (sig === 'sell' && shares > 0) {
      const exec = next.close;
      const sellAmt = shares * exec;
      const fee = calcFee(sellAmt, true);
      const pnl = sellAmt - fee - (shares * entryPrice + calcFee(shares * entryPrice, false));
      const pnlPct = pnl / (shares * entryPrice) * 100;
      trades.push({ entry: entryPrice, exit: exec, pnl, pnlPct });
      cash += sellAmt - fee;
      shares = 0;
    }

    // 资金曲线(持仓按现价估值) & 最大回撤
    const equity = cash + shares * cur.close;
    if (equity > equityPeak) equityPeak = equity;
    const dd = (equityPeak - equity) / equityPeak * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 期末平仓
  if (shares > 0) {
    const last = klines[klines.length - 1].close;
    const sellAmt = shares * last;
    const fee = calcFee(sellAmt, true);
    const pnl = sellAmt - fee - (shares * entryPrice + calcFee(shares * entryPrice, false));
    const pnlPct = pnl / (shares * entryPrice) * 100;
    trades.push({ entry: entryPrice, exit: last, pnl, pnlPct });
    cash += sellAmt - fee;
    shares = 0;
  }

  const finalEquity = cash;
  const totalReturn = (finalEquity / initialCapital - 1) * 100;
  const days = (new Date(klines[klines.length - 1].time) - new Date(klines[40].time)) / 86400000;
  const years = days / 365.25;
  const annualized = years > 0 ? (Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100 : 0;

  // 盈亏比
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);

  const rate = total ? (success / total * 100).toFixed(1) : 'N/A';
  return {
    rate, total, success,
    buy: results.buy, sell: results.sell,
    trades: trades.length, winTrades: wins.length,
    totalReturn, annualized, maxDrawdown, profitFactor, avgWin, avgLoss
  };
}

// ── 持仓成本分析 ──
function positionAnalysis(code, klines, costPrice, shares) {
  if (!costPrice || !shares) return null;
  const latest = klines[klines.length - 1];
  const cur = latest.close;
  const cost = costPrice * shares;
  const mkt = cur * shares;
  const pnl = mkt - cost;
  const pnlPct = (cur / costPrice - 1) * 100;
  const feeBuy = calcFee(cost, false);
  const feeSell = calcFee(mkt, true);

  // 各方案收益对比
  const ma5 = sma(klines.map(k => k.close), 5);
  const ma20 = sma(klines.map(k => k.close), 20);
  const low10 = Math.min(...klines.slice(-10).map(k => k.low));
  const high20 = Math.max(...klines.slice(-20).map(k => k.high));

  const scenarios = [
    { name: '立即卖出 (现价)', price: cur },
    { name: 'MA5 止损 (短线动能)', price: ma5 || cur },
    { name: '10日低点支撑', price: low10 },
    { name: 'MA20 附近', price: ma20 || cur },
    { name: '前高压力位', price: high20 },
  ];

  return {
    cur, costPrice, shares, cost, mkt, pnl, pnlPct,
    feeBuy, feeSell, scenarios, ma5, ma20, low10, high20
  };
}

// ── 入口: scenario 模式（必须在主流程前判断） ──
if (args.scenario) {
  runScenario(String(args.scenario));
  process.exit(0);
}

// ── 输出 ──
console.log('='.repeat(110));
console.log('主流量化策略对比回测 v2（本地数据库日K）— 含盈亏比/回撤/手续费/资金曲线');
if (args.code) console.log(`范围: ${args.code}`);
if (COST_PRICE) console.log(`持仓: 成本 ${COST_PRICE} × ${SHARES} 股`);
console.log('='.repeat(110));

const STRATS = [
  ['buyhold', '买入持有'],
  ['doubleMA', '双均线趋势'],
  ['ma20trend', 'MA20趋势'],
  ['momentum', '动量突破'],
  ['rsiReversal', 'RSI均值回归'],
  ['kdjReversal', 'KDJ超买超卖'],
  ['bollinger', '布林带'],
];

const summary = {};
let positionReport = null;

for (const code of CODES) {
  const klines = loadDaily(code);
  const name = db.prepare(`SELECT name FROM price_records WHERE code=? AND name IS NOT NULL LIMIT 1`).get(code)?.name || code;
  console.log(`\n📈 ${name} (${code}) — ${klines.length} 个交易日 (${klines[0].time} ~ ${klines[klines.length-1].time})`);
  console.log('-'.repeat(110));
  console.log('策略'.padEnd(14), '胜率'.padEnd(7), '信号'.padEnd(6), '买胜率'.padEnd(8), '卖胜率'.padEnd(8),
    '交易数'.padEnd(7), '盈利笔'.padEnd(7), '盈亏比'.padEnd(8), '总收益'.padEnd(9), '年化'.padEnd(8), '最大回撤'.padEnd(9));
  console.log('-'.repeat(110));

  for (const [key, label] of STRATS) {
    const r = runStrategy(code, klines, key);
    const buyRate = r.buy.n ? (r.buy.ok / r.buy.n * 100).toFixed(1) : '-';
    const sellRate = r.sell.n ? (r.sell.ok / r.sell.n * 100).toFixed(1) : '-';
    const pf = r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2);
    console.log(label.padEnd(14), `${r.rate}%`.padEnd(7), String(r.total).padEnd(6),
      `${buyRate}%`.padEnd(8), `${sellRate}%`.padEnd(8),
      String(r.trades).padEnd(7), String(r.winTrades).padEnd(7), pf.padEnd(8),
      `${r.totalReturn.toFixed(1)}%`.padEnd(9), `${r.annualized.toFixed(1)}%`.padEnd(8), `${r.maxDrawdown.toFixed(1)}%`.padEnd(9));
    if (!summary[label]) summary[label] = { total: 0, success: 0, trades: 0, wins: 0, ret: 0 };
    summary[label].total += r.total;
    summary[label].success += r.success;
    summary[label].trades += r.trades;
    summary[label].wins += r.winTrades;
    summary[label].ret += r.totalReturn;
  }

  // 持仓成本分析（只对 --code 指定的股票）
  if (COST_PRICE && SHARES && (!args.code || args.code === code)) {
    positionReport = positionAnalysis(code, klines, COST_PRICE, SHARES);
  }
}

if (Object.keys(summary).length > 0) {
  console.log('\n' + '='.repeat(110));
  console.log('📊 合并统计（胜率按信号数加权，收益为各股均值）');
  console.log('='.repeat(110));
  console.log('策略'.padEnd(14), '胜率'.padEnd(7), '信号'.padEnd(7), '交易数'.padEnd(7), '盈利笔'.padEnd(7), '平均收益'.padEnd(9));
  console.log('-'.repeat(110));
  const sorted = Object.entries(summary)
    .map(([name, v]) => [name, v.total ? v.success / v.total * 100 : 0, v.total, v.trades, v.wins, v.ret / CODES.length])
    .sort((a, b) => b[1] - a[1]);
  for (const [name, rate, total, trades, wins, ret] of sorted) {
    console.log(name.padEnd(14), `${rate.toFixed(1)}%`.padEnd(7), String(total).padEnd(7),
      String(trades).padEnd(7), String(wins).padEnd(7), `${ret.toFixed(1)}%`.padEnd(9));
  }
}

// ── 持仓分析输出 ──
if (positionReport) {
  const p = positionReport;
  console.log('\n' + '='.repeat(110));
  console.log(`💰 持仓分析（${p.shares} 股 @ 成本 ${p.costPrice}）`);
  console.log('='.repeat(110));
  console.log(`现价: ${p.cur} | 市值: ¥${p.mkt.toFixed(0)} | 成本: ¥${p.cost.toFixed(0)}`);
  console.log(`浮动盈亏: ${p.pnl >= 0 ? '+' : ''}¥${p.pnl.toFixed(0)} (${p.pnlPct.toFixed(2)}%)`);
  console.log(`买入费用估算: ¥${p.feeBuy.toFixed(2)} | 卖出费用估算: ¥${p.feeSell.toFixed(2)}`);
  console.log(`关键位: MA5=${p.ma5?.toFixed(2)} MA20=${p.ma20?.toFixed(2)} 10日低=${p.low10} 20日高=${p.high20}`);
  console.log('-'.repeat(110));
  console.log('卖出方案对比:');
  console.log('方案'.padEnd(20), '价格'.padEnd(9), '净到手'.padEnd(12), '盈亏'.padEnd(12), '较现价卖差');
  console.log('-'.repeat(110));
  const baseNet = p.mkt - p.feeSell;
  for (const s of p.scenarios) {
    const net = s.price * p.shares - calcFee(s.price * p.shares, true);
    const profit = net - (p.cost + p.feeBuy);
    const diff = net - baseNet;
    console.log(s.name.padEnd(20), String(s.price).padEnd(9),
      `¥${net.toFixed(0)}`.padEnd(12),
      `${profit >= 0 ? '+' : ''}¥${profit.toFixed(0)}`.padEnd(12),
      `${diff >= 0 ? '+' : ''}¥${diff.toFixed(0)}`);
  }
}

// ── 情景回测模式 ──
function rsiN(closes, n) {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  if (loss === 0) return 100;
  const rs = (gain / n) / (loss / n);
  return 100 - 100 / (1 + rs);
}

function runScenario(code) {
  const klines = loadDaily(code);
  const name = db.prepare(`SELECT name FROM price_records WHERE code=? AND name IS NOT NULL LIMIT 1`).get(code)?.name || code;
  console.log(`\n📈 情景回测: ${name} (${code}) — ${klines.length} 个交易日\n`);

  // 情景A: 从20日低点反弹≥12%，且 RSI9>80 (KDJ超买近似)
  const casesA = [];
  for (let i = 40; i < klines.length - 10; i++) {
    const slice = klines.slice(0, i + 1);
    const closes = slice.map(k => k.close);
    const low20 = Math.min(...slice.slice(-20).map(k => k.low));
    const cur = klines[i];
    const rebound = (cur.close - low20) / low20 * 100;
    const r9 = rsiN(closes, 9);
    if (rebound >= 12 && r9 !== null && r9 > 80) {
      const c = cur.close;
      casesA.push({
        date: cur.time, close: c, rebound, rsi: r9,
        d1: (klines[i + 1].close - c) / c * 100,
        d3: (klines[i + 3].close - c) / c * 100,
        d5: (klines[i + 5].close - c) / c * 100,
        d10: (klines[i + 10].close - c) / c * 100
      });
    }
  }
  console.log(`情景A: 20日低点反弹≥12% + RSI9>80 (KDJ超买) — 共 ${casesA.length} 次`);
  if (casesA.length) {
    const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
    const win = arr => (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0);
    const d1 = casesA.map(c => c.d1), d3 = casesA.map(c => c.d3), d5 = casesA.map(c => c.d5), d10 = casesA.map(c => c.d10);
    console.log(`平均:  后1日 ${avg(d1)}% | 后3日 ${avg(d3)}% | 后5日 ${avg(d5)}% | 后10日 ${avg(d10)}%`);
    console.log(`上涨概率: 后1日 ${win(d1)}% | 后3日 ${win(d3)}% | 后5日 ${win(d5)}% | 后10日 ${win(d10)}%`);
    console.log('最近20次:');
    console.log('日期'.padEnd(12), '收盘'.padEnd(8), '反弹%'.padEnd(8), '后1日%'.padEnd(8), '后5日%'.padEnd(8), '后10日%'.padEnd(8));
    for (const c of casesA.slice(-20)) {
      console.log(c.date.padEnd(12), String(c.close).padEnd(8), c.rebound.toFixed(1).padEnd(8),
        `${c.d1 >= 0 ? '+' : ''}${c.d1.toFixed(2)}`.padEnd(8),
        `${c.d5 >= 0 ? '+' : ''}${c.d5.toFixed(2)}`.padEnd(8),
        `${c.d10 >= 0 ? '+' : ''}${c.d10.toFixed(2)}`.padEnd(8));
    }
  }

  // 情景B: 现价在MA20 ±1%
  const casesB = [];
  for (let i = 40; i < klines.length - 10; i++) {
    const slice = klines.slice(0, i + 1);
    const closes = slice.map(k => k.close);
    const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const cur = klines[i];
    const dist = (cur.close - ma20) / ma20 * 100;
    if (Math.abs(dist) <= 1) {
      const c = cur.close;
      casesB.push({ date: cur.time, close: c, dist,
        d5: (klines[i + 5].close - c) / c * 100,
        d10: (klines[i + 10].close - c) / c * 100 });
    }
  }
  console.log(`\n情景B: 收盘价在MA20 ±1% 区间 — 共 ${casesB.length} 次`);
  if (casesB.length) {
    const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
    const win = arr => (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0);
    const d5 = casesB.map(c => c.d5), d10 = casesB.map(c => c.d10);
    console.log(`平均: 后5日 ${avg(d5)}% | 后10日 ${avg(d10)}%`);
    console.log(`上涨概率: 后5日 ${win(d5)}% | 后10日 ${win(d10)}%`);
    const above = casesB.filter(c => c.dist > 0);
    const below = casesB.filter(c => c.dist <= 0);
    if (above.length) {
      const a5 = above.map(c => c.d5), a10 = above.map(c => c.d10);
      console.log(`  MA20上方(${above.length}次): 后5日 ${avg(a5)}% (${win(a5)}%上涨) | 后10日 ${avg(a10)}% (${win(a10)}%上涨)`);
    }
    if (below.length) {
      const b5 = below.map(c => c.d5), b10 = below.map(c => c.d10);
      console.log(`  MA20下方(${below.length}次): 后5日 ${avg(b5)}% (${win(b5)}%上涨) | 后10日 ${avg(b10)}% (${win(b10)}%上涨)`);
    }
  }

  // 情景C: 距20日高点 -15%~-25% 反弹中
  const casesC = [];
  for (let i = 40; i < klines.length - 10; i++) {
    const slice = klines.slice(0, i + 1);
    const high20 = Math.max(...slice.slice(-20).map(k => k.high));
    const cur = klines[i];
    const dist = (cur.close - high20) / high20 * 100;
    if (dist >= -25 && dist <= -15) {
      const c = cur.close;
      casesC.push({ date: cur.time, close: c, dist,
        d5: (klines[i + 5].close - c) / c * 100,
        d10: (klines[i + 10].close - c) / c * 100,
        d20: (klines[i + 20]?.close ?? c - c) / c * 100 });
    }
  }
  console.log(`\n情景C: 距20日高点 -15%~-25% 反弹中 — 共 ${casesC.length} 次`);
  if (casesC.length) {
    const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
    const win = arr => (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0);
    const d5 = casesC.map(c => c.d5), d10 = casesC.map(c => c.d10), d20 = casesC.map(c => c.d20);
    console.log(`平均: 后5日 ${avg(d5)}% | 后10日 ${avg(d10)}% | 后20日 ${avg(d20)}%`);
    console.log(`上涨概率: 后5日 ${win(d5)}% | 后10日 ${win(d10)}% | 后20日 ${win(d20)}%`);
  }
  console.log('');
}

// ── 主流程: 策略对比（入口检查已在文件前部） ──