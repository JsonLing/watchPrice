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

const limit = Number(options.limit) || 5;
const codeFilter = options.code;
const format = (options.format || 'table').toLowerCase();

const clauses = ['indicators IS NOT NULL'];
const params = [];
if (codeFilter) {
  clauses.push('code = ?');
  params.push(codeFilter);
}

const rows = db.prepare(`
  SELECT id, code, timestamp, indicators
  FROM price_records
  WHERE ${clauses.join(' AND ')}
  ORDER BY timestamp DESC
  LIMIT ?
`).all(...params, limit);

if (!rows.length) {
  console.log('未找到带指标的历史记录，请等服务重新拉取');
  process.exit(0);
}

if (format === 'json') {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const summarized = rows.map(row => ({
  id: row.id,
  code: row.code,
  timestamp: row.timestamp,
  indicators: row.indicators
}));

console.table(summarized);
