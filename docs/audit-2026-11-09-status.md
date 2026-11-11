# Audit of 9 November 2026: status of each finding

Source: `supporting-files/prompts/Automated_QA_Audit_2026-11-09.md`, audited at commit `18b1172`. Each finding was checked against the code before anything changed. That commit was still the latest, so none was already resolved by later work.

Regression tests are in `tests/audit-fixes.test.ts`, `tests/qa-aggregation.test.ts` and `tests/rules.integration.test.ts`.

## Priority findings

| ID | Finding | Status | Evidence |
| --- | --- | --- | --- |
| A1 | A retest can mark an untested interaction as verified | **Fixed** | Checks and findings now share an exact `checkKey`, in `functional.ts`, `traversal.ts`, `keyboard.ts` and `links.ts`, matched in `workflow.ts`. Tests: another control passing stays `not_retested`; the same check passing is `verified`; a changed version or expectation stays `not_retested`; a different browser major version stays `not_retested`; an older finding with no key is never verified by a rule-level pass. |
| A2 | Starting another worker invalidates active jobs and deletes their files | **Fixed** | `apps/worker/src/worker-lock.ts`: an exclusive lock is taken before recovery and cleanup. Tests: a second start is refused and leaves the job and files untouched; a lock from a dead process is replaced and its job recovered; a reused process number does not block forever; stopping releases it. Concurrency is unchanged (`tests/browser-session.test.ts` passes). |
| A3 | Unsupported or inconclusive checks disappear from the final status | **Fixed** | `aggregation.ts`: `gaps` now includes unsupported, inconclusive and unknown, as do the statement and `finalStage`. Shown in `CoveragePanel.tsx`. Tests cover all three; a clear run stays `completed`. |
| A4 | Different lesson controls are wrongly treated as the same one | **Fixed, with a limit** | `functional.ts`: only a control named like part of the player, at a fixed address outside lesson blocks, is shared. Copies wait for the real outcome and link to it (`resolveSharedControls`). Tests: same-named lesson tabs each run; a source that never ran leaves a gap; passed, failed, blocked and cancelled sources are all truthful. **Limit:** it is still a name-and-address rule. Knowing from the adapter whether a control sits in the player is the better design and is not done. |
| A5 | Draft rules run before approval | **Fixed for results; two parts stay open** | `isRuleConfirmed` in `qa.ts`, applied in `runOne`: unapproved rules give Inconclusive and no finding. Test: a draft rule on a faulty course gives no verdict and no FUN-002; reviewed rules work as before. **Open:** a draft rule marked "use to get past this screen" still helps the walk, because that produces no verdict. Draft library cases are still run as before. |

## Other findings

| ID | Finding | Status | Evidence |
| --- | --- | --- | --- |
| A6 | Conditional rules use the wrapper page, not the course frame | **Still open** | Confirmed: `functional.ts` still passes the top-level page for `rule_*` tests. Needs a framed fixture. |
| A7 | Negative rule checks shorten the timing window | **Still open** | Confirmed: the absence window is capped at 3 s, and 800 ms while media is started. |

## Known limitations from the audit

| Item | Status | Evidence |
| --- | --- | --- |
| Rise LMS bypass applied without being shown | Still open, due in Phase 8 | `runner.ts:212` and `:429` |
| No Playwright trace capture | Still open, due in Phase 9 | No `context.tracing` in `apps` or `packages` |
| `prerequisites` and `resetPolicy` accepted but unused | Still open | No use of either in `apps/worker/src` |
| Frame eligibility too broad | Still open, due in Phase 12 | `content-root.ts` compares the last two hostname labels |
| Browser check looks at the full Chromium path while scans are headless | Still open | `capabilities.ts:23` |
| Team hosting and login | Still open | Server binds to loopback with no login |
| Real-course evidence is limited | Still open | One Rise course; several recipes fixture-only |

## Separate code review of these fixes

Ran on the uncommitted fixes. Ten points were raised and nine were acted on:

- The check identity could not match one finding across several screens.
- Older control findings were still accepted.
- Reused process numbers could block the tool.
- The lock could be taken twice in a race.
- Lesson tabs named like player controls were shared.
- The browser check held back findings that do not depend on the browser.
- Linked player controls counted as untested.
- A cancelled scan could leave copies waiting.
- The "is this rule confirmed" test was written in three places.

The tenth, merging three similar blocks of code, is a tidy-up and was left.

## Compatibility

No database migration: the new fields live in stored JSON. Findings saved before this change on per-control rules show as Not retested rather than Verified until they are found again in a new scan.

## Test results (9 November 2026)

- Type-check: clean.
- Audit and related fast tests: 89 of 89 passed.
- Browser tests (rules, traversal, functional, recipes, flows): 65 of 65 passed, before the code-review changes.
- Whole suite after the code-review changes: 417 passed, 0 failed, 1 file skipped (`real-exports`). This run took over 45 minutes.
- Proof that the tests catch the problems: each of 16 parts of the fixes was removed in turn. All 16 made at least one test fail, and each file was restored and its contents confirmed identical. The audit tests then passed again (21 of 21).
