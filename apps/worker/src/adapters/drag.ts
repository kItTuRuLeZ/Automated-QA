import type { Frame, Page } from 'playwright';

/** A rule item written as "drag: <thing> -> <place>" means: drag the first onto the second, with the mouse, like a learner. */
export function parseDragItem(label: string): { from: string; to: string } | undefined {
  const m = /^\s*drag\s*:\s*(.+?)\s*(?:->|→)\s*(.+?)\s*$/i.exec(label);
  return m ? { from: m[1]!, to: m[2]! } : undefined;
}

/**
 * Finds the one thing a drag item names: a visible element by its text, alt text, accessible name, or a selector the
 * reviewer wrote. Several matches are fine when they sit on the same spot (a drawn shape and the transparent copy
 * assistive technology uses); several different places are ambiguous and are refused rather than guessed.
 */
export async function resolveDragEnd(root: Page | Frame, name: string): Promise<string | undefined> {
  const q = name.replace(/"/g, '\\"');
  const candidates = [
    name,
    `text="${q}"`,
    `[alt="${q}" i]`,
    `[aria-label="${q}" i]`,
    `[alt*="${q}" i]`,
    `[aria-label*="${q}" i]`,
    `text=${name}`,
  ];
  for (const base of candidates) {
    const sel = `${base} >> visible=true`;
    let n = 0;
    try {
      n = await root.locator(sel).count();
    } catch {
      continue; // not a valid selector for this name
    }
    if (n === 0) continue;
    if (n === 1) return sel;
    const centers: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < Math.min(n, 8); i++) {
      const b = await root.locator(sel).nth(i).boundingBox().catch(() => null);
      if (b) centers.push({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    }
    if (centers.length === n && centers.every((c) => Math.abs(c.x - centers[0]!.x) < 12 && Math.abs(c.y - centers[0]!.y) < 12)) return `${sel} >> nth=0`;
  }
  return undefined;
}

/** Presses on the middle of one element, moves to the middle of another in small steps, and lets go. */
export async function performDrag(page: Page, root: Page | Frame, fromSelector: string, toSelector: string): Promise<void> {
  const from = await root.locator(fromSelector).first().boundingBox();
  const to = await root.locator(toSelector).first().boundingBox();
  if (!from || !to) throw new Error('The item to drag, or the place to drop it, could not be found on the screen.');
  const fx = from.x + from.width / 2;
  const fy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx + (tx - fx) * 0.1, fy + (ty - fy) * 0.1, { steps: 3 });
  await page.mouse.move(tx, ty, { steps: 12 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(400);
}
