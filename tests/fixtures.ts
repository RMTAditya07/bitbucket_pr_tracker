import type { BbAccount, BbParticipant, BbPullRequest } from '../src/bitbucket/types.js';

export const RITHIKA_S: BbAccount = { uuid: '{11111111-aaaa}', display_name: 'Rithika S' };
export const SHRAVYA: BbAccount = { uuid: '{22222222-bbbb}', display_name: 'Shravya' };
export const ARJUN: BbAccount = { uuid: '{33333333-cccc}', display_name: 'Arjun' };
export const AUTHOR: BbAccount = { uuid: '{99999999-dddd}', display_name: 'Rithika M' };

export function participant(user: BbAccount, state: string | null, role = 'REVIEWER'): BbParticipant {
  return { user, role, approved: state === 'approved', state };
}

export function makePr(overrides: Partial<BbPullRequest> & { id: number }): BbPullRequest {
  return {
    title: `PR ${overrides.id}`,
    state: 'OPEN',
    created_on: '2026-09-01T10:00:00.000000+00:00',
    updated_on: '2026-09-20T12:30:00.000000+00:00',
    links: { html: { href: `https://bitbucket.org/ws/repo/pull-requests/${overrides.id}` } },
    source: { branch: { name: `feature/pr-${overrides.id}` } },
    destination: { branch: { name: 'develop' } },
    author: AUTHOR,
    reviewers: [],
    participants: [],
    ...overrides,
  };
}
