import express from 'express';
import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { calcTradingSignal } from '../lib/trading-signal.js';
import { fetchTimeseriesSeries, TIMESERIES_DEFAULTS } from '../lib/timeseries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../watchprice.db');
const configPath = path.join(__dirname, '../config.json');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const app = express();
const port = process.env.PORT || 3000;

async function readConfig() {
  const raw = await fs.readFile(configPath, 'utf-8');
  return JSON.parse(raw);
}

async function saveConfig(config) {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

function parseIndicators(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildTimeseries(code, params = {}) {
  return fetchTimeseriesSeries(db, code, {
    intervalMinutes: Math.max(1, Number(params.interval) || params.intervalMinutes || TIMESERIES_DEFAULTS.intervalMinutes),
    limit: Math.max(1, Number(params.limit) || params.limit || TIMESERIES_DEFAULTS.windowLimit)
  });
}

app.get('/api/history', (req, res) => {
  const code = req.query.code || 'sh601288';
  const limit = Number(req.query.limit) || 120;
  const rows = db
    .prepare(
      `SELECT timestamp, price, indicators FROM price_records WHERE code = ? ORDER BY timestamp DESC LIMIT ?`
    )
    .all(code, limit);
  const history = rows
    .map(row => ({
      timestamp: row.timestamp,
      price: row.price,
      indicators: parseIndicators(row.indicators)
    }))
    .reverse();
  res.json({ code, data: history });
});

app.get('/api/latest', (req, res) => {
  const code = req.query.code || 'sh601288';
  const row = db
    .prepare(
      `SELECT timestamp, price, indicators FROM price_records WHERE code = ? ORDER BY timestamp DESC LIMIT 1`
    )
    .get(code);
  if (!row) {
    return res.status(404).json({ error: 'not found' });
  }
  const indicators = parseIndicators(row.indicators);
  const timeseries = buildTimeseries(code);
  const latestBucket = timeseries.length ? timeseries[timeseries.length - 1] : null;
  const signal = calcTradingSignal(indicators, latestBucket);
  res.json({
    code,
    timestamp: row.timestamp,
    price: row.price,
    indicators,
    signal
  });
});

app.get('/api/timeseries', (req, res) => {
  const code = (req.query.code || 'sh601288').trim();
  const interval = Math.max(1, Number(req.query.interval) || TIMESERIES_DEFAULTS.intervalMinutes);
  const limit = Math.max(1, Number(req.query.limit) || TIMESERIES_DEFAULTS.windowLimit);
  const data = buildTimeseries(code, { interval, limit });
  res.json({
    code,
    intervalMinutes: interval,
    limit,
    data
  });
});

app.post('/api/watchlist', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'code required' });
  }

  try {
    const config = await readConfig();
    const normalized = code.toLowerCase();
    const exists = config.stocks.some(stock => stock.code.toLowerCase() === normalized);
    if (exists) {
      return res.json({ message: 'already existed' });
    }

    config.stocks.push({
      name: code,
      code,
      source: 'auto'
    });
    await saveConfig(config);
    res.json({ message: 'added' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Dashboard server running at http://localhost:${port}/dashboard.html`);
});
