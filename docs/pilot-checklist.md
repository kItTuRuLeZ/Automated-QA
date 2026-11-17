# Pilot checklist

Run each item on the pilot computer and tick it only when you have seen the stated result. A scan that finishes is not, by itself, a pass.

| # | Check | How | Expected result | Done |
| --- | --- | --- | --- | --- |
| 1 | Ready to scan | Help → System status | "Scanning browser (Chromium)" shows Available | ☐ |
| 2 | A working course | Upload a course known to work, with interactions on; open the scan | Screens marked "Passed configured checks" where checks applied; no defects you cannot explain | ☐ |
| 3 | A course with known faults | Upload a copy with faults you planted (a broken tab, a dead flip card, a Continue that unlocks too early) | Each planted fault appears as an issue with expected and actual behavior and a screenshot | ☐ |
| 4 | Conditional gating | Add a behavior rule for a screen that must unlock after every item is used (Behavior rules tab), set Approval to Reviewed, rescan | The rule's checks pass on a correct screen and fail on a screen that unlocks early or never | ☐ |
| 5 | Quiz with an answer key | Add a quiz rule with the real answers, set to Reviewed, rescan | Correct and incorrect answers, blank submission and retry are checked; without a key they go to manual review | ☐ |
| 6 | Unknown branch | Scan a course with a screen the walk cannot reach (a locked lesson, a hidden branch) | The screen is listed as not reached; the run is "Finished with gaps", never "complete" | ☐ |
| 7 | Partial run | From **New scan**, scan the course's address with Advanced → Max screens set to 2 | The run ends "partial" at the screen limit; the report's banner says "Partial results"; screens not reached are listed | ☐ |
| 8 | Cancellation | Start a scan and press Cancel scan | Status Cancelled; checks already finished are kept; nothing unrun is shown as passed | ☐ |
| 9 | Evidence review | Open a failed check in the Screens tab | A screenshot, the ordered steps, and a browser trace you can download | ☐ |
| 10 | Export | Download the HTML report, the Excel workbook and the evidence archive | Counts in the report match the Screens tab; the report includes passed screens and reviewer decisions | ☐ |
| 11 | Compare versions | After fixing one planted fault, rescan and open Compare | The fixed fault is Resolved only if its check ran again and passed; the rest stay Still there | ☐ |
| 12 | One copy only | Check that only one window runs `npm start` | Do not test by starting a second copy: it rebuilds the web pages under the open copy. The worker lock that stops a second scan worker is covered by automated tests | ☐ |

Record the course name, its authoring tool and version, the date, and anything unexpected beside each item. Add each real course you test to `docs/compatibility-matrix.md`.
