/**
 * 雪人集团加仓/减仓点分析 —— 情景回测 (2023+ 数据, 避免复权污染)
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

function loadDaily(code, since = '2023-01-01') {
  const rows = db.prepare(
    `SELECT timestamp, price, high, low, volume FROM price_records WHERE code = ? AND timestamp >= ? ORDER BY timestamp ASC`
  ).all(code, since);
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

const code = 'sz002639';
const klines = loadDaily(code);
console.log(`📈 雪人集团 — ${klines.length} 个交易日 (${klines[0].time} ~ ${klines[klines.length-1].time})\n`);

// 情景1: KDJ超卖(RSI9<20) 后走势 —— 加仓时机
const oversold = [];
for (let i = 40; i < klines.length - 10; i++) {
  const closes = klines.slice(0, i + 1).map(k => k.close);
  const r9 = rsiN(closes, 9);
  if (r9 !== null && r9 < 20) {
    const c = klines[i].close;
    oversold.push({
      date: klines[i].time, close: c, r9,
      d3: (klines[i + 3].close - c) / c * 100,
      d5: (klines[i + 5].close - c) / c * 100,
      d10: (klines[i + 10].close - c) / c * 100
    });
  }
}
console.log(`情景1: KDJ超卖(RSI9<20) 后走势 — ${oversold.length} 次`);
if (oversold.length) {
  const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
  const win = arr => (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0);
  const d3 = oversold.map(x => x.d3), d5 = oversold.map(x => x.d5), d10 = oversold.map(x => x.d10);
  console.log(`平均: 后3日 ${avg(d3)}% | 后5日 ${avg(d5)}% | 后10日 ${avg(d10)}%`);
  console.log(`上涨概率: 后3日 ${win(d3)}% | 后5日 ${win(d5)}% | 后10日 ${win(d10)}%`);
  console.log('最近8次:');
  oversold.slice(-8).forEach(x => {
    console.log(`  ${x.date} 收盘${x.close.toFixed(2)} → 后3日${x.d3 >= 0 ? '+' : ''}${x.d3.toFixed(2)}% 后10日${x.d10 >= 0 ? '+' : ''}${x.d10.toFixed(2)}%`);
  });
}

// 情景2: 收盘在20日低点上方0~2% (支撑位附近) 后走势
const nearLow = [];
for (let i = 40; i < klines.length - 10; i++) {
  const slice = klines.slice(0, i + 1);
  const low20 = Math.min(...slice.slice(-20).map(k => k.low));
  const cur = klines[i];
  const dist = (cur.close - low20) / low20 * 100;
  if (dist >= 0 && dist <= 2) {
    const c = cur.close;
    nearLow.push({
      date: cur.time, close: c,
      d5: (klines[i + 5].close - c) / c * 100,
      d10: (klines[i + 10].close - c) / c * 100
    });
  }
}
console.log(`\n情景2: 收盘在20日低点上方0~2% (支撑位附近) — ${nearLow.length} 次`);
if (nearLow.length) {
  const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
  const win = arr => (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0);
  const d5 = nearLow.map(x => x.d5), d10 = nearLow.map(x => x.d10);
  console.log(`平均: 后5日 ${avg(d5)}% | 后10日 ${avg(d10)}%`);
  console.log(`上涨概率: 后5日 ${win(d5)}% | 后10日 ${win(d10)}%`);
}

// 情景3: 触及20日高点附近(0~2%) 后走势 —— 减仓时机(现价12.64 vs 高点12.95 = -2.4%)
const nearHigh = [];
for (let i = 40; i < klines.length - 10; i++) {
  const slice = klines.slice(0, i + 1);
  const high20 = Math.max(...slice.slice(-20).map(k => k.high));
  const cur = klines[i];
  const dist = (cur.close - high20) / high20 * 100;
  if (dist >= -2 && dist <= 0) {
    const c = cur.close;
    nearHigh.push({
      date: cur.time, close: c,
      d5: (klines[i + 5].close - c) / c * 100,
      d10: (klines[i + 10].close - c) / c * 100
    });
  }
}
console.log(`\n情景3: 收盘在20日高点下方0~2% (压力位附近) — ${nearHigh.length} 次`);
if (nearHigh.length) {
  const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
  const win = arr => (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0);
  const d5 = nearHigh.map(x => x.d5), d10 = nearHigh.map(x => x.d10);
  console.log(`平均: 后5日 ${avg(d5)}% | 后10日 ${avg(d10)}%`);
  console.log(`上涨概率: 后5日 ${win(d5)}% | 后10日 ${win(d10)}%`);
}

// 当前支撑结构
const last60 = klines.slice(-60);
console.log(`\n当前支撑/压力结构:`);
console.log(`  现价: ${klines[klines.length-1].close}`);
console.log(`  10日低: ${Math.min(...klines.slice(-10).map(k => k.low))}`);
console.log(`  20日低: ${Math.min(...klines.slice(-20).map(k => k.low))}`);
console.log(`  60日低: ${Math.min(...last60.map(k => k.low))}`);
console.log(`  10日高: ${Math.max(...klines.slice(-10).map(k => k.high))}`);
console.log(`  20日高: ${Math.max(...klines.slice(-20).map(k => k.high))}`);
console.log(`  60日高: ${Math.max(...last60.map(k => k.high))}`);
