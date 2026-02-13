import axios from 'axios';
import Database from 'better-sqlite3';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import iconv from 'iconv-lite';
import { ATR, MACD, RSI, SMA, Stochastic } from 'technicalindicators';
import { calcTradingSignal } from './lib/trading-signal.js';
import { fetchTimeseriesSeries, TIMESERIES_DEFAULTS } from './lib/timeseries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置
const CONFIG_FILE = path.join(__dirname, 'config.json');
const UPDATE_INTERVAL = 5000; // 5秒更新一次
const ALERT_THRESHOLD_DEFAULT = 1; // 1% 价格变动发送桌面提醒
const HISTORY_KLINE_LIMIT = 120;
const HISTORY_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 小时
const historyCache = new Map();
const DB_FILE = path.join(__dirname, 'watchprice.db');
const notificationCache = new Map(); // 缓存最近的提醒值
let currentConfig = null;
let currentStocks = [];

const db = new Database(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS price_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT,
    source TEXT,
    price REAL,
    change REAL,
    change_percent REAL,
    high REAL,
    low REAL,
    volume REAL,
    inner_volume REAL,
    outer_volume REAL,
    indicators TEXT
  )
`);
try {
  db.exec('ALTER TABLE price_records ADD COLUMN inner_volume REAL');
} catch (_) { /* 已存在则忽略 */ }
try {
  db.exec('ALTER TABLE price_records ADD COLUMN outer_volume REAL');
} catch (_) { /* 已存在则忽略 */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS strategy_pushes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trading_date TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT,
    action TEXT NOT NULL,
    close_price REAL NOT NULL,
    stop_loss REAL,
    take_profit REAL,
    rationale TEXT,
    next_close_price REAL,
    success INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  )
`);
const insertStrategyPush = db.prepare(`
  INSERT INTO strategy_pushes (trading_date, code, name, action, close_price, stop_loss, take_profit, rationale)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateStrategyResult = db.prepare(`
  UPDATE strategy_pushes SET next_close_price = ?, success = ?, updated_at = datetime('now')
  WHERE trading_date = ? AND code = ?
`);
const insertRecord = db.prepare(`
  INSERT INTO price_records (
    timestamp, code, name, source,
    price, change, change_percent, high, low, volume, inner_volume, outer_volume, indicators
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function getTimeseriesSummary(code, options = {}) {
  return fetchTimeseriesSeries(db, code, {
    intervalMinutes: options.intervalMinutes || TIMESERIES_DEFAULTS.intervalMinutes,
    limit: options.limit || TIMESERIES_DEFAULTS.windowLimit
  });
}

function formatTimeseriesSummary(series, intervalMinutes) {
  if (!series.length) {
    return '  分时：无有效窗口';
  }
  const latest = series[series.length - 1];
  const amplitude =
    latest.amplitude != null && Number.isFinite(latest.amplitude)
      ? `${latest.amplitude > 0 ? '+' : ''}${latest.amplitude.toFixed(2)}%`
      : 'N/A';
  const change =
    latest.changePercent != null && Number.isFinite(latest.changePercent)
      ? `${latest.changePercent > 0 ? '+' : ''}${latest.changePercent.toFixed(2)}%`
      : 'N/A';
  const volumeLabel =
    latest.volume != null && Number.isFinite(latest.volume)
      ? latest.volume >= 10000
        ? `${(latest.volume / 10000).toFixed(2)}万`
        : `${latest.volume.toFixed(0)}`
      : 'N/A';
  return `  分时${series.length}段（${intervalMinutes}m）：振幅 ${amplitude} · 涨幅 ${change} · 成交 ${volumeLabel}`;
}

function formatSignalSummary(signal) {
  if (!signal) return '';
  const reasons = Array.isArray(signal.rationale) ? signal.rationale : signal.reasons || [];
  const text = reasons.length ? reasons.join(' · ') : '信号偏中性';
  let out = `  策略建议: ${signal.action}（${text}）`;
  if (signal.stopLoss != null && Number.isFinite(signal.stopLoss)) {
    const pct = signal.stopLossPct != null && Number.isFinite(signal.stopLossPct)
      ? ` (${signal.stopLossPct >= 0 ? '+' : ''}${signal.stopLossPct.toFixed(2)}%)`
      : '';
    out += `\n  止损位: ${signal.stopLoss.toFixed(2)}${pct}`;
  }
  if (signal.takeProfit != null && Number.isFinite(signal.takeProfit)) {
    const pct = signal.takeProfitPct != null && Number.isFinite(signal.takeProfitPct)
      ? ` (${signal.takeProfitPct >= 0 ? '+' : ''}${signal.takeProfitPct.toFixed(2)}%)`
      : '';
    out += `\n  止盈位: ${signal.takeProfit.toFixed(2)}${pct}`;
  }
  return out;
}
// 股票数据源配置
const DATA_SOURCES = {
  // 新浪财经API（A股）
  sina: (code) => `http://hq.sinajs.cn/list=${code}`,
  // 腾讯财经API（A股、港股、美股）
  tencent: (code) => `https://qt.gtimg.cn/q=${code}`,
  // Yahoo Finance API（美股）
  yahoo: (code) => `https://query1.finance.yahoo.com/v8/finance/chart/${code}?interval=1m&range=1d`,
  // Yahoo Finance 历史数据（用于计算技术指标）
  yahooHistory: (code, period = '1mo') => `https://query1.finance.yahoo.com/v8/finance/chart/${code}?interval=1d&range=${period}`
};

const DEFAULT_MARKET_WINDOWS = [
  { label: '上午', start: '09:30', end: '11:30' },
  { label: '下午', start: '13:00', end: '15:00' }
];

function isDomesticMarket(code) {
  return /^(sh|sz|hk)/i.test(code);
}

function getCachedHistory(code) {
  const entry = historyCache.get(code);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > HISTORY_CACHE_TTL) {
    historyCache.delete(code);
    return null;
  }
  return entry.data;
}

function setCachedHistory(code, klines) {
  if (!klines) return;
  historyCache.set(code, { timestamp: Date.now(), data: klines });
}

/**
 * 从新浪财经获取股票价格
 */
async function fetchFromSina(code) {
  try {
    const url = DATA_SOURCES.sina(code);
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'Referer': 'http://finance.sina.com.cn'
      }
    });
    
    const data = iconv.decode(Buffer.from(response.data), 'gbk');
    // 解析格式: var hq_str_sh600000="浦发银行,12.35,12.36,12.40,12.45,12.30,12.40,12.41,12345678,152345678,100,12.40,200,12.39,300,12.38,400,12.37,500,12.36,2024-01-01,15:00:00,00";
    const match = data.match(/="([^"]+)"/);
    if (!match) return null;
    
    const fields = match[1].split(',');
    if (fields.length < 3) return null;
    
    return {
      name: fields[0],
      currentPrice: parseFloat(fields[3]) || 0,
      yesterdayClose: parseFloat(fields[2]) || 0,
      todayOpen: parseFloat(fields[1]) || 0,
      high: parseFloat(fields[4]) || 0,
      low: parseFloat(fields[5]) || 0,
      volume: parseInt(fields[8]) || 0,
      change: parseFloat(fields[3]) - parseFloat(fields[2]),
      changePercent: ((parseFloat(fields[3]) - parseFloat(fields[2])) / parseFloat(fields[2]) * 100).toFixed(2),
      time: `${fields[30]} ${fields[31]}`
    };
  } catch (error) {
    console.error(`获取 ${code} 数据失败 (Sina):`, error.message);
    return null;
  }
}

/**
 * 从腾讯财经获取股票价格
 */
async function fetchFromTencent(code) {
  try {
    const url = DATA_SOURCES.tencent(code);
    const response = await axios.get(url, {
      responseType: 'arraybuffer'
    });
    
    const data = iconv.decode(Buffer.from(response.data), 'gbk');
    // 解析格式: v_sh600000="1~浦发银行~600000~12.40~12.35~12.36~12345678~152345678~0.05~0.40~12.45~12.30~12.40~12.41~100~12.40~200~12.39~300~12.38~400~12.37~500~12.36~20240101150000~0.40";
    const match = data.match(/="([^"]+)"/);
    if (!match) return null;
    
    const fields = match[1].split('~');
    if (fields.length < 4) return null;
    
    const currentPrice = parseFloat(fields[3]) || 0;
    const yesterdayClose = parseFloat(fields[4]) || 0;
    const change = currentPrice - yesterdayClose;
    const changePercent = yesterdayClose > 0 ? (change / yesterdayClose * 100).toFixed(2) : '0.00';
    const volume = parseInt(fields[6], 10) || 0;
    const outerVolume = parseInt(fields[7], 10) || 0; // 外盘：主动买入
    const innerVolume = parseInt(fields[8], 10) || 0; // 内盘：主动卖出

    const result = {
      name: fields[1],
      code: fields[2],
      currentPrice,
      yesterdayClose,
      todayOpen: parseFloat(fields[5]) || 0,
      high: parseFloat(fields[33]) || 0,
      low: parseFloat(fields[34]) || 0,
      volume,
      change,
      changePercent,
      time: fields[30] || new Date().toLocaleString('zh-CN')
    };
    if (Number.isFinite(outerVolume) && Number.isFinite(innerVolume)) {
      result.outerVolume = outerVolume;
      result.innerVolume = innerVolume;
    }
    return result;
  } catch (error) {
    console.error(`获取 ${code} 数据失败 (Tencent):`, error.message);
    return null;
  }
}

/**
 * 从Yahoo Finance获取股票价格（美股）
 */
async function fetchFromYahoo(code) {
  try {
    const url = DATA_SOURCES.yahoo(code);
    const response = await axios.get(url);
    
    const result = response.data.chart.result[0];
    const meta = result.meta;
    const quote = result.indicators.quote[0];
    const currentPrice = meta.regularMarketPrice || meta.previousClose;
    const previousClose = meta.previousClose;
    const change = currentPrice - previousClose;
    const changePercent = ((change / previousClose) * 100).toFixed(2);
    
    return {
      name: meta.shortName || code,
      code: code,
      currentPrice,
      yesterdayClose: previousClose,
      todayOpen: meta.regularMarketOpen || previousClose,
      high: meta.regularMarketDayHigh || currentPrice,
      low: meta.regularMarketDayLow || currentPrice,
      volume: meta.regularMarketVolume || 0,
      change,
      changePercent,
      time: new Date(meta.regularMarketTime * 1000).toLocaleString('zh-CN')
    };
  } catch (error) {
    console.error(`获取 ${code} 数据失败 (Yahoo):`, error.message);
    return null;
  }
}

/**
 * 从Yahoo Finance获取历史K线数据（用于计算技术指标）
 */
async function fetchYahooHistory(code, period = '1mo') {
  try {
    const url = DATA_SOURCES.yahooHistory(code, period);
    const response = await axios.get(url);
    
    const result = response.data.chart.result[0];
    const timestamps = result.timestamp;
    const quote = result.indicators.quote[0];
    
    const klines = timestamps.map((timestamp, index) => ({
      time: new Date(timestamp * 1000),
      open: quote.open[index],
      high: quote.high[index],
      low: quote.low[index],
      close: quote.close[index],
      volume: quote.volume[index]
    })).filter(k => k.close && !isNaN(k.close));
    
    return klines;
  } catch (error) {
    console.error(`获取 ${code} 历史数据失败:`, error.message);
    return null;
  }
}

const secidForCode = (code) => {
  if (code.startsWith('sh')) return `1.${code.slice(2)}`;
  if (code.startsWith('sz')) return `0.${code.slice(2)}`;
  if (code.startsWith('hk')) return `2.${code.slice(2)}`;
  return null;
};

async function fetchEastmoneyHistory(code, count = HISTORY_KLINE_LIMIT) {
  try {
    const secid = secidForCode(code);
    if (!secid) return null;
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&beg=0&end=20500000&lmt=${count}`;
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data?.data;
    if (!data || !Array.isArray(data.klines)) return null;
    const klines = data.klines.map(line => {
      const parts = line.split(',');
      const [date, open, close, high, low, volume] = [parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]];
      return {
        time: new Date(date.replace(/-/g, '/')),
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseInt(volume, 10) || 0
      };
    }).filter(k => k && !Number.isNaN(k.close));
    return klines.length ? klines : null;
  } catch (error) {
    return null;
  }
}

/**
 * 新浪财经日K（备用）
 * scale=240 表示日K（240分钟/日），datalen 最多约 1023
 */
async function fetchSinaHistory(code, count = HISTORY_KLINE_LIMIT) {
  try {
    const symbol = code.toLowerCase();
    const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${encodeURIComponent(symbol)}&scale=240&ma=5&datalen=${Math.min(count, 1023)}`;
    const response = await axios.get(url, { timeout: 10000 });
    const raw = response.data;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const klines = raw
      .map((item) => {
        const day = item.day || item.date;
        const open = parseFloat(item.open);
        const high = parseFloat(item.high);
        const low = parseFloat(item.low);
        const close = parseFloat(item.close);
        const volume = parseInt(item.volume, 10) || 0;
        if (!day || !Number.isFinite(close)) return null;
        return {
          time: new Date(day.replace(/-/g, '/')),
          open: Number.isFinite(open) ? open : close,
          high: Number.isFinite(high) ? high : close,
          low: Number.isFinite(low) ? low : close,
          close,
          volume
        };
      })
      .filter(Boolean);
    return klines.length >= 30 ? klines : null;
  } catch (error) {
    return null;
  }
}

/** A 股代码转 Yahoo 标的符号（用于备用） */
function codeToYahooSymbol(code) {
  if (code.startsWith('sh')) return `${code.slice(2)}.SS`;
  if (code.startsWith('sz')) return `${code.slice(2)}.SZ`;
  return code;
}

async function fetchStockHistory(code) {
  const cached = getCachedHistory(code);
  if (cached) return cached;

  let klines = null;
  let source = null;

  if (isDomesticMarket(code)) {
    klines = await fetchEastmoneyHistory(code);
    if (klines) source = 'eastmoney';
    if (!klines) {
      klines = await fetchSinaHistory(code);
      if (klines) {
        source = 'sina';
        console.warn(`日K ${code} 已切换备用源: 新浪`);
      }
    }
    if (!klines) {
      const yahooCode = codeToYahooSymbol(code);
      klines = await fetchYahooHistory(yahooCode, '3mo');
      if (klines) {
        source = 'yahoo';
        console.warn(`日K ${code} 已切换备用源: Yahoo`);
      }
    }
  } else {
    klines = await fetchYahooHistory(code, '3mo');
    if (klines) source = 'yahoo';
  }

  if (klines && source) {
    setCachedHistory(code, klines);
  }
  return klines;
}

/**
 * 计算技术指标
 */
function describeKdjSignal(kValue, jValue) {
  const hasK = Number.isFinite(kValue);
  const hasJ = Number.isFinite(jValue);

  if (hasK && hasJ) {
    if (kValue >= 80 && jValue >= 80) {
      return '🔴 超买';
    }
    if (kValue <= 20 && jValue <= 20) {
      return '🟢 超卖';
    }
    return '⚪ 正常';
  }

  if (hasK) {
    if (kValue >= 80) return '🔴 超买';
    if (kValue <= 20) return '🟢 超卖';
    return '⚪ 正常';
  }

  return '⚪ 未知';
}

function calculateIndicators(klines) {
  if (!klines || klines.length < 30) {
    return null;
  }

  const filtered = klines
    .filter(k => k.close != null && k.high != null && k.low != null)
    .map(k => ({
      close: Number(k.close),
      high: Number(k.high),
      low: Number(k.low)
    }))
    .filter(k => !Number.isNaN(k.close) && !Number.isNaN(k.high) && !Number.isNaN(k.low));

  if (filtered.length < 30) return null;

  const closes = filtered.map(k => k.close);
  const highs = filtered.map(k => k.high);
  const lows = filtered.map(k => k.low);
  
  const indicators = {};
  
  try {
    // 计算 MACD
    const macdInput = {
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    };
    const macdResult = MACD.calculate(macdInput);
    if (macdResult && macdResult.length > 0) {
      const latest = macdResult[macdResult.length - 1];
      indicators.macd = {
        macd: latest.MACD?.toFixed(4) || 'N/A',
        signal: latest.signal?.toFixed(4) || 'N/A',
        histogram: latest.histogram?.toFixed(4) || 'N/A',
        signalType: latest.MACD > latest.signal ? '🟢 看涨' : '🔴 看跌'
      };
    }
  } catch (error) {
    console.error('MACD计算错误:', error.message);
  }
  
  try {
    // 计算 RSI
    const rsiInput = {
      values: closes,
      period: 14
    };
    const rsiResult = RSI.calculate(rsiInput);
    if (rsiResult && rsiResult.length > 0) {
      const latest = rsiResult[rsiResult.length - 1];
      indicators.rsi = {
        value: latest.toFixed(2),
        signal: latest > 70 ? '🔴 超买' : latest < 30 ? '🟢 超卖' : '⚪ 正常'
      };
    }
  } catch (error) {
    console.error('RSI计算错误:', error.message);
  }
  
  try {
    // 计算 KDJ (使用 Stochastic)
    const kdjInput = {
      high: highs,
      low: lows,
      close: closes,
      period: 9,
      signalPeriod: 3
    };
    const kdjResult = Stochastic.calculate(kdjInput);
    if (kdjResult && kdjResult.length > 0) {
      const latest = kdjResult[kdjResult.length - 1];
      const kValue = Number(latest.k);
      const dValue = Number(latest.d);
      const jValueRaw = Number(latest.j);
      const jValue =
        Number.isFinite(jValueRaw) && !Number.isNaN(jValueRaw)
          ? jValueRaw
          : Number.isFinite(kValue) && Number.isFinite(dValue)
            ? 3 * kValue - 2 * dValue
            : null;
      const signal = describeKdjSignal(kValue, jValue);
      indicators.kdj = {
        k: Number.isFinite(kValue) ? kValue.toFixed(2) : 'N/A',
        d: Number.isFinite(dValue) ? dValue.toFixed(2) : 'N/A',
        j: Number.isFinite(jValue) ? Number(jValue.toFixed(2)) : 'N/A',
        signal
      };
    }
  } catch (error) {
    console.error('KDJ计算错误:', error.message);
  }
  
  // 计算 DK (多空指标 - 简化版，基于价格趋势)
  try {
    const recentCloses = closes.slice(-5);
    const avgPrice = recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length;
    const currentPrice = closes[closes.length - 1];
    const priceChange = ((currentPrice - avgPrice) / avgPrice * 100).toFixed(2);
    
    indicators.dk = {
      value: priceChange,
      signal: parseFloat(priceChange) > 2 ? '🟢 多头' : parseFloat(priceChange) < -2 ? '🔴 空头' : '⚪ 震荡'
    };
  } catch (error) {
    console.error('DK计算错误:', error.message);
  }

  // ATR（波动率，用于止损/止盈）
  try {
    const atrResult = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    if (atrResult && atrResult.length > 0) {
      const atrValue = atrResult[atrResult.length - 1];
      if (Number.isFinite(atrValue)) indicators.atr = atrValue;
    }
  } catch (error) {
    console.error('ATR计算错误:', error.message);
  }

  // 近期结构：N 日高低点、MA20（支撑/阻力与止损止盈参考）
  try {
    const n10 = Math.min(10, lows.length);
    const n20 = Math.min(20, lows.length);
    if (n20 >= 5) {
      const sliceLow10 = lows.slice(-n10);
      const sliceLow20 = lows.slice(-n20);
      const sliceHigh10 = highs.slice(-n10);
      const sliceHigh20 = highs.slice(-n20);
      indicators.recentLow10 = Math.min(...sliceLow10);
      indicators.recentLow20 = Math.min(...sliceLow20);
      indicators.recentHigh10 = Math.max(...sliceHigh10);
      indicators.recentHigh20 = Math.max(...sliceHigh20);
    }
    if (closes.length >= 20) {
      const ma20Result = SMA.calculate({ period: 20, values: closes });
      if (ma20Result && ma20Result.length > 0) {
        const ma20 = ma20Result[ma20Result.length - 1];
        if (Number.isFinite(ma20)) indicators.ma20 = ma20;
      }
    }
  } catch (error) {
    console.error('近期结构/MA20计算错误:', error.message);
  }
  
  return Object.keys(indicators).length > 0 ? indicators : null;
}

/**
 * 获取股票价格（自动选择数据源）
 */
async function fetchStockPrice(stock) {
  const { code, source = 'auto' } = stock;
  
  let data = null;
  
  if (source === 'auto') {
    // 自动判断：A股使用sina/tencent，美股使用yahoo
    if (code.startsWith('sh') || code.startsWith('sz')) {
      data = await fetchFromTencent(code) || await fetchFromSina(code);
    } else if (code.match(/^[A-Z]+$/)) {
      // 美股代码（如AAPL, TSLA）
      data = await fetchFromYahoo(code);
    } else {
      // 尝试腾讯财经
      data = await fetchFromTencent(code);
    }
  } else if (source === 'sina') {
    data = await fetchFromSina(code);
  } else if (source === 'tencent') {
    data = await fetchFromTencent(code);
  } else if (source === 'yahoo') {
    data = await fetchFromYahoo(code);
  }
  
  // 任何股票只要能拿到历史 K 线，就试着算指标
  if (data) {
    try {
      const klines = await fetchStockHistory(code);
      if (klines) {
        const indicators = calculateIndicators(klines);
        if (indicators) {
          data.indicators = indicators;
        }
      }
    } catch (error) {
      // 技术指标获取失败不影响主功能
      console.error(`获取 ${code} 技术指标失败:`, error.message);
    }
  }
  
  return data;
}

/**
 * 格式化输出股票信息
 */
function formatStockInfo(stock, data) {
  if (!data) {
    return `❌ ${stock.name || stock.code}: 获取失败`;
  }

  const changeSymbol = data.change >= 0 ? '📈' : '📉';
  const changeColor = data.change >= 0 ? '🟢' : '🔴';

  const isUSStock = stock.code.match(/^[A-Z]+$/) && !stock.code.startsWith('hk');
  const currency = isUSStock ? '$' : '¥';

  let output = `
${changeSymbol} ${data.name} (${stock.code})
  当前价格: ${currency}${data.currentPrice.toFixed(2)}
  涨跌: ${changeColor} ${data.change >= 0 ? '+' : ''}${data.change.toFixed(2)} (${data.changePercent}%)
  今开: ${currency}${data.todayOpen.toFixed(2)} | 昨收: ${currency}${data.yesterdayClose.toFixed(2)}
  最高: ${currency}${data.high.toFixed(2)} | 最低: ${currency}${data.low.toFixed(2)}
  成交量: ${(data.volume / 10000).toFixed(2)}万
  更新时间: ${data.time}`;

  if (Number.isFinite(data.outerVolume) && Number.isFinite(data.innerVolume)) {
    const total = data.outerVolume + data.innerVolume;
    const ratio = total > 0 ? ((data.outerVolume / total) * 100).toFixed(1) : '0';
    output += `\n  内外盘: 外 ${(data.outerVolume / 10000).toFixed(2)}万 / 内 ${(data.innerVolume / 10000).toFixed(2)}万 (外盘占比 ${ratio}%)`;
  }

  if (data.indicators) {
    output += '\n  ───────────────────────────────';
    if (data.indicators.macd) {
      output += `\n  📊 MACD: ${data.indicators.macd.macd} | 信号: ${data.indicators.macd.signal} | 柱状图: ${data.indicators.macd.histogram} | ${data.indicators.macd.signalType}`;
    }
    if (data.indicators.rsi) {
      output += `\n  📈 RSI: ${data.indicators.rsi.value} | ${data.indicators.rsi.signal}`;
    }
    if (data.indicators.kdj) {
      output += `\n  📉 KDJ: K=${data.indicators.kdj.k} D=${data.indicators.kdj.d} J=${data.indicators.kdj.j} | ${data.indicators.kdj.signal}`;
    }
    if (data.indicators.dk) {
      output += `\n  🔄 DK: ${data.indicators.dk.value}% | ${data.indicators.dk.signal}`;
    }
    if (data.indicators.atr != null && Number.isFinite(data.indicators.atr)) {
      output += `\n  📐 ATR(14): ${data.indicators.atr.toFixed(3)}`;
    }
    if (data.indicators.ma20 != null && Number.isFinite(data.indicators.ma20)) {
      output += ` | MA20: ${data.indicators.ma20.toFixed(2)}`;
    }
    if (data.indicators.recentLow20 != null && data.indicators.recentHigh20 != null) {
      output += `\n  近20日: 低 ${data.indicators.recentLow20.toFixed(2)} / 高 ${data.indicators.recentHigh20.toFixed(2)}`;
    }
  }

  return output;
}

/**
 * 判断是否发送桌面提醒
 */
function shouldNotifyStock(stock, data, threshold) {
  if (!data || !threshold || threshold <= 0) return false;
  const percent = parseFloat(data.changePercent);
  if (!Number.isFinite(percent) || Math.abs(percent) < threshold) return false;

  const key = stock.code;
  const lastPercent = notificationCache.get(key);
  const diff = lastPercent ? Math.abs(percent - lastPercent) : Infinity;
  if (diff < threshold) return false;

  notificationCache.set(key, percent);
  return true;
}

/**
 * 发送 macOS 桌面提醒
 */
function notifyStock(stock, data, threshold) {
  const isUSStock = stock.code.match(/^[A-Z]+$/) && !stock.code.startsWith('hk');
  const currency = isUSStock ? '$' : '¥';
  const title = `股票提醒：${data.name || stock.code}`;
  const sign = data.change >= 0 ? '+' : '';
  const body = `${currency}${data.currentPrice.toFixed(2)} ${sign}${data.changePercent}%（${data.change >= 0 ? '上涨' : '下跌'}）`;
  const signal = data.indicators?.rsi?.signal || data.indicators?.macd?.signalType || '';
  const subtitle = `阈值：${threshold}% ${signal}`;

  const notificationScript = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} subtitle ${JSON.stringify(subtitle)} sound name "Glass"`;
  exec(`osascript -e ${JSON.stringify(notificationScript)}`, error => {
    if (error) {
      console.error('桌面通知失败：', error.message);
    }
  });
}

function formatTimestamp(value) {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  const compact = value.toString().replace(/\D+/g, '');
  const match = compact.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (match) {
    const [, y, m, d, hh, mm, ss] = match;
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`).toISOString();
  }

  return new Date().toISOString();
}

function persistPriceRecord(stock, data) {
  if (!data) return;
  const indicatorsJson = data.indicators ? JSON.stringify(data.indicators) : null;
  const changePercent = parseFloat(data.changePercent);
  const innerVolume = data.innerVolume != null && Number.isFinite(Number(data.innerVolume)) ? Number(data.innerVolume) : null;
  const outerVolume = data.outerVolume != null && Number.isFinite(Number(data.outerVolume)) ? Number(data.outerVolume) : null;
  insertRecord.run(
    formatTimestamp(data.time),
    stock.code,
    data.name || stock.name || stock.code,
    stock.source || 'auto',
    data.currentPrice,
    data.change,
    Number.isFinite(changePercent) ? changePercent : null,
    data.high,
    data.low,
    data.volume,
    innerVolume,
    outerVolume,
    indicatorsJson
  );
}
/**
 * 加载配置
 */
async function loadConfig() {
  try {
    const data = await fsPromises.readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    parsed.alertThresholdPercent = parsed.alertThresholdPercent ?? ALERT_THRESHOLD_DEFAULT;
    parsed.marketWindows = parsed.marketWindows || DEFAULT_MARKET_WINDOWS;
    return parsed;
  } catch (error) {
    // 如果配置文件不存在，创建默认配置
    const defaultConfig = {
      stocks: [
        { name: '浦发银行', code: 'sh600000', source: 'auto' },
        { name: '平安银行', code: 'sz000001', source: 'auto' }
      ],
      updateInterval: UPDATE_INTERVAL
    };
    defaultConfig.alertThresholdPercent = ALERT_THRESHOLD_DEFAULT;
    defaultConfig.marketWindows = DEFAULT_MARKET_WINDOWS;
    await fsPromises.writeFile(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf-8');
    console.log('已创建默认配置文件 config.json');
    return defaultConfig;
  }
}

async function reloadConfigFromDisk() {
  const config = await loadConfig();
  currentConfig = config;
  currentStocks = config.stocks;
  console.log('配置重新加载，股票数量：', currentStocks.length);
  return config;
}

function watchConfigFile() {
  fs.watchFile(CONFIG_FILE, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs <= prev.mtimeMs) return;
    reloadConfigFromDisk()
      .then(config => {
        scheduleNextTick(0, config, currentStocks, config.alertThresholdPercent ?? ALERT_THRESHOLD_DEFAULT);
      })
      .catch(error => {
        console.error('重新读取配置失败:', error.message);
      });
  });
}

/**
 * 主函数
 */
async function main() {
  console.log('🚀 股票价格监控服务启动中...\n');
  
  await reloadConfigFromDisk();
  watchConfigFile();
  const interval = currentConfig.updateInterval || UPDATE_INTERVAL;
  const alertThreshold = currentConfig.alertThresholdPercent ?? ALERT_THRESHOLD_DEFAULT;
  
  console.log(`📊 监控股票数量: ${currentStocks.length}`);
  console.log(`⏱️  更新间隔: ${interval / 1000}秒\n`);
  console.log('='.repeat(60));
  
  console.log(`🔔 价格提醒阈值: ${alertThreshold}%`);
  // 启动调度
  scheduleNextTick(0, currentConfig, currentStocks, alertThreshold);
}

/**
 * 更新所有股票价格
 */
async function updatePrices(stocks, alertThreshold) {
  console.log(`\n🔄 ${new Date().toLocaleString('zh-CN')} - 更新价格信息...`);
  console.log('='.repeat(60));
  
  const promises = stocks.map(stock => fetchStockPrice(stock));
  const results = await Promise.all(promises);
  
  results.forEach((data, index) => {
    const stock = stocks[index];
    console.log(formatStockInfo(stock, data));
    persistPriceRecord(stock, data);
    if (!data) return;
    const timeseries = getTimeseriesSummary(stock.code);
    console.log(formatTimeseriesSummary(timeseries, TIMESERIES_DEFAULTS.intervalMinutes));
    const latestBucket = timeseries.length ? timeseries[timeseries.length - 1] : null;
    const quote = {
      outerVolume: data.outerVolume,
      innerVolume: data.innerVolume,
      currentPrice: data.currentPrice
    };
    const signal = calcTradingSignal(data.indicators, latestBucket, timeseries, quote);
    console.log(formatSignalSummary(signal));
    if (shouldNotifyStock(stock, data, alertThreshold)) {
      notifyStock(stock, data, alertThreshold);
    }
  });
  
  console.log('='.repeat(60));
}

function parseTimeToMinutes(timeStr) {
  const [hour, minute] = timeStr.split(':').map(part => Number(part));
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return hour * 60 + minute;
}

function isTradingOpen(config, now = new Date()) {
  const windows = config.marketWindows || DEFAULT_MARKET_WINDOWS;
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  return windows.some(window => {
    const start = parseTimeToMinutes(window.start);
    const end = parseTimeToMinutes(window.end);
    if (start === null || end === null) return false;
    return totalMinutes >= start && totalMinutes < end;
  });
}

function millisUntilNextWindow(config, now = new Date()) {
  const windows = (config.marketWindows || DEFAULT_MARKET_WINDOWS)
    .slice()
    .map(window => ({
      ...window,
      startMinutes: parseTimeToMinutes(window.start),
      endMinutes: parseTimeToMinutes(window.end)
    }))
    .filter(win => win.startMinutes !== null && win.endMinutes !== null)
    .sort((a, b) => a.startMinutes - b.startMinutes);

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const baseMs = now.getSeconds() * 1000 + now.getMilliseconds();

  for (const window of windows) {
    if (currentMinutes < window.startMinutes) {
      return (window.startMinutes - currentMinutes) * 60 * 1000 - baseMs;
    }
  }

  if (windows.length > 0) {
    const firstStart = windows[0].startMinutes;
    const untilMidnight = (24 * 60 - currentMinutes) * 60 * 1000 - baseMs;
    return untilMidnight + firstStart * 60 * 1000;
  }

  return 5 * 60 * 1000;
}

let tickTimer;
let lastEodDate = null;

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function previousTradingDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return toDateStr(d);
}

/**
 * 每个交易日结束后：按 config 股票生成买卖策略推送，并以前一日的次日收盘更新成功率
 */
async function runEodRoutine(stocks) {
  if (!stocks || stocks.length === 0) return;
  const now = new Date();
  const todayStr = toDateStr(now);
  const yesterdayStr = previousTradingDate(todayStr);

  const promises = stocks.map(stock => fetchStockPrice(stock));
  const results = await Promise.all(promises);
  const todayCloses = {};

  for (let i = 0; i < results.length; i++) {
    const data = results[i];
    const stock = stocks[i];
    if (!data) continue;
    const closePrice = data.currentPrice;
    todayCloses[stock.code] = closePrice;
    const timeseries = getTimeseriesSummary(stock.code);
    const latestBucket = timeseries.length ? timeseries[timeseries.length - 1] : null;
    const quote = {
      outerVolume: data.outerVolume,
      innerVolume: data.innerVolume,
      currentPrice: data.currentPrice
    };
    const signal = calcTradingSignal(data.indicators, latestBucket, timeseries, quote);
    const rationale = Array.isArray(signal.rationale) ? signal.rationale.join('; ') : (signal.rationale || '');
    insertStrategyPush.run(
      todayStr,
      stock.code,
      stock.name || stock.code,
      signal.action,
      closePrice,
      signal.stopLoss ?? null,
      signal.takeProfit ?? null,
      rationale
    );
  }

  const yesterdayRows = db.prepare(
    'SELECT code, action, close_price FROM strategy_pushes WHERE trading_date = ? AND next_close_price IS NULL'
  ).all(yesterdayStr);

  for (const row of yesterdayRows) {
    const nextClose = todayCloses[row.code];
    if (nextClose == null || !Number.isFinite(nextClose)) continue;
    const isBuy = row.action === '买入' || row.action === '略偏买入';
    const isSell = row.action === '卖出' || row.action === '略偏卖出';
    const success = isBuy ? nextClose > row.close_price : isSell ? nextClose < row.close_price : null;
    if (success !== null) {
      updateStrategyResult.run(nextClose, success ? 1 : 0, yesterdayStr, row.code);
    }
  }

  const pushed = results.filter(Boolean).length;
  console.log(`\n📋 策略推送已生成 (${todayStr})，共 ${pushed} 只`);

  const successRows = db.prepare(
    'SELECT COUNT(*) as n FROM strategy_pushes WHERE success IS NOT NULL'
  ).get();
  const winRows = db.prepare(
    'SELECT COUNT(*) as n FROM strategy_pushes WHERE success = 1'
  ).get();
  const total = successRows?.n ?? 0;
  const wins = winRows?.n ?? 0;
  const rate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0';
  console.log(`   历史统计: 已验证 ${total} 条，成功 ${wins} 条，成功率 ${rate}%\n`);

  const notificationScript = `display notification "今日 ${pushed} 只策略已生成；历史成功率 ${rate}%（${wins}/${total}）" with title "WatchPrice 策略推送" sound name "Glass"`;
  exec(`osascript -e ${JSON.stringify(notificationScript)}`, () => {});
}

function scheduleNextTick(delay, config, stocks, alertThreshold) {
  if (tickTimer) {
    clearTimeout(tickTimer);
  }
  tickTimer = setTimeout(() => {
    tick(config, stocks, alertThreshold);
  }, Math.max(delay, 1000));
}

async function tick(config, stocks, alertThreshold) {
  const now = new Date();
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  const todayStr = toDateStr(now);

  if (!isTradingOpen(config, now)) {
    const wait = millisUntilNextWindow(config, now);
    console.log(`🌙 休市中，${Math.round(wait / 1000 / 60)} 分钟后尝试恢复`);
    scheduleNextTick(wait, config, stocks, alertThreshold);
    return;
  }

  try {
    await updatePrices(stocks, alertThreshold);
  } catch (error) {
    console.error('行情更新出错:', error);
  }

  // 策略推送：收盘前 20 分钟触发一次（下午 14:40–15:00 区间内首次 tick 执行）
  const afternoonEnd = 15 * 60;
  const pushWindowStart = afternoonEnd - 20;
  if (totalMinutes >= pushWindowStart && totalMinutes < afternoonEnd && lastEodDate !== todayStr) {
    lastEodDate = todayStr;
    try {
      await runEodRoutine(stocks);
    } catch (e) {
      console.error('策略推送失败:', e);
    }
  }

  scheduleNextTick(config.updateInterval || UPDATE_INTERVAL, config, stocks, alertThreshold);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  main().catch(error => {
    console.error('服务启动失败:', error);
    process.exit(1);
  });
}

export { calculateIndicators, fetchStockHistory };
