/**
 * 拉取与配置股票、板块相关的实时新闻。
 * - 按股票名称关键词搜索（Google News RSS，无需 API Key），保证能拿到你配置的股票相关新闻；
 * - 若有 FINNHUB_API_KEY，则额外拉取市场通用新闻。
 */
import axios from 'axios';
import Parser from 'rss-parser';

const parser = new Parser({ timeout: 10000 });
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const NEWS_PAGE_LIMIT = 10;
const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search';
const KEYWORD_NEWS_LIMIT = 15;

/**
 * 将 config 中的 code（如 sh601288, sz001696）转为 Finnhub 使用的交易所代码
 */
export function toFinnhubSymbol(code) {
  if (!code || typeof code !== 'string') return null;
  const lower = code.toLowerCase();
  if (lower.startsWith('sh')) return code.slice(2) + '.SH';
  if (lower.startsWith('sz')) return code.slice(2) + '.SZ';
  return code;
}

/**
 * 拉取某只股票的公司新闻（最近 7 天）
 */
export async function fetchCompanyNews(apiKey, symbol, fromDate, toDate) {
  if (!apiKey) return [];
  const sym = toFinnhubSymbol(symbol) || symbol;
  try {
    const { data } = await axios.get(`${FINNHUB_BASE}/company-news`, {
      params: { symbol: sym, from: fromDate, to: toDate, token: apiKey },
      timeout: 10000
    });
    return Array.isArray(data) ? data.slice(0, NEWS_PAGE_LIMIT) : [];
  } catch (err) {
    if (err.response?.status === 401) return [];
    // 403 多为 A 股等非美股标的不受支持，静默跳过，仅依赖市场新闻
    if (err.response?.status === 403) return [];
    console.error(`[news] company-news ${sym} 请求失败:`, err.message);
    return [];
  }
}

/**
 * 拉取市场/板块类通用新闻（category: general）
 */
export async function fetchMarketNews(apiKey, category = 'general') {
  if (!apiKey) return [];
  try {
    const { data } = await axios.get(`${FINNHUB_BASE}/news`, {
      params: { category, token: apiKey },
      timeout: 10000
    });
    return Array.isArray(data) ? data.slice(0, NEWS_PAGE_LIMIT) : [];
  } catch (err) {
    if (err.response?.status === 401) return [];
    console.error('[news] market news 请求失败:', err.message);
    return [];
  }
}

/** 关键词新闻只取最近多少天，默认 30（可从环境变量 KEYWORD_NEWS_DAYS 覆盖） */
function getKeywordNewsDays() {
  const n = parseInt(process.env.KEYWORD_NEWS_DAYS || '30', 10);
  return Number.isFinite(n) && n >= 1 ? n : 30;
}

/**
 * 按关键词从 Google News RSS 拉取新闻（无需 API Key，专注你配置的股票，仅最近 1 月）
 */
export async function fetchNewsByKeyword(query, options = {}) {
  const { label = null } = options;
  if (!query || typeof query !== 'string') return [];
  const q = query.trim();
  if (!q) return [];
  const days = getKeywordNewsDays();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceTime = since.getTime();
  try {
    const queryWithWhen = `${q} when:${days}d`;
    const url = `${GOOGLE_NEWS_RSS}?q=${encodeURIComponent(queryWithWhen)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
    const feed = await parser.parseURL(url);
    const items = (feed.items || [])
      .filter(item => {
        if (!item.pubDate) return true;
        const t = new Date(item.pubDate).getTime();
        return t >= sinceTime;
      })
      .slice(0, KEYWORD_NEWS_LIMIT)
      .map(item => {
        const raw = item.contentSnippet || item.content || '';
        const summary = stripHtml(raw).slice(0, 300);
        return {
          title: (item.title || '').trim(),
          summary: summary + (summary.length >= 300 ? '…' : '') || null,
          url: item.link || item.guid || '',
          time: item.pubDate ? new Date(item.pubDate).toISOString() : '',
          source: item.creator || item['dc:creator'] || (item.source && item.source.name) || '',
          symbol: label
        };
      });
    return items;
  } catch (err) {
    console.error(`[news] 关键词「${q}」RSS 请求失败:`, err.message);
    return [];
  }
}

/**
 * 去掉 HTML 标签，得到纯文本（用于 summary）
 */
function stripHtml(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => (text || href).trim())
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 归一化单条新闻为 { title, summary, url, time, source?, symbol? }
 */
export function normalizeItem(item, symbol = null) {
  const rawSummary = item.summary || item.description || '';
  const summary = stripHtml(rawSummary).slice(0, 300);
  const summaryOut = summary + (summary.length >= 300 ? '…' : '');
  return {
    title: (item.headline || item.title || '').trim(),
    summary: summaryOut || null,
    url: item.url || item.link || '',
    time: item.datetime != null ? new Date(item.datetime * 1000).toISOString() : (item.publishedAt || ''),
    source: item.source || '',
    symbol: symbol != null ? symbol : (item.related || null)
  };
}

/**
 * 拉取与配置股票及市场相关的新闻（去重、合并）。
 * @param {string} [apiKey] - 可选，Finnhub API Key，用于补充市场新闻
 * @param {Array<{code: string, name?: string}>} stocks - 配置的股票列表（必须有 name 用于关键词搜索）
 */
export async function fetchRelevantNews(apiKey, stocks = [], options = {}) {
  const { fromDate, toDate } = options;
  const to = toDate || new Date();
  const from = fromDate || new Date(to.getTime() - getKeywordNewsDays() * 24 * 60 * 60 * 1000);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);

  const seen = new Set();
  const out = [];

  // 1）按股票名称关键词搜索新闻（无需 API Key，确保能拿到你配置的股票相关新闻）
  const list = Array.isArray(stocks) && stocks[0] && typeof stocks[0] === 'object'
    ? stocks
    : stocks.map(c => ({ code: c, name: c }));
  for (const stock of list) {
    const name = (stock.name || stock.code || '').toString().trim();
    if (!name) continue;
    const label = `${name}(${stock.code || ''})`;
    const keywordItems = await fetchNewsByKeyword(`${name} 股票`, { label });
    for (const item of keywordItems) {
      const key = item.url || item.title;
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push({ ...item, symbol: label });
      }
    }
  }

  // 2）若有 Finnhub Key，补充公司新闻（美股等）与市场新闻
  if (apiKey) {
    for (const stock of list) {
      const code = stock.code || stock.name;
      if (!code) continue;
      const listCompany = await fetchCompanyNews(apiKey, code, fromStr, toStr);
      const sym = toFinnhubSymbol(code) || code;
      for (const item of listCompany) {
        const key = item.url || item.headline || item.id;
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push(normalizeItem(item, sym));
        }
      }
    }
    const market = await fetchMarketNews(apiKey, 'general');
    for (const item of market) {
      const key = item.url || item.headline || item.id;
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(normalizeItem(item));
      }
    }
  }

  out.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  return out.slice(0, 80);
}
