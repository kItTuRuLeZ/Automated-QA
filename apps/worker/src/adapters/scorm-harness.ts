/**
 * Test-only SCORM runtime for scans: a small, instrumented stand-in for the
 * LMS side of SCORM 1.2 (`API`) or SCORM 2004 (`API_1484_11`). It validates
 * calls against a documented subset of each data model, returns the error
 * codes that version defines, and records every call.
 *
 * It is NOT an LMS and NOT a conformance test of SCORM. It does not evaluate
 * sequencing, does not decide pass/fail from a mastery score, and implements
 * only the elements listed in `SUPPORTED_*` below; any other element returns
 * the version's "not implemented" error rather than pretending to work.
 *
 * `scormHarness` is serialized into the page by Playwright, so it must stay
 * self-contained (no imports or outer references). Tests call it directly.
 */
export type ScormVersion = '1.2' | '2004';

export interface HarnessConfig {
  version: ScormVersion;
  /** Fake learner. Never real data. */
  learner: { id: string; name: string };
  /** Committed values restored from an earlier session (only used when `entry` is `resume`). */
  restore: Record<string, string>;
  entry: 'ab-initio' | 'resume';
  launchData?: string;
  masteryScore?: string;
  /** Total time accumulated in earlier sessions, in seconds. */
  priorTotalSeconds: number;
}

export interface HarnessCall {
  seq: number;
  /** Milliseconds since the harness was installed. */
  t: number;
  fn: string;
  /** Arguments as the course passed them. Long or learner-related values are shown as a character count. */
  args: string[];
  ret: string;
  error: number;
  /** Which lifecycle state the API was in when called. */
  state: 'not_initialized' | 'running' | 'terminated';
}

export interface HarnessSnapshot {
  calls: HarnessCall[];
  /** Everything the course currently has set (redacted values shown as counts are NOT used here; this is for the Node side). */
  cmi: Record<string, string>;
  /** The values that survive a commit or finish: what a real LMS would store. */
  committed: Record<string, string>;
  state: 'not_initialized' | 'running' | 'terminated';
  /** Names the course looked for that this harness deliberately does not provide (the other SCORM version's API). */
  lookups: Array<{ name: string; t: number }>;
}

export interface Harness {
  api: Record<string, (...a: string[]) => string>;
  snapshot(): HarnessSnapshot;
}

export function scormHarness(cfg: HarnessConfig, win: any): Harness {
  const is12 = cfg.version === '1.2';
  const t0 = Date.now();
  const calls: HarnessCall[] = [];
  const lookups: Array<{ name: string; t: number }> = [];
  let state: 'not_initialized' | 'running' | 'terminated' = 'not_initialized';
  let lastError = 0;
  let seq = 0;
  const cmi: Record<string, string> = {};
  let committed: Record<string, string> = {};
  let sessionTimeSet = false;
  // Once the page starts closing, calls are also written to this origin's localStorage:
  // Playwright bindings can be torn down before `pagehide`/`unload` handlers run, which
  // is exactly when many courses (Storyline among them) commit and terminate.
  let leaving = false;

  // ---- error tables ----
  const ERR12: Record<number, string> = { 0: 'No error', 101: 'General exception', 201: 'Invalid argument error', 202: 'Element cannot have children', 203: 'Element not an array. Cannot have count', 301: 'Not initialized', 401: 'Not implemented error', 402: 'Invalid set value, element is a keyword', 403: 'Element is read only', 404: 'Element is write only', 405: 'Incorrect data type' };
  const ERR04: Record<number, string> = { 0: 'No Error', 101: 'General Exception', 102: 'General Initialization Failure', 103: 'Already Initialized', 104: 'Content Instance Terminated', 111: 'General Termination Failure', 112: 'Termination Before Initialization', 113: 'Termination After Termination', 122: 'Retrieve Data Before Initialization', 123: 'Retrieve Data After Termination', 132: 'Store Data Before Initialization', 133: 'Store Data After Termination', 142: 'Commit Before Initialization', 143: 'Commit After Termination', 201: 'General Argument Error', 301: 'General Get Failure', 351: 'General Set Failure', 391: 'General Commit Failure', 401: 'Undefined Data Model Element', 402: 'Unimplemented Data Model Element', 403: 'Data Model Element Value Not Initialized', 404: 'Data Model Element Is Read Only', 405: 'Data Model Element Is Write Only', 406: 'Data Model Element Type Mismatch', 407: 'Data Model Element Value Out Of Range', 408: 'Data Model Dependency Not Established' };
  const ERR = is12 ? ERR12 : ERR04;

  // ---- value checks ----
  const isReal = (v: string) => /^-?\d+(\.\d+)?$/.test(v);
  const timespan12 = (v: string) => /^\d{2,4}:\d{2}:\d{2}(\.\d{1,2})?$/.test(v) && Number(v.split(':')[1]) < 60 && Number(v.split(':')[2]) < 60;
  const clock12 = (v: string) => /^\d{2}:\d{2}:\d{2}(\.\d{1,2})?$/.test(v) && Number(v.split(':')[0]) < 24;
  const duration04 = (v: string) => /^P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d{1,2})?S)?)?$/.test(v);
  const seconds12 = (v: string) => {
    const [h, m, s] = v.split(':');
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  };
  const seconds04 = (v: string) => {
    const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(v);
    if (!m) return 0;
    return Number(m[1] ?? 0) * 31536000 + Number(m[2] ?? 0) * 2592000 + Number(m[3] ?? 0) * 86400 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0);
  };
  const fmt12 = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = (sec % 60).toFixed(2).padStart(5, '0');
    return `${String(h).padStart(4, '0')}:${String(m).padStart(2, '0')}:${s}`;
  };
  const fmt04 = (sec: number) => `PT${Math.floor(sec / 3600)}H${Math.floor((sec % 3600) / 60)}M${(sec % 60).toFixed(2)}S`;

  type Access = 'r' | 'w' | 'rw';
  interface Def {
    access: Access;
    check?: (v: string) => 'ok' | 'type' | 'range';
    initial?: string;
    /** Value that survives into the next session. */
    persist?: boolean;
  }
  const vocab = (...values: string[]) => (v: string): 'ok' | 'type' | 'range' => (values.includes(v) ? 'ok' : 'type');
  const str = (max: number) => (v: string): 'ok' | 'type' | 'range' => (v.length <= max ? 'ok' : 'range');
  const real = (lo: number, hi: number) => (v: string): 'ok' | 'type' | 'range' => (!isReal(v) ? 'type' : Number(v) < lo || Number(v) > hi ? 'range' : 'ok');
  const realOrEmpty = (lo: number, hi: number) => (v: string): 'ok' | 'type' | 'range' => (v === '' ? 'ok' : real(lo, hi)(v));

  const defs: Record<string, Def> = {};
  // Supported subsets. Anything else is "not implemented", never faked.
  if (is12) {
    Object.assign(defs, {
      'cmi._version': { access: 'r', initial: '3.4' },
      'cmi.core.student_id': { access: 'r', initial: cfg.learner.id },
      'cmi.core.student_name': { access: 'r', initial: cfg.learner.name },
      'cmi.core.lesson_location': { access: 'rw', check: str(255), initial: '', persist: true },
      'cmi.core.credit': { access: 'r', initial: 'credit' },
      'cmi.core.lesson_status': { access: 'rw', check: vocab('passed', 'completed', 'failed', 'incomplete', 'browsed', 'not attempted'), initial: 'not attempted', persist: true },
      'cmi.core.entry': { access: 'r', initial: cfg.entry },
      'cmi.core.score.raw': { access: 'rw', check: realOrEmpty(0, 100), initial: '', persist: true },
      'cmi.core.score.max': { access: 'rw', check: realOrEmpty(0, 100), initial: '', persist: true },
      'cmi.core.score.min': { access: 'rw', check: realOrEmpty(0, 100), initial: '', persist: true },
      'cmi.core.total_time': { access: 'r', initial: fmt12(cfg.priorTotalSeconds) },
      'cmi.core.lesson_mode': { access: 'r', initial: 'normal' },
      'cmi.core.exit': { access: 'w', check: vocab('time-out', 'suspend', 'logout', ''), initial: '' },
      'cmi.core.session_time': { access: 'w', check: (v: string) => (timespan12(v) ? 'ok' : 'type'), initial: '' },
      'cmi.suspend_data': { access: 'rw', check: str(4096), initial: '', persist: true },
      'cmi.launch_data': { access: 'r', initial: cfg.launchData ?? '' },
      'cmi.comments': { access: 'rw', check: str(4096), initial: '' },
      'cmi.comments_from_lms': { access: 'r', initial: '' },
      'cmi.student_data.mastery_score': { access: 'r', initial: cfg.masteryScore ?? '' },
      'cmi.student_data.max_time_allowed': { access: 'r', initial: '' },
      'cmi.student_data.time_limit_action': { access: 'r', initial: '' },
      'cmi.student_preference.audio': { access: 'rw', check: (v: string) => (/^-?\d+$/.test(v) && Number(v) >= -1 && Number(v) <= 100 ? 'ok' : 'type'), initial: '0' },
      'cmi.student_preference.language': { access: 'rw', check: str(255), initial: '' },
      'cmi.student_preference.speed': { access: 'rw', check: (v: string) => (/^-?\d+$/.test(v) && Number(v) >= -100 && Number(v) <= 100 ? 'ok' : 'type'), initial: '0' },
      'cmi.student_preference.text': { access: 'rw', check: (v: string) => (/^-?\d+$/.test(v) && Number(v) >= -1 && Number(v) <= 1 ? 'ok' : 'type'), initial: '0' },
    } satisfies Record<string, Def>);
  } else {
    Object.assign(defs, {
      'cmi._version': { access: 'r', initial: '1.0' },
      'cmi.completion_status': { access: 'rw', check: vocab('completed', 'incomplete', 'not attempted', 'unknown'), initial: 'unknown', persist: true },
      'cmi.credit': { access: 'r', initial: 'credit' },
      'cmi.entry': { access: 'r', initial: cfg.entry === 'resume' ? 'resume' : 'ab-initio' },
      'cmi.exit': { access: 'w', check: vocab('timeout', 'suspend', 'logout', 'normal', ''), initial: '' },
      'cmi.launch_data': { access: 'r', initial: cfg.launchData ?? '' },
      'cmi.learner_id': { access: 'r', initial: cfg.learner.id },
      'cmi.learner_name': { access: 'r', initial: cfg.learner.name },
      'cmi.location': { access: 'rw', check: str(1000), initial: '', persist: true },
      'cmi.mode': { access: 'r', initial: 'normal' },
      'cmi.progress_measure': { access: 'rw', check: real(0, 1), persist: true },
      'cmi.score.scaled': { access: 'rw', check: real(-1, 1), persist: true },
      'cmi.score.raw': { access: 'rw', check: (v: string) => (isReal(v) ? 'ok' : 'type'), persist: true },
      'cmi.score.min': { access: 'rw', check: (v: string) => (isReal(v) ? 'ok' : 'type'), persist: true },
      'cmi.score.max': { access: 'rw', check: (v: string) => (isReal(v) ? 'ok' : 'type'), persist: true },
      'cmi.session_time': { access: 'w', check: (v: string) => (duration04(v) ? 'ok' : 'type'), initial: '' },
      'cmi.success_status': { access: 'rw', check: vocab('passed', 'failed', 'unknown'), initial: 'unknown', persist: true },
      'cmi.suspend_data': { access: 'rw', check: str(64000), initial: '', persist: true },
      'cmi.total_time': { access: 'r', initial: fmt04(cfg.priorTotalSeconds) },
      'cmi.scaled_passing_score': { access: 'r' },
      'cmi.completion_threshold': { access: 'r' },
      'cmi.time_limit_action': { access: 'r' },
      'cmi.max_time_allowed': { access: 'r' },
    } satisfies Record<string, Def>);
  }
  // Interactions and objectives: stored as written, in order, with the field checks below. Quiz-style courses use these heavily.
  const counts = { interactions: 0, objectives: 0 };
  const arrFields: Record<string, Def> = {};
  const addFields = (prefix: string, fields: Record<string, Def>) => {
    for (const [k, d] of Object.entries(fields)) arrFields[prefix + k] = d;
  };
  const interType = vocab('true-false', 'choice', 'fill-in', 'long-fill-in', 'matching', 'performance', 'sequencing', 'likert', 'numeric', 'other');
  const realCheck = (v: string): 'ok' | 'type' | 'range' => (isReal(v) ? 'ok' : 'type');
  if (is12) {
    addFields('interactions.#.', {
      id: { access: 'w', check: str(255) },
      'objectives.#.id': { access: 'w', check: str(255) },
      time: { access: 'w', check: (v: string) => (clock12(v) ? 'ok' : 'type') },
      type: { access: 'w', check: interType },
      'correct_responses.#.pattern': { access: 'w', check: str(255) },
      weighting: { access: 'w', check: realCheck },
      student_response: { access: 'w', check: str(255) },
      result: { access: 'w', check: (v: string) => (['correct', 'wrong', 'unanticipated', 'neutral'].includes(v) || isReal(v) ? 'ok' : 'type') },
      latency: { access: 'w', check: (v: string) => (timespan12(v) ? 'ok' : 'type') },
    });
    addFields('objectives.#.', {
      id: { access: 'rw', check: str(255) },
      'score.raw': { access: 'rw', check: realOrEmpty(0, 100) },
      'score.min': { access: 'rw', check: realOrEmpty(0, 100) },
      'score.max': { access: 'rw', check: realOrEmpty(0, 100) },
      status: { access: 'rw', check: vocab('passed', 'completed', 'failed', 'incomplete', 'browsed', 'not attempted') },
    });
  } else {
    addFields('interactions.#.', {
      id: { access: 'rw', check: str(4000) },
      'objectives.#.id': { access: 'rw', check: str(4000) },
      timestamp: { access: 'rw', check: (v: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) ? 'ok' : 'type') },
      type: { access: 'rw', check: interType },
      'correct_responses.#.pattern': { access: 'rw', check: str(4000) },
      weighting: { access: 'rw', check: realCheck },
      learner_response: { access: 'rw', check: str(64000) },
      result: { access: 'rw', check: (v: string) => (['correct', 'incorrect', 'unanticipated', 'neutral'].includes(v) || isReal(v) ? 'ok' : 'type') },
      latency: { access: 'rw', check: (v: string) => (duration04(v) ? 'ok' : 'type') },
      description: { access: 'rw', check: str(250) },
    });
    addFields('objectives.#.', {
      id: { access: 'rw', check: str(4000) },
      'score.scaled': { access: 'rw', check: real(-1, 1) },
      'score.raw': { access: 'rw', check: realCheck },
      'score.min': { access: 'rw', check: realCheck },
      'score.max': { access: 'rw', check: realCheck },
      success_status: { access: 'rw', check: vocab('passed', 'failed', 'unknown') },
      completion_status: { access: 'rw', check: vocab('completed', 'incomplete', 'not attempted', 'unknown') },
      progress_measure: { access: 'rw', check: real(0, 1) },
      description: { access: 'rw', check: str(250) },
    });
  }
  const CHILDREN: Record<string, string> = is12
    ? {
        'cmi._children': 'core,suspend_data,launch_data,comments,objectives,student_data,student_preference,interactions',
        'cmi.core._children': 'student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time',
        'cmi.core.score._children': 'raw,min,max',
        'cmi.objectives._children': 'id,score,status',
        'cmi.interactions._children': 'id,objectives,time,type,correct_responses,weighting,student_response,result,latency',
        'cmi.student_data._children': 'mastery_score,max_time_allowed,time_limit_action',
        'cmi.student_preference._children': 'audio,language,speed,text',
      }
    : {
        'cmi.score._children': 'scaled,raw,min,max',
        'cmi.objectives._children': 'id,score,success_status,completion_status,progress_measure,description',
        'cmi.interactions._children': 'id,type,objectives,timestamp,correct_responses,weighting,learner_response,result,latency,description',
      };
  /** Resolves cmi.interactions.N.field and cmi.objectives.N.field to a definition, or an error code. */
  const arrayDef = (name: string, forSet: boolean): { def?: Def; code?: number } | undefined => {
    const m = /^cmi\.(interactions|objectives)\.(\d+)\.(.+)$/.exec(name);
    if (!m) return undefined;
    const kind = m[1] as 'interactions' | 'objectives';
    const n = Number(m[2]);
    const rest = m[3]!.replace(/(^|\.)\d+(?=\.|$)/g, '$1#');
    const def = arrFields[kind + '.#.' + rest];
    if (!def) return { code: 401 };
    if (forSet && n > counts[kind]) return { code: is12 ? 201 : 351 };
    if (!forSet && n >= counts[kind]) return { code: is12 ? 201 : 301 };
    return { def };
  };

  // Defined by the standards but not implemented here. Reported as such.
  const KNOWN_UNIMPLEMENTED = is12 ? [/^cmi\.core\.\w+$/] : [/^cmi\.learner_preference\./, /^cmi\.comments_from_learner/, /^cmi\.comments_from_lms/, /^adl\./];

  // Restore what a real LMS would hand back for a resumed attempt.
  for (const [k, d] of Object.entries(defs)) if (d.initial !== undefined) cmi[k] = d.initial;
  if (cfg.entry === 'resume') {
    for (const [k, v] of Object.entries(cfg.restore)) if (defs[k]?.persist) cmi[k] = v;
  } else {
    // A fresh attempt keeps what the LMS remembers about completion in 1.2 (status/score); location and suspend data start empty.
    for (const [k, v] of Object.entries(cfg.restore)) if (is12 && (k.endsWith('lesson_status') || k.includes('score.'))) cmi[k] = v;
  }
  committed = { ...Object.fromEntries(Object.entries(cmi).filter(([k]) => defs[k]?.persist)) };

  // ---- redaction in the call log ----
  const REDACT_ELEMENTS = /suspend_data|comments|student_response|learner_response|launch_data|student_name|learner_name|student_id|learner_id/;
  const shown = (name: string, value: string): string => (REDACT_ELEMENTS.test(name) ? `[${value.length} characters]` : value.length > 120 ? `${value.slice(0, 117)}...` : value);

  const spill = () => {
    if (!leaving) return;
    try {
      win.localStorage.setItem('__cqaScormSpill', JSON.stringify({ calls: calls.slice(-500), cmi, committed, state, lookups }));
    } catch {
      /* storage unavailable; the snapshot taken before leaving still stands */
    }
  };
  const record = (fn: string, args: string[], ret: string, error: number, loggedRet?: string): string => {
    const entry: HarnessCall = { seq: ++seq, t: Date.now() - t0, fn, args, ret: loggedRet ?? ret, error, state };
    calls.push(entry);
    if (calls.length > 5000) calls.shift();
    try {
      if (typeof win.__cqaScormEmit === 'function') win.__cqaScormEmit({ kind: 'call', call: entry });
    } catch {
      /* the binding may be gone while the page unloads */
    }
    spill();
    return ret;
  };
  const persist = () => {
    committed = Object.fromEntries(Object.entries(cmi).filter(([k]) => defs[k]?.persist));
    try {
      if (typeof win.__cqaScormEmit === 'function') win.__cqaScormEmit({ kind: 'persist', committed, cmi: { ...cmi } });
    } catch {
      /* see above */
    }
    spill();
  };
  const fail = (code: number): string => {
    lastError = code;
    return 'false';
  };
  const ok = (): string => {
    lastError = 0;
    return 'true';
  };

  const notInit = (kind: 'get' | 'set' | 'commit' | 'finish'): number => {
    if (is12) return 301;
    if (state === 'not_initialized') return { get: 122, set: 132, commit: 142, finish: 112 }[kind];
    return { get: 123, set: 133, commit: 143, finish: 113 }[kind];
  };

  const lookup = (name: string, forSet = false): { def?: Def; code?: number; keyword?: string } => {
    if (name in defs) return { def: defs[name] };
    if (name in CHILDREN) return { keyword: CHILDREN[name]! };
    const c = /^cmi\.(interactions|objectives)\._count$/.exec(name);
    if (c) return { keyword: String(counts[c[1] as 'interactions' | 'objectives']) };
    const a = arrayDef(name, forSet);
    if (a) return a.def ? { def: a.def } : { code: a.code };
    if (/\._children$/.test(name) || /\._count$/.test(name)) return { code: is12 ? (/_count$/.test(name) ? 203 : 202) : 401 };
    if (is12) return { code: 401 };
    return { code: KNOWN_UNIMPLEMENTED.some((re) => re.test(name)) ? 402 : 401 };
  };

  // ---- the operations ----
  const initialize = (param: string): string => {
    if (param !== '') return record(is12 ? 'LMSInitialize' : 'Initialize', [param], fail(is12 ? 201 : 201), lastError);
    if (state === 'running') return record(is12 ? 'LMSInitialize' : 'Initialize', [param], fail(is12 ? 101 : 103), lastError);
    if (state === 'terminated') return record(is12 ? 'LMSInitialize' : 'Initialize', [param], fail(is12 ? 101 : 104), lastError);
    const before = state;
    state = 'running';
    const r = ok();
    const entry: HarnessCall = { seq: ++seq, t: Date.now() - t0, fn: is12 ? 'LMSInitialize' : 'Initialize', args: [param], ret: r, error: 0, state: before };
    calls.push(entry);
    try {
      if (typeof win.__cqaScormEmit === 'function') win.__cqaScormEmit({ kind: 'call', call: entry });
    } catch {
      /* ignore */
    }
    return r;
  };

  const getValue = (name: string): string => {
    const fn = is12 ? 'LMSGetValue' : 'GetValue';
    if (state !== 'running') {
      fail(notInit('get'));
      return record(fn, [name], '', lastError);
    }
    if (typeof name !== 'string' || name === '') {
      fail(is12 ? 201 : 301);
      return record(fn, [String(name)], '', lastError);
    }
    const { def, code, keyword } = lookup(name);
    if (keyword !== undefined) {
      lastError = 0;
      return record(fn, [name], keyword, 0);
    }
    if (!def) {
      fail(code!);
      return record(fn, [name], '', lastError);
    }
    if (def.access === 'w') {
      fail(is12 ? 404 : 405);
      return record(fn, [name], '', lastError);
    }
    const v = cmi[name];
    if (v === undefined) {
      // 2004 distinguishes "defined but never given a value".
      lastError = is12 ? 0 : 403;
      return record(fn, [name], '', lastError);
    }
    lastError = 0;
    return record(fn, [name], v, 0, shown(name, v));
  };

  const setValue = (name: string, value: string): string => {
    const fn = is12 ? 'LMSSetValue' : 'SetValue';
    const a = [name, shown(String(name), String(value))];
    if (state !== 'running') {
      fail(notInit('set'));
      return record(fn, a, 'false', lastError);
    }
    const v = String(value);
    const { def, code, keyword } = lookup(String(name), true);
    if (keyword !== undefined) {
      fail(is12 ? 402 : 404);
      return record(fn, a, 'false', lastError);
    }
    if (!def) {
      fail(code === 202 || code === 203 ? (is12 ? 402 : 351) : code!);
      return record(fn, a, 'false', lastError);
    }
    if (def.access === 'r') {
      fail(is12 ? 403 : 404);
      return record(fn, a, 'false', lastError);
    }
    const verdict = def.check ? def.check(v) : 'ok';
    if (verdict !== 'ok') {
      fail(verdict === 'type' ? (is12 ? 405 : 406) : is12 ? 405 : 407);
      return record(fn, a, 'false', lastError);
    }
    const am = /^cmi\.(interactions|objectives)\.(\d+)\./.exec(String(name));
    if (am && Number(am[2]) === counts[am[1] as 'interactions' | 'objectives']) counts[am[1] as 'interactions' | 'objectives']++;
    cmi[name] = v;
    if (name.endsWith('session_time')) sessionTimeSet = true;
    ok();
    return record(fn, a, 'true', 0);
  };

  const commit = (param: string): string => {
    const fn = is12 ? 'LMSCommit' : 'Commit';
    if (state !== 'running') {
      fail(notInit('commit'));
      return record(fn, [param], 'false', lastError);
    }
    if (param !== '') {
      fail(is12 ? 201 : 201);
      return record(fn, [param], 'false', lastError);
    }
    persist();
    ok();
    return record(fn, [param], 'true', 0);
  };

  const finish = (param: string): string => {
    const fn = is12 ? 'LMSFinish' : 'Terminate';
    if (state !== 'running') {
      fail(notInit('finish'));
      return record(fn, [param], 'false', lastError);
    }
    if (param !== '') {
      fail(201);
      return record(fn, [param], 'false', lastError);
    }
    // Finishing saves everything, accumulates session time, and ends the session.
    if (sessionTimeSet) {
      const add = is12 ? seconds12(cmi['cmi.core.session_time']!) : seconds04(cmi['cmi.session_time']!);
      const total = cfg.priorTotalSeconds + add;
      cmi[is12 ? 'cmi.core.total_time' : 'cmi.total_time'] = is12 ? fmt12(total) : fmt04(total);
    }
    persist();
    // Record the call in the state it was made in, then end the session.
    const r = ok();
    record(fn, [param], r, 0);
    state = 'terminated';
    return r;
  };

  const errorString = (code: string): string => {
    const n = Number(code);
    return ERR[n] ?? '';
  };
  const diagnostic = (code: string): string => (code === '' || code === undefined ? ERR[lastError] ?? '' : (ERR[Number(code)] ?? ''));
  const getLastError = (): string => String(lastError);

  const api: Record<string, (...a: string[]) => string> = is12
    ? { LMSInitialize: initialize, LMSFinish: finish, LMSGetValue: getValue, LMSSetValue: setValue, LMSCommit: commit, LMSGetLastError: getLastError, LMSGetErrorString: errorString, LMSGetDiagnostic: diagnostic }
    : { Initialize: initialize, Terminate: finish, GetValue: getValue, SetValue: setValue, Commit: commit, GetLastError: getLastError, GetErrorString: errorString, GetDiagnostic: diagnostic };

  if (win && typeof win === 'object') {
    const mine = is12 ? 'API' : 'API_1484_11';
    const other = is12 ? 'API_1484_11' : 'API';
    try {
      Object.defineProperty(win, mine, { value: api, configurable: false, writable: false, enumerable: false });
      // The other version's API is deliberately absent, but a lookup for it is recorded so the report can say so.
      Object.defineProperty(win, other, {
        configurable: false,
        enumerable: false,
        get() {
          lookups.push({ name: other, t: Date.now() - t0 });
          try {
            if (typeof win.__cqaScormEmit === 'function') win.__cqaScormEmit({ kind: 'lookup', name: other, t: Date.now() - t0 });
          } catch {
            /* ignore */
          }
          return undefined;
        },
        set() {
          /* a course must not be able to replace the harness */
        },
      });
    } catch {
      /* already defined by the page; the harness cannot be installed */
    }
    win.__cqaScorm = { snapshot: () => ({ calls: calls.slice(), cmi: { ...cmi }, committed: { ...committed }, state, lookups: lookups.slice() }) };
    if (typeof win.addEventListener === 'function') {
      // Registered before any course script, so these run first and every later unload-time call is kept.
      const startLeaving = () => {
        leaving = true;
        spill();
      };
      win.addEventListener('beforeunload', startLeaving, true);
      win.addEventListener('pagehide', startLeaving, true);
    }
  }

  return { api, snapshot: () => ({ calls: calls.slice(), cmi: { ...cmi }, committed: { ...committed }, state, lookups: lookups.slice() }) };
}

/** Init-script source: installs the harness only in the top window (courses find it by walking up `parent`). */
export function harnessInitScript(cfg: HarnessConfig): string {
  // The read-back page only exists to read what the closing page spilled, so it gets no harness;
  // every other page starts from a clean spill so an earlier page's log is never mixed in.
  return `globalThis.__name ??= (fn) => fn;\n(function(){ if (window !== window.top) return; if (location.pathname.endsWith(${JSON.stringify(READBACK_PATH)})) return; try { localStorage.removeItem('__cqaScormSpill'); } catch {} (${scormHarness.toString()})(${JSON.stringify(cfg)}, window); })();`;
}

/** Path on the package origin the scan opens after leaving, to collect calls made while the course page closed. */
export const READBACK_PATH = '/__cqa_scorm_readback';

/** Reads (and clears) what the harness wrote while the page was closing. Runs on the read-back page. */
export function readSpill(): HarnessSnapshot | null {
  try {
    const raw = localStorage.getItem('__cqaScormSpill');
    localStorage.removeItem('__cqaScormSpill');
    return raw ? (JSON.parse(raw) as HarnessSnapshot) : null;
  } catch {
    return null;
  }
}
