/**
 * 用历史日 K：逐日根据当日数据做出策略判断，用次日收盘价算出成功率，并写入 strategy_pushes。
 * 执行后可用 npm run strategy:stats 查看记录与成功率。
 * 用法: node scripts/backfill-strategy-history.js
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { calculateIndicators, fetchStockHistory } from '../index.js';
import { calcTradingSignal } from '../lib/trading-signal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '../config.json');
const dbPath = path.join(__dirname, '../watchprice.db');

function toDateStr(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

async function run() {
  const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  const stocks = config.stocks || [];
  if (stocks.length === 0) {
    console.log('config.json 中无股票，请先配置 stocks');
    process.exit(1);
  }

  const db = new Database(dbPath);
  const insert = db.prepare(`
    INSERT INTO strategy_pushes (trading_date, code, name, action, close_price, stop_loss, take_profit, rationale, next_close_price, success)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const toInsert = [];

  for (const stock of stocks) {
    const code = stock.code;
    const name = stock.name || code;
    const klines = await fetchStockHistory(code);
    if (!klines || klines.length < 31) {
      console.log(`跳过 ${name} (${code}): 历史 K 线不足 31 根`);
      continue;
    }

    for (let i = 30; i < klines.length - 1; i++) {
      const slice = klines.slice(0, i + 1);
      const indicators = calculateIndicators(slice);
      if (!indicators) continue;

      const close = klines[i].close;
      const nextClose = klines[i + 1].close;
      const date = toDateStr(klines[i].time);
      const quote = { currentPrice: close };
      const signal = calcTradingSignal(indicators, null, [], quote);

      const isBuy = signal.action === '买入' || signal.action === '略偏买入';
      const isSell = signal.action === '卖出' || signal.action === '略偏卖出';
      if (!isBuy && !isSell) continue;

      const success = isBuy ? (nextClose > close ? 1 : 0) : (nextClose < close ? 1 : 0);
      const rationale = Array.isArray(signal.rationale) ? signal.rationale.join('; ') : (signal.rationale || '');

      toInsert.push({
        trading_date: date,
        code,
        name,
        action: signal.action,
        close_price: close,
        stop_loss: signal.stopLoss ?? null,
        take_profit: signal.takeProfit ?? null,
        rationale,
        next_close_price: nextClose,
        success
      });
    }
    console.log(`${name} (${code}): 已生成 ${toInsert.filter(r => r.code === code).length} 条历史判断`);
  }

  const transact = db.transaction(() => {
    db.prepare('DELETE FROM strategy_pushes').run();
    for (const r of toInsert) {
      insert.run(
        r.trading_date,
        r.code,
        r.name,
        r.action,
        r.close_price,
        r.stop_loss,
        r.take_profit,
        r.rationale,
        r.next_close_price,
        r.success
      );
    }
  });

  transact();
  db.close();

  const total = toInsert.length;
  const wins = toInsert.filter(r => r.success === 1).length;
  const rate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0';
  console.log('\n' + '='.repeat(50));
  console.log(`已写入 ${total} 条历史策略记录，成功 ${wins} 条，成功率 ${rate}%`);
  console.log('运行 npm run strategy:stats 查看明细');
  console.log('='.repeat(50));
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
