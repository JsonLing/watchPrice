/**
 * 查看策略推送记录与成功率（按股票拆分统计）
 * 用法: node scripts/show-strategy-stats.js [--limit 20] [--code sh601288]
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../watchprice.db');
const db = new Database(dbPath, { readonly: true });

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : 30;
const codeIdx = args.indexOf('--code');
const codeFilter = codeIdx >= 0 && args[codeIdx + 1] ? args[codeIdx + 1] : null;

const where = codeFilter ? 'WHERE code = ?' : '';

const rows = db.prepare(
  `SELECT trading_date, code, name, action, close_price, stop_loss, take_profit, next_close_price, success, created_at
   FROM strategy_pushes ${where}
   ORDER BY code, trading_date DESC LIMIT ?`
).all(...(codeFilter ? [codeFilter, limit] : [limit]));

// 按股票统计：每只的已验证条数、成功条数、成功率
const perStock = db.prepare(
  `SELECT code, name,
          COUNT(*) AS total,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS wins
   FROM strategy_pushes
   WHERE success IS NOT NULL
   GROUP BY code, name
   ORDER BY code`
).all();

const total = db.prepare('SELECT COUNT(*) as n FROM strategy_pushes WHERE success IS NOT NULL').get();
const wins = db.prepare('SELECT COUNT(*) as n FROM strategy_pushes WHERE success = 1').get();
const totalN = total?.n ?? 0;
const winN = wins?.n ?? 0;
const rateAll = totalN > 0 ? ((winN / totalN) * 100).toFixed(1) : '0';

console.log('【按股票统计】');
console.log('─'.repeat(60));
console.log('代码       名称      已验证  成功  成功率');
console.log('─'.repeat(60));
for (const s of perStock) {
  const r = s.total > 0 ? ((s.wins / s.total) * 100).toFixed(1) : '0';
  console.log(
    `${s.code.padEnd(10)} ${(s.name || '').slice(0, 8).padEnd(8)} ${String(s.total).padStart(6)} ${String(s.wins).padStart(4)}  ${r}%`
  );
}
console.log('─'.repeat(60));
console.log(`合计${' '.repeat(12)} ${String(totalN).padStart(6)} ${String(winN).padStart(4)}  ${rateAll}%\n`);

console.log('策略推送记录（按股票、交易日）');
console.log('─'.repeat(100));
console.log('日期        代码       名称    动作      收盘价   止损    止盈    次日收  结果');
console.log('─'.repeat(100));

let lastCode = null;
for (const r of rows) {
  if (!codeFilter && lastCode !== null && lastCode !== r.code) {
    console.log('');
  }
  lastCode = r.code;
  const next = r.next_close_price != null ? r.next_close_price.toFixed(2) : '-';
  const ok = r.success === 1 ? '✓' : r.success === 0 ? '✗' : '-';
  const stop = r.stop_loss != null ? r.stop_loss.toFixed(2) : '-';
  const take = r.take_profit != null ? r.take_profit.toFixed(2) : '-';
  console.log(
    `${r.trading_date}  ${r.code.padEnd(10)} ${(r.name || '').slice(0, 6).padEnd(6)} ${r.action.padEnd(8)} ${r.close_price.toFixed(2).padStart(8)} ${stop.padStart(8)} ${take.padStart(8)} ${next.padStart(8)} ${ok}`
  );
}

console.log('─'.repeat(100));
console.log(`\n历史统计（合计）: 已验证 ${totalN} 条，成功 ${winN} 条，成功率 ${rateAll}%`);
