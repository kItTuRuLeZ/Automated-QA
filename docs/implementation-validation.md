# Course QA Automation: Implementation Validation & Fixture Walkthrough

This document records the verification and validation methodology used to validate the Course QA Automation platform, including a detailed step-by-step walkthrough of reference behavioral fixtures and an explicit summary of architectural limitations.

---

## 1. Overview & Verification Strategy

The Course QA Automation platform operates under strict verification invariants:
- **No False Passes**: A screen, control, or check is marked as passed only when real browser execution has verified expected conditions.
- **Evidence-Backed Results**: Every failed or passed check captures an execution trace, expected vs. observed strings, and screenshot evidence where applicable.
- **Deterministic Aggregation**: Pure status aggregation rules ensure identical inputs always yield identical screen statuses and coverage figures.

---

## 2. Reproducible Behavioral Walkthroughs

The behavior rules engine (`packages/core/src/qa/behavior.ts` and test suite `tests/functional.integration.test.ts`) was validated against reference test fixtures simulating common eLearning interaction patterns and authoring defects.

```
                  ┌──────────────────────────────────────────────┐
                  │           Behavior Rule Validation           │
                  └──────────────────────┬───────────────────────┘
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
  ┌─────────────────────────────┐                 ┌─────────────────────────────┐
  │ fixtures/logic-allclick-    │                 │ fixtures/logic-allclick-    │
  │ correct                     │                 │ early                       │
  ├─────────────────────────────┤                 ├─────────────────────────────┤
  │ • 4 items: Alpha..Delta     │                 │ • 4 items: Alpha..Delta     │
  │ • Next unlocks at 4 unique  │                 │ • BUG: Next unlocks at 3    │
  │ • Outcome: 100% Passed      │                 │ • Outcome: Fails LOG-01/02  │
  └─────────────────────────────┘                 └─────────────────────────────┘
```

---

### Walkthrough 1: `fixtures/logic-allclick-correct` (Correct All-Click Logic)

#### Fixture Specification
- **Location**: `fixtures/logic-allclick-correct/index.html`
- **Course Contract**: A multi-item interaction with four required buttons (`Alpha`, `Bravo`, `Charlie`, `Delta`). The `Next` navigation button must remain disabled until all four unique items have been clicked. Repeated clicks on the same item do not advance progress.
- **Rule Definition**: Rule configured with 4 required items, `expectedEvent: 'next_enabled'`, `orderPolicy: 'any_order'`, `resetPolicy: 'fresh_context'`.

#### Execution Scenarios & Verification
1. **Scenario LOG-01 (Standard All-Click)**:
   - *Actions*: Browser activates `Alpha` -> `Bravo` -> `Charlie` -> `Delta`.
   - *Observation*: Initial state verified clean (`Next` disabled). `Next` button becomes enabled immediately following the fourth distinct click.
   - *Result*: **Passed**.
2. **Scenario LOG-02 (Single-Item Omissions)**:
   - *Actions*: Browser runs 4 distinct sub-scenarios leaving one item untouched each time (e.g., skip `Alpha`, skip `Bravo`, skip `Charlie`, skip `Delta`), resetting context between each attempt.
   - *Observation*: `Next` button remains disabled throughout all 4 omission runs.
   - *Result*: **Passed**.
3. **Scenario LOG-03 (Duplicate Click Resistance)**:
   - *Actions*: Browser clicks `Alpha` four times consecutively.
   - *Observation*: Progress counter tracks unique items; `Next` button stays disabled.
   - *Result*: **Passed**.
4. **Scenario LOG-04 (Order Independence)**:
   - *Actions*: Browser clicks all four items in reverse order (`Delta` -> `Charlie` -> `Bravo` -> `Alpha`).
   - *Observation*: `Next` button enables upon the 4th item regardless of activation sequence.
   - *Result*: **Passed**.

**Conclusion**: The fixture satisfies all four scenarios; status is recorded as `passed` with zero findings generated.

---

### Walkthrough 2: `fixtures/logic-allclick-early` (Premature Unlock Defect)

#### Fixture Specification
- **Location**: `fixtures/logic-allclick-early/index.html`
- **Authoring Bug**: The JavaScript logic enables the `Next` button when `count >= 3` instead of requiring all 4 items (`count === 4`).

#### Execution Scenarios & Defect Detection
1. **Scenario LOG-01 Execution**:
   - *Actions*: Browser begins activating items sequentially: `Alpha` (count=1), `Bravo` (count=2), `Charlie` (count=3).
   - *Defect Triggered*: The `Next` button becomes enabled after clicking `Charlie` (3 clicks, 3 unique items), before `Delta` is activated.
   - *Failure Recorded*: Check fails immediately.
   - *Reported Reason*: `Event fired before the last required item was activated.`
   - *Reported Actual*: `After 3 clicks (3 unique items: "Alpha", "Bravo", "Charlie"), event "next_enabled" was observed.`
   - *Evidence*: Captured screenshot of the DOM state at the exact moment of failure.
2. **Scenario LOG-02 Execution**:
   - *Defect Triggered*: When omitting `Delta`, the `Next` button still unlocks after 3 items.
   - *Result*: **Failed**.
3. **Issue Creation**:
   - Creates finding `FUN-002` associated with test execution `LOG-01`.
   - Status marked as `issues_found` on the corresponding screen.

---

## 3. Test Suite Validation Results

The full automated test suite validates all layers across packages and applications:

| Test Suite | Test Count | Scope & Validation Target |
| :--- | :---: | :--- |
| `qa-aggregation.test.ts` | 14 | Deterministic screen status and coverage calculations |
| `qa-library.test.ts` | 12 | Test library CRUD, versioning, CSV/XLSX/JSON import & export |
| `qa-routes.test.ts` | 18 | Fastify API routes, payload validation, progress/inventory endpoints |
| `qa-flows.integration.test.ts` | 5 | Package uploads, unvisited screen detection, cancellation recovery |
| `functional.integration.test.ts`| 10 | Real browser interaction execution on all behavioral fixtures |
| `qa-ui.e2e.test.ts` | 3 | UI E2E tests: library view, screens review tab, coverage denominators |
| `ui-flows.e2e.test.ts` | 15 | Core end-to-end scan creation, project management, and exports |
| `ops.test.ts` | 6 | Operational tooling: database backup, retention policy, and restore |

---

## 4. Honest Known Gaps & Limitations

In keeping with the project's strict commitment to factual engineering disclosures, the following architectural gaps are acknowledged:

1. **No Scoped Rerun**: Rerunning QA currently executes a full scan (`Retest`). Partial or single-screen rerun is scheduled for the next development phase.
2. **No Media-Prerequisite Fixture**: Verification of complex logic requiring full audio or video timeline completion relies on manual review or timing windows rather than synthetic media event triggers.
3. **Polling vs. Real-Time Push**: Live progress updates currently rely on client-side polling (`useLiveRun` interval fetch) rather than Server-Sent Events (SSE) or WebSockets.
4. **No Generative AI**: The system uses zero artificial intelligence or probabilistic language models. All assertions derive from deterministic DOM evaluation and code logic.
5. **Partial Branch Coverage**: Complex courses contain unknown numbers of internal click permutations; branch coverage is bounded by state and depth budgets.
6. **Manual Review Required for Subjective Policies**: The starter test library deliberately classifies ambiguous authoring expectations as `manual_review_required` rather than guessing.
7. **Single Browser Engine**: Automated execution currently targets Chromium via Playwright; WebKit and Firefox support are future roadmap items.
