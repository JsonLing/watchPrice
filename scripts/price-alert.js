/**
 * 到价提醒监控（独立调试工具）—— 主服务 index.js 已内置该功能（config.json alerts 段）
 * 本脚本保留用于：不启动主服务时的独立监控 / 调试飞书通知
 * 用法:
 *   node scripts/price-alert.js                  # 单次检查
 *   node scripts/price-alert.js --watch          # 持续监控(每5秒查一次)
 *   node scripts/price-alert.js --watch --interval=10
 *
 * 关键位在 config.json 的 alerts 段配置
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { exec } from 'child_process';
import { sendFeishu, isFeishuEnabled } from '../lib/feishu-notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../watchprice.db');
const configPath = path.join(__dirname, '../config.json');

const argv = process.argv.slice(2);
const WATCH = argv.includes('--watch');
// 支持 --interval=15 和 --interval 15 两种写法
let INTERVAL = 5000;
const eqMatch = argv.find(t => t.startsWith('--interval='));
if (eqMatch) {
  INTERVAL = Number(eqMatch.split('=')[1]) * 1000;
} else {
  const intervalIdx = argv.indexOf('--interval');
  if (intervalIdx >= 0 && argv[intervalIdx + 1]) INTERVAL = Number(argv[intervalIdx + 1]) * 1000;
}

// 从 config.json 读取 alerts 配置
let ALERTS = {};
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  ALERTS = config.alerts || {};
} catch (_) {}
// 已触发的提醒 (防止重复通知) key: `${code}:${price}`
const fired = new Set();

function notify(title, message) {
  const script = `display notification "${message}" with title "${title}" sound name "Glass"`;
  exec(`osascript -e '${script.replace(/'/g, "\\'")}'`, (err) => {
    if (err) console.error('通知失败:', err.message);
  });
}

function check() {
  const db = new Database(dbPath, { readonly: true });
  const firedThisRound = [];
  for (const [code, levels] of Object.entries(ALERTS)) {
    if (!levels.length) continue;
    const row = db.prepare(
      `SELECT code, name, price, timestamp FROM price_records WHERE code = ? ORDER BY timestamp DESC LIMIT 1`
    ).get(code);
    if (!row) continue;
    const price = Number(row.price);
    const name = row.name || code;
    for (const level of levels) {
      const key = `${code}:${level.price}`;
      if (fired.has(key)) continue;
      const dir = level.dir || 'below';
      // 方向触发: above=现价已涨到/超过关键位; below=现价已跌破关键位
      const hit = dir === 'above' ? price >= level.price : price <= level.price;
      if (hit) {
        fired.add(key);
        firedThisRound.push({ key, price, level, name });
      }
    }
  }
  db.close();

  // 异步发送通知（macOS + 飞书）
  for (const { price, level, name } of firedThisRound) {
    const arrow = level.dir === 'above' ? '📈 触及' : '📉 跌破';
    const msg = `${name} 现价 ${price} ${arrow} ${level.price} → ${level.label}`;
    console.log(`🔔 [${new Date().toLocaleTimeString()}] ${msg}`);
    notify('📈 到价提醒', msg);
    sendFeishu(`🔔 到价提醒\n${msg}\n⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`)
      .then(ok => console.log(ok ? '✅ 飞书已通知' : '⚠️ 飞书发送失败'));
  }
}

console.log(`🔔 到价提醒 ${WATCH ? `持续监控中 (每 ${INTERVAL/1000}s)` : '单次检查'} — 数据库: ${dbPath}`);
if (isFeishuEnabled()) console.log('📨 飞书通知: 已启用');
else console.log('📨 飞书通知: 未配置（仅 macOS 通知）');
console.log('监控点位:');
for (const [code, levels] of Object.entries(ALERTS)) {
  if (!levels.length) continue;
  console.log(`  ${code}: ${levels.map(l => `${l.price}(${l.label})`).join(' | ')}`);
}
console.log('-'.repeat(60));

check();

if (WATCH) {
  setInterval(check, INTERVAL);
} else {
  // 单次模式: 等待飞书异步发送完成
  setTimeout(() => process.exit(0), 6000);
}
