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
  acc[key] = value === undefined ? true : value;
  return acc;
}, {});

const code = options.code || 'sh601288';
const lookback = Number(options.lookback) || 15;

const rows = db.prepare(`
  SELECT timestamp, price, indicators
  FROM price_records
  WHERE code = ? AND indicators IS NOT NULL
  ORDER BY timestamp DESC
  LIMIT ?
`).all(code, lookback);

if (!rows.length) {
  console.log(`没有足够 ${code} 的指标数据，请等待服务抓取`);
  process.exit(0);
}

const latest = rows[0];
const parsedIndicators = (() => {
  try {
    return JSON.parse(latest.indicators);
  } catch {
    return latest.indicators;
  }
})();

const rsi = Number(parsedIndicators?.rsi?.value ?? parsedIndicators?.rsi);
const macdSignal = parsedIndicators?.macd?.signalType;
const dkSignal = parsedIndicators?.dk?.signal;

const closes = rows.map(r => Number(r.close)).filter(Number.isFinite);
const support = Math.min(...closes);
const resistance = Math.max(...closes);
const current = closes[0];

const rsiSignal = rsi >= 70 ? '超买' : rsi <= 30 ? '超卖' : '中性';

const breakthrough = current > resistance;
const breakdown = current < support;

let action = '保持观望';
if (rsiSignal === '超买' && breakthrough) {
  action = '考虑获利了结';
} else if (rsiSignal === '超卖' && breakdown) {
  action = '考虑低吸/回补';
} else if (dkSignal?.includes('多头') && macdSignal?.includes('看涨')) {
  action = '趋势偏多';
} else if (dkSignal?.includes('空头') && macdSignal?.includes('看跌')) {
  action = '趋势偏空';
}

console.log(`信号判定（${code}）`);
console.log(`  RSI: ${Number.isFinite(rsi) ? rsi.toFixed(2) : 'N/A'} (${rsiSignal})`);
console.log(`  MACD 方向: ${macdSignal || '未知'}`);
console.log(`  DK Signal: ${dkSignal || '未知'}`);
console.log(`  当前价格: ${Number.isFinite(current) ? current.toFixed(2) : 'N/A'}`);
console.log(`  支撑: ${support.toFixed(2)} / 压力: ${resistance.toFixed(2)}`);
console.log(`  建议: ${action}`);
