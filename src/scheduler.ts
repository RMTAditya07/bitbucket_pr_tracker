/**
 * Long-running scheduler: runs the sync every SYNC_INTERVAL_MINUTES.
 * Runs never overlap — the next one is scheduled only after the previous finishes.
 * Contains no sync logic; it only decides *when* to call runIncrementalSync.
 */
import { createSyncDeps, runIncrementalSync } from './app.js';
import { loadConfig, loadDotEnv } from './config/env.js';
import { createLogger } from './logger/logger.js';

loadDotEnv();
const config = loadConfig();
const logger = createLogger(config.logFormat);
const deps = createSyncDeps(config, logger);
const intervalMs = Math.max(1, config.sync.intervalMinutes) * 60_000;

let timer: NodeJS.Timeout | null = null;
let stopping = false;

async function tick(): Promise<void> {
  try {
    await runIncrementalSync(config, deps);
  } catch (err) {
    logger.event('error', 'SYNC_CRASHED', { error: err instanceof Error ? err.message : String(err) });
  }
  if (!stopping) {
    logger.event('info', 'NEXT_SYNC_SCHEDULED', { inMinutes: config.sync.intervalMinutes });
    timer = setTimeout(tick, intervalMs);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    logger.event('info', 'SCHEDULER_STOPPING', { signal });
    // An in-flight sync finishes its current request; the process exits when the event loop drains.
  });
}

logger.event('info', 'SCHEDULER_STARTED', { intervalMinutes: config.sync.intervalMinutes });
void tick();
