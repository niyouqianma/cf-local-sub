/**
 * Proxy link parser, preferred-IP node builder, and multi-client subscription renderers.
 */

import net from 'node:net';
import {
  BUILTIN_FALLBACK_DOMAINS,
  CF_HTTP_PORTS,
  CF_TLS_PORTS,
  DEFAULT_CLASH_TEST_URL,
  clampNumber,
} from './defaults.mjs';

/**
 * Encode UTF-8 string to Base64 using Node Buffer.
 */
export function b64EncodeUtf8(str) {
  return Buffer.from(String(str), 'utf8').toString('base64');
}

/**
 * Decode standard or URL-safe Base64 string to UTF-8.
 */
export function b64DecodeUtf8(str) {
  const normalized = String(str || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLen), 'base64').toString('utf8');
}

/**
 * Escape double-quoted YAML scalar values safely.
 */
function escapeYaml(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * Validate whether a host string is an allowed IPv4, IPv6, or domain name.
 */
export function isValidEndpointHost(host, allowIpv6 = false) {
  const ipVer = net.isIP(host);
  if (ipVer === 4) return true;
  if (ipVer === 6) return allowIpv6;
  return /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(host);
}

/**
 * Parse one endpoint entry (IP, IP:port, [IPv6]:port, domain) with optional #remark.
 */
export function parseEndpointLine(raw, { allowIpv6 = false, isCustom = true } = {}) {
  const textLine = String(raw || '').trim();
  if (!textLine || textLine.startsWith('#') || textLine.startsWith('//')) return null;

  const hashIdx = textLine.indexOf('#');
  const hostPart = (hashIdx === -1 ? textLine : textLine.slice(0, hashIdx)).trim();
  const remark = (hashIdx === -1 ? '' : textLine.slice(hashIdx + 1)).trim();
  if (!hostPart) return null;

  let server = '';
  let port;

  if (hostPart.startsWith('[')) {
    const v6Match = hostPart.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!v6Match) return null;
    server = v6Match[1].trim();
    port = v6Match[2] ? Number(v6Match[2]) : undefined;
  } else if ((hostPart.match(/:/g) || []).length > 1) {
    server = hostPart;
  } else {
    const match = hostPart.match(/^(.*?)(?::(\d+))?$/);
    server = (match?.[1] || hostPart).trim();
    port = match?.[2] ? Number(match[2]) : undefined;
  }

  if (!isValidEndpointHost(server, allowIpv6)) return null;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;

  return {
    server,
    port,
    colo: '',
    delayMs: null,
    lossRate: null,
    speedMBps: null,
    remark: remark || (isCustom ? '手动指定' : '备用域名'),
    isCustom,
    source: isCustom ? 'custom' : 'builtin',
  };
}

/**
 * Parse multi-line custom endpoint text into normalized endpoint objects.
 */
export function parsePreferredEndpoints(input, options = {}) {
  return String(input || '')
    .split(/[\r\n,;]+/)
    .map((line) => parseEndpointLine(line, options))
    .filter(Boolean);
}

function parseVmess(link) {
  const raw = link.slice('vmess://'.length).trim();
  const obj = JSON.parse(b64DecodeUtf8(raw));
  if (!obj.add || !obj.id) throw new Error('vmess 缺少 add 或 id');
  return {
    type: 'vmess',
    name: String(obj.ps || 'vmess').trim(),
    server: String(obj.add).trim(),
    port: Number(obj.port || 443),
    uuid: String(obj.id).trim(),
    cipher: obj.scy || 'auto',
    network: obj.net || 'ws',
    tls: obj.tls === 'tls' || obj.tls === true,
    security: obj.tls === 'tls' || obj.tls === true ? 'tls' : 'none',
    host: obj.host || '',
    path: obj.path || '/',
    sni: obj.sni || obj.host || '',
    alpn: obj.alpn || '',
    fp: obj.fp || '',
    serviceName: obj.net === 'grpc' ? (obj.path || '') : '',
    mode: '',
    extra: '',
  };
}

function parseUrlLike(link, type) {
  const parsed = new URL(link);
  const secret = decodeURIComponent(parsed.username || '');
  if (!parsed.hostname || !secret) {
    throw new Error(`${type} 缺少服务器地址或认证凭据`);
  }

  const network = parsed.searchParams.get('type') || 'tcp';
  const security = (parsed.searchParams.get('security') || '').toLowerCase();
  const tls = security === 'tls' || security === 'xtls' || (type === 'trojan' && security !== 'none');

  return {
    type,
    name: decodeURIComponent(parsed.hash.replace(/^#/, '')) || type,
    server: parsed.hostname,
    port: Number(parsed.port || 443),
    password: type === 'trojan' ? secret : undefined,
    uuid: type === 'vless' ? secret : undefined,
    network,
    tls,
    security: security || (tls ? 'tls' : 'none'),
    host: parsed.searchParams.get('host') || parsed.searchParams.get('sni') || '',
    path: parsed.searchParams.get('path') || '/',
    sni: tls ? (parsed.searchParams.get('sni') || parsed.searchParams.get('host') || '') : '',
    fp: parsed.searchParams.get('fp') || '',
    alpn: parsed.searchParams.get('alpn') || '',
    flow: parsed.searchParams.get('flow') || '',
    serviceName: parsed.searchParams.get('serviceName') || '',
    mode: parsed.searchParams.get('mode') || '',
    extra: parsed.searchParams.get('extra') || '',
  };
}

/**
 * Parse plain-text or Base64-encoded vmess/vless/trojan base node links.
 */
export function parseRawLinks(input) {
  const rawText = String(input || '').trim();
  if (!rawText) return { nodes: [], warnings: [] };

  let lines = rawText.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && !lines[0].includes('://')) {
    try {
      const decoded = b64DecodeUtf8(lines[0]);
      if (decoded.includes('://')) {
        lines = decoded.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
      }
    } catch {
      // Keep original line so unsupported-format warning reports accurately.
    }
  }

  const nodes = [];
  const warnings = [];

  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith('//')) continue;
    try {
      let parsedNode = null;
      if (line.startsWith('vmess://')) parsedNode = parseVmess(line);
      else if (line.startsWith('vless://')) parsedNode = parseUrlLike(line, 'vless');
      else if (line.startsWith('trojan://')) parsedNode = parseUrlLike(line, 'trojan');
      else {
        const scheme = line.includes('://') ? line.split('://')[0] : '未知格式';
        warnings.push(`已跳过不支持的节点格式: ${scheme}`);
        continue;
      }

      if (parsedNode.security === 'reality') {
        warnings.push(`节点 "${parsedNode.name}" 使用 Reality 直连协议，不经过 Cloudflare CDN，套用 CF 优选 IP 后将无法握手`);
      }
      if (parsedNode.network === 'xhttp' || parsedNode.network === 'splithttp') {
        warnings.push(`节点 "${parsedNode.name}" 使用 ${parsedNode.network} 传输：Raw(V2rayN/Xray) 原生支持，传统 Clash/Surge 内核可能不兼容`);
      }
      nodes.push(parsedNode);
    } catch (err) {
      warnings.push(`已跳过损坏的节点行 (${err?.message || '解析失败'})`);
    }
  }

  return { nodes, warnings };
}

function cleanGroupName(remark) {
  const r = String(remark || '').trim();
  if (!r) return 'CF';
  const rLower = r.toLowerCase();
  for (const key of ['电信', '联通', '移动', '三网', '多线', '优选域名', '本地实测']) {
    if (rLower.includes(key.toLowerCase())) return key;
  }
  if (rLower.startsWith('github-')) return r.slice(0, 16);
  if (rLower.includes('github')) return 'GitHub';
  const part = r.split('-')[0].split('#')[0].trim();
  return part || 'CF';
}

function resolveEndpointPort(node, ep) {
  if (!ep.port) return node.port;
  if (ep.isCustom) return ep.port;
  if (node.tls) return CF_TLS_PORTS.has(ep.port) ? ep.port : node.port;
  return CF_HTTP_PORTS.has(ep.port) ? ep.port : node.port;
}

/**
 * Deduplicate preferred endpoints by server:port while preserving priority order.
 */
export function deduplicateEndpoints(endpoints) {
  const seen = new Set();
  const out = [];
  for (const ep of endpoints) {
    if (!ep?.server) continue;
    const key = `${ep.server}:${ep.port || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ep);
  }
  return out;
}

function formatEndpointLabel(ep, includeMetrics) {
  const baseTag = ep.colo || cleanGroupName(ep.remark) || 'CF';
  if (!includeMetrics) return baseTag;

  const metrics = [];
  if (Number.isFinite(ep.speedMBps) && ep.speedMBps > 0) {
    metrics.push(`${ep.speedMBps.toFixed(1)}MB/s`);
  }
  if (Number.isFinite(ep.delayMs)) {
    metrics.push(`${Math.round(ep.delayMs)}ms`);
  }
  return metrics.length ? `${baseTag} (${metrics.join(' ')})` : baseTag;
}

/**
 * Combine base nodes with preferred endpoints into concrete proxy node objects.
 */
export function buildNodes(baseNodes, preferredEndpoints, options = {}) {
  const uniqueEndpoints = deduplicateEndpoints(preferredEndpoints);
  if (!baseNodes.length || !uniqueEndpoints.length) return [];

  const prefix = String(options.namePrefix ?? 'CF').trim();
  const includeMetrics = options.includeMetricsInName !== false;
  const keepOriginalHost = options.keepOriginalHost !== false;
  const multiBase = baseNodes.length > 1;
  const counters = {};
  const usedNames = new Set();
  const output = [];

  for (const node of baseNodes) {
    const shortBaseName = multiBase ? String(node.name || node.type).trim().slice(0, 14) : '';
    for (const ep of uniqueEndpoints) {
      const grp = ep.colo || cleanGroupName(ep.remark) || 'CF';
      const counterKey = shortBaseName ? `${shortBaseName}|${grp}` : grp;
      counters[counterKey] = (counters[counterKey] || 0) + 1;
      const idx = String(counters[counterKey]).padStart(2, '0');
      const metricSuffix = formatEndpointLabel(ep, includeMetrics);
      const coreTag = metricSuffix === grp ? `${grp} ${idx}` : `${grp} ${idx} · ${metricSuffix.replace(`${grp} `, '')}`;
      const tag = shortBaseName ? `${shortBaseName} ${coreTag}` : coreTag;
      let name = prefix ? `${prefix} | ${tag}` : tag;

      if (usedNames.has(name)) {
        let seq = 2;
        while (usedNames.has(`${name} #${seq}`)) seq += 1;
        name = `${name} #${seq}`;
      }
      usedNames.add(name);

      const host = keepOriginalHost ? (node.host || node.sni || node.server) : (node.host || '');
      const sni = node.tls
        ? (keepOriginalHost ? (node.sni || node.host || node.server) : (node.sni || ''))
        : '';
      output.push({
        ...node,
        name,
        server: ep.server,
        port: resolveEndpointPort(node, ep),
        host,
        sni,
        endpointMeta: {
          source: ep.source || 'cfst',
          sourceName: ep.sourceName || '',
          colo: ep.colo || '',
          delayMs: ep.delayMs ?? null,
          lossRate: ep.lossRate ?? null,
          speedMBps: ep.speedMBps ?? null,
          pingText: ep.pingText || '',
          speedText: ep.speedText || '',
          remark: ep.remark || '',
        },
      });
    }
  }

  return output;
}

function encodeVmess(node) {
  const payload = {
    v: '2',
    ps: node.name,
    add: node.server,
    port: String(node.port),
    id: node.uuid,
    aid: '0',
    scy: node.cipher || 'auto',
    net: node.network || 'ws',
    type: 'none',
    host: node.host || '',
    path: node.network === 'grpc' ? (node.serviceName || node.path || '') : (node.path || '/'),
    tls: node.tls ? 'tls' : '',
    sni: node.tls ? (node.sni || '') : '',
    alpn: node.alpn || '',
    fp: node.fp || '',
  };
  return `vmess://${b64EncodeUtf8(JSON.stringify(payload))}`;
}

function encodeUrlNode(node, scheme, secret) {
  const hostFormat = node.server.includes(':') ? `[${node.server}]` : node.server;
  const url = new URL(`${scheme}://${encodeURIComponent(secret)}@${hostFormat}:${node.port}`);
  if (node.network) url.searchParams.set('type', node.network);
  url.searchParams.set('security', node.tls ? 'tls' : 'none');
  if (node.host) url.searchParams.set('host', node.host);
  if (node.tls && node.sni) url.searchParams.set('sni', node.sni);

  if (node.network === 'grpc') {
    const svc = node.serviceName || (node.path && node.path !== '/' ? node.path : '');
    if (svc) url.searchParams.set('serviceName', svc);
  } else if (node.path) {
    url.searchParams.set('path', node.path);
  }

  if (node.mode) url.searchParams.set('mode', node.mode);
  if (node.extra) url.searchParams.set('extra', node.extra);
  if (node.alpn) url.searchParams.set('alpn', node.alpn);
  if (node.fp) url.searchParams.set('fp', node.fp);
  if (node.flow) url.searchParams.set('flow', node.flow);
  url.hash = encodeURIComponent(node.name);
  return url.toString();
}

/**
 * Render Base64-encoded raw subscription text for V2rayN / Shadowrocket / Xray clients.
 */
export function renderRaw(nodes) {
  if (!nodes.length) return '';
  const lines = nodes
    .map((node) => {
      if (node.type === 'vmess') return encodeVmess(node);
      if (node.type === 'vless') return encodeUrlNode(node, 'vless', node.uuid);
      if (node.type === 'trojan') return encodeUrlNode(node, 'trojan', node.password);
      return '';
    })
    .filter(Boolean);
  return b64EncodeUtf8(lines.join('\n'));
}

/**
 * Render the shared YAML `proxies:` block used by both full Clash config and Mihomo proxy-provider.
 */
function renderClashProxiesBlock(nodes) {
  if (!nodes.length) return 'proxies: []';

  const entries = nodes.map((node) => {
    const lines = [
      `  - name: "${escapeYaml(node.name)}"`,
      `    type: ${node.type}`,
      `    server: "${escapeYaml(node.server)}"`,
      `    port: ${node.port}`,
      '    udp: true',
    ];

    if (node.type === 'vmess') {
      lines.push(`    uuid: ${node.uuid}`);
      lines.push('    alterId: 0');
      lines.push(`    cipher: ${node.cipher || 'auto'}`);
    } else if (node.type === 'vless') {
      lines.push(`    uuid: ${node.uuid}`);
      if (node.flow) lines.push(`    flow: ${node.flow}`);
    } else if (node.type === 'trojan') {
      lines.push(`    password: "${escapeYaml(node.password || '')}"`);
    }

    if (node.tls) {
      lines.push('    tls: true');
      if (node.sni) lines.push(`    servername: "${escapeYaml(node.sni)}"`);
    }
    if (node.fp) lines.push(`    client-fingerprint: "${escapeYaml(node.fp)}"`);
    if (node.alpn) {
      const alpnList = String(node.alpn)
        .split(',')
        .map((a) => `"${escapeYaml(a.trim())}"`)
        .filter((a) => a !== '""')
        .join(', ');
      if (alpnList) lines.push(`    alpn: [${alpnList}]`);
    }

    const netType = node.network || 'ws';
    lines.push(`    network: ${netType}`);
    if (netType === 'ws' || netType === 'httpupgrade') {
      lines.push('    ws-opts:');
      lines.push(`      path: "${escapeYaml(node.path || '/')}"`);
      lines.push('      headers:');
      lines.push(`        Host: "${escapeYaml(node.host || node.sni || '')}"`);
    } else if (netType === 'grpc') {
      lines.push('    grpc-opts:');
      lines.push(`      grpc-service-name: "${escapeYaml(node.serviceName || node.path || '')}"`);
    } else if (netType === 'xhttp' || netType === 'splithttp') {
      lines.push('    xhttp-opts:');
      lines.push(`      path: "${escapeYaml(node.path || '/')}"`);
      if (node.host || node.sni) {
        lines.push(`      host: "${escapeYaml(node.host || node.sni || '')}"`);
      }
      if (node.mode) {
        lines.push(`      mode: "${escapeYaml(node.mode)}"`);
      }
    }

    return lines.join('\n');
  });

  return `proxies:\n${entries.join('\n')}`;
}

/**
 * Render a pure Mihomo/Clash Meta proxy-provider YAML containing only `proxies:`.
 */
export function renderClashProvider(nodes) {
  return [
    '# Generated by cf-local-sub (Mihomo proxy-provider)',
    renderClashProxiesBlock(nodes),
    '',
  ].join('\n');
}

/**
 * Render a standalone Clash / Mihomo profile with url-test and manual select groups.
 */
export function renderClash(nodes) {
  if (!nodes.length) {
    return [
      '# Generated by cf-local-sub',
      'mixed-port: 7890',
      'allow-lan: false',
      'mode: rule',
      'proxies: []',
      'proxy-groups:',
      '  - name: "节点选择"',
      '    type: select',
      '    proxies:',
      '      - DIRECT',
      'rules:',
      '  - MATCH,节点选择',
      '',
    ].join('\n');
  }

  const proxyNames = nodes.map((n) => `      - "${escapeYaml(n.name)}"`).join('\n');
  return [
    '# Generated by cf-local-sub',
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'ipv6: true',
    '',
    renderClashProxiesBlock(nodes),
    '',
    'proxy-groups:',
    '  - name: "自动选择"',
    '    type: url-test',
    `    url: "${DEFAULT_CLASH_TEST_URL}"`,
    '    interval: 300',
    '    tolerance: 50',
    '    proxies:',
    proxyNames,
    '',
    '  - name: "节点选择"',
    '    type: select',
    '    proxies:',
    '      - "自动选择"',
    proxyNames,
    '      - DIRECT',
    '',
    'rules:',
    '  - MATCH,节点选择',
    '',
  ].join('\n');
}

/**
 * Render Surge profile (supports TCP/WS VMess and TLS Trojan).
 */
export function renderSurge(nodes) {
  const supported = nodes.filter(
    (n) => (n.type === 'vmess' || (n.type === 'trojan' && n.tls)) && n.network !== 'grpc' && n.network !== 'xhttp'
  );
  if (!supported.length) {
    return [
      '# cf-local-sub Surge Profile',
      '# 当前输出节点不包含 Surge 传统配置支持的协议（仅支持 TCP/WS VMess 或 TLS Trojan）',
      '[General]',
      'loglevel = notify',
      `internet-test-url = ${DEFAULT_CLASH_TEST_URL}`,
      '[Rule]',
      'FINAL, DIRECT',
      '',
    ].join('\n');
  }

  const usedSurgeNames = new Set();
  const safeNames = [];
  const proxies = supported.map((node) => {
    let safeName = String(node.name || 'node').replace(/[=,\r\n]/g, ' ').replace(/\s+/g, ' ').trim() || 'node';
    if (usedSurgeNames.has(safeName)) {
      let seq = 2;
      while (usedSurgeNames.has(`${safeName} #${seq}`)) seq += 1;
      safeName = `${safeName} #${seq}`;
    }
    usedSurgeNames.add(safeName);
    safeNames.push(safeName);

    if (node.type === 'vmess') {
      const parts = [`${safeName} = vmess`, node.server, String(node.port), `username=${node.uuid}`];
      if (node.network === 'ws' || node.network === 'httpupgrade') {
        parts.push('ws=true');
        parts.push(`ws-path=${node.path || '/'}`);
        if (node.host) parts.push(`ws-headers=Host:${node.host}`);
      }
      parts.push(`tls=${node.tls ? 'true' : 'false'}`);
      if (node.tls && node.sni) parts.push(`sni=${node.sni}`);
      return parts.join(', ');
    }

    const parts = [`${safeName} = trojan`, node.server, String(node.port), `password=${node.password || ''}`];
    if (node.sni) parts.push(`sni=${node.sni}`);
    if (node.network === 'ws' || node.network === 'httpupgrade') {
      parts.push('ws=true');
      parts.push(`ws-path=${node.path || '/'}`);
      if (node.host) parts.push(`ws-headers=Host:${node.host}`);
    }
    return parts.join(', ');
  });

  const names = safeNames.join(', ');
  return [
    '[General]',
    'loglevel = notify',
    'skip-proxy = 127.0.0.1, localhost',
    `internet-test-url = ${DEFAULT_CLASH_TEST_URL}`,
    `proxy-test-url = ${DEFAULT_CLASH_TEST_URL}`,
    'ipv6 = false',
    '',
    '[Proxy]',
    proxies.join('\n'),
    '',
    '[Proxy Group]',
    `🚀 节点选择 = select, ♻️ 自动选择, ${names}`,
    `♻️ 自动选择 = url-test, ${names}, url=${DEFAULT_CLASH_TEST_URL}, interval=600, tolerance=50`,
    '',
    '[Rule]',
    'FINAL, 🚀 节点选择',
    '',
  ].join('\n');
}

/**
 * Resolve target format from explicit query string or client User-Agent.
 */
export function detectTarget(userAgent = '', explicitTarget = '') {
  const target = String(explicitTarget || '').trim().toLowerCase();
  if (target === 'provider') return 'clash-provider';
  if (target && target !== 'auto') return target;
  const ua = String(userAgent || '').toLowerCase();
  if (/clash|mihomo|stash|meta/.test(ua)) return 'clash';
  if (/surge/.test(ua)) return 'surge';
  return 'raw';
}

/**
 * Slice online pool categories in Worker order according to active strategy settings.
 */
export function selectOnlineEndpoints(onlinePool = null, strategy = {}) {
  if (!onlinePool) return [];
  const selected = [];

  if (strategy.enableBuiltinDomains === true && Array.isArray(onlinePool.domainItems)) {
    selected.push(...onlinePool.domainItems);
  }
  if (strategy.enableDynamicIps === true && Array.isArray(onlinePool.dynamicItems)) {
    const maxDyn = clampNumber(strategy.maxDynamic, 40, 1, 200);
    selected.push(...onlinePool.dynamicItems.slice(0, maxDyn));
  }
  if (strategy.enableGithubIps === true && Array.isArray(onlinePool.githubItems)) {
    const maxGh = clampNumber(strategy.maxGithub, 40, 1, 200);
    selected.push(...onlinePool.githubItems.slice(0, maxGh));
  }

  return selected;
}

/**
 * Resolve the effective ordered preferred endpoint list from CFST selection, custom IPs, and optional fallback domains.
 */
export function resolvePreferredEndpoints(cfstEndpoints = [], subConfig = {}, onlineEndpoints = []) {
  const customEndpoints = parsePreferredEndpoints(subConfig.customIps || '', {
    allowIpv6: subConfig.allowIpv6 === true,
    isCustom: true,
  });

  const customServersWithoutPort = new Set(
    customEndpoints.filter((ep) => ep.port === undefined).map((ep) => ep.server)
  );
  const allowIpv6 = subConfig.allowIpv6 === true;
  const filterAuto = (list) =>
    (Array.isArray(list) ? list : []).filter((ep) => {
      if (!ep?.server) return false;
      if (!allowIpv6 && net.isIP(ep.server) === 6) return false;
      return !customServersWithoutPort.has(ep.server);
    });

  const localList = filterAuto(cfstEndpoints);
  const onlineList = filterAuto(onlineEndpoints);
  const priority =
    subConfig.endpointPriority ||
    (subConfig.customFirst === true ? 'custom-local-online' : 'local-custom-online');

  let combined;
  if (priority === 'local-custom-online') {
    combined = [...localList, ...customEndpoints, ...onlineList];
  } else if (priority === 'online-local-custom') {
    combined = [...onlineList, ...localList, ...customEndpoints];
  } else {
    combined = [...customEndpoints, ...localList, ...onlineList];
  }

  if (!combined.length && subConfig.fallbackToBuiltinDomains) {
    combined = parsePreferredEndpoints(BUILTIN_FALLBACK_DOMAINS.join('\n'), {
      allowIpv6: false,
      isCustom: false,
    });
  }

  return deduplicateEndpoints(combined);
}

function appendCompatibilityWarnings(baseNodes, warnings) {
  if (!baseNodes.length) return;
  const hasOnlyVless = baseNodes.every((n) => n.type === 'vless');
  const hasSurgeCompatible = baseNodes.some(
    (n) => (n.type === 'vmess' || (n.type === 'trojan' && n.tls)) && n.network !== 'grpc' && n.network !== 'xhttp'
  );
  if (hasOnlyVless) {
    warnings.push('输入全部为 VLESS 节点：Clash / Mihomo / V2rayN / 小火箭均可正常使用，Surge 传统配置暂不支持 VLESS');
  } else if (!hasSurgeCompatible) {
    warnings.push('当前输入节点均不兼容 Surge 传统配置（Surge 仅支持 TCP/WS VMess 或 TLS Trojan）；Clash / V2rayN / 小火箭仍可正常使用');
  }
}

/**
 * Build assembled nodes and all rendered formats together.
 */
export function assembleSubscriptionBundle(subConfig, cfstEndpoints = [], onlineEndpoints = []) {
  const { nodes: baseNodes, warnings } = parseRawLinks(subConfig.baseLinks || '');
  appendCompatibilityWarnings(baseNodes, warnings);

  const endpoints = resolvePreferredEndpoints(cfstEndpoints, subConfig, onlineEndpoints);
  const assembledNodes = buildNodes(baseNodes, endpoints, {
    namePrefix: subConfig.namePrefix,
    includeMetricsInName: subConfig.includeMetricsInName,
    keepOriginalHost: subConfig.keepOriginalHost,
  });

  const endpointBreakdown = {
    custom: 0,
    cfst: 0,
    dynamic: 0,
    builtin: 0,
    github: 0,
  };
  for (const ep of endpoints) {
    const src = ep.source || 'cfst';
    if (Object.hasOwn(endpointBreakdown, src)) {
      endpointBreakdown[src] += 1;
    }
  }

  return {
    baseNodes,
    endpoints,
    endpointBreakdown,
    assembledNodes,
    warnings,
    rendered: {
      raw: renderRaw(assembledNodes),
      clash: renderClash(assembledNodes),
      'clash-provider': renderClashProvider(assembledNodes),
      surge: renderSurge(assembledNodes),
    },
  };
}
