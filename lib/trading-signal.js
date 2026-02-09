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
 * @param {Object} indicators 计算得到的技术指标
 * @param {Object|null} latestBucket 最新的分时窗口
 */
export function calcTradingSignal(indicators = {}, latestBucket = null) {
  const kdjSignal = (indicators?.kdj?.signal || '').toString();
  const rsiValue = toNumber(indicators?.rsi?.value ?? indicators?.rsi);
  const macdHistogram = toNumber(indicators?.macd?.histogram);
  const changePercent = toNumber(latestBucket?.changePercent);
  const close = toNumber(latestBucket?.close);
  const avgPrice = toNumber(latestBucket?.avgPrice);

  let buyScore = 0;
  let sellScore = 0;
  const buyReasons = [];
  const sellReasons = [];

  if (!Number.isNaN(rsiValue)) {
    if (rsiValue < 35) {
      buyScore += 1;
      pushReason(buyReasons, `RSI ${rsiValue.toFixed(1)}<35`);
    } else if (rsiValue > 65) {
      sellScore += 1;
      pushReason(sellReasons, `RSI ${rsiValue.toFixed(1)}>65`);
    }
  }

  if (kdjSignal.includes('超卖')) {
    buyScore += 1;
    pushReason(buyReasons, 'KDJ 超卖');
  } else if (kdjSignal.includes('超买')) {
    sellScore += 1;
    pushReason(sellReasons, 'KDJ 超买');
  }

  if (!Number.isNaN(changePercent)) {
    if (changePercent > 0) {
      buyScore += 1;
      pushReason(buyReasons, `分时涨幅 ${changePercent.toFixed(2)}%`);
    } else if (changePercent < 0) {
      sellScore += 1;
      pushReason(sellReasons, `分时跌幅 ${changePercent.toFixed(2)}%`);
    }
  }

  if (!Number.isNaN(close) && !Number.isNaN(avgPrice)) {
    if (close > avgPrice) {
      buyScore += 1;
      pushReason(buyReasons, '当前价在均价之上');
    } else if (close < avgPrice) {
      sellScore += 1;
      pushReason(sellReasons, '当前价在均价之下');
    }
  }

  if (!Number.isNaN(macdHistogram)) {
    if (macdHistogram > 0) {
      buyScore += 1;
      pushReason(buyReasons, `MACD 柱 ${macdHistogram.toFixed(3)}`);
    } else if (macdHistogram < 0) {
      sellScore += 1;
      pushReason(sellReasons, `MACD 柱 ${macdHistogram.toFixed(3)}`);
    }
  }

  let action = '观望';
  let rationale = [];
  if (buyScore >= 3 && buyScore >= sellScore) {
    action = '买入';
    rationale = buyReasons;
  } else if (sellScore >= 3 && sellScore > buyScore) {
    action = '卖出';
    rationale = sellReasons;
  } else if (buyScore > sellScore) {
    action = '略偏买入';
    rationale = buyReasons;
  } else if (sellScore > buyScore) {
    action = '略偏卖出';
    rationale = sellReasons;
  }

  if (!rationale.length) {
    rationale = ['信号偏中性'];
  }

  return {
    action,
    rationale,
    buyScore,
    sellScore,
    rsi: Number.isFinite(rsiValue) ? rsiValue : null,
    kdjSignal,
    latestChangePercent: changePercent
  };
}
