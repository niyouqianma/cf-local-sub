/**
 * Cross-platform binary detection and process execution for XIU2/CloudflareSpeedTest.
 */

import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Locate cfst executable across configured path, project bin/, Windows download folder, and PATH.
 */
export function detectCfstBinary(rootDir, configuredPath = '') {
  const candidates = [];
  if (configuredPath) candidates.push(configuredPath);
  if (process.env.CFST_BIN) candidates.push(process.env.CFST_BIN);

  if (process.platform === 'win32') {
    candidates.push(
      path.join(rootDir, 'bin', 'cfst.exe'),
      'E:\\Download\\cfst_windows_amd64\\cfst.exe',
      path.join(process.env.USERPROFILE || '', 'Downloads', 'cfst_windows_amd64', 'cfst.exe'),
      path.join(process.env.USERPROFILE || '', 'Desktop', 'cfst_windows_amd64', 'cfst.exe')
    );
  } else {
    candidates.push(path.join(rootDir, 'bin', 'cfst'), '/app/bin/cfst', '/usr/local/bin/cfst');
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  const pathLookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const names = process.platform === 'win32' ? ['cfst.exe', 'CloudflareST.exe'] : ['cfst', 'CloudflareST'];
  for (const binName of names) {
    try {
      const resolved = execFileSync(pathLookup, [binName], { encoding: 'utf8', timeout: 2000 })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {
      // Binary not on PATH.
    }
  }

  return '';
}

/**
 * Locate an existing local result.csv next to a detected cfst folder for quick preview import.
 */
export function detectSampleCsvPath(binaryPath) {
  const candidates = [];
  if (binaryPath) {
    candidates.push(path.join(path.dirname(binaryPath), 'result.csv'));
  }
  if (process.platform === 'win32') {
    candidates.push('E:\\Download\\cfst_windows_amd64\\result.csv');
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return '';
}

/**
 * Build CLI arguments for cfst from normalized configuration.
 */
export function buildCfstArgs(cfstCfg, ipFilePath, outputCsvPath) {
  const args = [
    '-n', String(cfstCfg.routines),
    '-t', String(cfstCfg.pingTimes),
    '-dn', String(cfstCfg.downloadCount),
    '-dt', String(cfstCfg.downloadTime),
    '-tp', String(cfstCfg.port),
    '-url', cfstCfg.testUrl,
    '-tl', String(cfstCfg.maxDelayMs),
    '-tll', String(cfstCfg.minDelayMs),
    '-tlr', String(cfstCfg.maxLossRate),
    '-sl', String(cfstCfg.minSpeedMBps),
    '-p', '20',
    '-f', ipFilePath,
    '-o', outputCsvPath,
  ];

  if (cfstCfg.mode === 'httping') {
    args.push('-httping');
    if (cfstCfg.httpingCode > 0) {
      args.push('-httping-code', String(cfstCfg.httpingCode));
    }
    if (cfstCfg.cfColo) {
      args.push('-cfcolo', cfstCfg.cfColo);
    }
  }
  if (cfstCfg.disableDownload) args.push('-dd');
  if (cfstCfg.testAll) args.push('-allip');
  return args;
}

/**
 * Manage single-flight execution of CloudflareSpeedTest and stream live logs.
 */
export class CfstRunner extends EventEmitter {
  constructor(rootDir, store) {
    super();
    this.rootDir = rootDir;
    this.store = store;
    this.activeChild = null;
    this.running = false;
    this.currentStartedAt = null;
    this.logBuffer = [];
    this.cachedVersion = { binaryPath: '', version: '' };
    this.probingVersion = false;
  }

  probeVersionAsync(binaryPath) {
    if (!binaryPath || this.probingVersion) return;
    if (this.cachedVersion.binaryPath === binaryPath && this.cachedVersion.version) return;

    this.probingVersion = true;
    const child = spawn(binaryPath, ['-v'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let output = '';
    let settled = false;
    const finish = (version) => {
      if (settled) return;
      settled = true;
      this.probingVersion = false;
      this.cachedVersion = { binaryPath, version };
      this.emit('status', { running: this.running, version });
      try {
        child.kill();
      } catch {
        // Process already exited.
      }
    };

    const onChunk = (chunk) => {
      output += chunk.toString('utf8');
      const verMatch = output.match(/v\d+\.\d+\.\d+/i);
      if (verMatch) finish(verMatch[0]);
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', () => finish('detected'));
    child.on('close', () => {
      const verMatch = output.match(/v\d+\.\d+\.\d+/i);
      finish(verMatch ? verMatch[0] : 'detected');
    });
    const timer = setTimeout(() => finish('detected'), 2500);
    timer.unref?.();
    child.on('close', () => clearTimeout(timer));
  }

  getEnvironmentInfo(configuredPath = '') {
    const binaryPath = detectCfstBinary(this.rootDir, configuredPath);
    const sampleCsvPath = detectSampleCsvPath(binaryPath);
    if (binaryPath) this.probeVersionAsync(binaryPath);
    const version = binaryPath && this.cachedVersion.binaryPath === binaryPath
      ? (this.cachedVersion.version || 'probing...')
      : '';

    return {
      platform: process.platform,
      arch: process.arch,
      isDocker: fs.existsSync('/.dockerenv'),
      binaryPath,
      binaryFound: Boolean(binaryPath),
      version,
      sampleCsvPath,
      sampleCsvFound: Boolean(sampleCsvPath),
    };
  }

  appendLog(line, level = 'info') {
    const clean = String(line || '').replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    if (!clean) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      text: clean,
    };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > 300) {
      this.logBuffer.splice(0, this.logBuffer.length - 300);
    }
    this.emit('log', entry);
  }

  /**
   * Run cfst once against a fresh temporary CSV path and return execution summary.
   */
  async runOnce(trigger = 'manual') {
    if (this.running) {
      throw new Error('已有测速任务正在运行中');
    }

    const config = this.store.getConfig();
    const binaryPath = detectCfstBinary(this.rootDir, config.cfst.binPath);
    if (!binaryPath) {
      throw new Error('未检测到 cfst 可执行文件，请在设置中填写路径或放入 bin/ 目录');
    }

    const tempCsvPath = path.join(this.store.runsDir, `active-${Date.now()}.csv`);
    const args = buildCfstArgs(config.cfst, this.store.ipTxtPath, tempCsvPath);

    this.running = true;
    this.currentStartedAt = new Date().toISOString();
    this.emit('status', { running: true, startedAt: this.currentStartedAt, trigger });
    this.store.updateState({
      lastRunStatus: 'running',
      lastRunMessage: `正在测速 (${trigger})...`,
    });
    this.appendLog(`开始测速 [${trigger}]: ${binaryPath} ${args.join(' ')}`, 'system');

    const startMs = Date.now();

    try {
      const exitCode = await new Promise((resolve, reject) => {
        const child = spawn(binaryPath, args, {
          cwd: path.dirname(binaryPath),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        this.activeChild = child;

        // Close stdin with a newline so Windows cfst.exe's Scanln pause exits immediately.
        child.stdin?.end('\n');

        const consumeStream = (stream, level) => {
          let partial = '';
          stream.on('data', (chunk) => {
            partial += chunk.toString('utf8');
            const parts = partial.split(/\r\n|\n|\r/);
            partial = parts.pop() || '';
            for (const line of parts) {
              const trimmed = line.trim();
              if (trimmed && !trimmed.includes('按下 回车键 或 Ctrl+C 退出')) {
                this.appendLog(trimmed, level);
              }
            }
          });
          stream.on('end', () => {
            if (partial.trim()) this.appendLog(partial.trim(), level);
          });
        };

        consumeStream(child.stdout, 'stdout');
        consumeStream(child.stderr, 'stderr');

        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 1));
      });

      const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
      const csvExists = fs.existsSync(tempCsvPath);
      const csvText = csvExists ? fs.readFileSync(tempCsvPath, 'utf8') : '';
      try {
        if (csvExists) fs.unlinkSync(tempCsvPath);
      } catch {
        // Safe to ignore temp cleanup failures.
      }

      if (exitCode !== 0 && !csvText.trim()) {
        throw new Error(`测速进程退出码 ${exitCode}，未产生有效结果`);
      }
      if (!csvText.trim()) {
        throw new Error('本次测速未匹配到符合阈值条件的 IP（已保留上次优选结果）');
      }

      this.store.saveCsvResult(csvText, `cfst (${trigger})`);
      const built = this.store.buildAndPersistSubscriptions();
      const finishedAt = new Date().toISOString();
      const summary = {
        at: finishedAt,
        trigger,
        status: 'success',
        durationSec: Number(durationSec),
        totalRows: built.csv.stats.totalRows,
        selectedRows: built.csv.stats.selectedRows,
        bestSpeedMBps: built.csv.stats.bestSpeedMBps,
        lowestDelayMs: Number.isFinite(built.csv.stats.lowestDelayMs) ? built.csv.stats.lowestDelayMs : null,
        outputNodes: built.bundle.assembledNodes.length,
      };

      this.store.updateState({
        lastRunAt: finishedAt,
        lastRunStatus: 'success',
        lastRunMessage: `测速成功：选出 ${summary.selectedRows} 个优选 IP，最高 ${summary.bestSpeedMBps} MB/s，生成 ${summary.outputNodes} 个节点`,
      });
      this.store.appendHistory(summary);
      this.appendLog(`测速完成 (${durationSec}s)：已更新 ${summary.selectedRows} 个优选 IP`, 'success');
      this.emit('complete', summary);
      return summary;
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
      const message = err?.message || '测速失败';
      const failure = {
        at: finishedAt,
        trigger,
        status: 'error',
        durationSec: Number(durationSec),
        message,
      };
      this.store.updateState({
        lastRunAt: finishedAt,
        lastRunStatus: 'error',
        lastRunMessage: message,
      });
      this.store.appendHistory(failure);
      this.appendLog(`测速失败: ${message}`, 'error');
      this.emit('complete', failure);
      throw err;
    } finally {
      this.activeChild = null;
      this.running = false;
      this.emit('status', { running: false, startedAt: null, trigger });
    }
  }

  stop() {
    if (!this.running || !this.activeChild) return false;
    this.appendLog('收到停止指令，正在中止测速进程...', 'error');
    this.activeChild.kill('SIGTERM');
    setTimeout(() => {
      if (this.activeChild) {
        try {
          this.activeChild.kill('SIGKILL');
        } catch {
          // Process already exited.
        }
      }
    }, 1500);
    return true;
  }
}
