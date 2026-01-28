import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { aggregateTimeseries } from '../lib/timeseries.js';

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

const code = (options.code || 'sh601288').trim();
const limit = Math.max(10, Number(options.limit) || 240);
const interval = Math.max(1, Number(options.interval) || 1);
const format = (options.format || 'json').toLowerCase();

const fetchLimit = Math.max(limit * 6, 200);
const rows = db
  .prepare(
    `SELECT timestamp, price, high, low, volume FROM price_records WHERE code = ? ORDER BY timestamp DESC LIMIT ?`
  )
  .all(code, fetchLimit);

const series = aggregateTimeseries(rows, { intervalMinutes: interval, limit });

if (format === 'csv') {
  console.log('timestamp,open,high,low,close,avgPrice,volume,amplitude,changePercent');
  series.forEach(item => {
    const csvLine = [
      item.timestamp,
      item.open ?? '',
      item.high ?? '',
      item.low ?? '',
      item.close ?? '',
      item.avgPrice ?? '',
      item.volume ?? '',
      item.amplitude ?? '',
      item.changePercent ?? ''
    ].join(',');
    console.log(csvLine);
  });
} else if (format === 'table') {
  console.table(series);
} else {
  console.log(
    JSON.stringify(
      {
        code,
        intervalMinutes: interval,
        limit,
        data: series
      },
      null,
      2
    )
  );
}
