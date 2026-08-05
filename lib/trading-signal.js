function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function pushReason(list, reason) {
  if (reason && !list.includes(reason)) {
    list.push(reason);
  }
}

/**
 * 结合指标与分时数据得出简要策略建议。
 * 策略原则：只做有反转依据的决策（RSI/KDJ 超卖超买），提高门槛以提升成功率；无反转则观望。
 * @param {Object} indicators 计算得到的技术指标
 * @param {Object|null} latestBucket 最新的分时窗口
 * @param {Array} series 分时序列
 * @param {Object} [quote] 实时盘口，如 { innerVolume, outerVolume } 内外盘（腾讯等数据源）
 * @param {Object} [history] 日 K 历史上下文，如 buildHistoryContext 的返回值
 */
export function calcTradingSignal(indicators = {}, latestBucket = null, series = [], quote = {}, history = null) {
  const kdjSignal = (indicators?.kdj?.signal || '').toString();
  const rsiValue = toNumber(indicators?.rsi?.value ?? indicators?.rsi);
  const macdHistogram = toNumber(indicators?.macd?.histogram);
  const changePercent = toNumber(latestBucket?.changePercent);
  const close = toNumber(latestBucket?.close);
  const avgPrice = toNumber(latestBucket?.avgPrice);
  const recentVolume = toNumber(latestBucket?.volume);
  const filteredSeries = (series ?? []).filter(item => Number.isFinite(toNumber(item?.volume)));
  const avgVolume =
    filteredSeries.length > 0
      ? filteredSeries.reduce((sum, item) => sum + (toNumber(item.volume) ?? 0), 0) / filteredSeries.length
      : null;
  const amplitudeList = (series ?? [])
    .map(item => toNumber(item?.amplitude))
    .filter(value => Number.isFinite(value));
  const amplitudeAvg =
    amplitudeList.length > 0
      ? amplitudeList.reduce((sum, value) => sum + value, 0) / amplitudeList.length
      : null;
  const firstClose = toNumber(series?.length ? series[0]?.close : null);
  const slope = Number.isFinite(firstClose) && Number.isFinite(close) ? close - firstClose : null;
  const currentPrice = toNumber(quote?.currentPrice) ?? close;

  let buyScore = 0;
  let sellScore = 0;
  let hasReversalBuy = false;
  let hasReversalSell = false;
  const buyReasons = [];
  const sellReasons = [];

  // 反转信号：收紧阈值（RSI 30/70）提高胜率，只做明确超卖/超买
  if (Number.isFinite(rsiValue)) {
    if (rsiValue < 30) {
      buyScore += 2;
      hasReversalBuy = true;
      pushReason(buyReasons, `RSI ${rsiValue.toFixed(1)}<30 超卖`);
    } else if (rsiValue > 70) {
      sellScore += 2;
      hasReversalSell = true;
      pushReason(sellReasons, `RSI ${rsiValue.toFixed(1)}>70 超买`);
    }
  }

  if (kdjSignal.includes('超卖')) {
    buyScore += 2;
    hasReversalBuy = true;
    pushReason(buyReasons, 'KDJ 超卖');
  } else if (kdjSignal.includes('超买')) {
    sellScore += 2;
    hasReversalSell = true;
    pushReason(sellReasons, 'KDJ 超买');
  }

  // 分时：仅明显回调/上涨才加分（±0.5%），减少噪音
  if (Number.isFinite(changePercent)) {
    if (changePercent < -0.5) {
      buyScore += 1;
      pushReason(buyReasons, `分时回调 ${changePercent.toFixed(2)}%`);
    } else if (changePercent > 0.5) {
      sellScore += 1;
      pushReason(sellReasons, `分时已涨 ${changePercent.toFixed(2)}%`);
    }
  }

  if (Number.isFinite(close) && Number.isFinite(avgPrice)) {
    if (close > avgPrice) {
      buyScore += 1;
      pushReason(buyReasons, '价在均价之上');
    } else if (close < avgPrice) {
      sellScore += 1;
      pushReason(sellReasons, '价在均价之下');
    }
  }

  if (Number.isFinite(macdHistogram)) {
    if (macdHistogram > 0) {
      buyScore += 1;
      pushReason(buyReasons, `MACD 柱 ${macdHistogram.toFixed(3)}`);
    } else if (macdHistogram < 0) {
      sellScore += 1;
      pushReason(sellReasons, `MACD 柱 ${macdHistogram.toFixed(3)}`);
    }
  }

  const historyTrend = (history?.trend || '').toString();
  const historyPosition20 = toNumber(history?.position20);
  const historyChange5 = toNumber(history?.change5);
  const historyChange20 = toNumber(history?.change20);
  const historyVolumeRatio = toNumber(history?.volumeRatio);
  const historyMa20 = toNumber(history?.ma20);
  const historyClose = toNumber(history?.close) ?? currentPrice;

  if (history?.available) {
    if (historyTrend === 'up') {
      buyScore += 2;
      pushReason(buyReasons, '日K趋势向上');
    } else if (historyTrend === 'down') {
      sellScore += 2;
      pushReason(sellReasons, '日K趋势向下');
    }

    if (Number.isFinite(historyPosition20)) {
      if (historyPosition20 <= 0.25) {
        buyScore += 1;
        hasReversalBuy = true;
        pushReason(buyReasons, `接近20日低位 ${(historyPosition20 * 100).toFixed(0)}%`);
      } else if (historyPosition20 >= 0.75) {
        sellScore += 1;
        hasReversalSell = true;
        pushReason(sellReasons, `接近20日高位 ${(historyPosition20 * 100).toFixed(0)}%`);
      }
    }

    if (Number.isFinite(historyChange5)) {
      if (historyChange5 <= -3) {
        buyScore += 1;
        pushReason(buyReasons, `5日回撤 ${historyChange5.toFixed(2)}%`);
      } else if (historyChange5 >= 5) {
        sellScore += 1;
        pushReason(sellReasons, `5日涨幅 ${historyChange5.toFixed(2)}%`);
      }
    }

    if (Number.isFinite(historyChange20)) {
      if (historyChange20 <= -8) {
        buyScore += 1;
        pushReason(buyReasons, `20日回撤 ${historyChange20.toFixed(2)}%`);
      } else if (historyChange20 >= 12) {
        sellScore += 1;
        pushReason(sellReasons, `20日涨幅 ${historyChange20.toFixed(2)}%`);
      }
    }

    if (Number.isFinite(historyVolumeRatio)) {
      if (historyVolumeRatio >= 1.4 && Number.isFinite(historyChange5) && historyChange5 > 0) {
        buyScore += 1;
        pushReason(buyReasons, '日K放量上行');
      } else if (historyVolumeRatio >= 1.4 && Number.isFinite(historyChange5) && historyChange5 < 0) {
        sellScore += 1;
        pushReason(sellReasons, '日K放量下行');
      }
    }

    if (Number.isFinite(historyMa20) && Number.isFinite(historyClose)) {
      if (historyClose > historyMa20) {
        buyScore += 1;
        pushReason(buyReasons, '收盘价在MA20上方');
      } else if (historyClose < historyMa20) {
        sellScore += 1;
        pushReason(sellReasons, '收盘价在MA20下方');
      }
    }
  }

  // 量能：放量结合方向判断，不单独作为买卖依据
  if (avgVolume && Number.isFinite(recentVolume)) {
    if (recentVolume > avgVolume * 1.3) {
      if (Number.isFinite(changePercent) && changePercent > 0) {
        sellScore += 1;
        pushReason(sellReasons, '放量上涨');
      } else if (Number.isFinite(changePercent) && changePercent < 0) {
        buyScore += 1;
        pushReason(buyReasons, '放量回调');
      }
    } else if (recentVolume < avgVolume * 0.6) {
      sellScore += 1;
      pushReason(sellReasons, '量能萎缩');
    }
  }

  if (Number.isFinite(amplitudeAvg) && amplitudeAvg > 0.4) {
    buyScore += 1;
    pushReason(buyReasons, `振幅 ${amplitudeAvg.toFixed(2)}%`);
  }

  if (Number.isFinite(slope)) {
    if (slope > 0) {
      buyScore += 1;
      pushReason(buyReasons, `分时斜率 ${slope.toFixed(2)}`);
    } else if (slope < 0) {
      sellScore += 1;
      pushReason(sellReasons, `分时斜率 ${slope.toFixed(2)}`);
    }
  }

  // 内外盘：仅明显偏离时计入（60/40），降低噪音
  const outerVolume = toNumber(quote?.outerVolume);
  const innerVolume = toNumber(quote?.innerVolume);
  if (Number.isFinite(outerVolume) && Number.isFinite(innerVolume) && outerVolume + innerVolume > 0) {
    const total = outerVolume + innerVolume;
    const outerRatio = outerVolume / total;
    if (outerRatio >= 0.6) {
      buyScore += 1;
      pushReason(buyReasons, `外盘>内盘 ${(outerRatio * 100).toFixed(0)}%`);
    } else if (outerRatio <= 0.4) {
      sellScore += 1;
      pushReason(sellReasons, `内盘>外盘 ${((1 - outerRatio) * 100).toFixed(0)}%`);
    }
  }

  const netBuy = buyScore - sellScore;
  const netSell = sellScore - buyScore;

  const atr = toNumber(indicators?.atr);
  // 低波动判断：ATR/价格 < 1.5% 视为低波动股（如银行股），不给出略偏信号
  const ATR_LOW_VOL_THRESHOLD = 0.015;
  const atrRatio = Number.isFinite(atr) && Number.isFinite(currentPrice) && currentPrice > 0
    ? atr / currentPrice
    : null;
  const isLowVol = Number.isFinite(atrRatio) && atrRatio < ATR_LOW_VOL_THRESHOLD;

  let action = '观望';
  let rationale = [];

  // 只做有反转依据的决策，且净分差要够大；无反转一律观望，减少低质量略偏
  if (hasReversalBuy && hasReversalSell) {
    action = '观望';
    rationale = ['多空信号冲突'];
  } else if (hasReversalBuy && buyScore >= sellScore && netBuy >= 2) {
    action = netBuy >= 4 ? '买入' : '略偏买入';
    rationale = buyReasons;
  } else if (hasReversalSell && sellScore >= buyScore && netSell >= 2) {
    action = netSell >= 4 ? '卖出' : '略偏卖出';
    rationale = sellReasons;
  }

  // 低波动股：只保留 买入/卖出，略偏 改为观望
  if (isLowVol && (action === '略偏买入' || action === '略偏卖出')) {
    action = '观望';
    rationale = ['低波动股暂不给出略偏信号', ...rationale];
  }

  if (history?.available) {
    if ((action === '买入' || action === '略偏买入') && historyTrend === 'down' && !hasReversalBuy) {
      action = '观望';
      rationale = ['历史趋势向下，缺少明确反转信号', ...buyReasons];
    } else if ((action === '卖出' || action === '略偏卖出') && historyTrend === 'up' && !hasReversalSell) {
      action = '观望';
      rationale = ['历史趋势向上，缺少明确转弱信号', ...sellReasons];
    }
  }

  if (!rationale.length) {
    rationale = ['信号偏中性'];
  }

  // 止损位 / 止盈位：基于 ATR 波动率 + 近期结构（高低点）
  const recentLow20 = toNumber(indicators?.recentLow20);
  const recentHigh20 = toNumber(indicators?.recentHigh20);

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
      stopLossPct = (((stopLoss - currentPrice) / currentPrice) * 100);
    } else {
      // 无 ATR 时用百分比兜底：约 -3% 止损
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
      takeProfitPct = (((takeProfit - currentPrice) / currentPrice) * 100);
    } else {
      takeProfit = currentPrice * 1.05;
      takeProfitPct = 5;
    }
  }

  return {
    action,
    rationale,
    buyScore,
    sellScore,
    stopLoss: stopLoss != null && Number.isFinite(stopLoss) ? stopLoss : null,
    takeProfit: takeProfit != null && Number.isFinite(takeProfit) ? takeProfit : null,
    stopLossPct: stopLossPct != null && Number.isFinite(stopLossPct) ? stopLossPct : null,
    takeProfitPct: takeProfitPct != null && Number.isFinite(takeProfitPct) ? takeProfitPct : null,
    rsi: Number.isFinite(rsiValue) ? rsiValue : null,
    kdjSignal,
    latestChangePercent: changePercent,
    avgVolume: Number.isFinite(avgVolume) ? avgVolume : null,
    amplitudeAvg: Number.isFinite(amplitudeAvg) ? amplitudeAvg : null,
    slope: Number.isFinite(slope) ? slope : null,
    history: history?.available ? history : null
  };
}
