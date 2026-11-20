/**
 * Worker-compatible online preferred-IP aggregator with TTL memory cache and per-source disk fallback.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  BUILTIN_DOMAINS,
  GITHUB_IP_SOURCES,
  HOSTMONIT_API_URL,
  IPDB_API_URL,
  IPDB_RAW_BESTCFV4_URL,
  WETEST_API_URL,
  XINGPINGCN_JSON_URL,
  clampNumber,
} from './defaults.mjs';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; CF-Local-Sub/2.0)';

/**
 * Build static item records for the 18 built-in Cloudflare preferred domains.
 */
export function getBuiltinDomainItems() {
  return BUILTIN_DOMAINS.map((entry) => ({
    server: entry.domain,
    port: undefined,
    endpoint: entry.domain,
    category: 'domain',
    source: 'builtin',
    sourceName: '内置域名',
    colo: '',
    delayMs: null,
    lossRate: null,
    speedMBps: null,
    pingText: 'Anycast',
    speedText: 'DNS 直连 CF',
    remark: entry.remark,
    isCustom: false,
    line: `${entry.domain}#${entry.remark}`,
  }));
}

function isValidIpv4(ip) {
  return net.isIP(String(ip || '').trim()) === 4;
}

function formatGithubRemark(rawRemark, defaultTag) {
  const cleaned = String(rawRemark || '')
    .replace(/[【】]/g, ' ')
    .replace(/优选\s*Nodes?/gi, '')
    .trim();
  if (!cleaned) return defaultTag;
  const ccMatch = cleaned.match(/\b([A-Z]{2})\b/);
  if (ccMatch) return `GitHub-${ccMatch[1]}`;
  const speedMatch = cleaned.match(/([\d.]+\s*MB\/s)/i);
  if (speedMatch) return `GitHub-${speedMatch[1].replace(/\s+/g, '')}`;
  return `GitHub-${cleaned.slice(0, 12)}`;
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      'User-Agent': DEFAULT_USER_AGENT,
      ...(options.headers || {}),
    };
    return await fetchImpl(url, { ...options, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch real-time Cloudflare speedtest IPs from WeTest API.
 */
export async function fetchWetestIps(fetchImpl = fetch, timeoutMs = 4500) {
  const key = 'wetest';
  const name = 'WeTest 测速';
  try {
    const res = await fetchWithTimeout(fetchImpl, WETEST_API_URL, {}, timeoutMs);
    if (!res.ok) return { key, name, category: 'dynamic', ok: false, items: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    const info = data?.info || {};
    const lineMap = { CT: '电信', CU: '联通', CM: '移动', CN: '三网' };
    const items = [];

    for (const [bucket, label] of Object.entries(lineMap)) {
      const rows = Array.isArray(info[bucket]) ? info[bucket] : [];
      for (const row of rows) {
        const ip = String(row.ip || '').trim();
        if (!isValidIpv4(ip)) continue;
        if (Number(row.loss_rate || 0) > 20) continue;
        const colo = row.colo ? String(row.colo).trim().toUpperCase() : '';
        const ping = row.rtt_avg ? `${Number(row.rtt_avg)}ms` : '';
        const speedMbps = row.speed ? `${((Number(row.speed) * 8) / 1000).toFixed(1)}Mbps` : '';
        const remark = [label, colo, ping].filter(Boolean).join('-');
        items.push({
          server: ip,
          port: undefined,
          endpoint: ip,
          category: 'dynamic',
          source: 'dynamic',
          sourceName: `WeTest-${label}`,
          colo: '',
          delayMs: null,
          lossRate: null,
          speedMBps: null,
          pingText: ping || '-',
          speedText: [colo, speedMbps].filter(Boolean).join(' · ') || '实时测速',
          remark,
          isCustom: false,
          line: `${ip}#${remark}`,
        });
      }
    }
    return { key, name, category: 'dynamic', ok: items.length > 0, items, error: items.length ? null : '无有效 IP' };
  } catch (err) {
    return { key, name, category: 'dynamic', ok: false, items: [], error: err?.message || '请求超时' };
  }
}

/**
 * Fetch optimization IPs from HostMonit API.
 */
export async function fetchHostmonitIps(fetchImpl = fetch, timeoutMs = 4500) {
  const key = 'hostmonit';
  const name = 'HostMonit';
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      HOSTMONIT_API_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'iDetkOys' }),
      },
      timeoutMs
    );
    if (!res.ok) return { key, name, category: 'dynamic', ok: false, items: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    const rows = Array.isArray(data?.info) ? data.info : [];
    const lineMap = { CT: '电信', CU: '联通', CM: '移动' };
    const items = [];

    for (const row of rows) {
      const ip = String(row.ip || '').trim();
      if (!isValidIpv4(ip)) continue;
      if (Number(row.loss || 0) > 20) continue;
      const label = lineMap[row.line] || '三网';
      const ping = row.latency ? `${Number(row.latency)}ms` : '';
      const speedText = row.speed ? `${row.speed}KB/s` : '';
      const remark = [label, ping].filter(Boolean).join('-');
      items.push({
        server: ip,
        port: undefined,
        endpoint: ip,
        category: 'dynamic',
        source: 'dynamic',
        sourceName: `HostMonit-${label}`,
        colo: '',
        delayMs: null,
        lossRate: null,
        speedMBps: null,
        pingText: ping || '-',
        speedText: speedText || '实时优选',
        remark,
        isCustom: false,
        line: `${ip}#${remark}`,
      });
    }
    return { key, name, category: 'dynamic', ok: items.length > 0, items, error: items.length ? null : '无有效 IP' };
  } catch (err) {
    return { key, name, category: 'dynamic', ok: false, items: [], error: err?.message || '请求超时' };
  }
}

/**
 * Fetch frequently updated ISP IPs from xingpingcn/enhanced-FaaS-in-China.
 */
export async function fetchXingpingcnIps(fetchImpl = fetch, timeoutMs = 4500) {
  const key = 'xingpingcn';
  const name = 'Xingpingcn';
  try {
    const res = await fetchWithTimeout(fetchImpl, XINGPINGCN_JSON_URL, {}, timeoutMs);
    if (!res.ok) return { key, name, category: 'dynamic', ok: false, items: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    const result = data?.Cf?.result || {};
    const lineMap = { dianxin: '电信', liantong: '联通', yidong: '移动', default: '三网' };
    const items = [];

    for (const [bucket, label] of Object.entries(lineMap)) {
      const ips = Array.isArray(result[bucket]) ? result[bucket] : [];
      for (const rawIp of ips) {
        const ip = String(rawIp || '').trim();
        if (!isValidIpv4(ip)) continue;
        const remark = `${label}-Xingping`;
        items.push({
          server: ip,
          port: undefined,
          endpoint: ip,
          category: 'dynamic',
          source: 'dynamic',
          sourceName: `Xingping-${label}`,
          colo: '',
          delayMs: null,
          lossRate: null,
          speedMBps: null,
          pingText: '分钟级',
          speedText: '实时监控',
          remark,
          isCustom: false,
          line: `${ip}#${remark}`,
        });
      }
    }
    return { key, name, category: 'dynamic', ok: items.length > 0, items, error: items.length ? null : '无有效 IP' };
  } catch (err) {
    return { key, name, category: 'dynamic', ok: false, items: [], error: err?.message || '请求超时' };
  }
}

/**
 * Fetch IPDB dynamic BestCF IPv4 list with GitHub mirror fallback.
 */
export async function fetchIpdbDynamicIps(fetchImpl = fetch, timeoutMs = 4500) {
  const key = 'ipdb';
  const name = 'IPDB API';
  for (const url of [IPDB_API_URL, IPDB_RAW_BESTCFV4_URL]) {
    try {
      const res = await fetchWithTimeout(fetchImpl, url, {}, timeoutMs);
      if (!res.ok) continue;
      const txt = await res.text();
      const items = [];
      for (const rawLine of txt.split(/\r?\n/)) {
        const ip = rawLine.trim().split('#')[0].trim();
        if (!isValidIpv4(ip)) continue;
        items.push({
          server: ip,
          port: undefined,
          endpoint: ip,
          category: 'dynamic',
          source: 'dynamic',
          sourceName: 'IPDB-BestCF',
          colo: '',
          delayMs: null,
          lossRate: null,
          speedMBps: null,
          pingText: '小时级',
          speedText: '官方优选段',
          remark: '三网-IPDB',
          isCustom: false,
          line: `${ip}#三网-IPDB`,
        });
      }
      if (items.length) return { key, name, category: 'dynamic', ok: true, items, error: null };
    } catch {
      // Try mirror fallback URL.
    }
  }
  return { key, name, category: 'dynamic', ok: false, items: [], error: '接口与镜像均不可用' };
}

/**
 * Fetch and sanitize one GitHub text IP list source.
 */
export async function fetchGithubListSource(source, fetchImpl = fetch, timeoutMs = 4500) {
  try {
    const res = await fetchWithTimeout(fetchImpl, source.url, {}, timeoutMs);
    if (!res.ok) return { key: source.key, name: source.name, category: 'github', ok: false, items: [], error: `HTTP ${res.status}` };
    const txt = await res.text();
    const items = [];

    for (const rawLine of txt.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      if (/\b0\.0+\s*MB\/s/i.test(line)) continue;
      const hashIdx = line.indexOf('#');
      const hostPart = (hashIdx === -1 ? line : line.slice(0, hashIdx)).trim();
      const rawRemark = hashIdx === -1 ? '' : line.slice(hashIdx + 1).trim();
      const m = hostPart.match(/^(\d+\.\d+\.\d+\.\d+)(?::(\d+))?$/);
      if (!m || !isValidIpv4(m[1])) continue;
      const port = m[2] ? Number(m[2]) : undefined;
      if (port !== undefined && (port < 1 || port > 65535)) continue;

      const remark = formatGithubRemark(rawRemark, source.defaultTag);
      const endpoint = port ? `${m[1]}:${port}` : m[1];
      items.push({
        server: m[1],
        port,
        endpoint,
        category: 'github',
        source: 'github',
        sourceName: source.name,
        colo: '',
        delayMs: null,
        lossRate: null,
        speedMBps: null,
        pingText: rawRemark.includes('MB/s') ? '测速优选' : '社区扫描',
        speedText: rawRemark || source.defaultTag,
        remark,
        isCustom: false,
        line: `${endpoint}#${remark}`,
      });
    }
    return {
      key: source.key,
      name: source.name,
      category: 'github',
      ok: items.length > 0,
      items,
      error: items.length ? null : '无有效 IP',
    };
  } catch (err) {
    return {
      key: source.key,
      name: source.name,
      category: 'github',
      ok: false,
      items: [],
      error: err?.message || '请求超时',
    };
  }
}

function buildPoolFromSourceResults(dynamicResults, githubResults, updatedAt) {
  const dynamicMap = new Map();
  for (const res of dynamicResults) {
    for (const item of res.items || []) {
      if (!dynamicMap.has(item.server)) {
        dynamicMap.set(item.server, item);
      }
    }
  }

  const githubMap = new Map();
  for (const res of githubResults) {
    for (const item of res.items || []) {
      if (dynamicMap.has(item.server)) continue;
      if (!githubMap.has(item.server)) {
        githubMap.set(item.server, item);
      }
    }
  }

  const domainItems = getBuiltinDomainItems();
  const sourceStatus = [
    {
      key: 'builtin',
      name: '内置域名',
      category: 'domain',
      ok: true,
      count: domainItems.length,
      fromCache: false,
      stale: false,
      error: null,
    },
    ...[...dynamicResults, ...githubResults].map((res) => ({
      key: res.key,
      name: res.name,
      category: res.category,
      ok: Boolean(res.ok),
      count: Array.isArray(res.items) ? res.items.length : 0,
      fromCache: Boolean(res.fromCache),
      stale: Boolean(res.stale),
      cachedAt: res.cachedAt || null,
      error: res.error || null,
    })),
  ];

  return {
    updatedAt,
    domainItems,
    dynamicItems: Array.from(dynamicMap.values()),
    githubItems: Array.from(githubMap.values()),
    sourceStatus,
  };
}

/**
 * Manage online preferred-IP fetching, short-term TTL memory caching, and disk snapshot fallback.
 */
export class OnlineSourceManager {
  constructor(dataDir, options = {}) {
    this.dataDir = path.resolve(dataDir);
    this.cachePath = path.join(this.dataDir, 'online_pool_cache.json');
    this.fetchImpl = options.fetchImpl || fetch;
    this.memoryCache = {
      expiresAt: 0,
      ttlMs: 300000,
      data: null,
    };
    this.inFlight = null;
  }

  readDiskSnapshot() {
    try {
      if (!fs.existsSync(this.cachePath)) return { updatedAt: null, sources: {} };
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      return {
        updatedAt: parsed.updatedAt || null,
        sources: parsed.sources && typeof parsed.sources === 'object' ? parsed.sources : {},
      };
    } catch {
      return { updatedAt: null, sources: {} };
    }
  }

  writeDiskSnapshot(snapshot) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.cachePath, JSON.stringify(snapshot, null, 2), 'utf8');
  }

  /**
   * Build a synchronous view from memory cache or disk snapshot without network calls.
   */
  getCachedSnapshotSync() {
    if (this.memoryCache.data) {
      return {
        ...this.memoryCache.data,
        cacheState: {
          mode: Date.now() < this.memoryCache.expiresAt ? 'memory' : 'memory-expired',
          expiresAt: this.memoryCache.expiresAt ? new Date(this.memoryCache.expiresAt).toISOString() : null,
          ttlSec: Math.round((this.memoryCache.ttlMs || 0) / 1000),
        },
      };
    }

    const disk = this.readDiskSnapshot();
    const dynKeys = ['wetest', 'hostmonit', 'xingpingcn', 'ipdb'];
    const ghKeys = GITHUB_IP_SOURCES.map((s) => s.key);
    const dynNames = {
      wetest: 'WeTest 测速',
      hostmonit: 'HostMonit',
      xingpingcn: 'Xingpingcn',
      ipdb: 'IPDB API',
    };

    const dynResults = dynKeys.map((key) => {
      const saved = disk.sources[key];
      if (saved?.items?.length) {
        return { ...saved, key, category: 'dynamic', ok: true, fromCache: true, stale: false, error: null };
      }
      return { key, name: dynNames[key], category: 'dynamic', ok: false, items: [], fromCache: false, error: '尚未拉取' };
    });

    const ghResults = GITHUB_IP_SOURCES.map((src) => {
      const saved = disk.sources[src.key];
      if (saved?.items?.length) {
        return { ...saved, key: src.key, name: src.name, category: 'github', ok: true, fromCache: true, stale: false, error: null };
      }
      return { key: src.key, name: src.name, category: 'github', ok: false, items: [], fromCache: false, error: '尚未拉取' };
    });

    const pool = buildPoolFromSourceResults(dynResults, ghResults, disk.updatedAt);
    return {
      ...pool,
      cacheState: {
        mode: disk.updatedAt ? 'disk-snapshot' : 'empty',
        expiresAt: null,
        ttlSec: Math.round((this.memoryCache.ttlMs || 300000) / 1000),
      },
    };
  }

  /**
   * Return cached online pool when valid, or concurrently refresh all 7 online routes.
   */
  async getPool(options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const ttlSec = clampNumber(options.sourceCacheTtlSec, 300, 0, 86400);
    const ttlMs = ttlSec * 1000;
    const timeoutMs = clampNumber(options.sourceTimeoutMs, 4500, 1000, 20000);
    const diskFallback = options.enableDiskPoolFallback !== false;

    const now = Date.now();
    if (!forceRefresh && ttlMs > 0 && this.memoryCache.data && now < this.memoryCache.expiresAt) {
      return {
        ...this.memoryCache.data,
        cacheState: {
          mode: 'memory',
          expiresAt: new Date(this.memoryCache.expiresAt).toISOString(),
          ttlSec,
        },
      };
    }

    if (this.inFlight && !forceRefresh) {
      return this.inFlight;
    }

    const refreshTask = (async () => {
      const priorDisk = this.readDiskSnapshot();
      const nextSources = { ...priorDisk.sources };
      const fetchAtIso = new Date().toISOString();

      const [wetest, hostmonit, xingpingcn, ipdb, ...ghRaw] = await Promise.all([
        fetchWetestIps(this.fetchImpl, timeoutMs),
        fetchHostmonitIps(this.fetchImpl, timeoutMs),
        fetchXingpingcnIps(this.fetchImpl, timeoutMs),
        fetchIpdbDynamicIps(this.fetchImpl, timeoutMs),
        ...GITHUB_IP_SOURCES.map((src) => fetchGithubListSource(src, this.fetchImpl, timeoutMs)),
      ]);

      const reconcile = (res) => {
        if (res.ok && res.items.length > 0) {
          nextSources[res.key] = {
            key: res.key,
            name: res.name,
            category: res.category,
            updatedAt: fetchAtIso,
            items: res.items,
          };
          return { ...res, fromCache: false, stale: false, cachedAt: fetchAtIso };
        }
        const prev = priorDisk.sources[res.key];
        if (diskFallback && prev?.items?.length) {
          return {
            ...res,
            ok: true,
            items: prev.items,
            fromCache: true,
            stale: true,
            cachedAt: prev.updatedAt || priorDisk.updatedAt || null,
            error: `${res.error || '拉取失败'}（已用磁盘缓存兜底）`,
          };
        }
        return { ...res, fromCache: false, stale: false, cachedAt: null };
      };

      const dynResults = [wetest, hostmonit, xingpingcn, ipdb].map(reconcile);
      const ghResults = ghRaw.map(reconcile);

      this.writeDiskSnapshot({
        updatedAt: fetchAtIso,
        sources: nextSources,
      });

      const pool = buildPoolFromSourceResults(dynResults, ghResults, fetchAtIso);
      const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
      this.memoryCache = {
        expiresAt,
        ttlMs,
        data: pool,
      };

      return {
        ...pool,
        cacheState: {
          mode: forceRefresh ? 'forced-live' : 'live',
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          ttlSec,
        },
      };
    })();

    this.inFlight = refreshTask;
    try {
      return await refreshTask;
    } finally {
      if (this.inFlight === refreshTask) {
        this.inFlight = null;
      }
    }
  }

  /**
   * Slice cached or live pool details for the monitor API and UI table.
   */
  async getDetailedView(options = {}) {
    const pool = await this.getPool(options);
    const maxDynamic = clampNumber(options.maxDynamic, 200, 1, 200);
    const maxGithub = clampNumber(options.maxGithub, 200, 1, 200);
    const dyn = pool.dynamicItems.slice(0, maxDynamic);
    const dom = pool.domainItems;
    const gh = pool.githubItems.slice(0, maxGithub);
    return {
      items: [...dyn, ...dom, ...gh],
      countsByCategory: {
        dynamic: dyn.length,
        domain: dom.length,
        github: gh.length,
        totalDynamicAvailable: pool.dynamicItems.length,
        totalGithubAvailable: pool.githubItems.length,
      },
      sourceStatus: pool.sourceStatus,
      updatedAt: pool.updatedAt,
      cacheState: pool.cacheState,
    };
  }
}
