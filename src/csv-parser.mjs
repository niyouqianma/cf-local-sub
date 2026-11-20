/**
 * Parse and filter XIU2/CloudflareSpeedTest result.csv outputs.
 */

import net from 'node:net';

/**
 * Parse a single CSV line handling optional quoted fields.
 */
function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Parse result.csv text into structured records and select the top preferred endpoints.
 */
export function parseCfstCsv(csvText, options = {}) {
  const cleanText = String(csvText || '').replace(/^\uFEFF/, '');
  const lines = cleanText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    return { allRows: [], selected: [], stats: { totalRows: 0, passedRows: 0 } };
  }

  const topN = Number.isInteger(options.topN) && options.topN > 0 ? options.topN : 12;
  const maxDelayMs = Number.isFinite(options.maxDelayMs) ? options.maxDelayMs : 9999;
  const maxLossRate = Number.isFinite(options.maxLossRate) ? options.maxLossRate : 1;
  const minSpeedMBps = Number.isFinite(options.minSpeedMBps) ? options.minSpeedMBps : 0;
  const disableDownload = options.disableDownload === true;
  const allowIpv6 = options.allowIpv6 === true;

  const allRows = [];
  for (const line of lines) {
    const cols = splitCsvLine(line);
    if (cols.length < 6) continue;
    const ip = cols[0];
    const ipVer = net.isIP(ip);
    if (ipVer === 0) continue;
    if (ipVer === 6 && !allowIpv6) continue;

    const sent = Number.parseInt(cols[1], 10) || 0;
    const received = Number.parseInt(cols[2], 10) || 0;
    const lossRate = Number.parseFloat(cols[3]);
    const delayMs = Number.parseFloat(cols[4]);
    const speedMBps = Number.parseFloat(cols[5]);
    const rawColo = (cols[6] || '').trim();
    const colo = rawColo && rawColo.toUpperCase() !== 'N/A' ? rawColo.toUpperCase() : '';

    if (!Number.isFinite(delayMs) || !Number.isFinite(lossRate) || !Number.isFinite(speedMBps)) {
      continue;
    }

    allRows.push({
      ip,
      ipVersion: ipVer,
      sent,
      received,
      lossRate,
      delayMs,
      speedMBps,
      colo,
    });
  }

  const effectiveMinSpeed = disableDownload ? 0 : Math.max(minSpeedMBps, 0.01);
  let filtered = allRows.filter((row) => {
    if (row.delayMs > maxDelayMs) return false;
    if (row.lossRate > maxLossRate) return false;
    if (!disableDownload && row.speedMBps < effectiveMinSpeed) return false;
    return true;
  });

  // If strict minSpeed eliminated every row, fall back gracefully to any positive-speed rows first.
  if (!filtered.length && !disableDownload) {
    filtered = allRows.filter((row) => row.speedMBps > 0 && row.lossRate <= maxLossRate);
  }
  if (!filtered.length) {
    filtered = allRows.filter((row) => row.lossRate <= maxLossRate);
  }

  filtered.sort((a, b) => {
    if (!disableDownload && b.speedMBps !== a.speedMBps) {
      return b.speedMBps - a.speedMBps;
    }
    if (a.lossRate !== b.lossRate) {
      return a.lossRate - b.lossRate;
    }
    return a.delayMs - b.delayMs;
  });

  const selected = filtered.slice(0, topN).map((row) => ({
    server: row.ip,
    port: undefined,
    colo: row.colo,
    delayMs: row.delayMs,
    lossRate: row.lossRate,
    speedMBps: row.speedMBps,
    remark: row.colo || '本地实测',
    isCustom: false,
    source: 'cfst',
  }));

  return {
    allRows,
    selected,
    stats: {
      totalRows: allRows.length,
      passedRows: filtered.length,
      selectedRows: selected.length,
      bestSpeedMBps: selected[0]?.speedMBps ?? 0,
      lowestDelayMs: selected.reduce((min, item) => Math.min(min, item.delayMs), Infinity),
    },
  };
}
