import { useState } from 'react';

export interface JourneyDraft {
  name: string;
  steps: string;
  status: string;
  completion: string;
  success: string;
  scoreMin: string;
  scoreMax: string;
}

export const emptyJourney = (name: string): JourneyDraft => ({ name, steps: '', status: '', completion: '', success: '', scoreMin: '', scoreMax: '' });

export const presetJourneys = (version: '1.2' | '2004'): JourneyDraft[] => [
  {
    name: 'Pass journey',
    steps: '',
    status: version === '1.2' ? 'passed' : '',
    completion: version === '2004' ? 'completed' : '',
    success: version === '2004' ? 'passed' : '',
    scoreMin: '',
    scoreMax: '',
  },
  {
    name: 'Fail journey',
    steps: '',
    status: version === '1.2' ? 'failed' : '',
    completion: version === '2004' ? 'incomplete' : '',
    success: version === '2004' ? 'failed' : '',
    scoreMin: '',
    scoreMax: '',
  },
  {
    name: 'Leave part-way & resume',
    steps: '',
    status: version === '1.2' ? 'incomplete' : '',
    completion: version === '2004' ? 'incomplete' : '',
    success: '',
    scoreMin: '',
    scoreMax: '',
  },
];

type Step = { action: string; target?: string; value?: string; ms?: number };

/** Lines like `click: text=Start`, `fill: #name = Sam`, `press: Enter`, `wait: 1500`. */
export function parseSteps(text: string): { steps: Step[]; problems: string[] } {
  const steps: Step[] = [];
  const problems: string[] = [];
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line, i) => {
      const m = /^(click|fill|select|press|wait)\s*:\s*(.*)$/i.exec(line);
      if (!m) return void problems.push(`Line ${i + 1} should start with click:, fill:, select:, press:, or wait:`);
      const action = m[1]!.toLowerCase();
      const rest = m[2]!.trim();
      if (action === 'wait') steps.push({ action, ms: Number(rest) || 1000 });
      else if (action === 'press') steps.push({ action, value: rest || 'Enter' });
      else if (action === 'click') steps.push({ action, target: rest });
      else {
        const [target, ...v] = rest.split('=');
        steps.push({ action, target: (target ?? '').trim(), value: v.join('=').trim() });
      }
    });
  return { steps, problems };
}

export function journeysToApi(drafts: JourneyDraft[], version: '1.2' | '2004'): { journeys: Array<{ name: string; steps: Step[]; expect?: Record<string, unknown> }>; problems: string[] } {
  const problems: string[] = [];
  const journeys = drafts
    .filter((d) => d.steps.trim() || d.status || d.completion || d.success || d.scoreMin || d.scoreMax)
    .map((d) => {
      const { steps, problems: p } = parseSteps(d.steps);
      problems.push(...p.map((x) => `${d.name}: ${x}`));
      const expect: Record<string, unknown> = {};
      if (version === '1.2' && d.status) expect.status = d.status;
      if (version === '2004' && d.completion) expect.completion = d.completion;
      if (version === '2004' && d.success) expect.success = d.success;
      if (d.scoreMin) expect.scoreMin = Number(d.scoreMin);
      if (d.scoreMax) expect.scoreMax = Number(d.scoreMax);
      return { name: d.name || 'Journey', steps, ...(Object.keys(expect).length ? { expect } : {}) };
    });
  return { journeys, problems };
}

/** Journeys the person writes, each with the tracking they expect afterwards. Pass and fail are separate journeys. */
export function ScormJourneys({ version, value, onChange }: { version: '1.2' | '2004'; value: JourneyDraft[]; onChange: (v: JourneyDraft[]) => void }) {
  const [open, setOpen] = useState(false);
  const set = (i: number, patch: Partial<JourneyDraft>) => onChange(value.map((d, n) => (n === i ? { ...d, ...patch } : d)));
  return (
    <fieldset className="fieldset">
      <legend>Journeys and expected tracking (optional)</legend>
      <p className="help">
        Without journeys the course is opened and left. A journey is a list of actions the scan carries out, then the tracking you expect the course to have recorded. Write a pass path and a fail path as separate journeys. A journey the scan cannot carry out is reported as not tested, never as passed.
      </p>
      <button type="button" className="btn btn-small" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide journeys' : 'Add journeys'}
      </button>
      {open &&
        value.map((d, i) => (
          <div key={i} className="card">
            <div className="field">
              <label htmlFor={`j-name-${i}`}>Journey name</label>
              <input id={`j-name-${i}`} value={d.name} maxLength={80} onChange={(e) => set(i, { name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`j-steps-${i}`}>Steps, one per line</label>
              <textarea id={`j-steps-${i}`} rows={4} placeholder={'click: text=Start\nclick: #answer-b\nclick: text=Submit'} value={d.steps} onChange={(e) => set(i, { steps: e.target.value })} aria-describedby={`j-steps-help-${i}`} />
              <p id={`j-steps-help-${i}`} className="help">
                Use <code>click:</code>, <code>fill: target = text</code>, <code>select: target = option</code>, <code>press: Enter</code>, or <code>wait: 1500</code>. Targets are <code>text=Visible text</code> or a CSS selector such as <code>#next</code>.
              </p>
            </div>
            <div className="grid-2">
              {version === '1.2' ? (
                <div className="field">
                  <label htmlFor={`j-status-${i}`}>Expected lesson status</label>
                  <select id={`j-status-${i}`} value={d.status} onChange={(e) => set(i, { status: e.target.value })}>
                    <option value="">No expectation</option>
                    {['passed', 'completed', 'failed', 'incomplete', 'browsed', 'not attempted'].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <>
                  <div className="field">
                    <label htmlFor={`j-comp-${i}`}>Expected completion status</label>
                    <select id={`j-comp-${i}`} value={d.completion} onChange={(e) => set(i, { completion: e.target.value })}>
                      <option value="">No expectation</option>
                      {['completed', 'incomplete', 'not attempted', 'unknown'].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={`j-succ-${i}`}>Expected success status</label>
                    <select id={`j-succ-${i}`} value={d.success} onChange={(e) => set(i, { success: e.target.value })}>
                      <option value="">No expectation</option>
                      {['passed', 'failed', 'unknown'].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
              <div className="field">
                <label htmlFor={`j-min-${i}`}>Score at least</label>
                <input id={`j-min-${i}`} type="number" value={d.scoreMin} onChange={(e) => set(i, { scoreMin: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={`j-max-${i}`}>Score at most</label>
                <input id={`j-max-${i}`} type="number" value={d.scoreMax} onChange={(e) => set(i, { scoreMax: e.target.value })} />
              </div>
            </div>
          </div>
        ))}
    </fieldset>
  );
}
