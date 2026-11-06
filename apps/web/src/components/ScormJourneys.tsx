import { useState } from 'react';

type Action = 'click' | 'fill' | 'press' | 'wait';
export interface StepDraft {
  action: Action;
  /** What to click or type into: the words on screen, or a CSS selector for advanced users. */
  target: string;
  /** Text to type, key to press, or seconds to wait. */
  value: string;
}

export interface JourneyDraft {
  name: string;
  steps: StepDraft[];
  /** What the LMS should show afterwards, in plain words (see RESULTS). */
  result: string;
  scoreMin: string;
  scoreMax: string;
}

export const emptyStep = (): StepDraft => ({ action: 'click', target: '', value: '' });
export const emptyJourney = (name: string): JourneyDraft => ({ name, steps: [emptyStep()], result: '', scoreMin: '', scoreMax: '' });
/** Nothing is checked until the person adds a check: an empty "pass" check with no steps would expect a pass from just opening the course. */
export const presetJourneys = (_version: '1.2' | '2004'): JourneyDraft[] => [];

/** Plain-language results, and the SCORM values each one means. */
const RESULTS: Record<'1.2' | '2004', Array<{ id: string; label: string; expect: Record<string, string> }>> = {
  '1.2': [
    { id: 'passed', label: 'Passed', expect: { status: 'passed' } },
    { id: 'failed', label: 'Failed', expect: { status: 'failed' } },
    { id: 'completed', label: 'Completed', expect: { status: 'completed' } },
    { id: 'incomplete', label: 'Started but not finished', expect: { status: 'incomplete' } },
  ],
  '2004': [
    { id: 'passed', label: 'Completed and passed', expect: { completion: 'completed', success: 'passed' } },
    { id: 'failed', label: 'Completed but failed', expect: { completion: 'completed', success: 'failed' } },
    { id: 'completed', label: 'Completed', expect: { completion: 'completed' } },
    { id: 'incomplete', label: 'Started but not finished', expect: { completion: 'incomplete' } },
  ],
};

const ACTIONS: Array<{ id: Action; label: string; target?: string; value?: string }> = [
  { id: 'click', label: 'Click', target: 'Button or text to click, e.g. Start' },
  { id: 'fill', label: 'Type text', target: 'Box to type into, e.g. Name', value: 'Text to type' },
  { id: 'press', label: 'Press a key', value: 'Key, e.g. Enter' },
  { id: 'wait', label: 'Wait', value: 'Seconds, e.g. 2' },
];

type Step = { action: string; target?: string; value?: string; ms?: number };

/** Words on screen become a text match; anything that already looks like a selector is used as given. */
const toTarget = (t: string) => {
  const s = t.trim();
  return /^([#.[]|text=|role=|css=|xpath=)/.test(s) ? s : `text=${s}`;
};

export function journeysToApi(drafts: JourneyDraft[], version: '1.2' | '2004'): { journeys: Array<{ name: string; steps: Step[]; expect?: Record<string, unknown> }>; problems: string[] } {
  const problems: string[] = [];
  const journeys = drafts.map((d, n) => {
    const label = d.name.trim() || `Check ${n + 1}`;
    const steps: Step[] = [];
    d.steps.forEach((s, i) => {
      const where = `${label}, step ${i + 1}`;
      if (s.action === 'wait') return void steps.push({ action: 'wait', ms: Math.round((Number(s.value) || 1) * 1000) });
      if (s.action === 'press') return void steps.push({ action: 'press', value: s.value.trim() || 'Enter' });
      // An empty row is ignored; a half-filled one is a mistake worth pointing out.
      if (!s.target.trim()) return void (s.value.trim() && problems.push(`${where}: say what to type into.`));
      if (s.action === 'click') steps.push({ action: 'click', target: toTarget(s.target) });
      else steps.push({ action: 'fill', target: toTarget(s.target), value: s.value });
    });
    if (!steps.length) problems.push(`${label}: add at least one step, or remove this check. Without steps the course is only opened, so it cannot be expected to pass or fail.`);
    const expect: Record<string, unknown> = { ...(RESULTS[version].find((r) => r.id === d.result)?.expect ?? {}) };
    if (d.scoreMin) expect.scoreMin = Number(d.scoreMin);
    if (d.scoreMax) expect.scoreMax = Number(d.scoreMax);
    return { name: label, steps, ...(Object.keys(expect).length ? { expect } : {}) };
  });
  return { journeys, problems };
}

/** Optional checks a person writes: do these steps, then the LMS should show this result. */
export function ScormJourneys({ version, value, onChange }: { version: '1.2' | '2004'; value: JourneyDraft[]; onChange: (v: JourneyDraft[]) => void }) {
  const [moreFor, setMoreFor] = useState<number[]>([]);
  const set = (i: number, patch: Partial<JourneyDraft>) => onChange(value.map((d, n) => (n === i ? { ...d, ...patch } : d)));
  const setStep = (i: number, k: number, patch: Partial<StepDraft>) => set(i, { steps: value[i]!.steps.map((s, n) => (n === k ? { ...s, ...patch } : s)) });
  return (
    <fieldset className="fieldset">
      <legend>Check what the LMS records (optional)</legend>
      <p className="help">
        You can skip this. The scan already checks that the course starts, saves progress and reports a status. Add a check only if you want to confirm that a certain path through the course ends with a certain result, for example “answer the quiz correctly, and the LMS shows Passed”.
      </p>
      {value.map((d, i) => {
        const more = moreFor.includes(i);
        return (
          <div key={i} className="card">
            <div className="field">
              <label htmlFor={`j-name-${i}`}>Name of this check</label>
              <input id={`j-name-${i}`} value={d.name} maxLength={80} placeholder="e.g. Pass the final quiz" onChange={(e) => set(i, { name: e.target.value })} />
            </div>
            <p style={{ margin: '0.5rem 0 0.25rem', fontWeight: 600 }}>1. What the scan should do, in order</p>
            <ol style={{ paddingLeft: '1.2rem', margin: 0 }}>
              {d.steps.map((s, k) => {
                const a = ACTIONS.find((x) => x.id === s.action)!;
                return (
                  <li key={k} style={{ marginBottom: '0.4rem' }}>
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                      <label className="sr-only" htmlFor={`j-${i}-a-${k}`}>Action</label>
                      <select id={`j-${i}-a-${k}`} value={s.action} onChange={(e) => setStep(i, k, { action: e.target.value as Action })}>
                        {ACTIONS.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.label}
                          </option>
                        ))}
                      </select>
                      {a.target && <input aria-label={a.target} placeholder={a.target} value={s.target} style={{ flex: '1 1 14rem' }} onChange={(e) => setStep(i, k, { target: e.target.value })} />}
                      {a.value && <input aria-label={a.value} placeholder={a.value} value={s.value} style={{ flex: '1 1 10rem' }} onChange={(e) => setStep(i, k, { value: e.target.value })} />}
                      <button type="button" className="btn btn-small" aria-label={`Remove step ${k + 1}`} disabled={d.steps.length === 1} onClick={() => set(i, { steps: d.steps.filter((_, n) => n !== k) })}>
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
            <button type="button" className="btn btn-small" onClick={() => set(i, { steps: [...d.steps, emptyStep()] })}>
              + Add a step
            </button>
            <p className="help">Type the words you see on the button or link, exactly as shown (for example <em>Next</em> or <em>Submit</em>).</p>

            <div className="field" style={{ marginTop: '0.75rem' }}>
              <label htmlFor={`j-res-${i}`} style={{ fontWeight: 600 }}>2. What the LMS should show afterwards</label>
              <select id={`j-res-${i}`} value={d.result} onChange={(e) => set(i, { result: e.target.value })}>
                <option value="">Don’t check the result, just record it</option>
                {RESULTS[version].map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <button type="button" className="btn btn-small" aria-expanded={more} onClick={() => setMoreFor((m) => (more ? m.filter((x) => x !== i) : [...m, i]))}>
              {more ? 'Hide score' : 'Also check the score'}
            </button>
            {more && (
              <div className="grid-2" style={{ marginTop: '0.5rem' }}>
                <div className="field">
                  <label htmlFor={`j-min-${i}`}>Score at least</label>
                  <input id={`j-min-${i}`} type="number" value={d.scoreMin} onChange={(e) => set(i, { scoreMin: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor={`j-max-${i}`}>Score at most</label>
                  <input id={`j-max-${i}`} type="number" value={d.scoreMax} onChange={(e) => set(i, { scoreMax: e.target.value })} />
                </div>
              </div>
            )}

            <div style={{ marginTop: '0.75rem' }}>
              <button type="button" className="btn btn-small" onClick={() => onChange(value.filter((_, n) => n !== i))}>
                Remove this check
              </button>
            </div>
          </div>
        );
      })}
      <button type="button" className="btn btn-small" onClick={() => onChange([...value, emptyJourney('')])}>
        + Add a check
      </button>
    </fieldset>
  );
}
