# Functional test library

Reusable test cases the scanner runs, and the place your team’s own cases live. Open it from **Test library** in the top bar.

## What a case holds

| Part | Meaning |
| --- | --- |
| ID, team ID | The app’s own stable ID, and your team’s ID if you imported one. Team IDs and wording are kept exactly as given. |
| Title, category, interaction type | What it is about (accordion, tab, dialog, required item group, quiz, …). |
| Severity, priority | Used when a failure becomes a finding. |
| Preconditions, when it applies | What must be true for the case to make sense. |
| Steps | Ordered actions. Manual cases hold plain-language steps. Automated cases hold structured steps (open, activate, activate all, wait, reset). |
| Checks | What is observed afterwards. Structured for automated cases; a question for a person for manual ones. |
| Expected result and its source | Where the expectation comes from: a reviewer-approved case, a specification, extracted metadata, the starter baseline, or an unconfirmed observation. The source is shown next to every result. |
| Evidence to keep | What a reviewer should expect to see (trace, screenshot, observation window). |
| Reset policy, timeout | Fresh copy of the screen, reload, or none; how long a step may take. |
| Course types, environments | Rise, Storyline, HTML5; Chromium (headless). |
| Automation class | **Automated**, **Partly automated**, or **Manual**. See below. |
| Approval | Starter (seeded, not reviewed), Draft, Reviewed, Approved, Retired. |
| Version and history | Every save is a new version; the earlier ones stay in the history with who changed what. |

Definitions are kept separate from results. A definition is never marked passed. A result (an *execution*) records the scan, the screen, the control, the attempt, the case version, timestamps, actual result, status, reason, evidence, and hashes of the content and configuration.

## The starter library

The 69 baseline cases (NAV, ACC, TAB, HOT, CLK, LAY, LOG, MCQ, MSQ, QUIZ, DND, TXT, SLD, FLP, TIM, AUD, VID, MED, LNK, RES, CMP, LMS, A11Y, VIS, ERR) plus three static package cases (STAT-01 to STAT-03) are seeded on first start. Editing a seeded case saves a new version; reseeding never overwrites an edit.

They are **starter baselines, not client requirements**. A failure of a starter case is reported as a heuristic warning with the words “starter baseline; a baseline, not a client requirement”. Approve or rewrite a case, and give it a better expectation source, when your team has a rule.

### Automation is classified by what the scanner really does

| Class | Meaning | Cases today |
| --- | --- | --- |
| **Automated** | The scanner performs the case and judges it | NAV-01, ACC-01, TAB-01, LAY-01, LAY-02, LOG-01 to LOG-05 (need a behavior rule), LNK-01, LMS-01, LMS-03, LMS-04, A11Y-01, VIS-01, ERR-01, ERR-02, STAT-01 to STAT-03 |
| **Partly automated** | The scanner does part of it and a person decides the rest | NAV-02, ACC-02, MED-02, MED-03, LMS-02, A11Y-02, A11Y-03, VIS-02 |
| **Manual** | No automation. Listed in every scan’s manual review queue | Everything else, including quizzes, drag and drop, hotspots, media playback, completion, restart and branching |

An automated or partly automated case must name a capability the scanner has (shown in the case). A case you write or import that names none is stored as manual, whatever the file says. Free-text steps are never run as code.

Cases marked “mapped” are judged from checks the scan already runs (for example ERR-01 from the runtime-error checks, VIS-01 from the layout checks, LMS-04 from the SCORM bookmark and resume check). The result is attached to the screen where the check ran, or to the course for course-wide checks such as link destinations.

## How each automated case is judged (generic HTML adapter)

| Case | What the scanner does | Fails when | Needs a person when |
| --- | --- | --- | --- |
| TAB-01 | Activates a tab | It does not become selected, or the panel it controls does not appear | It has no `aria-controls`, or the old panel stays visible |
| ACC-01 | Opens an accordion item or `<details>` | It does not open, or its content is empty or hidden | No content region is linked |
| ACC-02 | Opens two items in turn | never | always: it records single-open or multi-open and asks whether that is intended |
| LAY-01 | Opens a dialog | No dialog appears or it is empty | |
| LAY-02 | Opens, then dismisses a dialog (close control, else Escape) | It stays open, or focus does not return to the opener | |
| NAV-02 | Next, then Previous | Next changes nothing, or Previous lands on different content | Previous is missing, or text differs at the same address |
| LOG-01 to LOG-05 | Behavior-rule scenarios (see below) | The event fires early, late, never, or for the wrong reason | |

Each test runs in a fresh browser context at a clean copy of the screen it belongs to, and records an ordered trace: opened, acted, observed, asserted.

## Behavior rules and the all-click scenario

A behavior rule says, in plain fields: *which screen*, *which items the learner must use*, *which items are optional*, *what should happen* (a button becomes enabled, a message appears, a layer opens, the screen changes, a progress indicator changes, completion is reported to the SCORM test harness), *what to watch*, *how long to wait*, *order* (any order or a sequence), *how often*, *what to start each test from*, and optionally *where it should lead*. No selectors or code are needed; a picker lists controls found in the last scan.

For items A, B, C, D and “Next becomes enabled”, a scan tests:

1. **LOG-01** from a clean copy: Next is confirmed disabled, then A, B, C, D are activated in order. Next must stay disabled until the last item and become enabled within the timing window. If a destination is set, using Next must reach it.
2. **LOG-02** (premature event): for each required item, activate every other one and leave that item untouched. Next must stay disabled for the whole observation window (not just at one instant). Then the optional items alone, and then all-but-one required items plus the optional ones, so an optional item that counts as a requirement is caught. Up to 6 omissions are tried; the result says if it stopped there.
3. **LOG-03** (duplicate-count protection): one item is activated four times while the others stay untouched. The event must not appear.
4. **LOG-04** (order independence, for any-order rules): reverse order and a fixed shuffle. It does not claim to try every order.
5. **LOG-05** (sequence, for sequence rules): the declared sequence must fire the event; the first two items swapped must not.

A click is never treated as proof. “Fires” is asserted from observable state; “does not fire” is asserted over a window. If the starting state already shows the event, the case is blocked (cannot be tested from a clean state) or, for the premature case, failed. If an item cannot be found or is ambiguous, the case is blocked, not failed.

Without a rule, the expected behavior is unknown, so LOG-01 to LOG-05 go to the manual review queue with that reason. Cases LOG-06 to LOG-10 (persistence, frequency, reset, combined conditions, variables) have no automation and are manual.

## Importing your team’s cases

Open **Test library → Import team cases**.

1. Choose a CSV, Excel (.xlsx) or JSON file. Word and PDF files cannot be imported; copy the cases into the template. A template is available from the Export menu.
2. The importer suggests which of your columns is which. Change any that are wrong and preview again.
3. The preview shows every row: new, already exists (with the case it matches, by ID or team ID), or a problem with the reason (missing title, unknown type, bad priority, duplicate ID in the file, …). Rows with problems are never imported.
4. If any rows already exist, choose **Skip** or **Replace**. Replace saves the file’s version as a new version; the old one stays in the history.
5. Import. Imported cases are **drafts**, are **manual** unless they name a capability the scanner has, and keep your wording and IDs exactly.

JSON import accepts the structured action and check schema (the same one the app exports), validated strictly: unknown step types are rejected, and nothing in a file is executed. Export gives CSV, Excel and JSON. Spreadsheet cells that start with `=`, `+`, `-` or `@` are neutralized on export so a case title cannot run as a formula.

Unstructured team procedures can be brought in as manual cases and stay manual until someone maps them to a supported capability. There is no AI mapping in this version.

## Where expectations come from

In priority order: a reviewer-approved case or rule; a supplied storyboard or specification; metadata reliably read from the course files (with its source); the starter baseline; an observed or inferred hypothesis, which needs confirmation before it can be an assertion. The source is stored on every result and shown next to it. Observing that an event happened proves it happened, not that it was the intended event.
