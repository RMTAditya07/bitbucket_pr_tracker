import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  completionValues,
  parseSheetDate,
  planCompletion,
  rollupStatus,
  rowFormulas,
  sheetDate,
  type Interactive,
  type PhaseTask,
} from '../src/tracker/completion.js';

describe('parseSheetDate', () => {
  it('reads the sheet locale as day/month/year', () => {
    assert.equal(parseSheetDate('9/10/2026'), '2026-10-09');
    assert.equal(parseSheetDate('29/9/2026 1:35:33 PM'), '2026-09-29');
  });
  it('reads ISO, d-Mon-yyyy and date serials', () => {
    assert.equal(parseSheetDate('2026-10-09T10:00:00.000+0530'), '2026-10-09');
    assert.equal(parseSheetDate('7-Oct-2026'), '2026-10-07');
    assert.equal(parseSheetDate('46294'), '2026-09-29');
  });
  it('rejects blanks and impossible dates', () => {
    assert.equal(parseSheetDate(''), null);
    assert.equal(parseSheetDate('31/2/2026'), null);
    assert.equal(parseSheetDate('TBD'), null);
  });
  it('round-trips through the sheet format', () => {
    assert.equal(sheetDate('2026-09-05'), '5-Sep-2026');
    assert.equal(parseSheetDate(sheetDate('2026-09-05')), '2026-09-05');
  });
});

describe('rollupStatus', () => {
  it('is Done only when every phase task is closed', () => {
    assert.equal(rollupStatus(['Done', 'Closed']), 'Done');
    assert.equal(rollupStatus(['Done', 'Review']), 'In progress');
    assert.equal(rollupStatus(['To Do', 'To Do']), 'To do');
    assert.equal(rollupStatus([]), '');
  });
});

describe('rowFormulas', () => {
  it('never contains "+", which reaches Zoho as a space', () => {
    for (const f of Object.values(rowFormulas(12))) assert.equal(String(f).includes('+'), false, String(f));
  });
});

const GEO: Interactive = {
  rowIndex: 82,
  ticket: 'EIT-5196',
  name: 'GEO_51319_1.html',
  developer: 'Akshaya A',
  status: 'To do',
  drop: '2026-10-09',
};
const task = (status: string, storyPoints: number | null, resolvedAt: string | null = null): PhaseTask => ({
  status,
  storyPoints,
  resolvedAt,
});

describe('completionValues', () => {
  it('counts closed phases and their story points', () => {
    const v = completionValues(GEO, [task('Done', 5, '2026-09-20T10:00:00.000+0530'), task('Review', 3), task('To Do', 8)]);
    assert.deepEqual(v, {
      Interactive: 'GEO_51319_1.html',
      Developer: 'Akshaya A',
      Ticket: 'EIT-5196',
      'Build Drop Date': '9-Oct-2026',
      'Phases Done': '1 of 3',
      'Total SP': '16',
      'Done SP': '5',
      'Remaining SP': '11',
      'Completed On': '',
    });
  });
  it('dates completion by the last phase resolved, and only once every phase is closed', () => {
    const v = completionValues(GEO, [task('Done', 5, '2026-09-20T10:00:00.000+0530'), task('Closed', 3, '2026-10-02T09:00:00.000+0530')]);
    assert.equal(v['Completed On'], '2-Oct-2026');
    assert.equal(v['Remaining SP'], '0');
  });
});

describe('planCompletion', () => {
  const tasks = new Map([['EIT-5196', [task('Done', 5), task('To Do', 8)]]]);

  it('inserts a row for a due interactive that has none', () => {
    const ops = planCompletion({ due: [GEO], tasks, existing: [] });
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.kind, 'insert');
  });

  it('writes only changed synced cells, treating equal dates and numbers as unchanged', () => {
    const ops = planCompletion({
      due: [GEO],
      tasks,
      existing: [
        {
          rowIndex: 4,
          values: {
            Interactive: 'GEO_51319_1.html',
            Developer: 'Akshaya A',
            Ticket: 'EIT-5196',
            'Build Drop Date': '9/10/2026',
            'Phases Done': '0 of 2',
            'Total SP': '13',
            'Done SP': '0',
            'Remaining SP': '13.0',
            'SP / Day': '4',
          },
        },
      ],
    });
    assert.deepEqual(ops, [
      { kind: 'update', rowIndex: 4, changes: { 'Phases Done': '1 of 2', 'Done SP': '5', 'Remaining SP': '8' } },
    ]);
  });

  it('skips interactives without phase tasks and leaves other rows alone', () => {
    assert.deepEqual(planCompletion({ due: [GEO], tasks: new Map(), existing: [] }), []);
  });
});
