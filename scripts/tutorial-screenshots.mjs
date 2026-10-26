/**
 * Captures the Start here screenshots (public/tutorial/*.png) from the running app, so they
 * can be retaken whenever the interface changes. Start the dev server first, then run
 * `npm run screenshots:tutorial` (or pass another app URL as the first argument).
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { EXAMPLES } from '../src/data/tutorialExamples.js';

const URL = process.argv[2] ?? 'http://127.0.0.1:3000/';
const OUT = 'public/tutorial';
const POINTER = `int main(void) {
    int x = 5;
    int *p = &x;
    *p = 7;
    return 0;
}
`;
const example = id => EXAMPLES.find(e => e.id === id).code;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1180, height: 560 },
  deviceScaleFactor: 2,
});
// Open on the Sandbox, as a returning student would, with an empty draft.
await page.addInitScript(() => localStorage.setItem('pointerviz.visited.v1', '1'));
await page.goto(URL);

const code = page.getByRole('textbox', { name: 'C source code' });
const button = name => page.getByRole('button', { name, exact: true });
const codePane = page.locator('section[aria-label="C code"]');
const memoryPane = page.locator('section[aria-label="memory diagram"]');
const save = (locator, name) => locator.screenshot({ path: `${OUT}/${name}.png` });
const nextLine = () => page.locator('.next-line-number').textContent();
const PAD = 20;
/** Just the diagram: every box, without the canvas's floating buttons. */
async function saveDiagram(name) {
  await page.getByRole('button', { name: /fit view/i }).click();
  // Fit view animates: measure once the viewport has stopped moving.
  const viewport = page.locator('.react-flow__viewport');
  let transform;
  do {
    transform = await viewport.evaluate(v => v.style.transform);
    await page.waitForTimeout(150);
  } while (transform !== (await viewport.evaluate(v => v.style.transform)));
  const boxes = await page
    .locator('.react-flow__node')
    .evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
  const x = Math.min(...boxes.map(b => b.left)) - PAD;
  const y = Math.min(...boxes.map(b => b.top)) - PAD;
  const style = await page.addStyleTag({
    content: '.canvas-overlay, .react-flow__controls { visibility: hidden; }',
  });
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: {
      x,
      y,
      width: Math.max(...boxes.map(b => b.right)) + PAD - x,
      height: Math.max(...boxes.map(b => b.bottom)) + PAD - y,
    },
  });
  await style.evaluate(s => s.remove());
}
/** Step over until the highlighted next line is `line`. */
async function stepTo(line) {
  for (let i = 0; i < 100 && (await nextLine()) !== String(line); i++)
    await button('Step over').click();
}

// 1. Write: a short program in the code pane.
await code.fill(POINTER);
await code.blur();
const pane = await codePane.boundingBox();
await page.screenshot({
  path: `${OUT}/write.png`,
  clip: { x: pane.x, y: pane.y, width: pane.width, height: 174 },
});

// 2. Run: the step controls Run brings up. 3. Step: the memory once p points at x.
await button('Run').click();
await stepTo(5);
await saveDiagram('memory');
await save(page.locator('.stepper'), 'controls');

// Reading the diagram: the linked list once all three nodes are built.
await code.fill(example('list'));
await button('Run').click();
await stepTo(14);
await saveDiagram('diagram');

// Draw memory yourself: an editable copy of a step, with a pointer open in the inspector.
// Wide enough that the inspector floats beside the diagram instead of covering it.
await page.setViewportSize({ width: 1500, height: 600 });
await code.fill(POINTER);
await button('Run').click();
await stepTo(5);
await button('Edit').click();
await page.locator('.mem-cell .name', { hasText: /^p$/ }).click();
await save(memoryPane, 'draw');

await browser.close();
console.log(`Saved the tutorial screenshots in ${OUT}/.`);
