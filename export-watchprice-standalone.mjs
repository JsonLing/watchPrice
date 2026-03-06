/**
 * WatchPrice 数据导出 - 单文件、零安装（无需 npm install）
 * 仅依赖 Node 内置模块；首次运行会从 CDN 下载 sql.js 并缓存。
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const SQLJS_VERSION = '1.4.0';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/sql.js@${SQLJS_VERSION}/dist`;

function getCacheDir() {
  // 优先用当前目录下的缓存，避免无 ~/.cache 写权限
  const inCwd = path.join(process.cwd(), '.watchprice-export');
  if (process.env.WATCHPRICE_CACHE) return path.resolve(process.env.WATCHPRICE_CACHE);
  return inCwd;
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureSqlJs() {
  const cacheDir = getCacheDir();
  const jsPath = path.join(cacheDir, 'sql-wasm.cjs');
  const wasmPath = path.join(cacheDir, 'sql-wasm.wasm');

  if (!fs.existsSync(jsPath) || !fs.existsSync(wasmPath)) {
    process.stderr.write('首次运行：正在下载 sql.js（约 1MB），仅此一次…\n');
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const [jsBuf, wasmBuf] = await Promise.all([
        download(`${CDN_BASE}/sql-wasm.js`),
        download(`${CDN_BASE}/sql-wasm.wasm`)
      ]);
      fs.writeFileSync(jsPath, jsBuf);
      fs.writeFileSync(wasmPath, wasmBuf);
    } catch (e) {
      console.error('下载失败（请检查网络）:', e?.message || e);
      process.exit(1);
    }
  }

  const initSqlJs = require(jsPath);
  const wasmBinary = fs.readFileSync(wasmPath);
  const SQL = await initSqlJs({ wasmBinary });
  return SQL;
}

/** sql.js 没有 db.all，用 prepare + step + getAsObject 封装成与 better-sqlite3 类似的 all */
function dbAll(db, sql, ...params) {
  const stmt = db.prepare(sql);
  stmt.bind(params || []);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function parseArgs(argv) {
  const positional = [];
  const options = {};

  for (const token of argv) {
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const raw = token.slice(2);
    const eq = raw.indexOf('=');
    if (eq === -1) {
      options[raw] = true;
      continue;
    }
    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    options[key] = value;
  }

  return { positional, options };
}

function printHelp() {
  const text = `
WatchPrice 数据导出（单文件、零安装）

用法：
  node export-watchprice-standalone.mjs <command> [--key=value...]

无需 npm install，仅需 Node.js。首次运行会从 CDN 下载 sql.js 并缓存。

命令：
  history    导出某只股票最近 N 条记录（含 indicators）
  all        导出全库（可按 code / 时间范围过滤）
  timeseries 导出分时聚合窗口（OHLC/均价/振幅/涨幅/量）

通用参数：
  --db=<path>          SQLite 文件路径（默认 ./watchprice.db）

history 参数：
  --code=<code>        默认 sh601288
  --limit=<n>          默认 10
  --format=table|json|csv   默认 table

all 参数：
  --code=<code>        可选
  --since=<time>       可选（例如 2026-01-01 或 20260101 或 ISO）
  --to=<time>          可选
  --format=json|csv    默认 csv

timeseries 参数：
  --code=<code>        默认 sh601288
  --limit=<n>          默认 240（最少 10）
  --interval=<minutes> 默认 1（最少 1）
  --format=json|csv|table   默认 json

示例：
  node export-watchprice-standalone.mjs history --code=sh601288 --limit=5 --format=table
  node export-watchprice-standalone.mjs all --format=csv
  node export-watchprice-standalone.mjs all --code=AAPL --since=2026-01-01 --format=json
  node export-watchprice-standalone.mjs timeseries --code=TSLA --interval=5 --limit=60 --format=csv
`.trim();

  console.log(text);
}

function parseTimeToIso(value) {
  if (!value) return null;
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;

  const compact = raw.replace(/\s+/g, '').replace(/[^\dT:\-+.Z]/g, '');
  if (/^\d{8}$/.test(compact)) {
    const y = compact.slice(0, 4);
    const m = compact.slice(4, 6);
    const d = compact.slice(6, 8);
    const dt = new Date(`${y}-${m}-${d}T00:00:00`);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }

  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function csvEscape(value) {
  return JSON.stringify(value ?? '');
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function buildBucket() {
  return {
    start: 0,
    open: null,
    high: null,
    low: null,
    close: null,
    sumPrice: 0,
    count: 0,
    firstVolume: null,
    lastVolume: null
  };
}

function aggregateTimeseries(rows = [], options = {}) {
  const intervalMinutes = Math.max(1, Number(options.intervalMinutes) || 1);
  const limit = Math.max(1, Number(options.limit) || 240);
  const bucketMs = intervalMinutes * 60 * 1000;

  const normalized = (rows ?? [])
    .map(row => {
      const timestampMs = Date.parse(row.timestamp);
      if (!Number.isFinite(timestampMs)) return null;
      return {
        ...row,
        timestampMs,
        price: toNumber(row.price ?? row.close ?? row.open),
        high: toNumber(row.high),
        low: toNumber(row.low),
        volume: toNumber(row.volume)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const buckets = new Map();

  normalized.forEach(row => {
    const bucketStart = Math.floor(row.timestampMs / bucketMs) * bucketMs;
    let bucket = buckets.get(bucketStart);
    if (!bucket) {
      bucket = buildBucket();
      bucket.start = bucketStart;
      buckets.set(bucketStart, bucket);
    }

    if (row.price != null) {
      if (bucket.open == null) {
        bucket.open = row.price;
      }
      bucket.close = row.price;
      bucket.high = bucket.high != null ? Math.max(bucket.high, row.price) : row.price;
      bucket.low = bucket.low != null ? Math.min(bucket.low, row.price) : row.price;
      bucket.sumPrice += row.price;
      bucket.count += 1;
    }

    if (row.volume != null) {
      if (bucket.firstVolume == null) {
        bucket.firstVolume = row.volume;
      }
      bucket.lastVolume = row.volume;
    }
  });

  const bucketArray = Array.from(buckets.values())
    .filter(bucket => bucket.close != null)
    .sort((a, b) => a.start - b.start);

  const limitedBuckets = bucketArray.slice(-limit);
  const result = [];
  let prevClose = null;

  limitedBuckets.forEach(bucket => {
    const avgPrice = bucket.count ? bucket.sumPrice / bucket.count : bucket.close;
    const volume =
      bucket.firstVolume != null && bucket.lastVolume != null
        ? Math.max(bucket.lastVolume - bucket.firstVolume, 0)
        : null;
    const amplitude =
      bucket.low && bucket.high
        ? ((bucket.high - bucket.low) / (bucket.low || bucket.open || bucket.close || 1)) * 100
        : null;
    const changePercent =
      prevClose != null && prevClose !== 0 ? ((bucket.close - prevClose) / prevClose) * 100 : null;

    result.push({
      timestamp: new Date(bucket.start).toISOString(),
      open: bucket.open,
      high: bucket.high,
      low: bucket.low,
      close: bucket.close,
      avgPrice: avgPrice != null ? Number(avgPrice.toFixed(2)) : null,
      volume,
      amplitude: amplitude != null ? Number(amplitude.toFixed(2)) : null,
      changePercent: changePercent != null ? Number(changePercent.toFixed(2)) : null
    });

    prevClose = bucket.close;
  });

  return result;
}

function resolveDbPath(options) {
  const dbArg = options.db ? String(options.db) : null;
  const candidate = dbArg
    ? path.resolve(process.cwd(), dbArg)
    : path.resolve(process.cwd(), 'watchprice.db');

  if (fs.existsSync(candidate)) return candidate;

  const nearScript = path.resolve(__dirname, 'watchprice.db');
  if (!dbArg && fs.existsSync(nearScript)) return nearScript;

  return candidate;
}

function openDb(SQL, dbPath) {
  try {
    if (!fs.existsSync(dbPath)) {
      throw new Error('文件不存在');
    }
    const buf = fs.readFileSync(dbPath);
    return new SQL.Database(buf);
  } catch (e) {
    console.error(`无法打开数据库：${dbPath}`);
    console.error(`原因：${e?.message || e}`);
    process.exit(1);
  }
}

function commandHistory(db, dbAllFn, options, dbPath) {
  const code = (options.code || 'sh601288').trim();
  const limit = Math.max(1, Number(options.limit) || 10);
  const format = String(options.format || 'table').toLowerCase();

  const rows = dbAllFn(db, `
    SELECT code, timestamp, price, change, change_percent, indicators
    FROM price_records
    WHERE code = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `, code, limit);

  if (!rows.length) {
    console.log(`没有找到 ${code} 的记录（db: ${dbPath}）`);
    process.exit(0);
  }

  if (format === 'json') {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (format === 'csv') {
    const header = Object.keys(rows[0]).join(',');
    const body = rows
      .map(row => Object.values(row).map(csvEscape).join(','))
      .join('\n');
    console.log(header);
    console.log(body);
    return;
  }

  console.table(rows);
}

function commandAll(db, dbAllFn, options) {
  const code = options.code ? String(options.code).trim() : null;
  const sinceIso = parseTimeToIso(options.since);
  const toIso = parseTimeToIso(options.to);
  const format = String(options.format || 'csv').toLowerCase();

  const clauses = [];
  const params = [];
  if (code) {
    clauses.push('code = ?');
    params.push(code);
  }
  if (sinceIso) {
    clauses.push('timestamp >= ?');
    params.push(sinceIso);
  }
  if (toIso) {
    clauses.push('timestamp <= ?');
    params.push(toIso);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = dbAllFn(db, `
    SELECT *
    FROM price_records
    ${where}
    ORDER BY timestamp DESC
  `, ...params);

  if (!rows.length) {
    console.log('没有匹配的数据');
    process.exit(0);
  }

  if (format === 'json') {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const header = Object.keys(rows[0]).join(',');
  const body = rows
    .map(row => Object.values(row).map(csvEscape).join(','))
    .join('\n');
  console.log(header);
  console.log(body);
}

function commandTimeseries(db, dbAllFn, options) {
  const code = (options.code || 'sh601288').trim();
  const limit = Math.max(10, Number(options.limit) || 240);
  const interval = Math.max(1, Number(options.interval) || 1);
  const format = String(options.format || 'json').toLowerCase();

  const fetchLimit = Math.max(limit * 6, 200);
  const rows = dbAllFn(db,
    `SELECT timestamp, price, high, low, volume FROM price_records WHERE code = ? ORDER BY timestamp DESC LIMIT ?`,
    code, fetchLimit);

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
    return;
  }

  if (format === 'table') {
    console.table(series);
    return;
  }

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

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = (positional[0] || '').toLowerCase();

  if (!command || options.help || options.h || command === 'help' || command === '--help') {
    printHelp();
    return;
  }

  const SQL = await ensureSqlJs();
  const dbPath = resolveDbPath(options);
  const db = openDb(SQL, dbPath);
  const dbAllFn = (d, sql, ...params) => dbAll(d, sql, ...params);

  if (command === 'history') {
    commandHistory(db, dbAllFn, options, dbPath);
    return;
  }
  if (command === 'all') {
    commandAll(db, dbAllFn, options);
    return;
  }
  if (command === 'timeseries') {
    commandTimeseries(db, dbAllFn, options);
    return;
  }

  console.error(`未知命令：${command}`);
  printHelp();
  process.exit(1);
}

main();
