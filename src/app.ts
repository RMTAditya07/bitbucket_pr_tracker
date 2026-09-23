import { BitbucketClient } from './bitbucket/client.js';
import { BitbucketPullRequests } from './bitbucket/pullRequests.js';
import { secretValues, type Config } from './config/env.js';
import type { Logger } from './logger/logger.js';
import { readState, sinceFromState, writeState } from './sync/state.js';
import { runSync, type SyncDeps, type SyncSummary } from './sync/synchronizer.js';
import { ZohoClient } from './zoho/client.js';
import { ZohoSheetStore } from './zoho/sheet.js';

/** Wires real adapters. Build once and reuse across scheduled runs so OAuth tokens are cached. */
export function createSyncDeps(config: Config, logger: Logger): SyncDeps {
  logger.addSecrets(secretValues(config));
  const bitbucket = new BitbucketClient(config.bitbucket, config.http, logger);
  const zoho = new ZohoClient(config.zoho, config.http, logger);
  return {
    source: new BitbucketPullRequests(bitbucket),
    sheet: new ZohoSheetStore(zoho, config.zoho, logger),
    logger,
    timeZone: config.sync.timezone,
    insertUnmapped: config.sync.insertUnmapped,
  };
}

/** Periodic/manual sync: discovery + watermark. Advances the watermark only on a clean run. */
export async function runIncrementalSync(
  config: Config,
  deps: SyncDeps,
  opts: { full?: boolean } = {},
): Promise<SyncSummary> {
  const startedAt = new Date();
  const state = opts.full ? null : await readState(config.sync.stateFile);
  const since = opts.full ? null : sinceFromState(state, config.sync.initialLookbackDays, startedAt);

  const summary = await runSync(deps, {
    since,
    previousInteractivesFingerprint: state?.interactivesFingerprint ?? null,
  });

  if (!summary.aborted && summary.failed === 0) {
    await writeState(config.sync.stateFile, {
      lastSuccessfulSyncStartedAt: startedAt.toISOString(),
      interactivesFingerprint: summary.interactivesFingerprint,
    });
  }
  return summary;
}

/**
 * Entry point for a future Bitbucket webhook handler: sync just the PRs named in the event
 * (pullrequest:created / updated / approved / changes_request_created / fulfilled ...).
 * Does not touch the watermark; the periodic sync remains the safety net.
 */
export function syncPullRequests(deps: SyncDeps, prIds: number[]): Promise<SyncSummary> {
  return runSync(deps, { prIds });
}
