import { describe, expect, it } from 'vitest';
import type { InteractionInstance, TestExecution } from '@cqa/shared';
import { screenSearchIndex } from '@cqa/core';

const inter = (label: string, unitId = 'u1'): InteractionInstance => ({ id: label, runId: 'r', unitId, type: 'flip_card', label, confidence: 'high', capabilities: ['activate'], detectedBy: 't' });
const exec = (over: Partial<TestExecution>): TestExecution => ({ id: 'e', runId: 'r', definitionId: 'TAB-01', definitionVersion: 1, unitId: 'u1', attempt: 1, status: 'passed', trace: [], evidenceIds: [], scope: 'functional', ...over });
const units = [{ id: 'u1', title: 'Lesson 2: Safety basics' }, { id: 'b1', title: 'Block', parentId: 'u1' }, { id: 'b2', title: 'Inner', parentId: 'b1' }, { id: 'u2', title: 'Lesson 3' }];

describe('searching the course index', () => {
  it("finds a screen by its title, its controls, and each check's case, title, status and reason", () => {
    const own = screenSearchIndex(units, [inter('Fire exits card'), inter('Other lesson card', 'u2')], [exec({ definitionId: 'TAB-01', externalId: 'ACME-7' }), exec({ definitionId: 'MCQ-02', status: 'blocked', reason: 'Submit could not be found', evidenceIds: ['x'] })], new Map([['MCQ-02', { title: 'Submitting without an answer is handled' }]])).get('u1')!.own;
    for (const w of ['safety basics', 'fire exits', 'flip card', 'tab-01', 'acme-7', 'mcq-02', 'submitting without', 'blocked', 'submit could not be found', 'evidence']) expect(own).toContain(w);
  });

  it("keeps what sits in a lesson's blocks apart, so the index can say a match is inside a block", () => {
    const entry = screenSearchIndex(units, [inter('Card in a block', 'b2')], [exec({ unitId: 'b1', definitionId: 'FLP-01' })], new Map()).get('u1')!;
    expect(entry.nested).toContain('card in a block');
    expect(entry.nested).toContain('flp-01');
    expect(entry.own).not.toContain('flp-01');
  });

  it('never matches content from another screen', () => {
    const entry = screenSearchIndex(units, [inter('Other lesson card', 'u2')], [exec({ unitId: 'u2', definitionId: 'ACC-01' })], new Map()).get('u1')!;
    expect(`${entry.own} ${entry.nested}`).not.toMatch(/other lesson|acc-01/);
  });

  it('is not cut short, so a check far down a long lesson can still be found', () => {
    const many = Array.from({ length: 300 }, (_, i) => exec({ id: `e${i}`, definitionId: `CASE-${i}`, reason: 'a long reason that takes up room in the index' }));
    expect(screenSearchIndex(units, [], many, new Map()).get('u1')!.own).toContain('case-299');
  });
});
