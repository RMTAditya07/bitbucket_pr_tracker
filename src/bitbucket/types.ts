/** Subset of Bitbucket Cloud 2.0 payloads this service reads. */

export interface BbAccount {
  uuid?: string;
  account_id?: string;
  display_name?: string;
  nickname?: string;
}

export interface BbParticipant {
  user: BbAccount;
  /** "REVIEWER" | "PARTICIPANT" */
  role: string;
  approved: boolean;
  /** "approved" | "changes_requested" | null */
  state?: string | null;
  /** Last time this participant approved, requested changes or commented. */
  participated_on?: string | null;
}

export interface BbPullRequest {
  id: number;
  title: string;
  description?: string;
  /** "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED" */
  state: string;
  draft?: boolean;
  created_on: string;
  updated_on: string;
  links: { html?: { href: string } };
  source: { branch?: { name: string }; commit?: { hash: string } };
  destination: { branch?: { name: string } };
  author?: BbAccount;
  reviewers?: BbAccount[];
  participants?: BbParticipant[];
}

/**
 * One entry of `/pullrequests/{id}/activity` (newest first). Exactly one of the event keys is
 * set. `update` is written on creation, every push (new `source.commit`), edits and state
 * changes such as MERGED.
 */
export interface BbActivity {
  update?: {
    state?: string;
    date?: string;
    author?: BbAccount;
    source?: { commit?: { hash: string } };
  };
  approval?: { date?: string; user?: BbAccount };
  changes_requested?: { date?: string; user?: BbAccount };
  /** Older/alternative spelling seen in some payloads; treated the same as changes_requested. */
  request_changes?: { date?: string; user?: BbAccount };
  comment?: { created_on?: string; user?: BbAccount; deleted?: boolean };
}

/** `/pullrequests/{id}/comments` entry (general and inline comments, replies included). */
export interface BbComment {
  id: number;
  created_on?: string;
  updated_on?: string;
  user?: BbAccount;
  deleted?: boolean;
  /** Unpublished draft comment, visible only to its author. */
  pending?: boolean;
  parent?: { id: number };
  /** Set while the thread is resolved (top-level comments only). */
  resolution?: { created_on?: string; user?: BbAccount } | null;
}

export interface BbCommit {
  hash: string;
  date?: string;
}

export interface BbPage<T> {
  values: T[];
  next?: string;
}
