/**
 * 农业银行加仓点分析 —— KDJ超卖后走势 + 支撑位回测
 * 只统计近期数据(2023+)，避免早期复权价格污染
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

// 用 RSI9 近似 KDJ 超卖（与之前脚本一致）
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

const code = 'sh601288';
const klines = loadDaily(code);
console.log(`📈 农业银行 — ${klines.length} 个交易日 (${klines[0].time} ~ ${klines[klines.length-1].time})\n`);

// 情景1: KDJ超卖(RSI9<20) 后 1/3/5/10 日表现 —— 加仓时机参考
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
      d10: (klines[i + 10].close - c) / c * 100,
      max5: Math.max(...klines.slice(i + 1, i + 6).map(k => k.close)) / c * 100 - 100
    });
  }
}
console.log(`情景1: KDJ超卖(RSI9<20) 后走势 — ${oversold.length} 次 (2023+)`);
if (oversold.length) {
  const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
  const win = arr => (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0);
  const d3 = oversold.map(x => x.d3), d5 = oversold.map(x => x.d5), d10 = oversold.map(x => x.d10), mx = oversold.map(x => x.max5);
  console.log(`平均: 后3日 ${avg(d3)}% | 后5日 ${avg(d5)}% | 后10日 ${avg(d10)}% | 5日内最大反弹 ${avg(mx)}%`);
  console.log(`上涨概率: 后3日 ${win(d3)}% | 后5日 ${win(d5)}% | 后10日 ${win(d10)}%`);
  console.log('最近10次:');
  oversold.slice(-10).forEach(x => {
    console.log(`  ${x.date} 收盘${x.close.toFixed(2)} RSI9=${x.r9.toFixed(0)} → 后3日${x.d3 >= 0 ? '+' : ''}${x.d3.toFixed(2)}% 后10日${x.d10 >= 0 ? '+' : ''}${x.d10.toFixed(2)}%`);
  });
}

// 情景2: 回踩 20 日低点附近(±1.5%) 后走势 —— 支撑位加仓参考
const nearLow = [];
for (let i = 40; i < klines.length - 10; i++) {
  const slice = klines.slice(0, i + 1);
  const closes = slice.map(k => k.close);
  const low20 = Math.min(...slice.slice(-20).map(k => k.low));
  const cur = klines[i];
  const dist = (cur.close - low20) / low20 * 100;
  if (dist >= 0 && dist <= 1.5) { // 收盘价在20日低点上方 0~1.5%
    const c = cur.close;
    nearLow.push({
      date: cur.time, close: c,
      d5: (klines[i + 5].close - c) / c * 100,
      d10: (klines[i + 10].close - c) / c * 100
    });
  }
}
console.log(`\n情景2: 收盘在20日低点上方0~1.5% (支撑位附近) — ${nearLow.length} 次`);
if (nearLow.length) {
  const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
  const win = arr => (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0);
  const d5 = nearLow.map(x => x.d5), d10 = nearLow.map(x => x.d10);
  console.log(`平均: 后5日 ${avg(d5)}% | 后10日 ${avg(d10)}%`);
  console.log(`上涨概率: 后5日 ${win(d5)}% | 后10日 ${win(d10)}%`);
}

// 当前支撑结构
const last20 = klines.slice(-20);
const last10 = klines.slice(-10);
console.log(`\n当前支撑结构:`);
console.log(`  10日低点: ${Math.min(...last10.map(k => k.low))}`);
console.log(`  20日低点: ${Math.min(...last20.map(k => k.low))}`);
console.log(`  60日低点: ${Math.min(...klines.slice(-60).map(k => k.low))}`);
console.log(`  现价: ${klines[klines.length-1].close}`);
