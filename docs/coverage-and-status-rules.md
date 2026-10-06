# Coverage and status rules

How the app turns recorded test results into the statuses and numbers it shows. The rules are code (`packages/core/src/qa/aggregation.ts`) with unit tests (`tests/qa-aggregation.test.ts`); this page says the same thing in words. Every number comes from stored rows. Nothing comes from a timer or an estimate.

## Three separate statuses

| Kind | Who sets it | Values |
| --- | --- | --- |
| **Test status** (one per check on one screen or control) | The scanner, when a check ends | Not run yet, Running, Passed, Failed, Blocked, Runner error, Skipped, Not applicable, Needs manual review |
| **Automated screen status** (one per screen) | Computed from that screen’s test statuses | Not tested, In progress, Issues found, Needs manual review, Passed automated checks |
| **Reviewer decision** | A person | Accepted, False positive, Retest requested, Manual pass, Manual fail |

A reviewer decision is stored beside the automated result with who decided, when, why, and what the automated status was at that moment. It never replaces the automated result, and it never turns an automated failure into an automated pass.

Every status other than Passed carries a reason.

- A **Failed** check has a confirmed expected behavior and an observed behavior that differs from it.
- A **Runner error** or **Blocked** check is about the scan, not about the course. A control that could not be found again, a page that did not load, or an ambiguous selector is never reported as a course defect.
- **Needs manual review** is used when the expected result is unknown, the scanner has no automation for the case, or the outcome could not be observed.
- **Not applicable** is only counted as excluded when it has a recorded reason. A not-applicable result with no reason counts as a gap.

## Screen status, in order

The first rule that fits wins.

1. **In progress**: at least one check on the screen is running.
2. **Issues found**: at least one applicable check failed. Gaps on the same screen are still shown beside it as badges, so a screen with issues and gaps shows both.
3. **Not tested**: no check passed and nothing is open (no blocked, errored, skipped, manual or not-yet-run checks). An empty result is never a pass.
4. **Passed automated checks**: at least one check passed, nothing is open, and either a browser actually showed the screen or every executed check was a static one.
5. **Needs manual review**: everything else. That includes a screen with passes plus one blocked, errored, skipped, manual or pending check; a screen with only manual-review cases; and a screen that passed checks but that no browser ever showed.

Badges that can sit beside a status: Partially checked, Not visited by a browser, Manual checks pending, Static checks only, Blocked checks, Runner errors, Reviewer decision recorded.

### Static-only results

A run that only read the package files can say **“Passed selected static checks”**, and the screen shows **Static checks only. Functional behavior was not tested.** It never becomes a general functional pass. A screen with both static and functional passes is treated as functional.

## What a “screen” is

The counting unit depends on what the course is, and the report says which:

| Course | Units counted for visits | Listed, not tracked one by one |
| --- | --- | --- |
| Rise | Lessons | Blocks |
| Storyline | Slides | Scenes, layers |
| Other HTML or SCORM | Screens a browser reached (grouped by lesson or slide ID when the page states one, otherwise by address), and package items that contain nothing else | Package items that contain others |

Blocks and layers are listed in the inventory with their source and confidence. They are not given a visit status of their own, because opening a Rise lesson does not prove every block was seen.

Each unit records a stable ID, a title (a flagged readable fallback when the course gives none; titles are never invented), the source identifier when there is one, its parent, where it was discovered (package manifest, authoring export, player menu or run time), and a confidence. Units with the same page title are told apart by their location.

## Coverage dimensions (kept apart)

1. **What the course contains**: how it was discovered and how sure that is.
   - *Complete*: the list came from the package or player menu and nothing extra appeared at run time. Even then it is “as far as the package shows”, not proof of exhaustiveness.
   - *Partial*: the run found screens the course’s own list did not show, or some items have low confidence.
   - *Unknown*: only what a browser saw is listed (always the case for a plain web address).
2. **Units visited** = units a browser showed ÷ units discovered. With discovery *unknown* there is no percentage; the app says “N found so far”.
3. **Interactions exercised** = detected interactions that have a passed or failed check ÷ detected interactions. Clicking a control during exploration does not count as exercising it.
4. **Automated checks executed** = (passed + failed) ÷ mapped applicable automated checks. Blocked, errored, skipped, running and not-yet-run checks do not count as executed. Manual-only cases are not in the denominator; they are shown separately.
5. **States and branches**: reached states are listed. The total number of states and click orders is not known, so branch coverage is partial by definition. The app never claims exhaustive coverage.
6. **Manual review outstanding**: checks that need a person, plus not-applicable results that gave no reason.

**Pass rate** = passed ÷ (passed + failed), shown only when at least one check passed or failed.

When a denominator is zero or unknown, the app shows **Not available** with the reason. It never shows 100%. Counts and denominators appear beside every percentage, and the dimensions are never combined into one score.

Example of the generated statement:

> 24 of 30 discovered slides visited. 68 of 90 mapped automated checks executed (60 passed, 8 failed); 22 blocked, errored, skipped or not run. 6 slides not reached. 12 manual checks remain. Inventory discovery: partial.

If a denominator changes (new screens were discovered), the inventory revision increases and the “found so far” count changes. The progress panel and the Coverage tab show the new numbers.

## Run lifecycle

Stages: Queued, Validating, Discovering, Running, Finalizing, then one of **Completed**, **Completed with gaps**, **Failed**, **Cancelled**.

Finishing the work is different from covering the course. A run is **Completed** only when its result was clean *and* discovery is complete, every known unit was visited, nothing is blocked, errored, skipped or pending, and no manual checks remain. In every other finished case it is **Completed with gaps**, which is the normal outcome for a scan of a plain web address, because the scanner has no independent list of what the course contains.

Pause and resume are not offered: the worker cannot safely rebuild a browser session from a half-finished scan. Cancel stops the active work, keeps partial results, and leaves unexecuted checks listed as not run.

## Durability and recovery

- Progress is stored as a snapshot plus a numbered event log. The page asks for the snapshot and for events after the last number it applied, so a refresh, a second browser or a reconnect rebuilds the same view. An event at or below the last applied number is ignored.
- Counters are recomputed from the rows every time, so a retry or repeated event cannot count anything twice. Finalizing is idempotent.
- The worker writes a heartbeat once a second. If a run is still active and the heartbeat is older than `CQA_STALL_SECONDS` (default 60), the page says the worker is unresponsive and keeps the results saved so far.
- A run interrupted by a crash or cancel marks running checks as errors and not-yet-run checks as skipped, with a reason. A timeout alone never counts as a finished check.
- Scans made before this feature have no such records. They show “Coverage was not recorded in this older scan” instead of invented numbers.

## Retests and stale results

Each scan records the content hash (package SHA-256, or the opening screen’s signature for a web address), the configuration hash, the engine version and the test case version on every result. A retest is a new scan: it records its own results, and an earlier result is never carried over as a pass for changed content. Earlier attempts on the same screen and control inside one scan are kept as numbered attempts and appear in the exports.
