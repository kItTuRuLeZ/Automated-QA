import { type ChangeEvent, useState } from 'react';
import { type AssessmentSpec, type BehaviorRule, type RuleItem, isRuleConfirmed } from '@cqa/shared';
import { qaApi } from '../../api-qa';
import { Alert, Empty, ErrorBox, Loading, useLoader } from '../ui';
import { keyToLines, linesToKey } from './answer-key';

const EVENTS: Array<[BehaviorRule['expectedEvent'], string, string]> = [
  ['next_enabled', 'A button becomes enabled', 'Name the button, for example Next.'],
  ['message_shown', 'A message appears', 'Type the message text exactly as learners see it.'],
  ['layer_opened', 'A layer or dialog opens', 'Optional: name something that appears in it. Leave empty for any dialog.'],
  ['navigation_changed', 'The screen changes', 'Nothing to name: the address changing counts.'],
  ['progress_changed', 'A progress indicator changes', 'Name the indicator, for example its visible label.'],
  ['completion_emitted', 'The course reports completion', 'Needs the course to be scanned as a SCORM package: it is read from the SCORM test harness, not from a real LMS.'],
];
const SOURCES: Array<[BehaviorRule['expectationSource'], string]> = [
  ['approved_case', 'A reviewer-approved case'],
  ['specification', 'A specification or storyboard'],
  ['extracted_metadata', 'Extracted from the course files'],
  ['starter_baseline', 'Starter baseline'],
  ['observed_hypothesis', 'Observed behavior, not yet confirmed'],
];

const toLines = (items: RuleItem[]) => items.map((i) => (i.locator ? `${i.label} | ${i.locator}` : i.label)).join('\n');
const fromLines = (s: string): RuleItem[] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [label, locator] = l.split('|').map((x) => x.trim());
      return locator ? { label: label!, locator } : { label: label! };
    });


/** Behavior rules in plain fields: "After every required item has been visited, enable Next." No selectors or code are needed. */
const TEMPLATES: Array<{ id: string; label: string; draft: Partial<BehaviorRule> }> = [
  { id: 'quiz', label: 'Quiz question: answer and continue', draft: { title: 'Quiz question: answer and continue', unitMatch: 'QUESTION', requiredItems: [{ label: '[first option]' }, { label: 'Submit' }], expectedEvent: 'next_enabled', eventTarget: 'Next', orderPolicy: 'sequence', continueAfter: true } },
  { id: 'drag', label: 'Drag items onto targets', draft: { title: 'Drag and drop: place the items and continue', unitMatch: 'DRAG', requiredItems: [{ label: 'drag: Item 1 -> Target 1' }, { label: 'drag: Item 2 -> Target 2' }, { label: 'Submit' }], expectedEvent: 'next_enabled', eventTarget: 'Next', orderPolicy: 'sequence', continueAfter: true } },
  { id: 'unlock', label: 'Open every item before Next unlocks', draft: { title: 'Next unlocks after every item is opened', unitMatch: '', requiredItems: [{ label: 'Item 1' }, { label: 'Item 2' }, { label: 'Item 3' }], expectedEvent: 'next_enabled', eventTarget: 'Next', orderPolicy: 'any_order', continueAfter: false } },
];

export function RulesPanel({ projectId }: { projectId: string }) {
  const rules = useLoader(() => qaApi.rules(projectId), [projectId]);
  const [editing, setEditing] = useState<BehaviorRule | 'new'>();
  const [template, setTemplate] = useState<Partial<BehaviorRule>>();
  const [imported, setImported] = useState<{ tone: 'ok' | 'error'; text: string }>();

  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const f = input.files?.[0];
    if (!f) return;
    setImported(undefined);
    try {
      let content: unknown;
      try {
        content = JSON.parse(await f.text());
      } catch {
        throw new Error('That file is not valid JSON, so nothing was imported.');
      }
      const { imported: n } = await qaApi.importRules(projectId, content);
      setImported({ tone: 'ok', text: `Imported ${n} rule${n === 1 ? '' : 's'} as draft. Their tests stay inconclusive until each one is approved.` });
      rules.reload();
    } catch (err) {
      setImported({ tone: 'error', text: (err as Error).message });
    } finally {
      input.value = '';
    }
  };

  return (
    <section className="card" aria-labelledby="rules-h">
      <div className="toolbar">
        <div>
          <h2 id="rules-h">Behavior rules</h2>
          <p className="muted">Say what should happen on a screen, in plain fields. A scan then tests it: the event must not appear early, must appear after the last required item, and must not be fooled by repeated clicks or optional items. Without a rule, the scanner cannot know what should happen, so those cases go to manual review instead of passing.</p>
        </div>
        <div>
          <label htmlFor="rule-template" className="sr-only">Start from a template</label>
          <select id="rule-template" value="" onChange={(e) => { const t = TEMPLATES.find((x) => x.id === e.target.value); if (t) { setTemplate(t.draft); setEditing('new'); } }}>
            <option value="">Start from a template…</option>
            {TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>{' '}
          <button type="button" className="btn btn-primary" onClick={() => { setTemplate(undefined); setEditing('new'); }}>
            New rule
          </button>
        </div>
      </div>
      <p>
        <a className="btn btn-small" href={`/api/projects/${encodeURIComponent(projectId)}/behavior-rules/export`}>Export rules</a>{' '}
        <label className="btn btn-small">
          Import rules<input type="file" accept=".json,application/json" className="sr-only" onChange={(e) => void importFile(e)} />
        </label>
      </p>
      {imported && <p role="status" className={imported.tone === 'error' ? 'alert alert-error' : 'muted'}>{imported.text}</p>}
      {rules.error ? (
        <ErrorBox error={rules.error} onRetry={rules.reload} />
      ) : !rules.data ? (
        <Loading />
      ) : rules.data.length === 0 && !editing ? (
        <Empty title="No behavior rules yet">
          <p>Add one for a screen where finishing every item should unlock something, such as Next.</p>
        </Empty>
      ) : (
        <ul className="plain">
          {rules.data.map((r) => (
            <li key={r.id}>
              <strong>{r.title}</strong> <span className="muted">· {r.requiredItems.length} required item{r.requiredItems.length === 1 ? '' : 's'} · {EVENTS.find((e) => e[0] === r.expectedEvent)?.[1]} · {r.reviewState} · version {r.version ?? 1}{isRuleConfirmed(r) || r.reviewState === 'retired' ? '' : ' · provisional'}</span>{' '}
              <button type="button" className="btn btn-small" onClick={() => setEditing(r)}>
                Edit<span className="sr-only"> {r.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <RuleForm key={editing === 'new' ? `new-${template?.title ?? ''}` : editing.id} projectId={projectId} rule={editing === 'new' ? undefined : editing} initial={editing === 'new' ? template : undefined} onDone={() => (setEditing(undefined), setTemplate(undefined), rules.reload())} />}
    </section>
  );
}

function RuleForm({ projectId, rule, initial, onDone }: { projectId: string; rule?: BehaviorRule; initial?: Partial<BehaviorRule>; onDone: () => void }) {
  const base: Partial<BehaviorRule> | undefined = rule ?? initial;
  const [title, setTitle] = useState(base?.title ?? '');
  const [unitMatch, setUnitMatch] = useState(base?.unitMatch ?? '');
  const [required, setRequired] = useState(toLines(base?.requiredItems ?? []));
  const [optional, setOptional] = useState(toLines(base?.optionalItems ?? []));
  const [event, setEvent] = useState<BehaviorRule['expectedEvent']>(base?.expectedEvent ?? 'next_enabled');
  const [target, setTarget] = useState(base?.eventTarget ?? 'Next');
  const [windowSec, setWindowSec] = useState(String((base?.timingWindowMs ?? 2000) / 1000));
  const [order, setOrder] = useState<BehaviorRule['orderPolicy']>(base?.orderPolicy ?? 'any_order');
  const [repeat, setRepeat] = useState<BehaviorRule['repeatPolicy']>(base?.repeatPolicy ?? 'once');
  const [reset, setReset] = useState<BehaviorRule['resetPolicy']>(base?.resetPolicy ?? 'fresh_context');
  const [destination, setDestination] = useState(base?.destination ?? '');
  const [continueAfter, setContinueAfter] = useState(base?.continueAfter ?? false);
  const [source, setSource] = useState<BehaviorRule['expectationSource']>(base?.expectationSource ?? 'approved_case');
  const [review, setReview] = useState<BehaviorRule['reviewState']>(base?.reviewState ?? 'draft');
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const [pick, setPick] = useState(false);
  const quiz = base?.assessment;
  const [isQuiz, setIsQuiz] = useState(Boolean(quiz));
  const [key, setKey] = useState(keyToLines(quiz));
  const [submitLabel, setSubmitLabel] = useState(quiz?.submit ?? 'Submit');
  const [selection, setSelection] = useState<AssessmentSpec['selection']>(quiz?.selection ?? 'single');
  const [mustAnswer, setMustAnswer] = useState(Boolean(quiz?.unanswered));
  const [blankMessage, setBlankMessage] = useState(quiz?.unanswered?.message ?? '');
  const [retryLabel, setRetryLabel] = useState(quiz?.retry?.control ?? '');
  const [maxAttempts, setMaxAttempts] = useState(quiz?.retry?.maxAttempts ? String(quiz.retry.maxAttempts) : '');
  const discovered = useLoader(() => (pick ? qaApi.discovered(projectId) : Promise.resolve(undefined)), [projectId, pick]);

  const save = async () => {
    if (state === 'saving') return;
    setState('saving');
    setError(undefined);
    try {
      if (isQuiz && !linesToKey(key).length) throw new Error('Add at least one line to the answer key, or untick "This screen is a quiz question".');
      const assessment: AssessmentSpec | undefined = isQuiz
        ? { submit: submitLabel, selection, cases: linesToKey(key), ...(mustAnswer ? { unanswered: blankMessage ? { message: blankMessage } : {} } : {}), ...(retryLabel ? { retry: { control: retryLabel, ...(maxAttempts ? { maxAttempts: Number(maxAttempts) } : {}) } } : {}) }
        : undefined;
      await qaApi.saveRule(
        projectId,
        // A quiz needs no separate click list: its required items are the answer key's correct answers, then Submit.
        { assessment, title, unitMatch, requiredItems: required.trim() || !assessment ? fromLines(required) : [...(assessment.cases.find((c) => c.correct)?.answers ?? assessment.cases[0]!.answers).map((label) => ({ label })), { label: assessment.submit }], optionalItems: fromLines(optional), prerequisites: rule?.prerequisites ?? [], expectedEvent: event, eventTarget: target, timingWindowMs: Math.round(Number(windowSec) * 1000), orderPolicy: order, repeatPolicy: repeat, resetPolicy: reset, destination: destination || undefined, continueAfter, expectationSource: source, reviewState: review },
        rule?.id,
      );
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };
  const remove = async () => {
    if (!rule || !window.confirm(`Delete the rule "${rule.title}"? Past scans keep their results.`)) return;
    await qaApi.deleteRule(rule.id);
    onDone();
  };
  const evHelp = EVENTS.find((e) => e[0] === event)![2];

  return (
    <form
      className="form"
      aria-label={rule ? `Edit rule ${rule.title}` : 'New rule'}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{rule ? 'Edit rule' : 'New rule'}</h3>
      <div className="field">
        <label htmlFor="r-title">Name</label>
        <input id="r-title" required value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="Next unlocks after all four topics" />
      </div>
      <div className="field">
        <label htmlFor="r-unit">Which screen</label>
        <input id="r-unit" value={unitMatch} onChange={(e) => setUnitMatch(e.target.value)} placeholder="Part of the screen’s title" />
        <p className="help">Leave empty for the first screen the scan opens.</p>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="r-req">Items the learner must use (one per line)</label>
          <textarea id="r-req" required={!isQuiz} rows={5} value={required} onChange={(e) => setRequired(e.target.value)} placeholder={'Alpha\nBravo\nCharlie\nDelta'} aria-describedby="r-req-h" />
          <p id="r-req-h" className="help">Type each item’s visible name. If two items share a name, add a selector after a bar: Name | #id. If audio or video must play to its end, name its play button after media: like this: media: Play narration.</p>
        </div>
        <div className="field">
          <label htmlFor="r-opt">Optional items (one per line)</label>
          <textarea id="r-opt" rows={5} value={optional} onChange={(e) => setOptional(e.target.value)} aria-describedby="r-opt-h" />
          <p id="r-opt-h" className="help">Items that must not count toward the requirement. The scan checks they do not.</p>
        </div>
      </div>
      <p>
        <button type="button" className="btn btn-small" onClick={() => setPick((p) => !p)} aria-expanded={pick}>
          Choose from the last scan
        </button>
      </p>
      {pick && (
        <div className="item-picker" role="group" aria-label="Controls found in the last scan">
          {!discovered.data ? (
            <Loading />
          ) : discovered.data.items.length === 0 ? (
            <p className="muted">No scan with recorded results yet, so there is nothing to choose from. Run a scan, or type the names above.</p>
          ) : (
            <ul className="plain">
              {discovered.data.items.map((i) => (
                <li key={i.id}>
                  <span>
                    {i.label} <span className="muted">· {i.type.replace(/_/g, ' ')} on {i.unitTitle}</span>
                  </span>
                  <span>
                    <button type="button" className="btn btn-small" onClick={() => setRequired((r) => (r ? `${r}\n${i.label}` : i.label))}>
                      Add as required<span className="sr-only"> {i.label}</span>
                    </button>{' '}
                    <button type="button" className="btn btn-small" onClick={() => setOptional((r) => (r ? `${r}\n${i.label}` : i.label))}>
                      Add as optional<span className="sr-only"> {i.label}</span>
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="r-ev">What should happen</label>
          <select id="r-ev" value={event} onChange={(e) => setEvent(e.target.value as BehaviorRule['expectedEvent'])}>
            {EVENTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="r-target">What to watch</label>
          <input id="r-target" value={target} onChange={(e) => setTarget(e.target.value)} maxLength={300} aria-describedby="r-target-h" />
          <p id="r-target-h" className="help">{evHelp}</p>
        </div>
        <div className="field">
          <label htmlFor="r-win">How long to wait for it (seconds)</label>
          <input id="r-win" type="number" min={0.2} max={30} step={0.1} value={windowSec} onChange={(e) => setWindowSec(e.target.value)} />
          <p className="help">Also how long “it does not happen” is observed.</p>
        </div>
        <div className="field">
          <label htmlFor="r-dest">Where it should lead (optional)</label>
          <input id="r-dest" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Text on the next screen" />
        </div>
      </div>
      <div className="field">
        <label>
          <input type="checkbox" checked={continueAfter} onChange={(e) => setContinueAfter(e.target.checked)} /> Also use these steps to get past this screen when scanning the course
        </label>
        <p className="help">For a quiz question or any screen that keeps Next disabled until something is done. The scan performs the required items in order, then carries on to the next screen. To answer any question without naming the answer, write [first option] as an item. To drag something onto something else, write: drag: Chip One {'->'} Zone A (use the text, picture description or selector of each). Leave it off if the rule should only be tested.</p>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="r-order">Order</label>
          <select id="r-order" value={order} onChange={(e) => setOrder(e.target.value as BehaviorRule['orderPolicy'])}>
            <option value="any_order">Any order</option>
            <option value="sequence">Must be in the order listed</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="r-rep">How often it happens</label>
          <select id="r-rep" value={repeat} onChange={(e) => setRepeat(e.target.value as BehaviorRule['repeatPolicy'])}>
            <option value="once">Once</option>
            <option value="repeatable">Every time</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="r-reset">Start each test from</label>
          <select id="r-reset" value={reset} onChange={(e) => setReset(e.target.value as BehaviorRule['resetPolicy'])}>
            <option value="fresh_context">A fresh copy of the screen</option>
            <option value="reload">A reload</option>
            <option value="none">Where the last test stopped</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="r-src">Where this expectation comes from</label>
          <select id="r-src" value={source} onChange={(e) => setSource(e.target.value as BehaviorRule['expectationSource'])}>
            {SOURCES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="r-rev">Approval</label>
          <select id="r-rev" value={review} onChange={(e) => setReview(e.target.value as BehaviorRule['reviewState'])}>
            {['draft', 'reviewed', 'approved', 'retired'].map((v) => (
              <option key={v} value={v}>
                {v[0]!.toUpperCase() + v.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>
          <input type="checkbox" checked={isQuiz} onChange={(e) => setIsQuiz(e.target.checked)} /> This screen is a quiz question, and I have its answer key
        </label>
        <p className="help">Correct answers are never guessed. With an answer key, the scan tries each answer from a fresh start and checks the feedback, score and retries. Without one, these checks go to a person.</p>
      </div>
      {isQuiz && (
        <div className="form-grid">
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="r-key">Answer key (one case per line)</label>
            <textarea id="r-key" rows={4} value={key} onChange={(e) => setKey(e.target.value)} placeholder={'Right answer | correct | Paris | Well done. | Score: 100\nWrong answer | incorrect | London | Not quite. | Score: 0'} aria-describedby="r-key-h" />
            <p id="r-key-h" className="help">Name | correct or incorrect | the answers, separated by ; | the feedback shown | the score shown (optional). If your text contains | or ; put a backslash before it.</p>
          </div>
          <div className="field">
            <label htmlFor="r-submit">Submit button</label>
            <input id="r-submit" value={submitLabel} onChange={(e) => setSubmitLabel(e.target.value)} maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="r-sel">Answers allowed</label>
            <select id="r-sel" value={selection} onChange={(e) => setSelection(e.target.value as AssessmentSpec['selection'])}>
              <option value="single">One answer</option>
              <option value="multiple">Several answers</option>
            </select>
          </div>
          <div className="field">
            <label>
              <input type="checkbox" checked={mustAnswer} onChange={(e) => setMustAnswer(e.target.checked)} /> An answer is required before submitting
            </label>
            <input aria-label="Message shown when no answer is chosen" value={blankMessage} onChange={(e) => setBlankMessage(e.target.value)} maxLength={300} placeholder="Message shown when no answer is chosen (optional)" disabled={!mustAnswer} />
          </div>
          <div className="field">
            <label htmlFor="r-retry">Retry button (optional)</label>
            <input id="r-retry" value={retryLabel} onChange={(e) => setRetryLabel(e.target.value)} maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="r-max">Attempts allowed (optional)</label>
            <input id="r-max" type="number" min={1} max={10} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} />
          </div>
        </div>
      )}
      {review !== 'reviewed' && review !== 'approved' && review !== 'retired' && <Alert tone="note">While this rule is a draft, its tests show as inconclusive and never count as a pass or a defect. Set Approval to Reviewed or Approved when it is ready.</Alert>}
      {source === 'observed_hypothesis' && <Alert tone="warn">An observed behavior is a guess until someone confirms it. Its tests show as inconclusive and never count as a pass or a defect. Change the source above once it is confirmed.</Alert>}
      {state === 'error' && <p role="alert" className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={state === 'saving'}>
          {state === 'saving' ? 'Saving…' : 'Save rule'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        {rule && (
          <button type="button" className="btn btn-danger" onClick={() => void remove()}>
            Delete rule
          </button>
        )}
      </div>
    </form>
  );
}
