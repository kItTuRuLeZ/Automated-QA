import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@cqa/shared';
import { KEEP_EVENTS, mergeRunEvents, nextCursor } from '../apps/web/src/components/qa/live-events.js';

const ev = (seq: number, text = `event ${seq}`): RunEvent => ({ runId: 'r', seq, type: 'note', at: '2026-11-11T00:00:00Z', payload: { text } }) as unknown as RunEvent;

describe('live progress events', () => {
  it('a repeated event is shown once and cannot change what was already shown', () => {
    const first = mergeRunEvents([], [ev(1), ev(2)]);
    const again = mergeRunEvents(first.events, [ev(2, 'changed on resend'), ev(3)]);
    expect(again.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((again.events[1]!.payload as { text: string }).text).toBe('event 2');
    expect(again.lastSeq).toBe(3);
  });

  it('an event that arrives late is put back in order', () => {
    const merged = mergeRunEvents([ev(1), ev(3)], [ev(2)]);
    expect(merged.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(merged.gap).toBe(false);
  });

  it('missing numbers are reported, so the page asks again instead of showing a partial feed as whole', () => {
    const merged = mergeRunEvents([ev(1)], [ev(4)]);
    expect(merged.gap).toBe(true);
    expect(merged.lastSeq).toBe(4);
  });

  it('after a refresh the same calls rebuild the same view', () => {
    const live = mergeRunEvents(mergeRunEvents([], [ev(1), ev(2)]).events, [ev(3)]);
    const afterRefresh = mergeRunEvents([], [ev(1), ev(2), ev(3)]);
    expect(afterRefresh).toEqual(live);
  });

  it('keeps only the most recent events for the activity list', () => {
    const many = Array.from({ length: KEEP_EVENTS + 50 }, (_, i) => ev(i + 1));
    const merged = mergeRunEvents([], many);
    expect(merged.events).toHaveLength(KEEP_EVENTS);
    expect(merged.events[0]!.seq).toBe(51);
    expect(merged.gap).toBe(false);
  });
});

describe('asking again for missing events', () => {
  it('asks from the event before the hole, so the missing ones come back', () => {
    const merged = mergeRunEvents([ev(1)], [ev(4)]);
    expect(nextCursor(merged, new Set())).toEqual({ after: 1, holeAt: 4 });
  });

  it('asks only once: a hole that stays is carried past, so new events keep arriving', () => {
    const merged = mergeRunEvents([ev(1)], [ev(4), ev(5)]);
    expect(nextCursor(merged, new Set([4]))).toEqual({ after: 5 });
  });

  it('a later hole is still asked for after an earlier one was given up on', () => {
    const merged = mergeRunEvents([ev(1), ev(3)], [ev(4), ev(6)]);
    expect(nextCursor(merged, new Set([3]))).toEqual({ after: 4, holeAt: 6 });
  });

  it('with no hole, carries on from the newest event', () => {
    expect(nextCursor(mergeRunEvents([], [ev(1), ev(2)]), new Set())).toEqual({ after: 2 });
  });
});
