const state = {
  status: null,
  onlinePool: null,
  onlineFilter: 'all',
  onlineSearch: '',
  adminToken: localStorage.getItem('cf_local_sub_admin_token') || '',
  modalText: '',
};

const SCHEDULE_PRESETS = new Set(['0', '60', '180', '360', '720', '1440']);

const $ = (id) => document.getElementById(id);

function safeB64DecodeUtf8(str) {
  const normalized = String(str || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (normalized.length % 4)) % 4;
  const bin = atob(normalized + '='.repeat(pad));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function safeB64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function apiFetch(url, options = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, options.headers || {});
  if (state.adminToken) {
    headers['x-admin-token'] = state.adminToken;
  }
  const res = await fetch(url, Object.assign({}, options, { headers }));
  if (res.status === 401) {
    $('auth-modal').classList.remove('hidden');
    throw new Error('需要输入管理口令');
  }
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

function formatTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString('zh-CN', { hour12: false });
}

function formatCountdown(iso) {
  if (!iso) return '定时未开启';
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return '即将自动测速';
  const totalSec = Math.floor(diffMs / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `下次测速 ${h}:${m}:${s}`;
}

function formatCacheRemaining(cacheState) {
  if (!cacheState) return '等待拉取';
  if (cacheState.mode === 'empty') return '尚未拉取在线源';
  if (cacheState.mode === 'disk-snapshot') return '本地磁盘快照（待刷新）';
  if (!cacheState.expiresAt) return cacheState.ttlSec === 0 ? '每次实时拉取' : '缓存状态未知';
  const diffSec = Math.floor((new Date(cacheState.expiresAt).getTime() - Date.now()) / 1000);
  if (diffSec <= 0) return '缓存已过期（下次拉取自动刷新）';
  const min = Math.floor(diffSec / 60);
  const sec = diffSec % 60;
  return `内存缓存有效 · 剩余 ${min}分${String(sec).padStart(2, '0')}秒`;
}

function copyText(text, label = '内容') {
  navigator.clipboard.writeText(text).then(
    () => showToast(`已复制${label}`),
    () => showToast('复制失败，请手动复制')
  );
}

function getCustomEndpointSet() {
  const lines = String($('input-custom-ips')?.value || '')
    .split(/[\r\n,;]+/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
  const set = new Set();
  for (const line of lines) {
    const hostPart = line.split('#')[0].trim();
    set.add(hostPart);
    const noPort = hostPart.startsWith('[') ? hostPart : hostPart.split(':')[0];
    if (noPort) set.add(noPort);
  }
  return { lines, set };
}

function updateCustomIpBadge() {
  const { lines } = getCustomEndpointSet();
  $('custom-ip-badge').textContent = `${lines.length} 个地址`;
}

function hasAnyOnlineStrategyEnabled(strategy = null) {
  if (strategy) {
    return Boolean(strategy.enableDynamicIps || strategy.enableBuiltinDomains || strategy.enableGithubIps);
  }
  return (
    $('chk-enable-dynamic').checked ||
    $('chk-enable-builtin').checked ||
    $('chk-enable-github').checked
  );
}

function renderOnlineDisabledState() {
  $('badge-online-cache').textContent = '在线策略已关闭（按需点击刷新）';
  $('badge-online-cache').className = 'pill pill-muted';
  $('kpi-online-health').textContent = '仅本地 CFST';
  $('kpi-online-cache').textContent = '不拉取在线源';
  $('source-health-bar').innerHTML =
    '<span class="pill pill-muted">在线策略默认关闭（本地 CFST 为最高优先级；勾选上方策略或点击“🔄 刷新在线源”即可按需加载）</span>';
  $('cnt-all').textContent = '0';
  $('cnt-dynamic').textContent = '0';
  $('cnt-domain').textContent = '0';
  $('cnt-github').textContent = '0';
  $('online-pool-body').innerHTML =
    '<tr><td colspan="5" class="muted">当前仅启用本地 CFST（最高优先级），在线策略默认关闭；如需浏览或固定在线 IP，请勾选左侧策略或点击“🔄 刷新在线源”。</td></tr>';
}

function syncOnlineUiOnLoad(statusData) {
  if (hasAnyOnlineStrategyEnabled(statusData?.config?.strategy)) {
    return loadOnlineSources(false).catch((err) => {
      $('badge-online-cache').textContent = '在线源暂不可用';
      showToast(err.message);
    });
  }
  renderOnlineDisabledState();
  return Promise.resolve();
}

function inspectBaseLinksLive() {
  const raw = String($('input-base-links').value || '').trim();
  if (!raw) {
    $('base-node-badge').textContent = '0 个基础节点';
    $('base-node-badge').className = 'pill pill-muted';
    $('base-client-warnings').classList.add('hidden');
    return { count: 0 };
  }

  let lines = raw.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && !lines[0].includes('://')) {
    try {
      const decoded = safeB64DecodeUtf8(lines[0]);
      if (decoded.includes('://')) {
        lines = decoded.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
      }
    } catch {
      // Keep raw line count inspection.
    }
  }

  const counts = { vmess: 0, vless: 0, trojan: 0 };
  const warnings = [];
  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith('//')) continue;
    if (line.startsWith('vmess://')) counts.vmess += 1;
    else if (line.startsWith('vless://')) {
      counts.vless += 1;
      if (/security=reality/i.test(line)) {
        warnings.push('检测到 Reality 直连节点：不经过 Cloudflare CDN，套用优选 IP 后将无法握手');
      }
      if (/type=(xhttp|splithttp)/i.test(line)) {
        warnings.push('检测到 XHTTP 节点：Raw (V2rayN/Xray) 原生支持，传统 Clash/Surge 内核可能不兼容');
      }
    } else if (line.startsWith('trojan://')) counts.trojan += 1;
    else {
      const scheme = line.includes('://') ? line.split('://')[0] : '未知格式';
      warnings.push(`存在不支持的链接格式：${scheme}`);
    }
  }

  const validCount = counts.vmess + counts.vless + counts.trojan;
  if (validCount > 0 && counts.vless === validCount) {
    warnings.push('当前全为 VLESS 节点：Clash/Mihomo/V2rayN/小火箭均可使用，Surge 传统配置暂不支持 VLESS');
  }

  const parts = [];
  if (counts.vless) parts.push(`VLESS × ${counts.vless}`);
  if (counts.vmess) parts.push(`VMess × ${counts.vmess}`);
  if (counts.trojan) parts.push(`Trojan × ${counts.trojan}`);
  $('base-node-badge').textContent = validCount ? `${validCount} 个基础节点（${parts.join(' · ')}）` : '未检测到有效节点';
  $('base-node-badge').className = validCount ? 'pill pill-ok' : 'pill pill-warn';

  const warnBox = $('base-client-warnings');
  if (warnings.length) {
    warnBox.innerHTML = `<ul>${Array.from(new Set(warnings)).map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
    warnBox.classList.remove('hidden');
  } else {
    warnBox.classList.add('hidden');
  }

  return { count: validCount };
}

function updateEstimateBar() {
  const { count: baseCount } = inspectBaseLinksLive();
  const { lines: customLines } = getCustomEndpointSet();
  const enableLocal = $('chk-enable-local-cfst').checked;
  const topN = Math.max(1, Number($('input-top-n').value || 12));
  const cfstAvailable = state.status?.cfstPoolRows?.length ?? 0;
  const localCount = enableLocal ? Math.min(cfstAvailable, topN) : 0;

  const maxDyn = Number($('select-max-dynamic').value || 40);
  const maxGh = Number($('select-max-github').value || 40);
  const availDyn = state.onlinePool?.countsByCategory?.totalDynamicAvailable;
  const availGh = state.onlinePool?.countsByCategory?.totalGithubAvailable;

  const dynCount = $('chk-enable-dynamic').checked
    ? (Number.isFinite(availDyn) ? Math.min(availDyn, maxDyn) : maxDyn)
    : 0;
  const builtinCount = $('chk-enable-builtin').checked ? 18 : 0;
  const ghCount = $('chk-enable-github').checked
    ? (Number.isFinite(availGh) ? Math.min(availGh, maxGh) : maxGh)
    : 0;

  let estEndpoints = customLines.length + localCount + dynCount + builtinCount + ghCount;
  const fallbackUsed = estEndpoints === 0 && $('chk-fallback-domain').checked;
  if (fallbackUsed) estEndpoints = 18;

  const estNodes = baseCount * estEndpoints;
  const pieces = [];
  if (customLines.length) pieces.push(`自定义 ${customLines.length}`);
  if (localCount) pieces.push(`本地 CFST ${localCount}`);
  if (dynCount) pieces.push(`在线动态 ${dynCount}${Number.isFinite(availDyn) ? '' : '(预估)'}`);
  if (builtinCount) pieces.push(`内置域名 ${builtinCount}`);
  if (ghCount) pieces.push(`GitHub ${ghCount}${Number.isFinite(availGh) ? '' : '(预估)'}`);
  if (fallbackUsed) pieces.push('兜底内置域名 18');

  const emptyStrategyLabel = enableLocal
    ? '本地 CFST 尚无测速结果（请先测速或导入 CSV）'
    : '未选策略';

  $('estimate-text').textContent = baseCount
    ? `预计输出：${baseCount} 个自建节点 × 约 ${estEndpoints} 个端点（${pieces.join(' + ') || emptyStrategyLabel}）≈ ${estNodes} 个优选节点（最终以去重后为准）`
    : '请先在第 1 部分粘贴自建节点链接，然后点击“⚡ 立即生成订阅”。';
}

function syncFormsFromConfig(data) {
  const { config, ipText } = data;
  const sub = config.subscription;
  const strat = config.strategy || {};
  const cfst = config.cfst;
  const sched = config.schedule;

  $('input-base-links').value = sub.baseLinks || '';
  $('input-custom-ips').value = sub.customIps || '';
  $('input-name-prefix').value = sub.namePrefix || 'CF';
  $('input-top-n').value = sub.topN;
  $('chk-metrics-name').checked = sub.includeMetricsInName !== false;
  $('chk-keep-original-host').checked = sub.keepOriginalHost !== false;
  $('select-endpoint-priority').value = sub.endpointPriority || 'local-custom-online';
  $('chk-fallback-domain').checked = sub.fallbackToBuiltinDomains === true;
  $('chk-allow-ipv6').checked = sub.allowIpv6 === true;

  $('chk-enable-dynamic').checked = strat.enableDynamicIps === true;
  $('select-max-dynamic').value = String(strat.maxDynamic || 40);
  $('chk-enable-builtin').checked = strat.enableBuiltinDomains === true;
  $('chk-enable-github').checked = strat.enableGithubIps === true;
  $('select-max-github').value = String(strat.maxGithub || 40);
  $('chk-enable-local-cfst').checked = strat.enableLocalCfst !== false;
  $('input-cache-ttl').value = strat.sourceCacheTtlSec ?? 300;
  $('input-source-timeout').value = strat.sourceTimeoutMs ?? 4500;
  $('chk-disk-fallback').checked = strat.enableDiskPoolFallback !== false;

  const minStr = String(sched.intervalMinutes);
  $('input-schedule-preset').value = SCHEDULE_PRESETS.has(minStr) ? minStr : 'custom';
  $('input-schedule-minutes').value = sched.intervalMinutes;
  $('chk-schedule-enabled').checked = sched.enabled !== false;
  $('chk-run-startup').checked = sched.runOnStartup === true;

  $('input-cfst-bin').value = cfst.binPath || '';
  $('input-cfst-mode').value = cfst.mode || 'tcping';
  $('input-cfst-colo').value = cfst.cfColo || '';
  $('input-cfst-port').value = cfst.port;
  $('input-cfst-routines').value = cfst.routines;
  $('input-cfst-pingtimes').value = cfst.pingTimes;
  $('input-cfst-dn').value = cfst.downloadCount;
  $('input-cfst-dt').value = cfst.downloadTime;
  $('input-cfst-tl').value = cfst.maxDelayMs;
  $('input-cfst-tlr').value = cfst.maxLossRate;
  $('input-cfst-sl').value = cfst.minSpeedMBps;
  $('input-cfst-url').value = cfst.testUrl;
  $('chk-cfst-dd').checked = cfst.disableDownload === true;
  $('chk-cfst-allip').checked = cfst.testAll === true;

  $('input-ip-txt').value = ipText || '';
  updateCustomIpBadge();
  updateEstimateBar();
}

function collectConfigPayload() {
  const intervalMinutes = Number.parseInt($('input-schedule-minutes').value || '0', 10) || 0;
  return {
    config: {
      subscription: {
        baseLinks: $('input-base-links').value,
        customIps: $('input-custom-ips').value,
        namePrefix: $('input-name-prefix').value,
        topN: Number($('input-top-n').value || 12),
        includeMetricsInName: $('chk-metrics-name').checked,
        keepOriginalHost: $('chk-keep-original-host').checked,
        endpointPriority: $('select-endpoint-priority').value,
        fallbackToBuiltinDomains: $('chk-fallback-domain').checked,
        allowIpv6: $('chk-allow-ipv6').checked,
      },
      strategy: {
        enableLocalCfst: $('chk-enable-local-cfst').checked,
        enableDynamicIps: $('chk-enable-dynamic').checked,
        enableBuiltinDomains: $('chk-enable-builtin').checked,
        enableGithubIps: $('chk-enable-github').checked,
        maxDynamic: Number($('select-max-dynamic').value || 40),
        maxGithub: Number($('select-max-github').value || 40),
        sourceCacheTtlSec: Number($('input-cache-ttl').value || 300),
        sourceTimeoutMs: Number($('input-source-timeout').value || 4500),
        enableDiskPoolFallback: $('chk-disk-fallback').checked,
      },
      cfst: {
        binPath: $('input-cfst-bin').value,
        mode: $('input-cfst-mode').value,
        cfColo: $('input-cfst-colo').value,
        port: Number($('input-cfst-port').value || 443),
        routines: Number($('input-cfst-routines').value || 200),
        pingTimes: Number($('input-cfst-pingtimes').value || 4),
        downloadCount: Number($('input-cfst-dn').value || 12),
        downloadTime: Number($('input-cfst-dt').value || 10),
        maxDelayMs: Number($('input-cfst-tl').value || 350),
        maxLossRate: Number($('input-cfst-tlr').value || 0.2),
        minSpeedMBps: Number($('input-cfst-sl').value || 0),
        testUrl: $('input-cfst-url').value,
        disableDownload: $('chk-cfst-dd').checked,
        testAll: $('chk-cfst-allip').checked,
      },
      schedule: {
        enabled: $('chk-schedule-enabled').checked && intervalMinutes > 0,
        intervalMinutes,
        runOnStartup: $('chk-run-startup').checked,
      },
    },
    ipText: $('input-ip-txt').value,
  };
}

function renderStatus(data, syncForms = false) {
  state.status = data;
  if (syncForms) syncFormsFromConfig(data);

  const { env, state: runState, metrics, urls, outputFiles, warnings, endpointBreakdown, cfstPoolRows, onlinePoolSummary } = data;

  const rtBadge = $('badge-runtime');
  rtBadge.textContent = env.isDocker ? `Docker (${env.arch})` : `${env.platform} 本地`;
  rtBadge.className = 'pill pill-cyan';

  const cfstBadge = $('badge-cfst');
  if (env.binaryFound) {
    cfstBadge.textContent = `CFST ${env.version || '已就绪'}`;
    cfstBadge.className = 'pill pill-ok';
    cfstBadge.title = env.binaryPath;
  } else {
    cfstBadge.textContent = '未检测到 cfst';
    cfstBadge.className = 'pill pill-warn';
  }

  $('btn-import-local').classList.toggle('hidden', !env.sampleCsvFound);
  $('btn-run-now').classList.toggle('hidden', Boolean(runState.running));
  $('btn-stop-now').classList.toggle('hidden', !runState.running);
  $('badge-next-run').textContent = runState.running ? '正在测速中...' : formatCountdown(runState.nextRunAt);

  const banner = $('status-banner');
  const statusClass = runState.running ? 'status-running' : `status-${runState.lastRunStatus || 'idle'}`;
  banner.className = `status-banner ${statusClass}`;
  $('status-text').textContent = runState.lastRunMessage || '就绪';
  $('status-meta').textContent = runState.lastRunAt ? `最近更新: ${formatTime(runState.lastRunAt)}` : '尚未执行测速';

  const bd = endpointBreakdown || { custom: 0, cfst: 0, dynamic: 0, builtin: 0, github: 0 };
  $('kpi-endpoint-count').textContent = String(metrics.effectiveEndpointsCount);
  $('kpi-endpoint-sub').textContent = `本地 ${bd.cfst} · 动态 ${bd.dynamic} · 域名 ${bd.builtin}${bd.github ? ` · GH ${bd.github}` : ''}${bd.custom ? ` · 自选 ${bd.custom}` : ''}`;

  $('kpi-cfst-speed').textContent = metrics.bestSpeedMBps > 0 ? `${metrics.bestSpeedMBps.toFixed(2)} MB/s` : '--';
  const delayLabel = Number.isFinite(metrics.lowestDelayMs) ? `${metrics.lowestDelayMs.toFixed(1)} ms` : '--';
  $('kpi-cfst-delay').textContent = `最低延迟 ${delayLabel} · CSV ${metrics.totalCsvRows} 行`;

  $('kpi-node-count').textContent = String(metrics.outputNodesCount);
  $('kpi-node-sub').textContent = `基础节点 ${metrics.baseNodesCount} 个`;

  const onlineEnabled = hasAnyOnlineStrategyEnabled(data.config?.strategy);
  if (!state.onlinePool) {
    if (!onlineEnabled) {
      renderOnlineDisabledState();
    } else if (onlinePoolSummary) {
      renderOnlineHealthSummary(onlinePoolSummary.sourceStatus, onlinePoolSummary.cacheState);
    }
  }

  const warnBox = $('warnings-box');
  if (warnings && warnings.length) {
    warnBox.innerHTML = `<ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
    warnBox.classList.remove('hidden');
  } else {
    warnBox.classList.add('hidden');
  }

  $('breakdown-bar').innerHTML = [
    `<span class="breakdown-pill">基础节点 <strong>${metrics.baseNodesCount}</strong></span>`,
    `<span class="breakdown-pill">生效端点 <strong>${metrics.effectiveEndpointsCount}</strong></span>`,
    `<span class="breakdown-pill">输出节点 <strong style="color:var(--emerald)">${metrics.outputNodesCount}</strong></span>`,
    `<span class="breakdown-pill">自定义 ${bd.custom}</span>`,
    `<span class="breakdown-pill">本地 CFST ${bd.cfst}</span>`,
    `<span class="breakdown-pill">动态 API ${bd.dynamic}</span>`,
    `<span class="breakdown-pill">内置域名 ${bd.builtin}</span>`,
    `<span class="breakdown-pill">GitHub ${bd.github}</span>`,
  ].join('');

  const linkSpecs = [
    { label: 'Mihomo Proxy-Provider (推荐)', desc: '挂载为外部节点组，不破坏原有分流', url: urls.provider, target: 'clash-provider' },
    { label: 'Clash / Mihomo 完整配置', desc: '自带分流与自动测速组，直接导入', url: urls.clash, target: 'clash' },
    { label: 'V2rayN / Shadowrocket (Raw)', desc: 'Base64 通用订阅（含 XHTTP 原生支持）', url: urls.raw, target: 'raw' },
    { label: '通用自动识别 (Auto)', desc: '按客户端 User-Agent 自动匹配格式', url: urls.auto, target: 'clash' },
    { label: 'Surge 托管配置', desc: '兼容 TCP/WS VMess 与 TLS Trojan', url: urls.surge, target: 'surge' },
  ];
  $('sub-links-list').innerHTML = linkSpecs
    .map(
      (item) => `
      <article class="client-card">
        <div class="client-card-head">
          <div>
            <div class="client-card-title">${escapeHtml(item.label)}</div>
            <div class="client-card-desc">${escapeHtml(item.desc)}</div>
          </div>
          <div class="btn-row">
            <button class="btn btn-primary btn-sm" data-copy-url="${escapeHtml(item.url)}" type="button">复制</button>
            <button class="btn btn-secondary btn-sm" data-preview-target="${escapeHtml(item.target)}" type="button">源码预览</button>
          </div>
        </div>
        <div class="client-url-row">
          <input type="text" readonly value="${escapeHtml(item.url)}" />
        </div>
      </article>`
    )
    .join('');

  $('static-files-list').innerHTML = [
    `<div>Mihomo Provider: ${escapeHtml(outputFiles.provider)}</div>`,
    `<div>Clash 完整配置: ${escapeHtml(outputFiles.clash)}</div>`,
    `<div>Raw Base64: ${escapeHtml(outputFiles.raw)}</div>`,
    `<div>Surge 配置: ${escapeHtml(outputFiles.surge)}</div>`,
  ].join('');

  const nodesBody = $('nodes-preview-body');
  if (!data.previewNodes.length) {
    nodesBody.innerHTML = '<tr><td colspan="7" class="muted">暂无生成节点：请先在第 1 部分粘贴基础节点，再点击上方“⚡ 立即生成订阅”</td></tr>';
  } else {
    const srcLabels = { custom: '自定义', cfst: '本地CFST', dynamic: '在线动态', builtin: '内置域名', github: 'GitHub' };
    nodesBody.innerHTML = data.previewNodes
      .map((n, idx) => {
        const meta = n.endpointMeta || {};
        const srcLabel = srcLabels[meta.source] || meta.source || '--';
        const metricText = meta.speedMBps > 0
          ? `${srcLabel} · ${meta.speedMBps.toFixed(1)} MB/s · ${Math.round(meta.delayMs || 0)}ms`
          : Number.isFinite(meta.delayMs)
            ? `${srcLabel} · ${Math.round(meta.delayMs)}ms`
            : `${srcLabel}${meta.sourceName ? ` (${meta.sourceName})` : ''}${meta.pingText ? ` · ${meta.pingText}` : ''}`;
        return `
          <tr>
            <td class="mono-cell">${idx + 1}</td>
            <td class="node-name-cell" title="${escapeHtml(n.name)}">${escapeHtml(n.name)}</td>
            <td><span class="pill pill-cyan">${escapeHtml(n.type.toUpperCase())} / ${escapeHtml(n.network)}</span></td>
            <td class="mono-cell">${escapeHtml(n.server)}</td>
            <td class="mono-cell">${escapeHtml(n.port)}</td>
            <td class="mono-cell">${escapeHtml(n.host || n.sni || '-')}</td>
            <td class="mono-cell">${escapeHtml(metricText)}</td>
          </tr>`;
      })
      .join('');
  }

  $('cfst-pool-summary').textContent = metrics.totalCsvRows
    ? `已加载 ${metrics.totalCsvRows} 行测速记录，当前选出 Top ${metrics.selectedIpsCount} 个本地优选 IP`
    : '尚未生成本地 result.csv，可点击右侧“⚡ 立即测速”或导入现成 CSV';
  renderCfstPoolTable(cfstPoolRows || []);
  updateEstimateBar();

  const historyBody = $('history-body');
  const history = runState.history || [];
  if (!history.length) {
    historyBody.innerHTML = '<tr><td colspan="5" class="muted">暂无测速运行记录</td></tr>';
  } else {
    historyBody.innerHTML = history
      .map((h) => {
        const ok = h.status === 'success';
        const summary = ok
          ? `选出 ${h.selectedRows} 个 IP，最高 ${h.bestSpeedMBps} MB/s，生成 ${h.outputNodes} 个节点`
          : (h.message || '失败');
        return `
          <tr>
            <td class="mono-cell">${escapeHtml(formatTime(h.at))}</td>
            <td>${escapeHtml(h.trigger)}</td>
            <td class="mono-cell">${escapeHtml(h.durationSec)}s</td>
            <td><span class="pill ${ok ? 'pill-ok' : 'pill-err'}">${ok ? '成功' : '失败'}</span></td>
            <td>${escapeHtml(summary)}</td>
          </tr>`;
      })
      .join('');
  }

  const intervalSec = Math.max(300, (data.config.schedule.intervalMinutes || 360) * 60);
  $('snippet-mihomo').textContent = [
    'proxy-providers:',
    '  cf_local_best:',
    '    type: http',
    `    url: "${urls.provider}"`,
    '    path: ./proxy_providers/cf_local_best.yaml',
    `    interval: ${intervalSec}`,
    '    health-check:',
    '      enable: true',
    '      url: "https://www.gstatic.com/generate_204"',
    '      interval: 300',
    '',
    'proxy-groups:',
    '  - name: "CF-优选自动"',
    '    type: url-test',
    '    use:',
    '      - cf_local_best',
    '    tolerance: 50',
  ].join('\n');
}

function renderCfstPoolTable(rows) {
  const poolBody = $('ip-pool-body');
  if (!rows.length) {
    poolBody.innerHTML = '<tr><td colspan="7" class="muted">暂无本地优选 IP（点击“⚡ 立即测速”或“导入本地 result.csv”）</td></tr>';
    return;
  }
  const { set: customSet } = getCustomEndpointSet();
  poolBody.innerHTML = rows
    .map((ep, idx) => {
      const pinLine = `${ep.server}${ep.colo ? `#${ep.colo}` : '#本地实测'}`;
      const pinned = customSet.has(ep.server);
      return `
      <tr>
        <td class="mono-cell">${idx + 1}</td>
        <td class="mono-cell">${escapeHtml(ep.server)}${ep.port ? `:${ep.port}` : ''}</td>
        <td>${ep.colo ? `<span class="pill pill-ok">${escapeHtml(ep.colo)}</span>` : '<span class="muted">-</span>'}</td>
        <td class="mono-cell">${Number.isFinite(ep.delayMs) ? `${ep.delayMs.toFixed(1)} ms` : '-'}</td>
        <td class="mono-cell">${Number.isFinite(ep.lossRate) ? `${(ep.lossRate * 100).toFixed(0)}%` : '-'}</td>
        <td class="mono-cell">${Number.isFinite(ep.speedMBps) && ep.speedMBps > 0 ? `${ep.speedMBps.toFixed(2)} MB/s` : '-'}</td>
        <td class="col-op"><button class="pin-btn ${pinned ? 'pinned' : ''}" data-pin-line="${escapeHtml(pinLine)}" data-pin-host="${escapeHtml(ep.server)}" type="button" title="固定到自定义 IP 列表">${pinned ? '✓' : '+'}</button></td>
      </tr>`;
    })
    .join('');
}

function renderOnlineHealthSummary(sourceStatus = [], cacheState = null) {
  const okCount = sourceStatus.filter((s) => s.ok).length;
  const totalCount = sourceStatus.length || 8;
  $('kpi-online-health').textContent = sourceStatus.length ? `${okCount}/${totalCount} 路可用` : '--';
  const cacheText = formatCacheRemaining(cacheState);
  $('kpi-online-cache').textContent = cacheText;
  $('badge-online-cache').textContent = cacheText;
  $('badge-online-cache').className = cacheState?.mode === 'memory' || cacheState?.mode === 'live' || cacheState?.mode === 'forced-live'
    ? 'pill pill-ok'
    : 'pill pill-cyan';

  if (!sourceStatus.length) return;
  $('source-health-bar').innerHTML = sourceStatus
    .map((s) => {
      const notFetchedYet = !s.ok && s.error === '尚未拉取';
      const cls = notFetchedYet ? 'pill-muted' : (!s.ok ? 'pill-err' : (s.stale || s.fromCache ? 'pill-warn' : 'pill-ok'));
      const suffix = notFetchedYet ? '未拉取' : (!s.ok ? '失败' : `${s.count}${s.stale ? ' (兜底)' : ''}`);
      const title = s.error ? `${s.name}: ${s.error}` : `${s.name}: ${s.count} 个可用`;
      return `<span class="pill ${cls}" title="${escapeHtml(title)}">${escapeHtml(s.name)} · ${escapeHtml(suffix)}</span>`;
    })
    .join('');
}

function renderOnlinePoolTable() {
  const pool = state.onlinePool;
  const tbody = $('online-pool-body');
  if (!pool) return;

  const items = Array.isArray(pool.items) ? pool.items : [];
  const c = pool.countsByCategory || {};
  $('cnt-all').textContent = String(items.length);
  $('cnt-dynamic').textContent = String(c.dynamic ?? items.filter((i) => i.category === 'dynamic').length);
  $('cnt-domain').textContent = String(c.domain ?? items.filter((i) => i.category === 'domain').length);
  $('cnt-github').textContent = String(c.github ?? items.filter((i) => i.category === 'github').length);

  const q = state.onlineSearch.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (state.onlineFilter !== 'all' && item.category !== state.onlineFilter) return false;
    if (!q) return true;
    const hay = `${item.endpoint || item.server} ${item.sourceName || ''} ${item.remark || ''} ${item.speedText || ''}`.toLowerCase();
    return hay.includes(q);
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">当前筛选条件下无匹配项（可点击“🔄 刷新在线源”）</td></tr>';
    return;
  }

  const { set: customSet } = getCustomEndpointSet();
  const catBadge = {
    dynamic: '<span class="pill pill-cyan">实时动态</span>',
    domain: '<span class="pill pill-emerald">内置域名</span>',
    github: '<span class="pill pill-muted">GitHub</span>',
  };
  tbody.innerHTML = filtered
    .slice(0, 220)
    .map((item) => {
      const hostVal = item.endpoint || item.server;
      const pinned = customSet.has(hostVal) || customSet.has(item.server);
      return `
        <tr>
          <td class="mono-cell">${escapeHtml(hostVal)}</td>
          <td>${catBadge[item.category] || ''} <span class="muted">${escapeHtml(item.sourceName || '')}</span></td>
          <td class="mono-cell">${escapeHtml(item.pingText || '-')}</td>
          <td>${escapeHtml(item.speedText || item.remark || '-')}</td>
          <td class="col-op"><button class="pin-btn ${pinned ? 'pinned' : ''}" data-pin-line="${escapeHtml(item.line || hostVal)}" data-pin-host="${escapeHtml(hostVal)}" type="button" title="固定到自定义 IP 列表">${pinned ? '✓' : '+'}</button></td>
        </tr>`;
    })
    .join('');
}

async function loadOnlineSources(forceRefresh = false) {
  if (forceRefresh) {
    $('badge-online-cache').textContent = '正在并发拉取 7 路在线源...';
  }
  const data = await apiFetch(`/api/online-sources${forceRefresh ? '?refresh=1' : ''}`);
  state.onlinePool = data;
  renderOnlineHealthSummary(data.sourceStatus, data.cacheState);
  renderOnlinePoolTable();
  updateEstimateBar();
  if (
    forceRefresh ||
    (state.status && data.metrics && data.metrics.outputNodesCount !== state.status.metrics.outputNodesCount)
  ) {
    await refreshStatus(false).catch(() => {});
  }
  if (forceRefresh) {
    showToast('已刷新在线数据源池');
  }
}

function pinEndpointToCustom(pinLine, pinHost) {
  const textarea = $('input-custom-ips');
  const { set } = getCustomEndpointSet();
  if (set.has(pinHost)) {
    showToast(`${pinHost} 已在自定义固定 IP 列表中`);
    return;
  }
  const current = textarea.value.trim();
  textarea.value = current ? `${current}\n${pinLine}` : pinLine;
  updateCustomIpBadge();
  renderOnlinePoolTable();
  if (state.status?.cfstPoolRows) {
    renderCfstPoolTable(state.status.cfstPoolRows);
  }
  updateEstimateBar();
  showToast(`已固定 ${pinHost} 到第 5 部分自定义列表，点击“立即生成订阅”即可生效`);
}

function appendConsoleLog(entry) {
  const box = $('console-logs');
  const div = document.createElement('div');
  div.className = `log-line log-${entry.level || 'info'}`;
  const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  div.innerHTML = `<span class="log-ts">[${escapeHtml(ts)}]</span><span>${escapeHtml(entry.text)}</span>`;
  box.appendChild(div);
  while (box.children.length > 260) {
    box.removeChild(box.firstChild);
  }
  box.scrollTop = box.scrollHeight;
}

async function refreshStatus(syncForms = false) {
  const data = await apiFetch('/api/status');
  renderStatus(data, syncForms);
  return data;
}

async function saveConfigAndRefresh() {
  const payload = collectConfigPayload();
  const data = await apiFetch('/api/config', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  renderStatus(data, true);
  showToast('配置已保存并重新组装订阅');
}

async function generateSubscriptions(forceRefresh = false) {
  const btn = forceRefresh ? $('btn-generate-force') : $('btn-generate-sub');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = forceRefresh ? '正在刷新并生成...' : '正在生成订阅...';
  try {
    const payload = {
      ...collectConfigPayload(),
      forceRefresh,
    };
    const data = await apiFetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    renderStatus(data, true);
    const onlineEnabled = hasAnyOnlineStrategyEnabled(data.config?.strategy);
    if (forceRefresh || onlineEnabled) {
      if (data.onlinePoolSummary && state.onlinePool) {
        renderOnlineHealthSummary(data.onlinePoolSummary.sourceStatus, data.onlinePoolSummary.cacheState);
      }
      const needServerForce =
        forceRefresh && !data.config?.strategy?.enableDynamicIps && !data.config?.strategy?.enableGithubIps;
      if (
        forceRefresh ||
        !state.onlinePool ||
        data.onlinePoolSummary?.updatedAt !== state.onlinePool?.updatedAt
      ) {
        await loadOnlineSources(needServerForce).catch(() => {});
      }
    } else if (!state.onlinePool) {
      renderOnlineDisabledState();
    }
    showToast(`订阅已生成：${data.metrics.outputNodesCount} 个优选节点（${data.metrics.effectiveEndpointsCount} 个去重端点）`);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

function connectLogStream() {
  const tokenQuery = state.adminToken ? `?admin_token=${encodeURIComponent(state.adminToken)}` : '';
  const es = new EventSource(`/api/logs${tokenQuery}`);
  es.addEventListener('init', (ev) => {
    const data = JSON.parse(ev.data);
    $('console-logs').innerHTML = '';
    for (const entry of data.logs || []) appendConsoleLog(entry);
  });
  es.addEventListener('log', (ev) => {
    appendConsoleLog(JSON.parse(ev.data));
  });
  es.addEventListener('status', () => {
    refreshStatus(false).catch(() => {});
  });
  es.addEventListener('complete', () => {
    refreshStatus(false).catch(() => {});
  });
}

function bindEvents() {
  document.querySelectorAll('.step-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.step-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
    });
  });

  document.querySelectorAll('.mini-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mini-tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.side-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`side-panel-${btn.dataset.sideTab}`).classList.add('active');
    });
  });

  $('btn-fill-demo').addEventListener('click', () => {
    $('input-base-links').value = [
      'vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&security=tls&type=ws&host=example.com&sni=example.com&path=%2Fws#CF-VLESS-Demo',
      `vmess://${safeB64EncodeUtf8(JSON.stringify({ v: '2', ps: 'CF-VMess-Demo', add: 'example.com', port: '443', id: '00000000-0000-0000-0000-000000000000', aid: '0', net: 'ws', type: 'none', host: 'example.com', path: '/ws', tls: 'tls', sni: 'example.com' }))}`,
    ].join('\n');
    updateEstimateBar();
    showToast('已填入演示节点，点击第 4 部分“⚡ 立即生成订阅”即可查看效果');
  });

  $('btn-clear-links').addEventListener('click', () => {
    $('input-base-links').value = '';
    updateEstimateBar();
  });

  $('btn-clear-custom-ips').addEventListener('click', () => {
    $('input-custom-ips').value = '';
    updateCustomIpBadge();
    renderOnlinePoolTable();
    if (state.status?.cfstPoolRows) renderCfstPoolTable(state.status.cfstPoolRows);
    updateEstimateBar();
  });

  $('input-base-links').addEventListener('input', updateEstimateBar);
  $('input-custom-ips').addEventListener('input', () => {
    updateCustomIpBadge();
    renderOnlinePoolTable();
    if (state.status?.cfstPoolRows) renderCfstPoolTable(state.status.cfstPoolRows);
    updateEstimateBar();
  });

  [
    'select-max-dynamic',
    'select-max-github',
    'chk-enable-local-cfst',
    'input-top-n',
    'chk-fallback-domain',
  ].forEach((id) => {
    $(id).addEventListener('change', updateEstimateBar);
  });

  ['chk-enable-dynamic', 'chk-enable-builtin', 'chk-enable-github'].forEach((id) => {
    $(id).addEventListener('change', (ev) => {
      updateEstimateBar();
      if (ev.target.checked && !state.onlinePool) {
        loadOnlineSources(false).catch((e) => showToast(e.message));
      } else if (!hasAnyOnlineStrategyEnabled() && !state.onlinePool) {
        renderOnlineDisabledState();
      }
    });
  });

  $('btn-refresh-online').addEventListener('click', () => {
    loadOnlineSources(true).catch((e) => showToast(e.message));
  });

  $('online-filter-tabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-filter]');
    if (!btn) return;
    document.querySelectorAll('#online-filter-tabs .filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.onlineFilter = btn.dataset.filter;
    renderOnlinePoolTable();
  });

  $('input-online-search').addEventListener('input', (ev) => {
    state.onlineSearch = ev.target.value || '';
    renderOnlinePoolTable();
  });

  $('online-pool-body').addEventListener('click', (ev) => {
    const pin = ev.target.closest('[data-pin-line]');
    if (pin) pinEndpointToCustom(pin.dataset.pinLine, pin.dataset.pinHost);
  });

  $('ip-pool-body').addEventListener('click', (ev) => {
    const pin = ev.target.closest('[data-pin-line]');
    if (pin) pinEndpointToCustom(pin.dataset.pinLine, pin.dataset.pinHost);
  });

  $('btn-generate-sub').addEventListener('click', () => generateSubscriptions(false).catch((e) => showToast(e.message)));
  $('btn-generate-force').addEventListener('click', () => generateSubscriptions(true).catch((e) => showToast(e.message)));
  $('btn-save-all').addEventListener('click', () => saveConfigAndRefresh().catch((e) => showToast(e.message)));
  $('btn-save-settings-bottom').addEventListener('click', () => saveConfigAndRefresh().catch((e) => showToast(e.message)));

  $('btn-reset-ip-txt').addEventListener('click', async () => {
    $('input-ip-txt').value = '';
    await saveConfigAndRefresh();
    showToast('已恢复默认 Cloudflare IPv4 网段');
  });

  $('input-schedule-preset').addEventListener('change', (ev) => {
    const val = ev.target.value;
    if (val !== 'custom') {
      $('input-schedule-minutes').value = val;
      $('chk-schedule-enabled').checked = val !== '0';
    }
  });

  $('btn-run-now').addEventListener('click', async () => {
    try {
      await saveConfigAndRefresh();
      await apiFetch('/api/run', { method: 'POST', body: '{}' });
      showToast('已启动本地 CFST 测速');
      await refreshStatus(false);
      document.querySelector('[data-side-tab="logs"]').click();
    } catch (err) {
      showToast(err.message);
    }
  });

  $('btn-stop-now').addEventListener('click', async () => {
    try {
      await apiFetch('/api/stop', { method: 'POST', body: '{}' });
      showToast('已发送停止测速信号');
    } catch (err) {
      showToast(err.message);
    }
  });

  $('btn-import-local').addEventListener('click', async () => {
    try {
      const data = await apiFetch('/api/import-csv', {
        method: 'POST',
        body: JSON.stringify({ useDetectedLocal: true }),
      });
      renderStatus(data, false);
      showToast('已导入本地 result.csv 并生成优选节点');
    } catch (err) {
      showToast(err.message);
    }
  });

  $('file-csv-upload').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const csvText = await file.text();
      const data = await apiFetch('/api/import-csv', {
        method: 'POST',
        body: JSON.stringify({ csvText }),
      });
      renderStatus(data, false);
      showToast(`已导入 ${file.name}`);
    } catch (err) {
      showToast(err.message);
    } finally {
      ev.target.value = '';
    }
  });

  $('sub-links-list').addEventListener('click', async (ev) => {
    const copyBtn = ev.target.closest('[data-copy-url]');
    if (copyBtn) {
      copyText(copyBtn.dataset.copyUrl, '订阅链接');
      return;
    }
    const previewBtn = ev.target.closest('[data-preview-target]');
    if (previewBtn) {
      try {
        const target = previewBtn.dataset.previewTarget;
        const data = await apiFetch(`/api/preview?target=${encodeURIComponent(target)}`);
        state.modalText = data.content || '(当前无输出内容，请先输入基础节点并导入或运行测速)';
        $('modal-title').textContent = `订阅源码预览 · ${target} (${data.lineCount} 行)`;
        $('modal-content').textContent = state.modalText;
        $('preview-modal').classList.remove('hidden');
      } catch (err) {
        showToast(err.message);
      }
    }
  });

  $('btn-modal-close').addEventListener('click', () => $('preview-modal').classList.add('hidden'));
  $('preview-modal').addEventListener('click', (ev) => {
    if (ev.target === $('preview-modal')) $('preview-modal').classList.add('hidden');
  });
  $('btn-modal-copy').addEventListener('click', () => copyText(state.modalText, '订阅内容'));
  $('btn-clear-logs').addEventListener('click', () => { $('console-logs').innerHTML = ''; });
  $('btn-copy-mihomo').addEventListener('click', () => copyText($('snippet-mihomo').textContent, 'Mihomo 配置片段'));

  $('btn-auth-submit').addEventListener('click', async () => {
    state.adminToken = $('input-admin-token').value.trim();
    localStorage.setItem('cf_local_sub_admin_token', state.adminToken);
    $('auth-modal').classList.add('hidden');
    const statusData = await refreshStatus(true);
    await syncOnlineUiOnLoad(statusData);
    connectLogStream();
  });

  const sections = ['part-1', 'part-2', 'part-3', 'part-4', 'part-5']
    .map((id) => $(id))
    .filter(Boolean);
  window.addEventListener('scroll', () => {
    const y = window.scrollY + 130;
    let activeId = sections[0]?.id;
    for (const sec of sections) {
      if (sec.offsetTop <= y) activeId = sec.id;
    }
    if (activeId) {
      document.querySelectorAll('.step-pill').forEach((p) => {
        p.classList.toggle('active', p.dataset.section === activeId);
      });
    }
  }, { passive: true });

  setInterval(() => {
    if (state.status?.state && !state.status.state.running) {
      $('badge-next-run').textContent = formatCountdown(state.status.state.nextRunAt);
    }
    if (state.onlinePool?.cacheState) {
      const cacheText = formatCacheRemaining(state.onlinePool.cacheState);
      $('kpi-online-cache').textContent = cacheText;
      $('badge-online-cache').textContent = cacheText;
    }
  }, 1000);
}

bindEvents();
refreshStatus(true)
  .then((statusData) => {
    connectLogStream();
    return syncOnlineUiOnLoad(statusData);
  })
  .catch((err) => showToast(err.message));
