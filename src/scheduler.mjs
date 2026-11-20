/**
 * Interval-based background scheduler for automated CloudflareSpeedTest runs.
 */

/**
 * Schedule periodic speedtest execution according to store configuration.
 */
export class RunScheduler {
  constructor(store, runner) {
    this.store = store;
    this.runner = runner;
    this.timer = null;
  }

  start() {
    this.reschedule();
    const cfg = this.store.getConfig();
    if (cfg.schedule.runOnStartup && !this.runner.running) {
      setTimeout(() => {
        if (!this.runner.running) {
          this.runner.runOnce('startup').catch(() => {});
        }
      }, 1500);
    }
  }

  reschedule() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const cfg = this.store.getConfig();
    if (!cfg.schedule.enabled || cfg.schedule.intervalMinutes <= 0) {
      this.store.updateState({ nextRunAt: null });
      return;
    }

    const intervalMs = cfg.schedule.intervalMinutes * 60 * 1000;
    const nextAt = new Date(Date.now() + intervalMs).toISOString();
    this.store.updateState({ nextRunAt: nextAt });

    this.timer = setTimeout(async () => {
      try {
        if (!this.runner.running) {
          await this.runner.runOnce('schedule');
        }
      } catch {
        // Failure is recorded in store state and logs.
      } finally {
        this.reschedule();
      }
    }, intervalMs);

    // Avoid keeping CLI/test processes alive solely due to background timer.
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
