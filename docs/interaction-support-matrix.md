# Interaction support matrix

What the scanner really tests, and on what evidence. "Real course" means a scan of the Leadership Expectations Rise 360 package (7 Nov 2026). "Fixture" means a local test page built for this purpose. A recipe that has only passed on fixtures may still meet markup it does not expect in a real export.

| Interaction | Case | What is checked | Evidence | When it cannot judge |
| --- | --- | --- | --- | --- |
| Tabs | TAB-01 | The tab becomes selected and its linked panel appears | Real course (9 passed); fixtures | No `aria-controls`: Needs manual review. Control gone: Blocked |
| Accordions and disclosure controls | ACC-01 | The item opens and shows readable content | Real course (navigation menu, 1 passed); fixtures. No Rise accordion block in that course | No linked region: Needs manual review |
| Accordion open policy | ACC-02 | Reports single-open or multi-open | Fixtures | Always Needs manual review until a policy is declared |
| Rise flip cards | FLP-01 | The card flips, the back has content, and it turns back | Real course (10 passed); fixtures with a dead button, an empty back and a card that cannot turn back | No back side in the page: Not supported |
| Carousels (ARIA) | TIM-01 | Next moves through every slide; Previous comes back | **Fixtures only.** Rise process and gallery blocks use other markup and are not covered | Next disabled at the start: Inconclusive. No Previous: Needs manual review |
| Video | VID-01 | Play through a learner's control, time moves, pause stops it. Seeking is not tested | Real course (1 passed); fixture for an undecodable format | Format the scan browser cannot decode, or no play control: Not supported. Time not moving: Inconclusive |
| Audio | AUD-01 | Same as video | **Fixtures only** (working, disconnected play button, missing file) | Same as video |
| Dialogs and layers | LAY-01, LAY-02 | Opens with content; closes; focus returns | Fixtures | Control gone: Blocked |
| Next and Previous | NAV-02 | Next changes the content; Previous returns | Real course (Rise Continue buttons have no way back, so 11 are Needs manual review); fixtures | Disabled Next or no Previous: Needs manual review |
| Links | LNK rules | Link target status, without crawling outside | Fixtures; real scans | Outside links in packages are not requested |
| Conditional rules: all items used, media finished, or a mix | LOG-01 to LOG-05 | Reviewer-defined rules: locked until met, a repeat does not count as a missing item, the named outcome appears | Fixtures only | Rule cannot find its screen, or media does not finish in 2 minutes: Blocked. A rule only inferred from behavior: Inconclusive |
| Quiz questions with an answer key | MCQ-01 to 04, MSQ-01, QUIZ-01 | Selection, blank submission, supplied correct and incorrect answers with feedback and score, retry reset and attempt limit, each from a fresh start | Fixtures only | No answer key: Needs manual review. Answer not on screen: Blocked |
| SCORM screen against tracking | SCO12-008, SCO04-008 | What the screen says, and the bookmark, compared with what the course reported to the test harness | Fixtures only | Harness, not an LMS |

## Not automated yet

These stay as manual cases in the library, listed for a person and never marked passed.

| Interaction | Why |
| --- | --- |
| Rise labeled graphics, process, sorting and scenario blocks | No real sample of their markup has been tested |
| Rise knowledge checks without an answer key | Correct answers are never guessed. Add an answer key to a rule to test them |
| Storyline hotspots and layers | Handled only as a walk step (a temporary workaround until Phase 7) |
| Drag and drop | Needs known targets and expected placements |
| Canvas content, and frames the scanner cannot open | Recorded as Not supported |

## How the Rise walk works

Exploration on Rise follows Continue buttons and links between lessons, each destination once, for at most half the run's time. It does not click in-page controls: the recipes test those, each on a fresh copy of the screen where the control was first found.

Recognised Rise markup, read from a real export: `[data-block-id]`, `[data-continue-btn]`, `.flashcard`, `.flashcard--flipped`, `.flashcard-side--back`, `.flashcard-side-flip__btn` and `[role="tab"]`. Lessons scroll inside their own container and fade blocks in as they appear, and tab ids change on each load, so tabs are located by block id and position. A Rise export from a different version may change any of this.

## Reading "interactions exercised"

The figure counts every control the scan listed, so it stays low on purpose. On the real course it was 21 of 106: most of the rest are 40 links (checked by the link rules, not by a recipe) and repeated course-frame buttons such as Exit Module and Skip to Lesson, which the tool has no recipe for.
