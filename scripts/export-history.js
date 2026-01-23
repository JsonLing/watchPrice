import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../watchprice.db');

const db = new Database(dbPath, { fileMustExist: true });

const DEFAULT_LIMIT = 10;
const DEFAULT_FORMAT = 'table';

const argv = process.argv.slice(2);
const options = argv.reduce((acc, token) => {
  if (!token.startsWith('--')) return acc;
  const [key, value] = token.slice(2).split('=');
  acc[key] = value || true;
  return acc;
}, {});

const code = options.code || 'sh601288';
const limit = Number(options.limit) || DEFAULT_LIMIT;
const format = (options.format || DEFAULT_FORMAT).toLowerCase();

const rows = db.prepare(`
  SELECT code, timestamp, price, change, change_percent, indicators
  FROM price_records
  WHERE code = ?
  ORDER BY timestamp DESC
  LIMIT ?
`).all(code, limit);

if (!rows.length) {
  console.log(`没有找到 ${code} 的记录（db: ${dbPath}）`);
  process.exit(0);
}

if (format === 'json') {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (format === 'csv') {
  const header = Object.keys(rows[0]).join(',');
  const body = rows
    .map(row => Object.values(row).map(value => JSON.stringify(value ?? '')).join(','))
    .join('\n');
  console.log(header);
  console.log(body);
  process.exit(0);
}

console.table(rows);
