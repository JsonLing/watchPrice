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

const code = options.code;
const since = options.since;
const to = options.to;
const format = (options.format || 'csv').toLowerCase();

const clauses = [];
const params = [];
if (code) {
  clauses.push('code = ?');
  params.push(code);
}
if (since) {
  clauses.push('timestamp >= ?');
  params.push(new Date(since).toISOString());
}
if (to) {
  clauses.push('timestamp <= ?');
  params.push(new Date(to).toISOString());
}

const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
const rows = db.prepare(`
  SELECT *
  FROM price_records
  ${where}
  ORDER BY timestamp DESC
`).all(...params);

if (!rows.length) {
  console.log('没有匹配的数据');
  process.exit(0);
}

if (format === 'json') {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const header = Object.keys(rows[0]).join(',');
const body = rows
  .map(row => Object.values(row).map(value => JSON.stringify(value ?? '')).join(','))
  .join('\n');
console.log(header);
console.log(body);
