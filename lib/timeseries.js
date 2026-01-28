function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function buildBucket() {
  return {
    start: 0,
    open: null,
    high: null,
    low: null,
    close: null,
    sumPrice: 0,
    count: 0,
    firstVolume: null,
    lastVolume: null
  };
}

/**
 * 将原始记录按照指定分钟数聚合成分时数据。
 * @param {Array} rows 原始 price_records 行
 * @param {Object} options
 * @param {number} options.intervalMinutes 每个分时窗口的分钟数
 * @param {number} options.limit 最多返回的窗口数
 */
export function aggregateTimeseries(rows = [], options = {}) {
  const intervalMinutes = Math.max(1, Number(options.intervalMinutes) || 1);
  const limit = Math.max(1, Number(options.limit) || 240);
  const bucketMs = intervalMinutes * 60 * 1000;

  const normalized = (rows ?? [])
    .map(row => {
      const timestampMs = Date.parse(row.timestamp);
      if (!Number.isFinite(timestampMs)) return null;
      return {
        ...row,
        timestampMs,
        price: toNumber(row.price ?? row.close ?? row.open),
        high: toNumber(row.high),
        low: toNumber(row.low),
        volume: toNumber(row.volume)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const buckets = new Map();

  normalized.forEach(row => {
    const bucketStart = Math.floor(row.timestampMs / bucketMs) * bucketMs;
    let bucket = buckets.get(bucketStart);
    if (!bucket) {
      bucket = buildBucket();
      bucket.start = bucketStart;
      buckets.set(bucketStart, bucket);
    }

    if (row.price != null) {
      if (bucket.open == null) {
        bucket.open = row.price;
      }
      bucket.close = row.price;
      bucket.high = bucket.high != null ? Math.max(bucket.high, row.price) : row.price;
      bucket.low = bucket.low != null ? Math.min(bucket.low, row.price) : row.price;
      bucket.sumPrice += row.price;
      bucket.count += 1;
    }

    if (row.volume != null) {
      if (bucket.firstVolume == null) {
        bucket.firstVolume = row.volume;
      }
      bucket.lastVolume = row.volume;
    }
  });

  const bucketArray = Array.from(buckets.values())
    .filter(bucket => bucket.close != null)
    .sort((a, b) => a.start - b.start);

  const limitedBuckets = bucketArray.slice(-limit);
  const result = [];
  let prevClose = null;

  limitedBuckets.forEach(bucket => {
    const avgPrice = bucket.count ? bucket.sumPrice / bucket.count : bucket.close;
    const volume =
      bucket.firstVolume != null && bucket.lastVolume != null
        ? Math.max(bucket.lastVolume - bucket.firstVolume, 0)
        : null;
    const amplitude =
      bucket.low && bucket.high
        ? ((bucket.high - bucket.low) / (bucket.low || bucket.open || bucket.close || 1)) * 100
        : null;
    const changePercent =
      prevClose != null && prevClose !== 0 ? ((bucket.close - prevClose) / prevClose) * 100 : null;

    result.push({
      timestamp: new Date(bucket.start).toISOString(),
      open: bucket.open,
      high: bucket.high,
      low: bucket.low,
      close: bucket.close,
      avgPrice: avgPrice != null ? Number(avgPrice.toFixed(2)) : null,
      volume,
      amplitude: amplitude != null ? Number(amplitude.toFixed(2)) : null,
      changePercent: changePercent != null ? Number(changePercent.toFixed(2)) : null
    });

    prevClose = bucket.close;
  });

  return result;
}
