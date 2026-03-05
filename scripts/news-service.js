/**
 * 新闻服务：实时抓取与你配置的股票相关的新闻，提取标题和摘要并打印（标题加粗）。
 * 按股票名称关键词搜索（Google News），无需 API Key 即可获取配置股票相关新闻。
 * 可选 .env 中配置 FINNHUB_API_KEY 以补充国际市场新闻。
 * 用法: node scripts/news-service.js [--interval 10] [--once]
 */
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { fetchRelevantNews } from '../lib/news-fetcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function loadStocks() {
  const configPath = path.join(__dirname, '../config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  return (config.stocks || []).filter(s => (s.name || s.code));
}

function printNews(items) {
  if (!items.length) return;
  const sep = '─'.repeat(80);
  console.log(`\n${sep}`);
  console.log(`📰 相关新闻 (${new Date().toLocaleString('zh-CN')})`);
  console.log(sep);
  for (const item of items) {
    const title = (item.title || '无标题').trim();
    const summary = (item.summary || '').trim();
    const meta = [item.time ? item.time.slice(0, 19) : '', item.source, item.symbol].filter(Boolean).join(' · ');
    console.log(`\n  ${BOLD}${title}${RESET}`);
    if (meta) console.log(`  ${meta}`);
    if (summary) console.log(`  ${summary}`);
    if (item.url && !summary.includes(item.url)) console.log(`  ${item.url}`);
  }
  console.log(`\n${sep}\n`);
}

async function runOnce(apiKey, stocks) {
  const items = await fetchRelevantNews(apiKey, stocks);
  printNews(items);
}

async function runService(apiKey, stocks, intervalMinutes) {
  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
  const names = stocks.map(s => s.name || s.code).join('、');
  console.log(`新闻服务已启动，监控股票：${names}，每 ${intervalMinutes} 分钟刷新\n`);

  const tick = async () => {
    await runOnce(apiKey, stocks);
  };

  await tick();
  setInterval(tick, intervalMs);
}

function main() {
  const apiKey = process.env.FINNHUB_API_KEY || process.env.FINNHUB_API_TOKEN;
  const stocks = loadStocks();
  if (!stocks.length) {
    console.error('config.json 中未配置 stocks（需包含 name 与 code）');
    process.exit(1);
  }
  if (!apiKey) {
    console.log('未设置 FINNHUB_API_KEY，仅按股票名称拉取相关新闻（无需 Key）\n');
  }

  const args = process.argv.slice(2);
  const intervalIdx = args.indexOf('--interval');
  const intervalMinutes = intervalIdx >= 0 && args[intervalIdx + 1]
    ? parseInt(args[intervalIdx + 1], 10)
    : 10;

  if (args.includes('--once')) {
    runOnce(apiKey, stocks).catch(err => {
      console.error(err);
      process.exit(1);
    });
  } else {
    runService(apiKey, stocks, intervalMinutes).catch(err => {
      console.error(err);
      process.exit(1);
    });
  }
}

main();
