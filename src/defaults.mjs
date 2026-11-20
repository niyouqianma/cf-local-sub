/**
 * Default constants, CF port rules, and configuration normalization helpers.
 */

export const DEFAULT_IPV4_CIDRS = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/12',
  '172.64.0.0/17',
  '172.64.128.0/18',
  '172.64.192.0/19',
  '172.64.224.0/22',
  '172.64.229.0/24',
  '172.64.230.0/23',
  '172.64.232.0/21',
  '172.64.240.0/21',
  '172.64.248.0/21',
  '172.65.0.0/16',
  '172.66.0.0/16',
  '172.67.0.0/16',
  '131.0.72.0/22',
];

export const BUILTIN_DOMAINS = [
  { domain: 'cloudflare.182682.xyz', remark: '优选域名-182682' },
  { domain: 'bestcf.top', remark: '优选域名-bestcf' },
  { domain: 'cf.0sm.com', remark: '优选域名-0sm' },
  { domain: 'cf.090227.xyz', remark: '优选域名-090227' },
  { domain: 'cfip.1323123.xyz', remark: '优选域名-cfip' },
  { domain: 'cloudflare-ip.mofashi.ltd', remark: '优选域名-mofashi' },
  { domain: 'cf.877771.xyz', remark: '优选域名-877771' },
  { domain: 'xn--b6gac.eu.org', remark: '优选域名-b6gac' },
  { domain: 'cf-cname.xingpingcn.top', remark: '优选域名-xingpingcn' },
  { domain: 'cf.877774.xyz', remark: '优选域名-877774' },
  { domain: 'bestcf.030101.xyz', remark: '优选域名-IPDB' },
  { domain: 'cloudflare.seeck.cn', remark: '优选域名-Seeck三网' },
  { domain: 'ctcc.cloudflare.seeck.cn', remark: '优选域名-Seeck电信' },
  { domain: 'cmcc.cloudflare.seeck.cn', remark: '优选域名-Seeck移动' },
  { domain: 'cucc.cloudflare.seeck.cn', remark: '优选域名-Seeck联通' },
  { domain: 'saas.sin.fan', remark: '优选域名-SaasSin' },
  { domain: 'cdn.tzpro.xyz', remark: '优选域名-tzpro' },
  { domain: 'cf.vvhan.com', remark: '优选域名-vvhan' },
];

export const BUILTIN_FALLBACK_DOMAINS = BUILTIN_DOMAINS.map(
  (entry) => `${entry.domain}#${entry.remark}`
);

export const WETEST_API_URL = 'https://www.wetest.vip/api/cf2dns/get_cloudflare_ip?key=o1zrmHAF&type=v4';
export const HOSTMONIT_API_URL = 'https://api.hostmonit.com/get_optimization_ip';
export const XINGPINGCN_JSON_URL = 'https://raw.githubusercontent.com/xingpingcn/enhanced-FaaS-in-China/main/Cf.json';
export const IPDB_API_URL = 'https://ipdb.api.030101.xyz/?type=bestcf';
export const IPDB_RAW_BESTCFV4_URL = 'https://raw.githubusercontent.com/ymyuuu/IPDB/main/BestCF/bestcfv4.txt';

export const GITHUB_IP_SOURCES = [
  {
    key: 'github_lancelot',
    name: 'LancelotRar Top100',
    url: 'https://raw.githubusercontent.com/LancelotRar/best-cf-ips/main/best-cf-ip-scanned-top100.txt',
    defaultTag: 'GitHub-Scan',
  },
  {
    key: 'github_gslege',
    name: 'gslege Cdtools',
    url: 'https://raw.githubusercontent.com/gslege/CloudflareIP/main/Cdtools.txt',
    defaultTag: 'GitHub-测速',
  },
  {
    key: 'github_ipdb',
    name: 'IPDB BestCF',
    url: 'https://raw.githubusercontent.com/ymyuuu/IPDB/main/bestcf.txt',
    defaultTag: 'GitHub-IPDB',
  },
];

export const ENDPOINT_PRIORITIES = new Set([
  'custom-local-online',
  'local-custom-online',
  'online-local-custom',
]);

export const CF_TLS_PORTS = new Set([443, 2053, 2083, 2087, 2096, 8443]);
export const CF_HTTP_PORTS = new Set([80, 8080, 8880, 2052, 2082, 2086, 2095]);
export const DEFAULT_CLASH_TEST_URL = 'http://cp.cloudflare.com/generate_204';
export const DEFAULT_CFST_TEST_URL = 'https://cf.xiu2.xyz/url';

/**
 * Clamp an integer or float to [min, max] with a safe fallback.
 */
export function clampNumber(value, fallback, min, max, isFloat = false) {
  const parsed = isFloat ? Number.parseFloat(value) : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Build a normalized configuration object from partial input and environment defaults.
 */
export function normalizeConfig(raw = {}, env = process.env) {
  const cfstRaw = raw.cfst && typeof raw.cfst === 'object' ? raw.cfst : {};
  const subRaw = raw.subscription && typeof raw.subscription === 'object' ? raw.subscription : {};
  const stratRaw = raw.strategy && typeof raw.strategy === 'object' ? raw.strategy : {};
  const schedRaw = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {};

  const intervalMinutes = clampNumber(
    schedRaw.intervalMinutes ?? env.SCHEDULE_INTERVAL_MINUTES,
    360,
    0,
    10080
  );

  let endpointPriority = String(subRaw.endpointPriority || '').trim();
  if (!ENDPOINT_PRIORITIES.has(endpointPriority)) {
    endpointPriority = subRaw.customFirst === true ? 'custom-local-online' : 'local-custom-online';
  }
  const customFirst = endpointPriority === 'custom-local-online';

  const sourceCacheTtlSec = clampNumber(
    stratRaw.sourceCacheTtlSec ?? env.SOURCE_CACHE_TTL_SEC,
    300,
    0,
    86400
  );

  return {
    subscription: {
      baseLinks: String(subRaw.baseLinks ?? '').trim(),
      customIps: String(subRaw.customIps ?? '').trim(),
      namePrefix: String(subRaw.namePrefix ?? 'CF').trim() || 'CF',
      topN: clampNumber(subRaw.topN, 12, 1, 200),
      includeMetricsInName: subRaw.includeMetricsInName !== false,
      keepOriginalHost: subRaw.keepOriginalHost !== false,
      allowIpv6: subRaw.allowIpv6 === true,
      fallbackToBuiltinDomains: subRaw.fallbackToBuiltinDomains === true,
      customFirst,
      endpointPriority,
    },
    strategy: {
      enableLocalCfst: stratRaw.enableLocalCfst !== false,
      enableDynamicIps: stratRaw.enableDynamicIps === true,
      enableBuiltinDomains: stratRaw.enableBuiltinDomains === true,
      enableGithubIps: stratRaw.enableGithubIps === true,
      maxDynamic: clampNumber(stratRaw.maxDynamic, 40, 1, 200),
      maxGithub: clampNumber(stratRaw.maxGithub, 40, 1, 200),
      sourceCacheTtlSec,
      sourceTimeoutMs: clampNumber(stratRaw.sourceTimeoutMs ?? env.SOURCE_TIMEOUT_MS, 4500, 1000, 20000),
      enableDiskPoolFallback: stratRaw.enableDiskPoolFallback !== false,
    },
    cfst: {
      binPath: String(cfstRaw.binPath ?? env.CFST_BIN ?? '').trim(),
      mode: cfstRaw.mode === 'httping' ? 'httping' : 'tcping',
      httpingCode: clampNumber(cfstRaw.httpingCode, 0, 0, 599),
      cfColo: String(cfstRaw.cfColo ?? '').trim().toUpperCase(),
      routines: clampNumber(cfstRaw.routines, 200, 1, 1000),
      pingTimes: clampNumber(cfstRaw.pingTimes, 4, 1, 20),
      downloadCount: clampNumber(cfstRaw.downloadCount, 12, 1, 100),
      downloadTime: clampNumber(cfstRaw.downloadTime, 10, 2, 60),
      port: clampNumber(cfstRaw.port, 443, 1, 65535),
      testUrl: String(cfstRaw.testUrl ?? env.CFST_URL ?? DEFAULT_CFST_TEST_URL).trim() || DEFAULT_CFST_TEST_URL,
      maxDelayMs: clampNumber(cfstRaw.maxDelayMs, 350, 10, 9999),
      minDelayMs: clampNumber(cfstRaw.minDelayMs, 0, 0, 9999),
      maxLossRate: clampNumber(cfstRaw.maxLossRate, 0.2, 0, 1, true),
      minSpeedMBps: clampNumber(cfstRaw.minSpeedMBps, 1.0, 0, 1000, true),
      disableDownload: cfstRaw.disableDownload === true,
      testAll: cfstRaw.testAll === true,
    },
    schedule: {
      enabled: schedRaw.enabled !== false && intervalMinutes > 0,
      intervalMinutes,
      runOnStartup: schedRaw.runOnStartup === true,
    },
  };
}
