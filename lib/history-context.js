function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function average(values) {
  const nums = values.map(toNumber).filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function percentChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

/**
 * Build a compact daily-history context for strategy scoring.
 * The signal engine can combine this slower historical structure with
 * intraday quote data, so a single request tick does not dominate the call.
 */
export function buildHistoryContext(klines = []) {
  const normalized = (klines ?? [])
    .map(kline => ({
      close: toNumber(kline?.close ?? kline?.price),
      high: toNumber(kline?.high ?? kline?.close ?? kline?.price),
      low: toNumber(kline?.low ?? kline?.close ?? kline?.price),
      volume: toNumber(kline?.volume)
    }))
    .filter(kline => Number.isFinite(kline.close));

  if (normalized.length < 20) {
    return {
      available: false,
      days: normalized.length
    };
  }

  const latest = normalized[normalized.length - 1];
  const close = latest.close;
  const last5 = normalized.slice(-5);
  const last10 = normalized.slice(-10);
  const last20 = normalized.slice(-20);
  const prev20 = normalized.slice(-40, -20);
  const ma5 = average(last5.map(kline => kline.close));
  const ma20 = average(last20.map(kline => kline.close));
  const high20 = Math.max(...last20.map(kline => kline.high).filter(Number.isFinite));
  const low20 = Math.min(...last20.map(kline => kline.low).filter(Number.isFinite));
  const high10 = Math.max(...last10.map(kline => kline.high).filter(Number.isFinite));
  const low10 = Math.min(...last10.map(kline => kline.low).filter(Number.isFinite));
  const change5 = percentChange(last5[0]?.close, close);
  const change20 = percentChange(last20[0]?.close, close);
  const volume5 = average(last5.map(kline => kline.volume));
  const volume20 = average(last20.map(kline => kline.volume));
  const previousVolume20 = average(prev20.map(kline => kline.volume));
  const volumeRatio = Number.isFinite(volume5) && Number.isFinite(volume20) && volume20 > 0
    ? volume5 / volume20
    : null;
  const longerVolumeRatio = Number.isFinite(volume20) && Number.isFinite(previousVolume20) && previousVolume20 > 0
    ? volume20 / previousVolume20
    : null;
  const range20 = Number.isFinite(high20) && Number.isFinite(low20) ? high20 - low20 : null;
  const position20 =
    Number.isFinite(range20) && range20 > 0
      ? (close - low20) / range20
      : null;

  let trend = 'neutral';
  if (Number.isFinite(ma5) && Number.isFinite(ma20) && Number.isFinite(change20)) {
    if (close >= ma20 && ma5 >= ma20 && change20 > 1) {
      trend = 'up';
    } else if (close <= ma20 && ma5 <= ma20 && change20 < -1) {
      trend = 'down';
    }
  }

  return {
    available: true,
    days: normalized.length,
    close,
    ma5,
    ma20,
    high10: Number.isFinite(high10) ? high10 : null,
    low10: Number.isFinite(low10) ? low10 : null,
    high20: Number.isFinite(high20) ? high20 : null,
    low20: Number.isFinite(low20) ? low20 : null,
    change5,
    change20,
    position20,
    volumeRatio,
    longerVolumeRatio,
    trend
  };
}
