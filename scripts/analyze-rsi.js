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

const codeFilter = options.code;
const windowMs = 5 * 60 * 1000;

const baseQuery = `
  SELECT code, timestamp, indicators
  FROM price_records
  WHERE indicators IS NOT NULL
  ${codeFilter ? 'AND code = ?' : ''}
  ORDER BY timestamp DESC
`;

const rows = codeFilter
  ? db.prepare(baseQuery).all(codeFilter)
  : db.prepare(baseQuery).all();

if (!rows.length) {
  console.log('No indicator rows found.');
  process.exit(0);
}

function safeParseIndicators(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const stats = new Map();

rows.forEach(row => {
  const indicators = safeParseIndicators(row.indicators);
  const rsiRaw = indicators?.rsi?.value ?? indicators?.rsi;
  const rsi = Number(rsiRaw);
  if (Number.isNaN(rsi)) return;
  const timestamp = Date.parse(row.timestamp);
  if (Number.isNaN(timestamp)) return;

  const code = row.code;
  const key = Math.floor(timestamp / windowMs);
  const entry = stats.get(code) ?? { windows: new Map(), rsiSum: 0, rsiCount: 0 };
  const windowBucket = entry.windows.get(key) ?? { first: null, last: null };

  if (!windowBucket.first || timestamp < windowBucket.first.ts) {
    windowBucket.first = { ts: timestamp, rsi };
  }
  if (!windowBucket.last || timestamp > windowBucket.last.ts) {
    windowBucket.last = { ts: timestamp, rsi };
  }

  entry.windows.set(key, windowBucket);
  entry.rsiSum += rsi;
  entry.rsiCount += 1;
  stats.set(code, entry);
});

const summary = [];

stats.forEach((entry, code) => {
  const windowChanges = [];
  entry.windows.forEach(bucket => {
    if (bucket.first && bucket.last) {
      windowChanges.push(bucket.last.rsi - bucket.first.rsi);
    }
  });
  const avgRsi = entry.rsiCount ? (entry.rsiSum / entry.rsiCount).toFixed(2) : 'N/A';
  const avgChange = windowChanges.length
    ? (windowChanges.reduce((sum, change) => sum + change, 0) / windowChanges.length).toFixed(2)
    : 'N/A';
  summary.push({
    code,
    windows: windowChanges.length,
    avgRsi,
    avgChange
  });
});

console.table(summary);
