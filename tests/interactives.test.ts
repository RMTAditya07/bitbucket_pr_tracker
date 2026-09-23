import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMatcher, isCodeLike, normalizeKey } from '../src/sync/interactives.js';

const CATALOG = [
  { name: 'SHA_qcode_11757_ans.html', type: 'Static' },
  { name: 'DEC_qcode_1060_ans.html', type: 'Static' },
  { name: 'WNO_qcode_10682.html', type: 'Static' },
  { name: 'WNO_qcode_10682_1.html', type: 'Static' },
  { name: 'WNO_storyAnimations.html', type: 'Dynamic' },
  { name: 'TMP_groupingTwo.html', type: 'Static' },
  { name: 'Translation.html', type: 'Static' },
];
const m = buildMatcher(CATALOG);

describe('interactive detection', () => {
  it('finds a name in the title', () => {
    const d = m.detect({ title: 'EIT-5465: Functional and Tech specs — rotation_transform (SHA_qcode_11757_ans)' });
    assert.deepEqual(d, { kind: 'match', entry: CATALOG[0], source: 'title' });
  });
  it('matches across separators and camelCase in branch names', () => {
    const d = m.detect({ branch: 'feat/wno-story-animations-tests' });
    assert.equal(d.kind === 'match' && d.entry.name, 'WNO_storyAnimations.html');
  });
  it('prefers the branch over the title and description', () => {
    const d = m.detect({ branch: 'feat/DEC_qcode_1060_ans', title: 'also SHA_qcode_11757_ans' });
    assert.equal(d.kind === 'match' && d.source, 'branch');
  });
  it('keeps the longest name when one is contained in another', () => {
    const d = m.detect({ title: 'Widgetbook for WNO_qcode_10682_1' });
    assert.equal(d.kind === 'match' && d.entry.name, 'WNO_qcode_10682_1.html');
  });
  it('reports ambiguity instead of guessing', () => {
    const d = m.detect({ title: 'Widgetbook: TMP_groupingTwo and DEC_qcode_1060_ans' });
    assert.deepEqual(d, {
      kind: 'ambiguous',
      candidates: ['DEC_qcode_1060_ans.html', 'TMP_groupingTwo.html'],
      source: 'title',
    });
  });
  it('does not match inside a longer identifier', () => {
    assert.equal(m.detect({ title: 'DEC_qcode_10601_ans' }).kind, 'none');
  });
  it('never auto-detects plain-word names', () => {
    assert.equal(m.detect({ title: 'Translation fixes for the workbench' }).kind, 'none');
    assert.ok(!isCodeLike('Translation.html'));
    assert.ok(isCodeLike('TMP_groupingTwo.html'));
  });
  it('looks up entries by name regardless of extension/case', () => {
    assert.equal(m.lookup('wno_storyanimations')?.type, 'Dynamic');
    assert.equal(normalizeKey('SHA_qcode_30516_1.html'), 'shaqcode305161');
  });
  it('fingerprint changes when an interactive is added', () => {
    const more = buildMatcher([...CATALOG, { name: 'NEW_qcode_1.html', type: 'Static' }]);
    assert.notEqual(more.fingerprint, m.fingerprint);
    assert.equal(buildMatcher([]).fingerprint, '');
  });
});
