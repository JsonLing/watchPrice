/**
 * 持仓分析模块 —— 根据 config.json positions 段 + 实时行情/指标计算：
 *  - 摊薄成本、总市值、浮动盈亏
 *  - 止损位 / 止盈位（2×ATR 规则，与 trading-signal.js 一致）
 *  - 各档加仓明细
 *
 * config.json positions 格式:
 *   "positions": {
 *     "sz001696": {
 *       "name": "宗申动力",
 *       "available": 1100,                    // 可选：可用股数
 *       "lots": [                              // 多档成本记录
 *         { "shares": 1000, "costPrice": 35.70, "date": "2026-06-01", "note": "早期建仓" },
 *         { "shares": 1100, "costPrice": 15.61, "date": "2026-08-05", "note": "8/5 加仓" }
 *       ]
 *     }
 *   }
 */

/** 计算单只股票的持仓汇总 */
export function summarizePosition(posConfig, quote) {
  if (!posConfig || !Array.isArray(posConfig.lots) || posConfig.lots.length === 0) return null;
  if (!quote || !Number.isFinite(Number(quote.price))) return null;

  const price = Number(quote.price);
  let totalShares = 0;
  let totalCost = 0;
  const lots = posConfig.lots
    .map(lot => {
      const shares = Number(lot.shares) || 0;
      const costPrice = Number(lot.costPrice) || 0;
      totalShares += shares;
      totalCost += shares * costPrice;
      return {
        shares,
        costPrice,
        date: lot.date || '',
        note: lot.note || '',
        marketValue: shares * price,
        pnl: shares * (price - costPrice),
      };
    })
    .filter(lot => lot.shares > 0);

  if (totalShares === 0) return null;
  const avgCost = totalCost / totalShares;
  const marketValue = totalShares * price;
  const pnl = marketValue - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

  return {
    name: posConfig.name || '',
    code: posConfig.code || '',
    lots,
    totalShares,
    available: Number(posConfig.available) || totalShares,
    avgCost,
    price,
    totalCost,
    marketValue,
    pnl,
    pnlPct,
  };
}

/**
 * 计算止损/止盈位（2×ATR 规则，与 lib/trading-signal.js 完全一致）
 * @param {number} price 当前价
 * @param {object} indicators 指标（需含 atr / recentLow20 / recentHigh20）
 */
export function calcStopLevels(price, indicators = {}) {
  const atr = Number(indicators.atr);
  const recentLow20 = Number(indicators.recentLow20);
  const recentHigh20 = Number(indicators.recentHigh20);
  const currentPrice = Number(price);

  let stopLoss = null;
  let takeProfit = null;
  let stopLossPct = null;
  let takeProfitPct = null;

  if (Number.isFinite(currentPrice) && currentPrice > 0) {
    if (Number.isFinite(atr) && atr > 0) {
      // ATR 止损：当前价 - 2*ATR，但不低于近期 20 日低点（结构支撑）
      const atrStop = currentPrice - 2 * atr;
      stopLoss =
        Number.isFinite(recentLow20) && recentLow20 < currentPrice
          ? Math.max(recentLow20, atrStop)
          : atrStop;
      if (stopLoss >= currentPrice) stopLoss = atrStop;
      stopLoss = Math.max(0, stopLoss);
      stopLossPct = ((stopLoss - currentPrice) / currentPrice) * 100;
    } else {
      stopLoss = currentPrice * 0.97;
      stopLossPct = -3;
    }

    if (Number.isFinite(atr) && atr > 0) {
      // 止盈：当前价 + 2*ATR，若近期 20 日高点高于当前价则取 min(近期高点, 当前+2ATR)
      const atrTarget = currentPrice + 2 * atr;
      takeProfit =
        Number.isFinite(recentHigh20) && recentHigh20 > currentPrice
          ? Math.min(recentHigh20, atrTarget)
          : atrTarget;
      if (takeProfit <= currentPrice) takeProfit = atrTarget;
      takeProfitPct = ((takeProfit - currentPrice) / currentPrice) * 100;
    } else {
      takeProfit = currentPrice * 1.05;
      takeProfitPct = 5;
    }
  }

  return { stopLoss, takeProfit, stopLossPct, takeProfitPct };
}

/** 格式化持仓状态为多行文本（用于日志/飞书） */
export function formatPositionStatus(summary, levels) {
  if (!summary) return null;
  const lines = [];
  lines.push(`💰 持仓: ${summary.name || summary.code} ${summary.totalShares}股 @ ${summary.avgCost.toFixed(3)}`);

  // 各档明细
  for (const lot of summary.lots) {
    const lotPnl = lot.pnl;
    lines.push(
      `   ├ ${lot.shares}股 @ ${lot.costPrice.toFixed(2)}` +
      (lot.date ? ` (${lot.date})` : '') +
      (lot.note ? ` ${lot.note}` : '') +
      ` 盈亏 ${lotPnl >= 0 ? '+' : ''}¥${lotPnl.toFixed(0)}`
    );
  }

  lines.push(
    `   现价 ${summary.price.toFixed(2)} | ` +
    `浮盈亏 ${summary.pnl >= 0 ? '+' : ''}¥${summary.pnl.toFixed(0)} (${summary.pnlPct.toFixed(2)}%) | ` +
    `市值 ¥${summary.marketValue.toFixed(0)}`
  );

  if (levels) {
    if (levels.stopLoss != null) {
      lines.push(`   📉 止损位: ${levels.stopLoss.toFixed(2)} (距现价 ${levels.stopLossPct.toFixed(1)}%)`);
    }
    if (levels.takeProfit != null) {
      lines.push(`   📈 止盈位: ${levels.takeProfit.toFixed(2)} (距现价 ${levels.takeProfitPct.toFixed(1)}%)`);
    }
  }

  return lines.join('\n');
}
