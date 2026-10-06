import { useState } from 'react';
import type { BehaviorRule, RuleItem } from '@cqa/shared';
import { qaApi } from '../../api-qa';
import { Alert, Empty, ErrorBox, Loading, useLoader } from '../ui';

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
export function RulesPanel({ projectId }: { projectId: string }) {
  const rules = useLoader(() => qaApi.rules(projectId), [projectId]);
  const [editing, setEditing] = useState<BehaviorRule | 'new'>();

  return (
    <section className="card" aria-labelledby="rules-h">
      <div className="toolbar">
        <div>
          <h2 id="rules-h">Behavior rules</h2>
          <p className="muted">Say what should happen on a screen, in plain fields. A scan then tests it: the event must not appear early, must appear after the last required item, and must not be fooled by repeated clicks or optional items. Without a rule, the scanner cannot know what should happen, so those cases go to manual review instead of passing.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          New rule
        </button>
      </div>
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
              <strong>{r.title}</strong> <span className="muted">· {r.requiredItems.length} required item{r.requiredItems.length === 1 ? '' : 's'} · {EVENTS.find((e) => e[0] === r.expectedEvent)?.[1]} · {r.reviewState}</span>{' '}
              <button type="button" className="btn btn-small" onClick={() => setEditing(r)}>
                Edit<span className="sr-only"> {r.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <RuleForm key={editing === 'new' ? 'new' : editing.id} projectId={projectId} rule={editing === 'new' ? undefined : editing} onDone={() => (setEditing(undefined), rules.reload())} />}
    </section>
  );
}

function RuleForm({ projectId, rule, onDone }: { projectId: string; rule?: BehaviorRule; onDone: () => void }) {
  const [title, setTitle] = useState(rule?.title ?? '');
  const [unitMatch, setUnitMatch] = useState(rule?.unitMatch ?? '');
  const [required, setRequired] = useState(toLines(rule?.requiredItems ?? []));
  const [optional, setOptional] = useState(toLines(rule?.optionalItems ?? []));
  const [event, setEvent] = useState<BehaviorRule['expectedEvent']>(rule?.expectedEvent ?? 'next_enabled');
  const [target, setTarget] = useState(rule?.eventTarget ?? 'Next');
  const [windowSec, setWindowSec] = useState(String((rule?.timingWindowMs ?? 2000) / 1000));
  const [order, setOrder] = useState<BehaviorRule['orderPolicy']>(rule?.orderPolicy ?? 'any_order');
  const [repeat, setRepeat] = useState<BehaviorRule['repeatPolicy']>(rule?.repeatPolicy ?? 'once');
  const [reset, setReset] = useState<BehaviorRule['resetPolicy']>(rule?.resetPolicy ?? 'fresh_context');
  const [destination, setDestination] = useState(rule?.destination ?? '');
  const [source, setSource] = useState<BehaviorRule['expectationSource']>(rule?.expectationSource ?? 'approved_case');
  const [review, setReview] = useState<BehaviorRule['reviewState']>(rule?.reviewState ?? 'draft');
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const [pick, setPick] = useState(false);
  const discovered = useLoader(() => (pick ? qaApi.discovered(projectId) : Promise.resolve(undefined)), [projectId, pick]);

  const save = async () => {
    if (state === 'saving') return;
    setState('saving');
    setError(undefined);
    try {
      await qaApi.saveRule(
        projectId,
        { title, unitMatch, requiredItems: fromLines(required), optionalItems: fromLines(optional), prerequisites: rule?.prerequisites ?? [], expectedEvent: event, eventTarget: target, timingWindowMs: Math.round(Number(windowSec) * 1000), orderPolicy: order, repeatPolicy: repeat, resetPolicy: reset, destination: destination || undefined, expectationSource: source, reviewState: review },
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
          <textarea id="r-req" required rows={5} value={required} onChange={(e) => setRequired(e.target.value)} placeholder={'Alpha\nBravo\nCharlie\nDelta'} aria-describedby="r-req-h" />
          <p id="r-req-h" className="help">Type each item’s visible name. If two items share a name, add a selector after a bar: Name | #id.</p>
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
      {source === 'observed_hypothesis' && <Alert tone="warn">An observed behavior is a guess until someone confirms it. Results are marked as such.</Alert>}
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
