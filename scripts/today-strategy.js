/**
 * 根据当前策略与库内最新数据，输出「到今天为止」的策略建议。
 * 用法: node scripts/today-strategy.js
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { fetchTimeseriesSeries, TIMESERIES_DEFAULTS } from '../lib/timeseries.js';
import { calcTradingSignal } from '../lib/trading-signal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '../config.json');
const dbPath = path.join(__dirname, '../watchprice.db');

function parseIndicators(raw) {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function run() {
  const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  const stocks = config.stocks || [];
  const db = new Database(dbPath);

  const todayStr = new Date().toISOString().slice(0, 10);
  console.log(`\n📅 截至今日（${todayStr}）策略建议\n`);
  console.log('─'.repeat(60));

  for (const stock of stocks) {
    const code = stock.code;
    const name = stock.name || code;

    const row = db.prepare(
      `SELECT timestamp, price, indicators, inner_volume, outer_volume FROM price_records WHERE code = ? ORDER BY timestamp DESC LIMIT 1`
    ).get(code);
    if (!row) {
      console.log(`\n${name} (${code}): 无最近数据，请先运行 npm start 拉取`);
      continue;
    }

    const indicators = parseIndicators(row.indicators);
    const timeseries = fetchTimeseriesSeries(db, code, { limit: TIMESERIES_DEFAULTS.windowLimit });
    const latestBucket = timeseries.length ? timeseries[timeseries.length - 1] : null;
    const quote = {
      currentPrice: row.price,
      innerVolume: row.inner_volume ?? undefined,
      outerVolume: row.outer_volume ?? undefined
    };
    const signal = calcTradingSignal(indicators, latestBucket, timeseries, quote);

    const dataTime = row.timestamp ? new Date(row.timestamp).toLocaleString('zh-CN') : '';
    console.log(`\n${name} (${code})  数据时间: ${dataTime}`);
    console.log(`  当前价: ${row.price != null ? Number(row.price).toFixed(2) : 'N/A'}`);
    console.log(`  建议: ${signal.action}`);
    if (signal.stopLoss != null) console.log(`  止损位: ${signal.stopLoss.toFixed(2)}`);
    if (signal.takeProfit != null) console.log(`  止盈位: ${signal.takeProfit.toFixed(2)}`);
    const reasons = Array.isArray(signal.rationale) ? signal.rationale : (signal.rationale ? [signal.rationale] : []);
    if (reasons.length) console.log(`  依据: ${reasons.join(' · ')}`);
  }

  console.log('\n' + '─'.repeat(60));
  db.close();
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
