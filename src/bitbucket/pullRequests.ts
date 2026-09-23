import type { PullRequestSource } from '../sync/synchronizer.js';
import type { BitbucketClient } from './client.js';
import type { BbPullRequest } from './types.js';

const ALL_STATES = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'];

export class BitbucketPullRequests implements PullRequestSource {
  constructor(private readonly client: BitbucketClient) {}

  async listOpenPullRequestIds(): Promise<number[]> {
    const ids: number[] = [];
    const path = `${this.client.repoPath()}/pullrequests?state=OPEN&pagelen=50&fields=next,values.id`;
    for await (const pr of this.client.paginate<{ id: number }>(path)) ids.push(pr.id);
    return ids;
  }

  /**
   * PRs in any state whose `updated_on` is at or after `since` (all PRs when `since` is null).
   * Sorted newest-first so we can stop paging at the first older PR, which avoids depending
   * on BBQL date-literal syntax.
   */
  async listPullRequestIdsUpdatedSince(since: Date | null): Promise<number[]> {
    const states = ALL_STATES.map((s) => `state=${s}`).join('&');
    const path =
      `${this.client.repoPath()}/pullrequests?${states}&sort=-updated_on&pagelen=50` +
      `&fields=next,values.id,values.updated_on`;
    const ids: number[] = [];
    for await (const pr of this.client.paginate<{ id: number; updated_on: string }>(path)) {
      if (since && Date.parse(pr.updated_on) < since.getTime()) break;
      ids.push(pr.id);
    }
    return ids;
  }

  /** Full PR (includes `reviewers` and `participants`). Null if the PR does not exist. */
  async getPullRequest(id: number): Promise<BbPullRequest | null> {
    return this.client.get<BbPullRequest>(`${this.client.repoPath()}/pullrequests/${id}`);
  }
}
