/**
 * 情景回测: 宗申动力 "从20日低点反弹≥12% 且 KDJ超买(RSI9>80)" 之后的走势
 * 回答用户问题: 15.61 加仓后策略喊卖出, 历史上这种位置后续怎么走?
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '../watchprice.db'), { readonly: true });

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
    if (!Number.isFinite(price) || price <= 0) continue;
    const key = dateKey(r.timestamp);
    const d = byDate.get(key);
    if (!d) byDate.set(key, { time: key, close: price, high: Number(r.high) || price, low: Number(r.low) || price });
    else {
      d.high = Math.max(d.high, Number(r.high) || price);
      d.low = Math.min(d.low, Number(r.low) || price);
      d.close = price;
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.time.localeCompare(b.time));
}

function rsi9(closes) {
  if (closes.length < 10) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - 9; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + (gain / 9) / (loss / 9));
}

const code = 'sz001696';
const klines = loadDaily(code);
console.log(`📈 宗申动力 (${code}) — ${klines.length} 个交易日\n`);

// 情景A: 从20日低点反弹 ≥12%，且 KDJ超买(RSI9>80)，看之后 1/3/5/10 日表现
const cases = [];
for (let i = 40; i < klines.length - 10; i++) {
  const slice = klines.slice(0, i + 1);
  const closes = slice.map(k => k.close);
  const low20 = Math.min(...slice.slice(-20).map(k => k.low));
  const cur = klines[i];
  const rebound = (cur.close - low20) / low20 * 100;
  const r9 = rsi9(closes);
  if (rebound >= 12 && r9 !== null && r9 > 80) {
    const c = cur.close;
    const f1 = klines[i + 1].close, f3 = klines[i + 3].close, f5 = klines[i + 5].close, f10 = klines[i + 10].close;
    cases.push({ date: cur.time, close: c, rebound, rsi: r9,
      d1: (f1 - c) / c * 100, d3: (f3 - c) / c * 100, d5: (f5 - c) / c * 100, d10: (f10 - c) / c * 100 });
  }
}

console.log(`情景A: 20日低点反弹≥12% + RSI9>80 (KDJ超买) — 共 ${cases.length} 次\n`);
if (cases.length) {
  const avg = (arr, n) => arr.length ? (arr.reduce((a, b) => a + b, 0) / n).toFixed(2) : 'N/A';
  const win = (arr) => arr.filter(x => x > 0).length;
  console.log('日期'.padEnd(12), '收盘'.padEnd(8), '反弹%'.padEnd(8), 'RSI9'.padEnd(7), '后1日%'.padEnd(8), '后3日%'.padEnd(8), '后5日%'.padEnd(8), '后10日%'.padEnd(8));
  console.log('-'.repeat(70));
  for (const c of cases.slice(-20)) {
    console.log(c.date.padEnd(12), String(c.close).padEnd(8), c.rebound.toFixed(1).padEnd(8), c.rsi.toFixed(0).padEnd(7),
      `${c.d1 >= 0 ? '+' : ''}${c.d1.toFixed(2)}`.padEnd(8), `${c.d3 >= 0 ? '+' : ''}${c.d3.toFixed(2)}`.padEnd(8),
      `${c.d5 >= 0 ? '+' : ''}${c.d5.toFixed(2)}`.padEnd(8), `${c.d10 >= 0 ? '+' : ''}${c.d10.toFixed(2)}`.padEnd(8));
  }
  console.log('-'.repeat(70));
  const d1 = cases.map(c => c.d1), d3 = cases.map(c => c.d3), d5 = cases.map(c => c.d5), d10 = cases.map(c => c.d10);
  console.log(`平均:  后1日 ${avg(d1, d1.length)}% | 后3日 ${avg(d3, d3.length)}% | 后5日 ${avg(d5, d5.length)}% | 后10日 ${avg(d10, d10.length)}%`);
  console.log(`上涨概率: 后1日 ${(win(d1)/d1.length*100).toFixed(0)}% | 后3日 ${(win(d3)/d3.length*100).toFixed(0)}% | 后5日 ${(win(d5)/d5.length*100).toFixed(0)}% | 后10日 ${(win(d10)/d10.length*100).toFixed(0)}%`);
}

// 情景B: 现价在MA20附近(±1%)，且刚突破MA20的情况
console.log('\n' + '='.repeat(70));
const nearMa20 = [];
for (let i = 40; i < klines.length - 10; i++) {
  const slice = klines.slice(0, i + 1);
  const closes = slice.map(k => k.close);
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const cur = klines[i];
  const dist = (cur.close - ma20) / ma20 * 100;
  if (Math.abs(dist) <= 1) { // 在MA20 ±1% 内
    const c = cur.close;
    const f5 = klines[i + 5].close, f10 = klines[i + 10].close;
    nearMa20.push({ date: cur.time, close: c, dist,
      d5: (f5 - c) / c * 100, d10: (f10 - c) / c * 100 });
  }
}
console.log(`情景B: 收盘价在MA20 ±1% 区间 — 共 ${nearMa20.length} 次`);
if (nearMa20.length) {
  const d5 = nearMa20.map(c => c.d5), d10 = nearMa20.map(c => c.d10);
  const avg = (arr) => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
  const win = (arr) => (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0);
  console.log(`平均: 后5日 ${avg(d5)}% | 后10日 ${avg(d10)}%`);
  console.log(`上涨概率: 后5日 ${win(d5)}% | 后10日 ${win(d10)}%`);
  // 区分在MA20上方还是下方
  const above = nearMa20.filter(c => c.dist > 0);
  const below = nearMa20.filter(c => c.dist <= 0);
  if (above.length) {
    const a5 = above.map(c => c.d5), a10 = above.map(c => c.d10);
    console.log(`  MA20上方(${above.length}次): 后5日 ${avg(a5)}% (${win(a5)}%上涨) | 后10日 ${avg(a10)}% (${win(a10)}%上涨)`);
  }
  if (below.length) {
    const b5 = below.map(c => c.d5), b10 = below.map(c => c.d10);
    console.log(`  MA20下方(${below.length}次): 后5日 ${avg(b5)}% (${win(b5)}%上涨) | 后10日 ${avg(b10)}% (${win(b10)}%上涨)`);
  }
}

// 情景C: 深套后反弹——当前价距离20日高点的位置
console.log('\n' + '='.repeat(70));
const fromHigh = [];
for (let i = 40; i < klines.length - 10; i++) {
  const slice = klines.slice(0, i + 1);
  const high20 = Math.max(...slice.slice(-20).map(k => k.high));
  const cur = klines[i];
  const dist = (cur.close - high20) / high20 * 100;
  if (dist >= -25 && dist <= -15) { // 距20日高点 -15%~-25% (类似现在 15.66 vs 19.75 = -20.7%)
    const c = cur.close;
    const f5 = klines[i + 5].close, f10 = klines[i + 10].close, f20 = klines[i + 20]?.close ?? c;
    fromHigh.push({ date: cur.time, close: c, dist,
      d5: (f5 - c) / c * 100, d10: (f10 - c) / c * 100, d20: (f20 - c) / c * 100 });
  }
}
console.log(`情景C: 距20日高点 -15%~-25% 反弹中(现: 15.66 vs 19.75 = -20.7%) — 共 ${fromHigh.length} 次`);
if (fromHigh.length) {
  const d5 = fromHigh.map(c => c.d5), d10 = fromHigh.map(c => c.d10), d20 = fromHigh.map(c => c.d20);
  const avg = (arr) => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
  const win = (arr) => (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0);
  console.log(`平均: 后5日 ${avg(d5)}% | 后10日 ${avg(d10)}% | 后20日 ${avg(d20)}%`);
  console.log(`上涨概率: 后5日 ${win(d5)}% | 后10日 ${win(d10)}% | 后20日 ${win(d20)}%`);
}
