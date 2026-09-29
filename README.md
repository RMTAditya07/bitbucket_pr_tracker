# Bitbucket → Zoho Sheet PR review sync

A small deterministic service that copies Bitbucket Cloud pull-request and reviewer state into a
Zoho Sheet, **one row per (PR, reviewer)**, so the sheet can drive pivot tables and dashboards.
There is no AI, no fuzzy matching and no frontend. It uses only REST APIs and plain upsert logic.

```text
Bitbucket Cloud REST API ──► sync service (Node/TS) ──► Zoho Sheet Data API ──► Zoho Sheet ──► pivots
```

- [Architecture](#architecture)
- [Data model](#data-model)
- [Zoho Sheet setup](#zoho-sheet-setup)
- [Bitbucket setup](#bitbucket-setup)
- [Local setup](#local-setup)
- [Example output](#example-sync-output)
- [Scheduling](#scheduling)
- [PR digest to Zoho Cliq](#pr-digest-to-zoho-cliq)
- [Webhooks (later)](#webhooks-later)
- [Error handling](#error-handling)
- [Open questions / things to verify](#open-questions--things-to-verify)

---

## Architecture

```text
src/
  config/env.ts            env parsing + validation, auth-mode selection
  logger/logger.ts         text or JSON logs, secret redaction
  http/request.ts          fetch + timeout + retry/backoff (network, 408/429/5xx, Retry-After)
  bitbucket/
    client.ts              auth (access token / API token / OAuth client-credentials), pagination
    pullRequests.ts        list open PRs, list PRs updated since T, get PR detail
    reviewers.ts           participants/reviewers → one entry per reviewer, keyed by UUID
    timeline.ts            activity + commits → review history; fingerprint cache
  zoho/
    client.ts              OAuth refresh-token flow, request spacing, Zoho error codes
    sheet.ts               records.fetch / records.add / records.update
  sync/
    identity.ts            row key = "<PR ID>:<reviewer UUID>"
    mapper.ts              state normalization, row building, diffing, interactive mapping
    queue.ts               review queue: Queue State, Waiting On, rounds, dependencies (pure)
    synchronizer.ts        runSync(): discovery → per-PR upsert → summary (no I/O details)
    state.ts               incremental watermark file
  jira/client.ts           Jira Cloud search: story → phase tasks; status, story points, resolution
  tracker/
    completion.ts          build tracker planning: due interactives, rollups, changed cells (pure)
    sync.ts                Jira → Static Interactives Status + INTERACTIVE_COMPLETION (npm run sync:tracker)
  digest/plan.ts           PR digest: rows + rota -> one Cliq message per person (pure)
  cliq/client.ts           Zoho Cliq: list users, bot message to one user; sheet name -> Cliq user
  digest.ts                CLI: npm run digest (dry run) / -- --send
  app.ts                   wires adapters; runIncrementalSync() and syncPullRequests(ids)
  index.ts                 CLI: npm run sync
  scheduler.ts             interval loop, calls app.ts only
```

The synchronizer depends on two small interfaces, `PullRequestSource` and `SheetStore`. The
Bitbucket and Zoho classes implement them, and the tests supply in-memory fakes. The scheduler,
the CLI and a future webhook handler all call the same `runSync`.

### What one run does

1. **Read the sheet once**: all rows of the main worksheet, plus the optional *PR Mapping* and
   *Reviewer Levels* worksheets. Index rows by `Sync Key` and by `PR ID`.
2. **Discover candidate PRs**, as the union of:
   - every **OPEN** PR. These are always re-checked, because an approval may not bump the PR's `updated_on`.
   - PRs in any state updated since the last clean run, minus 5 minutes of overlap.
   - PR IDs in the mapping worksheet that have no rows yet, so a PR mapped *after* it was
     reported UNMAPPED is picked up on the next run.
   - PR IDs whose sheet rows still say `OPEN` but which are no longer open. This catches merges even if a
     run was missed.
3. **For each PR** (isolated in try/catch), fetch its detail and extract reviewers. For each reviewer:
   - A row exists with that `Sync Key` → diff the Bitbucket-owned columns and **update only
     what changed**, or report UNCHANGED.
   - A hand-entered row exists for the same PR ID and Reviewer name with no `Sync Key` → **adopt** it:
     update it and write the key. The first run against an existing sheet therefore creates no duplicates.
   - Otherwise → **insert** a row (all of a PR's new rows go to Zoho in one call). Manual
     fields come from the mapping; if the PR is unmapped they are left **blank** and
     `UNMAPPED_PR` is logged (`SYNC_INSERT_UNMAPPED_PRS=true`, the default). With `false`,
     unmapped PRs are only logged and nothing is written.
4. **Save the watermark** only if no PR failed, so failed PRs are retried on the next run.

---

## Data model

**Main worksheet**: one row = one reviewer on one PR.

| Column | Owner | Source |
|---|---|---|
| Developer | manual | mapping; else the PR **author**'s Bitbucket display name. Only fills a blank cell |
| Interactive Type | manual | mapping, only on insert |
| Interactive Name | manual | mapping, only on insert |
| Phase | manual | mapping, only on insert |
| PR (e.g. PR1) | manual* | mapping, only on insert. *See open questions* |
| PR ID | sync | `#123`, a **hyperlink** to the PR: `=HYPERLINK(links.html.href, "#123")`. The text and the link come from the same PR |
| Reviewer Level | sync | *Reviewer Levels* worksheet (never blanked if unknown) |
| Reviewer | sync | `display_name` (updates if the person renames) |
| Review Status | sync | `Approved` / `Requested Changes` / `Pending` |
| PR Status | sync | `OPEN` / `MERGED` / `DECLINED` / `SUPERSEDED` |
| Source Branch | sync | `source.branch.name` |
| Target Branch | sync | `destination.branch.name` |
| Created At | sync | `created_on`, formatted `YYYY-MM-DD HH:mm:ss` in `SHEET_TIMEZONE` |
| Updated At | sync | `updated_on`, same format |
| Last Synced At | sync | when *this row* was last written (unchanged rows are not rewritten) |
| PR Count | sync (optional) | `1` on exactly one row per PR, `0` on the others. **SUM this to count PRs**; counting rows counts reviewers |
| Days Open | sync (optional) | whole days from creation to now (OPEN) or to `updated_on` (closed). Bitbucket exposes no merge timestamp, so a comment after merge extends it |
| Queue State | sync (optional) | Where this reviewer's review is stuck. See [Review queue](#review-queue) |
| PR Queue State | sync (optional) | PR-level: where the PR as a whole is stuck (same on all its rows). Use it with Sum of `PR Count` |
| Waiting On | sync (optional) | Who acts next: the reviewer, the PR author, or the blocking PR(s) (`#71`). Blank = nobody |
| Waiting Since | sync (optional) | When the current wait started |
| Days Waiting | sync (optional) | **Working days** (Mon–Fri, in `SHEET_TIMEZONE`) since `Waiting Since`. Same day = 0 |
| Review Round | sync (optional) | 1 for the first review, +1 for each new revision this reviewer has to look at |
| Commits Since Review | sync (optional) | Commits pushed after this reviewer's last review. Blank = not reviewed yet |
| First Review At | sync (optional) | PR-level: first approval / change request / comment by anyone but the author |
| Merged At | sync (optional) | PR-level: merge time from the activity feed. Also makes `Days Open` exact for merged PRs |
| Depends On | sync (optional) | PR-level: `#71, #72`. See [Dependencies](#dependencies) |
| **Sync Key** | sync | `<PR ID>:<reviewer UUID>`, e.g. `123:{3f2a…}`. Row identity. Do not edit. |

Manual columns are **never overwritten**. The only time the sync writes one on an existing row is
to fill a **blank** cell from the mapping worksheet, for example when a PR inserted unmapped is mapped
later. Enforced in `diffSyncedFields` / `fillBlankManualFields` and covered by tests.

**Reviewer identity** is the Bitbucket account UUID, which is stable across display-name changes.
The key uses the UUID rather than the name, so a rename updates the `Reviewer` cell and does not
create a new row.

**State normalization**

| Bitbucket participant | Sheet |
|---|---|
| `state: "approved"` (or `approved: true`) | Approved |
| `state: "changes_requested"` | Requested Changes |
| `state: null`, assigned reviewer | Pending |
| anything else | cell left unchanged. Raw value logged as `UNKNOWN_REVIEW_STATE` |

A PR state other than the four known values leaves `PR Status` unchanged and logs `UNKNOWN_PR_STATE`.

**Who counts as a reviewer**: everyone in the PR's `reviewers` list, plus any participant who
approved or requested changes without being assigned. People who only commented are not counted.

**Removed reviewers**: their row is kept and not modified, and `REVIEWER_REMOVED` is logged.
Deleting rows could destroy manual data.

### Review queue

Add any of the optional queue headers above to `PR Reviews` to turn them on. When none are present, the
extra Bitbucket calls are skipped too. For each (PR, reviewer) row:

| Queue State | Meaning | Waiting On |
|---|---|---|
| Waiting for Review | Reviewer has not looked at the current revision | reviewer |
| Changes Requested | Reviewer requested changes, and the author has not handed it back yet | PR author |
| Waiting for Re-review | Reviewer approved / requested changes / commented, **then the author pushed, or resolved all of that reviewer's threads** | reviewer |
| Waiting for L2 | L2 reviewers only: every L1 owner approved, no L2 has approved or requested changes yet | that L2 reviewer |
| Approved | Approved, nothing blocking | — |
| Blocked by Dependency | Approved, but a PR it depends on is still open | `#71` |
| Draft | PR is a draft | PR author |
| Merged / Declined / Superseded | Closed; out of the queue | — |
| Removed | Reviewer was taken off the PR; out of the queue | — |
| Optional | On the PR in Bitbucket, but doesn't own its review (see below); out of the queue | — |

**Who owns a review.** Most PRs have the whole team as default reviewers, so counting everyone would put every PR in
everyone's queue. Each PR therefore uses one of two modes:

- **Rota mode**: the PR's developer has a row in `Review Rota` whose `From`–`To` dates cover the PR's creation date.
  That row's reviewers own the review from the start, before they have engaged. A rota reviewer who isn't a
  reviewer on the PR in Bitbucket is logged as `ROTA_REVIEWER_NOT_ON_PR`.
- **Engaged mode**: every other PR, including all PRs created before the rota started. Only reviewers who have
  engaged (approved, requested changes, commented or opened a thread) own it. If nobody has engaged yet, **one** row
  of the PR says `Waiting for Review` with `Waiting On` = `Unassigned`, so the PR is still counted, once.

In both modes, anyone who has engaged stays an owner: their feedback still has to be resolved. Everyone else is `Optional`.

**L2 step.** Reviewers with Level `L2` in `Reviewer Levels` are left out of the above. Their rows stay `Optional` until
every L1 owner has approved. Then each L2 reviewer's row says `Waiting for L2`, with `Waiting Since` = the last L1
approval. This lasts until one L2 reviewer approves or requests changes. That reviewer is then handled like any
owner, and the other L2 reviewers go back to `Optional`. Comments alone don't pull an L2 reviewer in early. In engaged
mode, a single engaged L1 approval is enough to start the L2 step.

**PR Queue State** summarizes the rows (Optional and Removed rows are ignored). The first state that applies wins:
Waiting for Re-review → Waiting for Review → Changes Requested → Waiting for L2 → Blocked by Dependency → Approved.
Closed and draft PRs take their own state.

- **The author hands feedback back in one of two ways:** push commits, or **resolve every comment thread the reviewer opened**
  (for example, fixed in another PR, or explained in a reply). A reply alone does not count ("will fix tomorrow").
  If the reviewer requested changes without opening any thread, only a push hands it back.
- A **comment** counts as reviewing the revision it was made on. A push after comments therefore puts the PR
  back in the reviewer's queue even without a formal *Request changes*. Without a push or resolved threads, comments
  alone don't move the PR to the author: use *Request changes* when the ball is in the author's court.
- **Dependencies don't block review**, only merging: review against the combined baseline, rebase once the
  dependency merges.
- Review history comes from `/pullrequests/{id}/activity`, `/commits` and `/comments`. It is cached in the state
  file and re-fetched only when the PR's head commit, state, `updated_on`, or a participant's review state or
  `participated_on` changes. Quiet PRs cost nothing extra. The first run fetches it for every PR.
  Resolving a thread may not change any of those, so open PRs with a change request outstanding get their
  comments re-read (one request) on every run.

### Dependencies

`Depends On` is resolved per PR, in this order:

1. The **`Depends On` column of `PR Mapping`** (`#71, #72`, or `-` for "none"). When set, it replaces 2 and 3.
2. `Depends on #71` (also `depends-on: #71, #72`) in the **PR description**. This is the easiest way for developers to declare it.
3. **Stacked branches**: the PR targets another open PR's source branch.

The PR is only *blocked* while one of those PRs is still open.

---

## Zoho Sheet setup

Create one spreadsheet with these worksheets. Row 1 is the header row, spelled **exactly** as shown.

**1. `PR Reviews`** (the `ZOHO_WORKSHEET_NAME`)

```text
Developer | Interactive Type | Interactive Name | Phase | PR | PR ID | Reviewer Level | Reviewer | Review Status | PR Status | Source Branch | Target Branch | Created At | Updated At | Last Synced At | PR Count | Days Open | Queue State | PR Queue State | Waiting On | Waiting Since | Days Waiting | Review Round | Commits Since Review | First Review At | Merged At | Depends On | Sync Key
```

- Column order does not matter. `PR Count`, `Days Open` and the review-queue columns are optional: if a header is missing, that column is simply not written.
- You can hide the `Sync Key` column, but do not delete or edit it.
- No merged cells, and no blank rows inside the data.
- Build pivots from this sheet only.

**2. `PR Mapping`** (optional, but this is how PRs get mapped to interactives)

```text
PR ID | Interactive Name | Developer | Interactive Type | Phase | PR | Depends On
123   | WNO_storyAnimations | Rithika M | Static | SPEC | PR1 |
```

`Depends On` is optional. Leave it blank for automatic detection.

You don't need this sheet: with `SYNC_INSERT_UNMAPPED_PRS=true` every PR lands in `PR Reviews`
and you can type Developer / Interactive / Phase straight into the rows. The mapping sheet is a
shortcut. Add a PR here and the next sync fills its **blank** manual cells. Cells that already
have a value are never changed, so editing a mapping later does not rewrite what you typed.

A PR with no mapping row is still considered mapped if some row in `PR Reviews` for the same
PR ID already has an Interactive Name. New reviewers then copy the manual fields from that row.

**3. `Review Rota`** (optional, `ZOHO_REVIEW_ROTA_WORKSHEET_NAME`)

```text
Developer | L1 Reviewer 1 | L1 Reviewer 2    | From       | To
Saad Khan | Shravya Das   | Srinithi Sridhar | 2026-09-30 |
```

- `Developer` and the reviewer names must match **Bitbucket display names** (case and extra spaces are ignored).
  `Developer` is matched against the PR author and the row's `Developer` column.
- Every column whose header contains the word `Reviewer` counts (`L1 Reviewer 1`, `L1 Reviewer 2`, `L2 Reviewer` …).
- `From` is **required**; rows without it are skipped (`ROTA_ROW_SKIPPED`), so the rota never pulls older PRs in
  by accident. `To` blank = open-ended. Write dates as `YYYY-MM-DD`; `30/09/2026` also works (read day-first).
- New rotation: add new rows with the next `From`, and close the old ones with a `To`. Don't edit old rows, or PRs from the
  previous sprint change owners.

**4. `Reviewer Levels`** (optional)

```text
Reviewer | Reviewer ID          | Level
Shravya  | {uuid, optional}     | L1
```

Matching uses `Reviewer ID` (the Bitbucket UUID) first, then the name. Unknown reviewers are
logged once per run as `UNKNOWN_REVIEWER_LEVEL`, and their Level cell is left alone.

**Zoho OAuth (Self Client)**

1. Open the API console for **your** data centre (e.g. `https://api-console.zoho.in` for India), then
   *Add Client* → *Self Client*.
2. *Generate Code*, with scope `ZohoSheet.dataAPI.READ,ZohoSheet.dataAPI.UPDATE` and a 10-minute duration.
3. Exchange the code for a refresh token within 10 minutes:
   ```bash
   curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
     -d grant_type=authorization_code -d client_id=… -d client_secret=… -d code=…
   ```
   Put `refresh_token` in `.env`. Use the `accounts.zoho.<dc>` host that matches your account.
4. `ZOHO_SHEET_ID` is the resource id in the spreadsheet URL.

---

## Pivot recipes

All of these use `PR Reviews` as the source. **Use Sum of `PR Count` whenever you mean "number of PRs"**,
because each PR has one row per reviewer.

| Question | Rows | Columns | Values | Filter |
|---|---|---|---|---|
| PRs per interactive by state | Interactive Name | PR Status | Sum of PR Count | |
| Phase progress per interactive | Interactive Name | Phase | Sum of PR Count | PR Status = MERGED |
| Developer throughput | Developer | PR Status | Sum of PR Count | |
| Average cycle time (days) | Developer or Interactive Name | | Average of Days Open | PR Count = 1, PR Status = MERGED |
| Ageing open PRs | PR ID | | Max of Days Open | PR Count = 1, PR Status = OPEN |
| Reviewer queue | Reviewer | Queue State | Count of Sync Key | PR Status = OPEN, Queue State ≠ Optional |
| **Review queue status** | PR Queue State | | Sum of PR Count | PR Status = OPEN |
| **Reviewer load** (who is the bottleneck) | Waiting On | Queue State | Count of Sync Key | Queue State = Waiting for Review, Waiting for Re-review, Waiting for L2. `Unassigned` = PRs nobody has picked up |
| **Ageing** | Days Waiting | Queue State | Count of Sync Key | PR Status = OPEN, Queue State ≠ Optional |
| **Waiting on developers** | Waiting On | | Count of Sync Key | Queue State = Changes Requested |
| **Time to first review** | Developer | | Average of a helper column `=IF(ISBLANK([@First Review At]),"",[@First Review At]-[@Created At])` | PR Count = 1 |

For an SLA flag, add a formula column next to `Days Waiting`, e.g.
`=IF([@Days Waiting]="","",IF([@Days Waiting]>=3,"Escalate",IF([@Days Waiting]>=2,"Attention",IF([@Days Waiting]>=1,"Due","OK"))))`
(or the A1 equivalent), and conditional-format it.
| Changes-requested rate | Developer | Review Status | Count of Sync Key | Queue State ≠ Optional |

**Linking to `Static Interactives`.** Branch tickets rarely match the interactive's ticket, so the link is
the **Interactive Name** typed on the PR rows. Keep it exact:

1. On `PR Reviews` → Interactive Name column → *Data → Data Validation → List from range* →
   `'Static Interactives'!A2:A1000`. The column becomes a dropdown.
2. Create named ranges on `PR Reviews` (*Data → Named Ranges*), each covering a whole column:
   `PR_Interactive`, `PR_Status`, `PR_Count`, `PR_DaysOpen`. The formulas below then keep working even if
   columns move.
3. Add summary columns to `Static Interactives`. Its rows are maintained by hand, so the formulas can simply be filled down:
   ```text
   Total PRs        =SUMIFS(PR_Count, PR_Interactive, A2)
   Open PRs         =SUMIFS(PR_Count, PR_Interactive, A2, PR_Status, "OPEN")
   Merged PRs       =SUMIFS(PR_Count, PR_Interactive, A2, PR_Status, "MERGED")
   Oldest open (d)  =MAXIFS(PR_DaysOpen, PR_Interactive, A2, PR_Status, "OPEN", PR_Count, 1)
   ```
   (Use `;` instead of `,` if your locale requires it.) Pivot `Static Interactives` on Status, Developer or
   Build Drop date against these columns.

---

## Bitbucket setup

Set **one** of the following. Bitbucket app passwords were retired in 2026.

| Option | Env vars | Notes |
|---|---|---|
| **Repository access token** (recommended) | `BITBUCKET_ACCESS_TOKEN` | Repo settings → Access tokens. Scope *Pull requests: Read*. Not tied to a person. |
| Atlassian API token | `BITBUCKET_EMAIL`, `BITBUCKET_API_TOKEN` | Scopes `read:pullrequest:bitbucket`, `read:repository:bitbucket`. Basic auth with your **email** as the username. |
| OAuth consumer | `BITBUCKET_CLIENT_ID`, `BITBUCKET_CLIENT_SECRET` | Private consumer with *Pull requests: Read*. Uses the client-credentials grant; tokens are refreshed automatically. |

Endpoints used (all `GET`, under `https://api.bitbucket.org/2.0`):

- `/repositories/{ws}/{repo}/pullrequests?state=OPEN&fields=next,values.id`
- `/repositories/{ws}/{repo}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on&fields=next,values.id,values.updated_on`.
  Paging stops at the first PR older than the watermark.
- `/repositories/{ws}/{repo}/pullrequests/{id}`, which returns the full PR including `reviewers` and `participants`.
- `/repositories/{ws}/{repo}/pullrequests/{id}/activity`, `/commits` and `/comments?fields=+values.resolution.*`
  (verified: without that parameter `resolution` comes back as `{}`, with no time or user), only when review-queue
  columns exist and the PR changed since the cached copy. `/comments` is also read every run for open PRs where
  changes are requested.

---

## Local setup

Requires Node **20.12+**, which provides `process.loadEnvFile` and native `fetch`.

```bash
npm install
cp .env.example .env        # fill it in
npm test                    # unit tests, no network
npm run sync                # one incremental sync
npm run sync:full           # ignore the watermark, scan all history
npm run sync -- --pr 123    # just one PR (same path a webhook would use)
```

Exit codes: `0` clean, `1` some PRs failed or the run aborted, `2` configuration error.

The first run looks back `SYNC_INITIAL_LOOKBACK_DAYS` (default 90). After that, each run starts
from the last clean run. The watermark is stored in `.sync-state.json`. Deleting that file is safe:
the upserts are idempotent.

`LOG_FORMAT=json` produces one JSON object per line, for log shippers.

---

## Example sync output

```text
SYNC STARTED
  Mode: incremental
  Since: 2026-09-23T05:40:00.000Z
PRS DISCOVERED
  Open: 14
  Updated Since Last Sync: 3
  Newly Mapped: 1
  Total: 16
PR 123
  Reviewer: Rithika S
  Status: Approved
  Action: UPDATED
  Changed: Review Status, Updated At
PR 123
  Reviewer: Shravya
  Status: Requested Changes
  Action: UNCHANGED
PR 456
  Reviewer: Arjun
  Status: Pending
  Action: INSERTED
[WARN] PR 789
  Action: UNMAPPED_PR
  Title: Fractions intro – spec fixes
  Source Branch: feature/fractions-intro
  Reviewers Not Inserted: 2
  Note: Add this PR ID to the mapping worksheet; rows will be inserted on the next sync.
[WARN] UNKNOWN REVIEWER LEVEL
  Reviewer: Arjun
  Reviewer Id: {5c1e…}
  Note: Add to the reviewer-levels worksheet; Reviewer Level left unchanged
SYNC COMPLETED
  Inserted: 2
  Updated: 5
  Unchanged: 18
  Unmapped: 1
  Failed: 0
  Duration Ms: 21450
```

Tokens and secrets are never logged. The logger also redacts every configured secret value from
error messages.

---

## Scheduling

The scheduler only decides **when** to run. All sync logic stays in `runSync`.

**Option 1: built-in loop** (simplest; one long-running process)

```bash
npm run build && npm start          # every SYNC_INTERVAL_MINUTES, runs never overlap
```

Keep it alive with pm2 (`pm2 start dist/scheduler.js --name pr-sync`), systemd, or Docker.

**Option 2: cron / launchd** (recommended; no long-lived process)

```cron
*/15 * * * * cd /opt/pr-sync && /usr/bin/node dist/index.js >> /var/log/pr-sync.log 2>&1
```

Runs cannot overlap in practice, because a run takes seconds. If you need a hard guarantee, wrap the command in `flock -n /tmp/pr-sync.lock …`.

**Bitbucket Pipelines schedules** only go down to hourly. The state file also does not persist
between pipeline runs, so every run falls back to the lookback window. That is correct but makes
more API calls. Use a small VM/container or a cloud scheduler if you want 15-minute runs.

---

## Build tracker (Jira → Static Interactives + INTERACTIVE_COMPLETION)

Three tabs track delivery; nothing else duplicates them:

| Tab | Maintained by | Answers |
|---|---|---|
| **Static Interactives** | people (+ Status from the sync) | What is being built, by whom, for which **Build Drop date** |
| **INTERACTIVE_COMPLETION** | the sync (+ SP / Day by people) | Will each interactive be complete by its drop? |
| **BUILD_HISTORY** | people, one row per drop, never overwritten | What actually happened |

PR and reviewer detail stays in **PR Reviews** (the Bitbucket sync above); the build tracker does
not repeat it.

```bash
npm run sync:tracker
```

For every interactive whose Build Drop date (Static Interactives, read as `d/m/yyyy`) is **today or
later** in `SHEET_TIMEZONE`, it reads the Story's 8 phase Tasks from Jira (linked with
*is parent of*) and:

1. writes the rolled-up **Status** into Static Interactives: `Done` when every phase is
   Done/Closed, `To do` when none has started, else `In progress`;
2. keeps that interactive's **INTERACTIVE_COMPLETION** row current, adding it the first time.

| Column | Source |
|---|---|
| Interactive, Developer, Ticket, Build Drop Date | Static Interactives |
| Phases Done (`5 of 8`), Total SP, Done SP, Remaining SP | Jira phase tasks (`JIRA_STORY_POINTS_FIELD`) |
| Completed On | Jira: when the last phase was resolved, once all are Done/Closed |
| **SP / Day** | typed by you: that developer's capacity (blank = 5) |
| Work Days Left | working days from today to the drop |
| Forecast Completion | today + (the developer's Remaining SP on every interactive due on or before this drop ÷ SP / Day) working days |
| On Time | Done / Done late / On track / At risk / No SP / Missed |

Jira assignees are never read, so placeholder assignees cannot leak into the sheet. Rows of
interactives whose drop has passed are left as they were.

GitHub Actions runs it hourly on weekdays, 09:00–19:00 IST (`.github/workflows/tracker-sync.yml`,
also runnable by hand from the Actions tab). It shares the PR sync's concurrency group because both
write to the same Zoho document. It needs, in addition to the existing Zoho/Bitbucket settings:

| Kind | Name | Value |
|---|---|---|
| Secret | `JIRA_API_TOKEN` | Atlassian API token (id.atlassian.com → Security → API tokens) |
| Variable | `JIRA_BASE_URL` | `https://ei-study.atlassian.net` |
| Variable | `JIRA_EMAIL` | the token owner's Atlassian email |
| Variable (optional) | `JIRA_STORY_POINTS_FIELD` | default `customfield_10028` |
| Variable (optional) | `TRACKER_BUILD_SOURCE_WORKSHEET` / `TRACKER_COMPLETION_WORKSHEET` | defaults `Static Interactives` / `INTERACTIVE_COMPLETION` |

Zoho Sheet API quirks this code works around: a `+` in a formula arrives as a space (formulas use
`SUM()`), no API sets a number format (date formula cells get a date typed in first), and
`worksheet.csvdata.set` ignores its row on table-like tabs (existing cells are written with
`cell.content.set`).

---

## PR digest to Zoho Cliq

Each person gets **one direct message** from the Cliq bot `PR Review Digest` (`prreviewdigest`), built from
*PR Reviews* and *Review Rota* only. Items are grouped by **Build Drop Date**, soonest first. A drop that has
passed while PRs are still open shows first as ⚠️, and PRs with no drop date come last. People are always named, never
referred to by pronoun.

**As an author**, the person's open PRs, each with what it needs next:

| PR Queue State / row | Line |
|---|---|
| Changes Requested | 🔧 `Ravi (1d) requested changes. Resolve the comments and push the fixes` |
| Waiting for Review | 👥 `Please connect with Asha (2d) to get it reviewed` |
| Waiting On = Unassigned | 👥 `No reviewer has picked it up yet. Please connect with Asha and Ravi from the review rota` (the author's active rota row) |
| Waiting for Re-review | 👥 `Please follow up with Ravi (1d) for the re-review` |
| Waiting for L2 | 👥 `L1 approved. Please connect with Stephen (2d) for the L2 review` |
| Blocked by Dependency | ⛔ `Approved, waiting for #71 to merge first` |
| Approved | 🔧 `All approvals in. Ready to merge` |
| Draft | 🔧 `Still a draft. Publish it when it is ready for review` |

**As a reviewer**, the rows whose `Waiting On` is that person: 🆕 fresh reviews (Waiting for Review / L2, plus
unassigned PRs of developers they are on the rota for) and 🔁 re-reviews. PRs from the same author and interactive
share one line, for example `🔁 Rithika M · WNO_storyAnimations · #48 +26 4d, #49 +37 4d`. Here `4d` is working days
waiting and `+26` is the number of new commits since the last review.

The **evening** digest has the same content, plus `✅ Merged today`. People with nothing open get no message.

Cliq rejects messages over 5000 characters. When a digest would be longer, the latest drops are cut and the
message ends with `…and N more PRs in the PR Reviews sheet` (a link).

**Setup**

1. The Zoho refresh token needs the Cliq scopes as well. Regenerate it with
   `ZohoSheet.dataAPI.READ,ZohoSheet.dataAPI.UPDATE,ZohoCliq.Webhooks.CREATE,ZohoCliq.Users.READ`
   (`npm run zoho:token -- <code>`), then update the `ZOHO_REFRESH_TOKEN` secret.
2. The bot must be visible to everyone who should receive it (Cliq → Bots & Tools → the bot → Access level:
   Organization or Team). Each person may need to open the bot and subscribe once.
3. People are matched by name to Cliq users: an exact match first, then a unique Cliq name that starts with the sheet
   name (`Shravya Das` → `Shravya Das V D`). Anyone else is logged as `CLIQ_USER_NOT_FOUND` and skipped. Map them with
   `CLIQ_USER_MAP=Stephen Prabhu=stephen@example.com; …` (a repository **variable** in Actions).

```bash
npm run digest                                   # dry run: prints every message, sends nothing
npm run digest -- --to "Muthu Tharuunaditya R"   # dry run for one person
npm run digest -- --send --to "Muthu Tharuunaditya R"
npm run digest -- --evening --send               # everyone
```

`.github/workflows/pr-digest.yml` sends the digest at **09:30 and 18:30 IST, Mon–Fri**. A manual run (*Run workflow*)
is a dry run unless *Send* is ticked. It only reads the sheet, so it does not share the sync's concurrency group.

---

## Webhooks (later)

`syncPullRequests(deps, [prId])` in `src/app.ts` is the entry point. A handler for Bitbucket events
(`pullrequest:created`, `:updated`, `:approved`, `:unapproved`, `:changes_request_created`,
`:changes_request_removed`, `:fulfilled`, `:rejected`) only needs to verify the webhook secret,
read `pullrequest.id` from the payload, and call it. Keep the periodic sync running as a safety net
for missed deliveries.

---

## Error handling

| Situation | Behaviour |
|---|---|
| Network error / timeout / 408 / 429 / 5xx | Retry with exponential backoff and jitter, honouring `Retry-After`, up to `HTTP_MAX_ATTEMPTS` |
| Bitbucket 401/403, Zoho auth failure | One token refresh where applicable. After that, **abort the run** (every call would fail the same way) |
| Zoho throttle (error 2950) | Abort the run. Zoho locks the document for about 5 minutes, so retrying immediately is pointless. Calls are spaced by `ZOHO_MIN_REQUEST_INTERVAL_MS` to avoid it |
| One PR fails | Logged as `FAILED`. Other PRs continue. Watermark not advanced |
| PR not found (404) | `MISSING_PR` logged. Not counted as a failure |
| PR has no reviewers | `NO_REVIEWERS` logged, nothing written |
| Account without UUID | `MISSING_REVIEWER_ID`, skipped |
| Duplicate `Sync Key` rows in the sheet | `DUPLICATE_ROWS` warning. All copies receive identical updates, and no new copies are ever made |
| Unmapped PR | `UNMAPPED_PR`. Nothing is inserted |

---

## Open questions / things to verify

These could not be confirmed from public documentation or depend on your setup. Each is isolated
in one place in the code so it can be adjusted easily.

**Decisions for you**

1. **"PR" column (PR1, PR2 …).** Bitbucket has no per-interactive PR ordinal, so this is treated as
   a *manual* column, filled from the mapping worksheet's `PR` column on insert. If you want it
   derived instead (e.g. the Nth PR for an interactive by creation date), that rule needs to be
   defined. → `MANUAL_COLUMNS` in `src/sync/mapper.ts`
2. **Reviewer Level (L1/L2).** Bitbucket has no reviewer levels. It is currently looked up per person
   from the *Reviewer Levels* worksheet. If a level depends on the PR instead (the same person is L1 on
   one PR and L2 on another), the mapping needs a per-PR source. → `lookupLevel` in `synchronizer.ts`
3. **Non-assigned approvers.** Someone who approves without being added as a reviewer currently gets a
   row. → `extractReviewers`
4. **Removed reviewers** are kept as-is and logged. An alternative is to mark their row with a status
   such as `Removed`.

**API behaviour to verify on first run** (run `npm run sync -- --pr <id>` against a test PR)

5. **Zoho data centre.** `ZOHO_ACCOUNTS_URL` / `ZOHO_SHEET_API_URL` must match your account. An `.ei.study`
   org is probably on `.in`, but check the URL you see when logged in.
6. **Zoho `records_start_index`** is assumed to be 1-based, with a maximum of 1000 records per fetch (documented).
   → `ZohoSheetStore.fetchAll`
7. **Zoho criteria on a numeric column.** Legacy-row adoption matches `"PR ID"=123 and "Reviewer"="…"`.
   If your PR ID cells are stored as text, the number may not match. Keyed rows are unaffected, because
   they match on the text `Sync Key`. → `buildCriteria`
8. **Zoho date round-trip.** Zoho may return date cells in a different display format. Comparison
   is tolerant (both sides are parsed and compared to the minute). If a second run still shows every row as
   `UPDATED` with `Changed: Created At, Updated At`, set those two columns to *Text* format in Zoho,
   or match the date format. → `cellEquals`
9. **Zoho per-minute rate limit.** The exact number is not published. Start with the default 1000 ms spacing,
   and increase it if you ever see error 2950.
10. **Zoho empty worksheet.** `records.fetch` on a sheet with only a header row is expected to return
    zero records. If it returns an error instead, add one dummy row first.
11. **Bitbucket `updated_on` on approval.** It is not documented whether approving bumps it. The design does
    not depend on it: open PRs are always re-read.
12. **Bitbucket rate limit.** About 1,000 authenticated requests per hour per user/token for repository
    data. Cost per run is roughly `1 + ⌈open/50⌉ + (open + changed)` requests. With 50 open PRs every 15 min,
    that is about 210 per hour. With review-queue columns, add 3 or more requests per PR **that changed**
    (activity, commits and comments pages), plus 1 per open PR with changes requested. A first run with 90 open PRs
    costs about 360 requests. Later runs usually cost a handful, plus about 10 for change-requested PRs, so roughly 40 per hour.
