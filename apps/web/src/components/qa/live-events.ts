import type { RunEvent } from '@cqa/shared';

/** How many recent events the page keeps for its activity list. */
export const KEEP_EVENTS = 200;

/**
 * Adds newly fetched events to those already shown. An event is identified by its sequence number, which the server
 * hands out in order: a repeat is dropped, a late one is put back in its place, and nothing at or below the highest
 * number already applied can change what is shown. `gap` says whether numbers are missing in what is held, so the page
 * can ask for them again rather than show an incomplete feed as if it were whole.
 */
export function mergeRunEvents(held: readonly RunEvent[], incoming: readonly RunEvent[]): { events: RunEvent[]; lastSeq: number; gap: boolean } {
  const bySeq = new Map<number, RunEvent>();
  for (const e of held) bySeq.set(e.seq, e);
  for (const e of incoming) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-KEEP_EVENTS);
  const lastSeq = events.length ? events[events.length - 1]!.seq : 0;
  const gap = events.some((e, i) => i > 0 && e.seq !== events[i - 1]!.seq + 1);
  return { events, lastSeq, gap };
}

/**
 * Where to ask for events next. Each hole in what is held is asked for once, from the event before it, so the missing
 * ones come back; a hole still there after that is not on the server, so it is passed over and newer events keep coming.
 */
export function nextCursor(merged: { events: readonly RunEvent[]; lastSeq: number; gap: boolean }, triedHoles: ReadonlySet<number>): { after: number; holeAt?: number } {
  if (!merged.gap) return { after: merged.lastSeq };
  const i = merged.events.findIndex((e, k) => k > 0 && e.seq !== merged.events[k - 1]!.seq + 1 && !triedHoles.has(e.seq));
  if (i < 0) return { after: merged.lastSeq };
  return { after: merged.events[i - 1]!.seq, holeAt: merged.events[i]!.seq };
}
