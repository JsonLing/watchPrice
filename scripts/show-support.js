import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database(path.join(__dirname, '../watchprice.db'), { fileMustExist: true });
const argv = process.argv.slice(2);
const options = argv.reduce((acc, token) => {
  if (!token.startsWith('--')) return acc;
  const [key, value] = token.slice(2).split('=');
  acc[key] = value || true;
  return acc;
}, {});

const code = options.code || 'sh601288';
const lookback = Number(options.lookback) || 40;
const rows = db.prepare(`
  SELECT price, high, low, timestamp
  FROM price_records
  WHERE code = ?
  ORDER BY timestamp DESC
  LIMIT ?
`).all(code, lookback);

if (!rows.length) {
  console.log(`没有 ${code} 的历史数据`);
  process.exit(0);
}

const priceValues = rows.map(r => Number(r.price)).filter(Number.isFinite);
const highs = rows.map(r => Number(r.high)).filter(Number.isFinite);
const lows = rows.map(r => Number(r.low)).filter(Number.isFinite);
const supportValues = [...priceValues, ...lows].filter(Number.isFinite);
const resistanceValues = [...priceValues, ...highs].filter(Number.isFinite);
const support = supportValues.length ? Math.min(...supportValues) : null;
const resistance = resistanceValues.length ? Math.max(...resistanceValues) : null;
const current =
  priceValues.length > 0
    ? priceValues[0]
    : closeValues.length > 0
      ? closeValues[0]
      : null;
const breakout = resistance !== null && current !== null && current > resistance;
const breakdown = support !== null && current !== null && current < support;

console.log(`最近 ${rows.length} 条 ${code} 价格区间：`);
console.log(`  支撑≈ ${support?.toFixed(2) ?? 'N/A'}`);
console.log(`  压力≈ ${resistance?.toFixed(2) ?? 'N/A'}`);
console.log(`  当前价格：${current !== null ? current.toFixed(2) : 'N/A'}`);
console.log('  备注：', breakout ? '已突破压力' : breakdown ? '跌破支撑' : '区间震荡');
