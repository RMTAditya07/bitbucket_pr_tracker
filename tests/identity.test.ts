import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSyncKey,
  normalizeName,
  normalizeUuid,
  parsePrId,
  parseSyncKey,
  reviewerIdentity,
} from '../src/sync/identity.js';

describe('normalizeUuid', () => {
  it('lower-cases and ensures braces', () => {
    assert.equal(normalizeUuid('{AB12-CD34}'), '{ab12-cd34}');
    assert.equal(normalizeUuid('ab12-cd34'), '{ab12-cd34}');
    assert.equal(normalizeUuid('  {Ab12-cd34} '), '{ab12-cd34}');
  });
});

describe('reviewerIdentity', () => {
  it('prefers uuid over account_id and display name', () => {
    assert.equal(reviewerIdentity({ uuid: '{ABC}', account_id: '557058:x', display_name: 'Shravya' }), '{abc}');
  });
  it('falls back to account_id', () => {
    assert.equal(reviewerIdentity({ account_id: '557058:x', display_name: 'Shravya' }), 'acct:557058:x');
  });
  it('returns null when no stable id exists (never uses display name)', () => {
    assert.equal(reviewerIdentity({ display_name: 'Shravya' }), null);
  });
});

describe('buildSyncKey', () => {
  it('is PR id + reviewer uuid', () => {
    assert.equal(buildSyncKey(123, '{ABC-1}'), '123:{abc-1}');
  });
  it('is identical for the same account regardless of uuid formatting', () => {
    assert.equal(buildSyncKey(123, 'abc-1'), buildSyncKey(123, '{ABC-1}'));
  });
  it('differs per reviewer and per PR', () => {
    const keys = new Set([
      buildSyncKey(123, '{a}'),
      buildSyncKey(123, '{b}'),
      buildSyncKey(456, '{a}'),
    ]);
    assert.equal(keys.size, 3);
  });
  it('keeps account_id fallback keys intact', () => {
    assert.equal(buildSyncKey(7, 'acct:557058:x'), '7:acct:557058:x');
  });
  it('rejects invalid input', () => {
    assert.throws(() => buildSyncKey(0, '{a}'));
    assert.throws(() => buildSyncKey(1.5, '{a}'));
    assert.throws(() => buildSyncKey(1, ''));
  });
  it('round-trips through parseSyncKey', () => {
    assert.deepEqual(parseSyncKey(buildSyncKey(42, '{x}')), { prId: 42, reviewerId: '{x}' });
    assert.equal(parseSyncKey('garbage'), null);
  });
});

describe('normalizeName', () => {
  it('ignores case and extra whitespace', () => {
    assert.equal(normalizeName('  Rithika   S '), normalizeName('rithika s'));
  });
});

describe('parsePrId', () => {
  it('accepts numbers and numeric strings as Zoho may return them', () => {
    assert.equal(parsePrId(123), 123);
    assert.equal(parsePrId('123'), 123);
    assert.equal(parsePrId('123.0'), 123);
    assert.equal(parsePrId('#123'), 123);
    assert.equal(parsePrId({ url: 'https://x', text: '#123' }), 123);
  });
  it('rejects anything else', () => {
    for (const v of ['', 'PR1', null, undefined, 0, -1, 1.5, 'abc']) assert.equal(parsePrId(v), null);
  });
});
