const STEPS = ['Upload course', 'Choose checks', 'Run QA', 'Review screens', 'Export report'] as const;

/** The primary workflow, with the current step marked in text as well as by style. */
export function WorkflowSteps({ current }: { current: 0 | 1 | 2 | 3 | 4 }) {
  return (
    <ol className="workflow" aria-label="Where you are in the workflow">
      {STEPS.map((label, i) => (
        <li key={label} aria-current={i === current ? 'step' : undefined} className={i === current ? 'current' : i < current ? 'done' : ''}>
          <span className="step-num" aria-hidden="true">
            {i + 1}
          </span>
          {label}
          {i < current && <span className="sr-only"> (done)</span>}
        </li>
      ))}
    </ol>
  );
}
