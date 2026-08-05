/**
 * Use only local watchprice.db records to produce strategy suggestions.
 * It reads every collected price_records row for each configured stock,
 * builds a daily history context from local data, and combines it with
 * intraday aggregation plus the latest saved indicators.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { buildHistoryContext } from '../lib/history-context.js';
import { calcTradingSignal } from '../lib/trading-signal.js';
import { aggregateTimeseries } from '../lib/timeseries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '../config.json');
const dbPath = path.join(__dirname, '../watchprice.db');

function parseArgs(argv) {
  return argv.reduce((acc, token) => {
    if (!token.startsWith('--')) return acc;
    const [key, value] = token.slice(2).split('=');
    acc[key] = value === undefined ? true : value;
    return acc;
  }, {});
}

function parseIndicators(raw) {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function dateKey(timestamp) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return String(timestamp).slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function buildDailyRows(rows) {
  const byDate = new Map();

  for (const row of rows) {
    const price = Number(row.price);
    if (!Number.isFinite(price)) continue;

    const key = dateKey(row.timestamp);
    const volume = Number(row.volume);
    let daily = byDate.get(key);
    if (!daily) {
      daily = {
        time: key,
        open: price,
        high: Number.isFinite(Number(row.high)) ? Number(row.high) : price,
        low: Number.isFinite(Number(row.low)) ? Number(row.low) : price,
        close: price,
        firstVolume: Number.isFinite(volume) ? volume : null,
        lastVolume: Number.isFinite(volume) ? volume : null
      };
      byDate.set(key, daily);
      continue;
    }

    daily.high = Math.max(daily.high, Number.isFinite(Number(row.high)) ? Number(row.high) : price);
    daily.low = Math.min(daily.low, Number.isFinite(Number(row.low)) ? Number(row.low) : price);
    daily.close = price;
    if (Number.isFinite(volume)) {
      if (daily.firstVolume == null) daily.firstVolume = volume;
      daily.lastVolume = volume;
    }
  }

  return Array.from(byDate.values())
    .map(daily => ({
      time: daily.time,
      open: daily.open,
      high: daily.high,
      low: daily.low,
      close: daily.close,
      volume:
        daily.firstVolume != null && daily.lastVolume != null
          ? Math.max(daily.lastVolume - daily.firstVolume, 0)
          : null
    }))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

function formatPct(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : 'N/A';
}

function filterRowsByRecentTradingDays(rows, dailyRows, days) {
  if (!Number.isFinite(days) || days <= 0 || dailyRows.length <= days) {
    return { rows, dailyRows };
  }

  const recentDailyRows = dailyRows.slice(-days);
  const allowedDates = new Set(recentDailyRows.map(row => row.time));
  return {
    rows: rows.filter(row => allowedDates.has(dateKey(row.timestamp))),
    dailyRows: recentDailyRows
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  const configuredStocks = config.stocks || [];
  const requestedCode = options.code ? String(options.code) : null;
  const stocks = requestedCode
    ? configuredStocks.filter(stock => stock.code === requestedCode)
    : configuredStocks;

  if (requestedCode && stocks.length === 0) {
    stocks.push({ code: requestedCode, name: requestedCode });
  }

  const interval = Math.max(1, Number(options.interval) || 1);
  const days = options.days ? Math.max(1, Number(options.days) || 0) : null;
  const db = new Database(dbPath, { fileMustExist: true });

  console.log(`\n本地数据库${days ? `最近 ${days} 个交易日` : '全量'}策略建议`);
  console.log(`数据源: watchprice.db / price_records ${days ? `最近 ${days} 个交易日记录` : '全部已收集记录'}`);
  console.log('='.repeat(72));

  for (const stock of stocks) {
    const rows = db.prepare(`
      SELECT timestamp, code, name, price, high, low, volume, inner_volume, outer_volume, indicators
      FROM price_records
      WHERE code = ?
      ORDER BY timestamp ASC
    `).all(stock.code);

    if (!rows.length) {
      console.log(`\n${stock.name || stock.code} (${stock.code}): 数据库暂无记录`);
      continue;
    }

    const allDailyRows = buildDailyRows(rows);
    const scoped = filterRowsByRecentTradingDays(rows, allDailyRows, days);
    const scopedRows = scoped.rows;
    const dailyRows = scoped.dailyRows;
    const latest = scopedRows[scopedRows.length - 1] ?? rows[rows.length - 1];
    const history = buildHistoryContext(dailyRows);
    const timeseries = aggregateTimeseries(scopedRows, { intervalMinutes: interval, limit: scopedRows.length });
    const latestBucket = timeseries.length ? timeseries[timeseries.length - 1] : null;
    const indicators = parseIndicators(latest.indicators);
    const quote = {
      currentPrice: latest.price,
      innerVolume: latest.inner_volume ?? undefined,
      outerVolume: latest.outer_volume ?? undefined
    };
    const signal = calcTradingSignal(indicators, latestBucket, timeseries, quote, history);
    const reasons = Array.isArray(signal.rationale) ? signal.rationale : signal.rationale ? [signal.rationale] : [];

    console.log(`\n${latest.name || stock.name || stock.code} (${stock.code})`);
    console.log(`  记录数: ${scopedRows.length} 条 / 聚合交易日: ${dailyRows.length} 天`);
    if (days) console.log(`  数据范围: 最近 ${dailyRows.length} 个交易日（全库 ${allDailyRows.length} 个交易日）`);
    console.log(`  最新时间: ${latest.timestamp}`);
    console.log(`  当前价: ${Number.isFinite(Number(latest.price)) ? Number(latest.price).toFixed(2) : 'N/A'}`);
    console.log(`  建议: ${signal.action}`);
    console.log(`  历史趋势: ${history.available ? history.trend : '样本不足'}`);
    if (history.available) {
      console.log(`  MA5/MA20: ${history.ma5.toFixed(2)} / ${history.ma20.toFixed(2)}`);
      console.log(`  20日位置: ${Number.isFinite(history.position20) ? `${(history.position20 * 100).toFixed(0)}%` : 'N/A'}`);
      console.log(`  5日/20日涨跌: ${formatPct(history.change5)} / ${formatPct(history.change20)}`);
    }
    if (signal.stopLoss != null) console.log(`  止损位: ${signal.stopLoss.toFixed(2)}`);
    if (signal.takeProfit != null) console.log(`  止盈位: ${signal.takeProfit.toFixed(2)}`);
    if (reasons.length) console.log(`  依据: ${reasons.join(' · ')}`);
  }

  console.log('\n' + '='.repeat(72));
  db.close();
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
