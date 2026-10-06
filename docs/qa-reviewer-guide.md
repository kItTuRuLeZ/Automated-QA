# QA reviewer guide

For instructional designers, graphic designers and QA reviewers. You do not need to know how the scanner works.

## The five steps

**Upload course → Choose checks → Run QA → Review screens → Export report.** The bar at the top of the setup and results pages shows where you are.

### 1. Upload the course

Open a project and choose **Start new scan**. Give the published link, or upload the course as a ZIP (SCORM 1.2, SCORM 2004 or HTML5 export). A ZIP is looked at first without being run. The page then tells you what it is (for example *Rise 360* or *Storyline 360*), how many lessons or slides its own files list, and what the next step does. A project’s source file (a `.story` or Rise project file) is not a published course and cannot be scanned.

### 2. Choose checks

| Choice | What it does |
| --- | --- |
| **Quick check** | Opens the first page and reads the files. Interaction behavior is not executed. |
| **Functional check** | Opens the course, clicks through it, and runs the test cases and your behavior rules. |
| **Full available check** | Everything the tool can run, plus a list of cases only a person can do. It does not cover all possible course behavior. |
| **Custom** | You pick. |

The page lists what will run, what goes to the manual review list, and what this tool cannot do at all (real devices, a real LMS, drag and drop, video playback, quiz scoring). Timeouts, other websites the course needs, and limits are under **Advanced settings**.

### 3. Run QA

The progress panel shows the real stage, the screen being checked, how many screens have been found and opened, how many checks have a result, and the elapsed time. It does not show a percentage or a time estimate when the tool cannot know how big the course is. You can leave the page, refresh, or open it on another computer; the scan carries on. If the worker stops reporting, the page says so and keeps the results saved so far. **Cancel scan** stops the work, keeps what finished, and leaves the rest listed as not run.

### 4. Review screens

Open the **Screens** tab. The left side is the course outline; the middle is the selected screen’s results; the evidence for one result sits below or beside it.

Filters: **Needs attention** (the default), **Issues found**, **Needs manual review**, **Passed automated checks**, **Not tested**, **All screens**. You do not have to open every passed screen. **Spot-check a passed screen** opens one at random if you want a sample.

What the statuses mean:

| Status | Meaning |
| --- | --- |
| **Issues found** | A check that applies here failed. The result shows what was expected, what happened, and the evidence. |
| **Needs manual review** | Nothing failed, but something could not be decided: no automation exists, the expected result is unknown, a check was blocked or hit a runner error, or the screen was never opened. |
| **Passed automated checks** | At least one check passed, nothing else is open, and a browser really showed the screen. This is not “error-free”. It says only that the automated checks that apply here passed. |
| **Not tested** | No check ran. No findings here does not mean it was tested. |

**Blocked** and **Runner error** describe the scan, not the course. Do not report them as defects.

If a screen says **Static checks only**, only the package files were read; how it behaves was not tested.

Each result shows *Expected* with its source (a reviewer-approved case, a specification, the starter baseline, …). Starter baseline results are not client requirements; confirm them before raising a defect.

**Recording your own decision.** On a result or a screen choose a decision, give a reason, and save: *Accept this result*, *Mark as a false positive*, *Request a retest*, *Record a manual pass*, *Record a manual failure*. Your name, the time, your reason and the automated result at that moment are kept. The automated result stays as it was. (*Request a retest* records the request; start the retest from the Issues tab.)

**Issues** and **Retest.** Failures become issues with an owner and a status like any other finding. “Marked fixed” is your note that the change was made; only a retest can set “Verified”.

### 5. Export the report

**Download report** gives the Excel issue tracker, PDF and HTML report, and the **QA results workbook** with these sheets: Summary, Course Coverage, Findings, Test Results, Manual Review, Interaction Logic, Run Details. CSV exports and a complete JSON file are under technical exports. Coverage lists passed screens, screens with issues, partly checked screens and screens never tested, not only failures. Editing a downloaded file does not change anything in the app.

## Adding a behavior rule

Use this for “after the learner opens all four items, Next should unlock”.

1. Open the project, then **Behavior rules → New rule**.
2. Name the rule and the screen (a part of its title; empty means the first screen).
3. List the items the learner must use, one per line, as they appear on screen. Use **Choose from the last scan** to add them without typing.
4. List optional items, if any, so the scan can check they do not count.
5. Choose what should happen (for example *A button becomes enabled*), what to watch (*Next*), and how long to wait.
6. Choose *Any order* or *Must be in the order listed*.
7. Save. The next Functional or Full scan tests it.

A scan reports whether the event fires after the last item, whether it fires too early (and after which click), whether repeated clicks on one item wrongly complete it, whether optional items wrongly count, and whether other orders behave as the rule says. The result shows the ordered list of clicks and what was seen after each. If the scan cannot find an item, or it matches several controls, the result is **Blocked** and says why.

## Adding your team’s test cases

**Test library → Import team cases**, or write one with **New case**. See *functional-test-library.md*. Imported cases start as drafts and as manual cases.

## What this tool does not tell you

A finished scan, with no issues, is not a QA sign-off. It does not test a real LMS, real devices, spelling and grammar, quiz scoring, drag and drop, or video and audio playback. It does not try every click order. The coverage numbers always show what they are out of. Anything the tool could not do is listed as **manual** or **blocked**, never as passed.
