/**
 * 用历史日 K 回测策略：按日模拟信号，以次日收盘价判定成败，输出成功率。
 * 用法: node scripts/backtest-strategy.js
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, fetchStockHistory } from '../index.js';
import { calcTradingSignal } from '../lib/trading-signal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '../config.json');

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

  const allResults = [];
  for (const stock of stocks) {
    const code = stock.code;
    const name = stock.name || code;
    const klines = await fetchStockHistory(code);
    if (!klines || klines.length < 31) {
      console.log(`跳过 ${name} (${code}): 历史 K 线不足 31 根`);
      continue;
    }

    let total = 0;
    let success = 0;
    const byAction = { 买入: { n: 0, ok: 0 }, 略偏买入: { n: 0, ok: 0 }, 卖出: { n: 0, ok: 0 }, 略偏卖出: { n: 0, ok: 0 } };

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

      const ok = isBuy ? nextClose > close : nextClose < close;
      total++;
      if (ok) success++;
      if (byAction[signal.action]) {
        byAction[signal.action].n++;
        if (ok) byAction[signal.action].ok++;
      }
      allResults.push({ code, name, date, action: signal.action, close, nextClose, ok });
    }

    const rate = total > 0 ? ((success / total) * 100).toFixed(1) : 0;
    console.log(`\n${name} (${code}): 有效信号 ${total} 次，成功 ${success} 次，成功率 ${rate}%`);
    Object.entries(byAction).forEach(([action, v]) => {
      if (v.n > 0) {
        const r = ((v.ok / v.n) * 100).toFixed(1);
        console.log(`  ${action}: ${v.n} 次, 成功 ${v.ok}, ${r}%`);
      }
    });
  }

  const totalAll = allResults.length;
  const successAll = allResults.filter(r => r.ok).length;
  const rateAll = totalAll > 0 ? ((successAll / totalAll) * 100).toFixed(1) : 0;
  console.log('\n' + '='.repeat(50));
  console.log(`整体: 有效信号 ${totalAll} 次，成功 ${successAll} 次，成功率 ${rateAll}%`);
  console.log('='.repeat(50));
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
