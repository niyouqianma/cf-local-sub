/**
 * Persistent storage for configuration, CIDR list, CSV results, run history, and generated subscriptions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_IPV4_CIDRS, normalizeConfig } from './defaults.mjs';
import { parseCfstCsv } from './csv-parser.mjs';
import { OnlineSourceManager } from './online-sources.mjs';
import { assembleSubscriptionBundle, selectOnlineEndpoints } from './sub-engine.mjs';

/**
 * Manage persisted data files inside DATA_DIR.
 */
export class AppStore {
  constructor(dataDir, env = process.env, options = {}) {
    this.dataDir = path.resolve(dataDir);
    this.env = env;
    this.runsDir = path.join(this.dataDir, 'runs');
    this.outputDir = path.join(this.dataDir, 'output');
    this.configPath = path.join(this.dataDir, 'config.json');
    this.statePath = path.join(this.dataDir, 'state.json');
    this.ipTxtPath = path.join(this.dataDir, 'ip.txt');
    this.latestCsvPath = path.join(this.dataDir, 'latest_result.csv');
    this.onlineSources = new OnlineSourceManager(this.dataDir, {
      fetchImpl: options.fetchImpl,
    });

    this.ensureInitialized();
  }

  /**
   * Initialize required folders and default seed files if absent.
   */
  ensureInitialized() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.runsDir, { recursive: true });
    fs.mkdirSync(this.outputDir, { recursive: true });

    if (!fs.existsSync(this.ipTxtPath)) {
      fs.writeFileSync(this.ipTxtPath, `${DEFAULT_IPV4_CIDRS.join('\n')}\n`, 'utf8');
    }
    if (!fs.existsSync(this.configPath)) {
      const initial = normalizeConfig({}, this.env);
      fs.writeFileSync(this.configPath, JSON.stringify(initial, null, 2), 'utf8');
    }
    if (!fs.existsSync(this.statePath)) {
      const emptyState = {
        lastRunAt: null,
        lastRunStatus: 'idle',
        lastRunMessage: '尚未执行本地测速',
        lastCsvSource: null,
        nextRunAt: null,
        history: [],
      };
      fs.writeFileSync(this.statePath, JSON.stringify(emptyState, null, 2), 'utf8');
    }
  }

  getConfig() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return normalizeConfig(parsed, this.env);
    } catch {
      return normalizeConfig({}, this.env);
    }
  }

  saveConfig(nextRaw) {
    const normalized = normalizeConfig(nextRaw, this.env);
    fs.writeFileSync(this.configPath, JSON.stringify(normalized, null, 2), 'utf8');
    return normalized;
  }

  getIpText() {
    try {
      return fs.readFileSync(this.ipTxtPath, 'utf8');
    } catch {
      return `${DEFAULT_IPV4_CIDRS.join('\n')}\n`;
    }
  }

  saveIpText(text) {
    const cleaned = String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
    const finalContent = cleaned ? `${cleaned}\n` : `${DEFAULT_IPV4_CIDRS.join('\n')}\n`;
    fs.writeFileSync(this.ipTxtPath, finalContent, 'utf8');
    return finalContent;
  }

  getState() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return {
        lastRunAt: null,
        lastRunStatus: 'idle',
        lastRunMessage: '尚未执行本地测速',
        lastCsvSource: null,
        nextRunAt: null,
        history: [],
      };
    }
  }

  updateState(patch) {
    const current = this.getState();
    const next = { ...current, ...patch };
    fs.writeFileSync(this.statePath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  appendHistory(entry) {
    const current = this.getState();
    const history = [entry, ...(Array.isArray(current.history) ? current.history : [])].slice(0, 30);
    return this.updateState({ history });
  }

  getLatestCsvText() {
    if (!fs.existsSync(this.latestCsvPath)) return '';
    return fs.readFileSync(this.latestCsvPath, 'utf8');
  }

  saveCsvResult(csvText, sourceLabel = 'cfst') {
    fs.writeFileSync(this.latestCsvPath, csvText, 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(this.runsDir, `result-${stamp}.csv`);
    fs.writeFileSync(archivePath, csvText, 'utf8');
    this.pruneOldRuns(20);
    return this.updateState({ lastCsvSource: sourceLabel });
  }

  pruneOldRuns(keepCount = 20) {
    const files = fs
      .readdirSync(this.runsDir)
      .filter((f) => f.endsWith('.csv'))
      .sort()
      .reverse();
    for (const oldFile of files.slice(keepCount)) {
      try {
        fs.unlinkSync(path.join(this.runsDir, oldFile));
      } catch {
        // Ignore transient lock errors during cleanup.
      }
    }
  }

  /**
   * Parse current CSV with active filtering rules, assemble nodes, and persist static subscription files.
   */
  buildAndPersistSubscriptions(onlinePoolOverride = null) {
    const config = this.getConfig();
    const csvText = this.getLatestCsvText();
    const parsedCsv = parseCfstCsv(csvText, {
      topN: config.subscription.topN,
      maxDelayMs: config.cfst.maxDelayMs,
      maxLossRate: config.cfst.maxLossRate,
      minSpeedMBps: config.cfst.minSpeedMBps,
      disableDownload: config.cfst.disableDownload,
      allowIpv6: config.subscription.allowIpv6,
    });

    const cfstEndpoints = config.strategy.enableLocalCfst ? parsedCsv.selected : [];
    const onlinePool = onlinePoolOverride || this.onlineSources.getCachedSnapshotSync();
    const onlineEndpoints = selectOnlineEndpoints(onlinePool, config.strategy);
    const bundle = assembleSubscriptionBundle(config.subscription, cfstEndpoints, onlineEndpoints);

    const outputFiles = {
      raw: path.join(this.outputDir, 'sub_raw.txt'),
      clash: path.join(this.outputDir, 'sub_clash.yaml'),
      provider: path.join(this.outputDir, 'sub_provider.yaml'),
      surge: path.join(this.outputDir, 'sub_surge.conf'),
    };

    fs.writeFileSync(outputFiles.raw, bundle.rendered.raw, 'utf8');
    fs.writeFileSync(outputFiles.clash, bundle.rendered.clash, 'utf8');
    fs.writeFileSync(outputFiles.provider, bundle.rendered['clash-provider'], 'utf8');
    fs.writeFileSync(outputFiles.surge, bundle.rendered.surge, 'utf8');

    return {
      config,
      csv: parsedCsv,
      onlinePool,
      bundle,
      outputFiles,
    };
  }

  /**
   * Refresh online sources if enabled & expired, then rebuild and persist subscription files.
   */
  async buildWithFreshOnlinePool(options = {}) {
    const config = this.getConfig();
    const needsOnlineFetch =
      options.alwaysFetchOnline === true ||
      config.strategy.enableDynamicIps ||
      config.strategy.enableGithubIps;

    const onlinePool = needsOnlineFetch
      ? await this.onlineSources.getPool({
          forceRefresh: options.forceRefresh === true,
          sourceCacheTtlSec: config.strategy.sourceCacheTtlSec,
          sourceTimeoutMs: config.strategy.sourceTimeoutMs,
          enableDiskPoolFallback: config.strategy.enableDiskPoolFallback,
        })
      : this.onlineSources.getCachedSnapshotSync();

    return this.buildAndPersistSubscriptions(onlinePool);
  }
}
