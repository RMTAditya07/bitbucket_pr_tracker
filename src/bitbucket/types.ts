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
  source: { branch?: { name: string } };
  destination: { branch?: { name: string } };
  author?: BbAccount;
  reviewers?: BbAccount[];
  participants?: BbParticipant[];
}

export interface BbPage<T> {
  values: T[];
  next?: string;
}
