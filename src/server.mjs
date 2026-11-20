/**
 * HTTP server exposing the local dashboard UI, CFST controls, SSE logs, and /sub endpoints.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampNumber } from './defaults.mjs';
import { CfstRunner } from './cfst-runner.mjs';
import { RunScheduler } from './scheduler.mjs';
import { AppStore } from './store.mjs';
import { detectTarget, selectOnlineEndpoints } from './sub-engine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('请求体过大');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function isAdminAuthorized(req, url, adminToken) {
  if (!adminToken) return true;
  const headerToken = req.headers['x-admin-token'];
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const queryToken = url.searchParams.get('admin_token') || '';
  return headerToken === adminToken || bearer === adminToken || queryToken === adminToken;
}

function buildSubscriptionUrls(req, subAccessToken) {
  const hostHeader = req.headers.host || `127.0.0.1:${process.env.PORT || 8787}`;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const base = `${proto}://${hostHeader}/sub/default`;
  const ampToken = subAccessToken ? `&token=${encodeURIComponent(subAccessToken)}` : '';
  const qToken = subAccessToken ? `?token=${encodeURIComponent(subAccessToken)}` : '';
  return {
    auto: `${base}${qToken}`,
    clash: `${base}?target=clash${ampToken}`,
    provider: `${base}?target=clash-provider${ampToken}`,
    raw: `${base}?target=raw${ampToken}`,
    surge: `${base}?target=surge${ampToken}`,
  };
}

function extractConfigPatch(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.config && typeof body.config === 'object') return body.config;
  if (body.subscription || body.strategy || body.cfst || body.schedule) return body;
  return null;
}

function mergeAndSaveConfig(store, incoming) {
  const current = store.getConfig();
  const subIncoming = incoming.subscription && typeof incoming.subscription === 'object' ? incoming.subscription : null;
  const mergedSub = subIncoming ? { ...current.subscription, ...subIncoming } : { ...current.subscription };
  if (subIncoming && subIncoming.customFirst !== undefined && subIncoming.endpointPriority === undefined) {
    delete mergedSub.endpointPriority;
  }
  return store.saveConfig({
    subscription: mergedSub,
    strategy: incoming.strategy && typeof incoming.strategy === 'object' ? { ...current.strategy, ...incoming.strategy } : current.strategy,
    cfst: incoming.cfst && typeof incoming.cfst === 'object' ? { ...current.cfst, ...incoming.cfst } : current.cfst,
    schedule: incoming.schedule && typeof incoming.schedule === 'object' ? { ...current.schedule, ...incoming.schedule } : current.schedule,
  });
}

function createStatusPayload(req, store, runner, env, prebuilt = null) {
  const built = prebuilt || store.buildAndPersistSubscriptions();
  const envInfo = runner.getEnvironmentInfo(built.config.cfst.binPath);
  const state = store.getState();
  const subAccessToken = String(env.SUB_ACCESS_TOKEN || '').trim();
  const envSummary = Object.assign({}, envInfo, {
    adminAuthEnabled: Boolean(String(env.ADMIN_TOKEN || '').trim()),
    subTokenEnabled: Boolean(subAccessToken),
    dataDir: store.dataDir,
  });
  const stateSummary = Object.assign({}, state, {
    running: runner.running,
    currentStartedAt: runner.currentStartedAt,
  });

  const pool = built.onlinePool;
  const onlineEndpoints = selectOnlineEndpoints(pool, built.config.strategy);
  const onlinePoolSummary = pool
    ? {
        updatedAt: pool.updatedAt || null,
        cacheState: pool.cacheState || null,
        sourceStatus: Array.isArray(pool.sourceStatus) ? pool.sourceStatus : [],
        countsByCategory: {
          dynamic: pool.dynamicItems?.length || 0,
          domain: pool.domainItems?.length || 0,
          github: pool.githubItems?.length || 0,
          selectedTotal: onlineEndpoints.length,
        },
      }
    : null;

  return {
    ok: true,
    env: envSummary,
    config: built.config,
    ipText: store.getIpText(),
    state: stateSummary,
    metrics: {
      totalCsvRows: built.csv.stats.totalRows,
      selectedIpsCount: built.csv.stats.selectedRows,
      effectiveEndpointsCount: built.bundle.endpoints.length,
      bestSpeedMBps: built.csv.stats.bestSpeedMBps,
      lowestDelayMs: Number.isFinite(built.csv.stats.lowestDelayMs) ? built.csv.stats.lowestDelayMs : null,
      baseNodesCount: built.bundle.baseNodes.length,
      outputNodesCount: built.bundle.assembledNodes.length,
    },
    endpointBreakdown: built.bundle.endpointBreakdown,
    cfstPoolRows: built.csv.selected,
    onlinePoolSummary,
    selectedEndpoints: built.bundle.endpoints,
    previewNodes: built.bundle.assembledNodes.slice(0, 120).map((node) => ({
      name: node.name,
      type: node.type,
      network: node.network,
      server: node.server,
      port: node.port,
      host: node.host || '',
      sni: node.sni || '',
      endpointMeta: node.endpointMeta || {},
    })),
    warnings: built.bundle.warnings,
    urls: buildSubscriptionUrls(req, subAccessToken),
    outputFiles: built.outputFiles,
  };
}

/**
 * Create HTTP server, store, runner, and scheduler instances without side effects on import.
 */
export function createAppServer(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT_DIR;
  const env = options.env || process.env;
  const dataDir = options.dataDir || env.DATA_DIR || path.join(rootDir, 'data');
  const publicDir = path.join(rootDir, 'public');

  const store = new AppStore(dataDir, env, { fetchImpl: options.fetchImpl });
  const runner = new CfstRunner(rootDir, store);
  const scheduler = new RunScheduler(store, runner);

  const initialBuilt = store.buildAndPersistSubscriptions();
  runner.getEnvironmentInfo(initialBuilt.config.cfst.binPath);

  const sseClients = new Set();
  const broadcastSse = (eventName, data) => {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      client.write(payload);
    }
  };

  runner.on('log', (entry) => broadcastSse('log', entry));
  runner.on('status', (status) => broadcastSse('status', status));
  runner.on('complete', (summary) => broadcastSse('complete', summary));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const adminToken = String(env.ADMIN_TOKEN || '').trim();
      const subAccessToken = String(env.SUB_ACCESS_TOKEN || '').trim();

      if (req.method === 'GET' && url.pathname === '/health') {
        const cfg = store.getConfig();
        const envInfo = runner.getEnvironmentInfo(cfg.cfst.binPath);
        return sendJson(res, 200, {
          ok: true,
          running: runner.running,
          binaryFound: envInfo.binaryFound,
          uptimeSec: Math.round(process.uptime()),
        });
      }

      if (url.pathname === '/sub' || url.pathname.startsWith('/sub/')) {
        if (subAccessToken && url.searchParams.get('token') !== subAccessToken) {
          return sendText(res, 403, 'Forbidden: invalid token');
        }
        const forceRefresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
        const built = await store.buildWithFreshOnlinePool({ forceRefresh });
        const target = detectTarget(req.headers['user-agent'], url.searchParams.get('target'));
        const intervalHours = Math.max(1, Math.round((built.config.schedule.intervalMinutes || 360) / 60));
        const subHeaders = {
          'subscription-userinfo': 'upload=0; download=0; total=107374182400; expire=2000000000',
          'profile-update-interval': String(intervalHours),
        };

        if (target === 'clash') {
          return sendText(res, 200, built.bundle.rendered.clash, 'text/yaml; charset=utf-8', subHeaders);
        }
        if (target === 'clash-provider') {
          return sendText(res, 200, built.bundle.rendered['clash-provider'], 'text/yaml; charset=utf-8', subHeaders);
        }
        if (target === 'surge') {
          return sendText(res, 200, built.bundle.rendered.surge, 'text/plain; charset=utf-8', subHeaders);
        }
        return sendText(res, 200, built.bundle.rendered.raw, 'text/plain; charset=utf-8', subHeaders);
      }

      if (url.pathname.startsWith('/api/')) {
        if (!isAdminAuthorized(req, url, adminToken)) {
          return sendJson(res, 401, { ok: false, error: '需要管理员口令 (ADMIN_TOKEN)' });
        }

        if (req.method === 'GET' && url.pathname === '/api/status') {
          return sendJson(res, 200, createStatusPayload(req, store, runner, env));
        }

        if (req.method === 'GET' && url.pathname === '/api/config') {
          return sendJson(res, 200, {
            ok: true,
            config: store.getConfig(),
            ipText: store.getIpText(),
          });
        }

        if (req.method === 'POST' && url.pathname === '/api/config') {
          const body = await readJsonBody(req);
          const incoming = extractConfigPatch(body);
          if (incoming) mergeAndSaveConfig(store, incoming);
          if (typeof body.ipText === 'string') store.saveIpText(body.ipText);
          scheduler.reschedule();
          return sendJson(res, 200, createStatusPayload(req, store, runner, env));
        }

        if (req.method === 'POST' && url.pathname === '/api/generate') {
          const body = await readJsonBody(req);
          const incoming = extractConfigPatch(body);
          let changed = false;
          if (incoming) {
            mergeAndSaveConfig(store, incoming);
            changed = true;
          }
          if (typeof body.ipText === 'string') {
            store.saveIpText(body.ipText);
            changed = true;
          }
          if (changed) {
            scheduler.reschedule();
          }
          const forceRefresh =
            body.forceRefresh === true ||
            url.searchParams.get('refresh') === '1' ||
            url.searchParams.get('refresh') === 'true';
          const built = await store.buildWithFreshOnlinePool({ forceRefresh });
          return sendJson(res, 200, createStatusPayload(req, store, runner, env, built));
        }

        if (req.method === 'GET' && (url.pathname === '/api/online-sources' || url.pathname === '/api/preferred-details')) {
          const cfg = store.getConfig();
          const forceRefresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
          const maxDynamic = clampNumber(url.searchParams.get('maxDynamic'), 200, 1, 200);
          const maxGithub = clampNumber(url.searchParams.get('maxGithub'), 200, 1, 200);
          const pool = await store.onlineSources.getPool({
            forceRefresh,
            sourceCacheTtlSec: cfg.strategy.sourceCacheTtlSec,
            sourceTimeoutMs: cfg.strategy.sourceTimeoutMs,
            enableDiskPoolFallback: cfg.strategy.enableDiskPoolFallback,
          });
          const built = store.buildAndPersistSubscriptions(pool);
          const dyn = pool.dynamicItems.slice(0, maxDynamic);
          const dom = pool.domainItems;
          const gh = pool.githubItems.slice(0, maxGithub);
          return sendJson(res, 200, {
            ok: true,
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
            endpointBreakdown: built.bundle.endpointBreakdown,
            metrics: {
              effectiveEndpointsCount: built.bundle.endpoints.length,
              outputNodesCount: built.bundle.assembledNodes.length,
            },
          });
        }

        if (req.method === 'POST' && url.pathname === '/api/run') {
          if (runner.running) {
            return sendJson(res, 409, { ok: false, error: '测速任务已在运行中' });
          }
          const currentCfg = store.getConfig();
          const envInfo = runner.getEnvironmentInfo(currentCfg.cfst.binPath);
          if (!envInfo.binaryFound) {
            return sendJson(res, 400, { ok: false, error: '未检测到 cfst 可执行文件，请先设置路径或使用导入 CSV 测试' });
          }
          runner.runOnce('manual').catch(() => {});
          return sendJson(res, 202, { ok: true, message: '测速任务已启动' });
        }

        if (req.method === 'POST' && url.pathname === '/api/stop') {
          const stopped = runner.stop();
          return sendJson(res, 200, { ok: true, stopped });
        }

        if (req.method === 'POST' && url.pathname === '/api/import-csv') {
          const body = await readJsonBody(req, 4 * 1024 * 1024);
          let csvText = '';
          let label = '手动导入 CSV';

          if (body.useDetectedLocal) {
            const cfg = store.getConfig();
            const envInfo = runner.getEnvironmentInfo(cfg.cfst.binPath);
            if (!envInfo.sampleCsvFound) {
              return sendJson(res, 404, { ok: false, error: '未在本机检测到现成 result.csv 文件' });
            }
            csvText = fs.readFileSync(envInfo.sampleCsvPath, 'utf8');
            label = `导入本地文件 (${path.basename(envInfo.sampleCsvPath)})`;
          } else {
            csvText = String(body.csvText || '');
          }

          if (!csvText.trim()) {
            return sendJson(res, 400, { ok: false, error: 'CSV 内容为空' });
          }

          store.saveCsvResult(csvText, label);
          const built = store.buildAndPersistSubscriptions();
          if (!built.csv.stats.totalRows) {
            return sendJson(res, 400, { ok: false, error: '未从 CSV 中解析出有效的 IP 测速行' });
          }

          const now = new Date().toISOString();
          store.updateState({
            lastRunAt: now,
            lastRunStatus: 'success',
            lastRunMessage: `${label}：选出 ${built.csv.stats.selectedRows} 个优选 IP，生成 ${built.bundle.assembledNodes.length} 个节点`,
          });
          runner.appendLog(`${label}：解析 ${built.csv.stats.totalRows} 行，选出 Top ${built.csv.stats.selectedRows} IP`, 'success');
          return sendJson(res, 200, createStatusPayload(req, store, runner, env));
        }

        if (req.method === 'GET' && url.pathname === '/api/preview') {
          const forceRefresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
          const built = await store.buildWithFreshOnlinePool({ forceRefresh });
          const target = detectTarget('', url.searchParams.get('target') || 'clash');
          const content = built.bundle.rendered[target] ?? built.bundle.rendered.clash;
          return sendJson(res, 200, {
            ok: true,
            target,
            content,
            lineCount: content ? content.split(/\r?\n/).length : 0,
          });
        }

        if (req.method === 'GET' && url.pathname === '/api/logs') {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
          });
          res.write(`event: init\ndata: ${JSON.stringify({
            running: runner.running,
            startedAt: runner.currentStartedAt,
            logs: runner.logBuffer,
          })}\n\n`);
          sseClients.add(res);

          const heartbeat = setInterval(() => {
            res.write(': keepalive\n\n');
          }, 20000);
          heartbeat.unref?.();

          req.on('close', () => {
            clearInterval(heartbeat);
            sseClients.delete(res);
          });
          return;
        }

        return sendJson(res, 404, { ok: false, error: '未知接口' });
      }

      if (req.method === 'GET') {
        const reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
        const normalizedRel = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '');
        const targetPath = path.resolve(publicDir, normalizedRel);

        if (
          (targetPath === publicDir || targetPath.startsWith(publicDir + path.sep)) &&
          fs.existsSync(targetPath) &&
          fs.statSync(targetPath).isFile()
        ) {
          const ext = path.extname(targetPath).toLowerCase();
          const mime = MIME_TYPES[ext] || 'application/octet-stream';
          res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
          fs.createReadStream(targetPath).pipe(res);
          return;
        }
      }

      return sendText(res, 404, 'Not Found');
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err?.message || '服务器内部错误' });
    }
  });

  return { server, store, runner, scheduler };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  const port = Number.parseInt(process.env.PORT || '8787', 10) || 8787;
  const host = process.env.HOST || '0.0.0.0';
  const { server, scheduler, runner, store } = createAppServer();

  server.listen(port, host, () => {
    scheduler.start();
    const localHint = host === '0.0.0.0' ? `http://127.0.0.1:${port}` : `http://${host}:${port}`;
    console.log(`[cf-local-sub] 控制台已启动: ${localHint}`);
    console.log(`[cf-local-sub] 数据目录: ${store.dataDir}`);
    const envInfo = runner.getEnvironmentInfo(store.getConfig().cfst.binPath);
    console.log(`[cf-local-sub] CFST 检测: ${envInfo.binaryFound ? envInfo.binaryPath : '未检测到（可在 UI 中指定或用于预览）'}`);
  });

  const shutdown = () => {
    scheduler.stop();
    runner.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
