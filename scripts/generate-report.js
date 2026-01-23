import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '../watchprice.db');
const db = new Database(dbPath, { fileMustExist: true });

const argv = process.argv.slice(2);
const options = argv.reduce((acc, token) => {
  if (!token.startsWith('--')) return acc;
  const [key, value] = token.slice(2).split('=');
  acc[key] = value || true;
  return acc;
}, {});

const code = options.code || 'sh601288';
const limit = Number(options.limit) || 120;

const rows = db.prepare(`
  SELECT timestamp, price, indicators
  FROM price_records
  WHERE code = ?
  ORDER BY timestamp DESC
  LIMIT ?
`).all(code, limit);

if (!rows.length) {
  console.error(`未找到 ${code} 的数据`);
  process.exit(1);
}

const ordered = rows.slice().reverse();
const timestamps = ordered.map(r => r.timestamp);
const closeValues = ordered.map(r => Number(r.price));
const rsiValues = ordered.map(r => {
  if (!r.indicators) return null;
  try {
    const parsed = JSON.parse(r.indicators);
    const rsiValue = Number(parsed?.rsi?.value ?? parsed?.rsi);
    return Number.isFinite(rsiValue) ? rsiValue : null;
  } catch {
    return null;
  }
});

const latestIndicators = (() => {
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const record = ordered[i];
    if (record.indicators) {
      try {
        return JSON.parse(record.indicators);
      } catch {
        return null;
      }
    }
  }
  return null;
})();

const formatIndicator = (name, value) => `<tr><td>${name}</td><td>${value ?? 'N/A'}</td></tr>`;

const indicatorRows = latestIndicators
  ? [
      formatIndicator('RSI', latestIndicators.rsi?.value ?? latestIndicators.rsi ?? 'N/A'),
      formatIndicator('MACD', latestIndicators.macd?.macd ?? 'N/A'),
      formatIndicator('MACD signal', latestIndicators.macd?.signal ?? 'N/A'),
      formatIndicator('MACD histogram', latestIndicators.macd?.histogram ?? 'N/A'),
      formatIndicator('MACD 趋势', latestIndicators.macd?.signalType ?? 'N/A'),
      formatIndicator('KDJ K', latestIndicators.kdj?.k ?? 'N/A'),
      formatIndicator('KDJ D', latestIndicators.kdj?.d ?? 'N/A'),
      formatIndicator('KDJ J', latestIndicators.kdj?.j ?? 'N/A'),
      formatIndicator('KDJ 信号', latestIndicators.kdj?.signal ?? 'N/A'),
      formatIndicator('DK', latestIndicators.dk?.value ?? 'N/A'),
      formatIndicator('DK 信号', latestIndicators.dk?.signal ?? 'N/A')
    ].join('')
  : '<tr><td colspan="2">暂未获取指标</td></tr>';

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${code} 技术报告</title>
  <style>
    body { font-family: sans-serif; margin: 0; padding: 16px; background: #0f172a; color: #f8fafc; }
    canvas { max-width: 100%; height: 360px; }
    h1 { margin-bottom: 8px; }
    .meta { margin-bottom: 20px; color: #94a3b8; }
  </style>
</head>
<body>
  <h1>${code} 价格 & RSI 报告</h1>
  <div class="meta">展示最近 ${limit} 条记录</div>
  <canvas id="priceChart"></canvas>
  <canvas id="rsiChart"></canvas>
  <h2>最新指标</h2>
  <table style="width:100%; border-collapse: collapse; margin-bottom: 16px;">
    <thead>
      <tr>
        <th style="text-align:left; border-bottom:1px solid #334155; padding-bottom:4px;">指标</th>
        <th style="text-align:left; border-bottom:1px solid #334155; padding-bottom:4px;">当前值</th>
      </tr>
    </thead>
    <tbody>
      ${indicatorRows}
    </tbody>
  </table>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    const timestamps = ${JSON.stringify(timestamps)};
    const closeValues = ${JSON.stringify(closeValues)};
    const rsiValues = ${JSON.stringify(rsiValues)};

    new Chart(document.getElementById('priceChart').getContext('2d'), {
      type: 'line',
      data: {
        labels: timestamps,
        datasets: [{
          label: '价格',
          data: closeValues,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.3)',
          pointRadius: 0
        }]
      },
      options: {
        responsive: true,
        scales: {
          x: { ticks: { color: '#cbd5f5' } },
          y: { ticks: { color: '#cbd5f5' } }
        }
      }
    });

    new Chart(document.getElementById('rsiChart').getContext('2d'), {
      type: 'line',
      data: {
        labels: timestamps,
        datasets: [{
          label: 'RSI',
          data: rsiValues,
          borderColor: '#f43f5e',
          backgroundColor: 'rgba(244, 63, 94, 0.3)',
          pointRadius: 0
        }]
      },
      options: {
        responsive: true,
        scales: {
          x: { ticks: { color: '#cbd5f5' } },
          y: { ticks: { color: '#cbd5f5' }, suggestedMin: 0, suggestedMax: 100 }
        }
      }
    });
  </script>
</body>
</html>`;

const outputPath = path.join(__dirname, `../report-${code}.html`);
fs.writeFileSync(outputPath, html, 'utf-8');
console.log(`图形报告已生成：${outputPath}`);
