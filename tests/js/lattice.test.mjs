/**
 * The frame lattice, checked against the same oracle the Python suite uses.
 *
 * The rule lives in two languages so the editor cannot express a length the compiler
 * would reject. That duplication is only safe if both sides are tested -- a sign
 * difference in `%` between the two once made this round down instead of up.
 *
 *   node tests/js/lattice.test.mjs
 */

import { snapUp, PHASE, STRIDE, FPS, length, renderWindow } from "../../web/timeline/model.js";

let failures = 0;
const check = (name, got, want) => {
  if (got !== want) { console.error(`FAIL ${name}: got ${got}, want ${want}`); failures++; }
};

/** The expression the official MiniMax H3 templates carry. */
const oracle = (seconds) => {
  const n = Math.max(5, Math.round(seconds * 24));
  return n + (((5 - (n % 17)) % 17) + 17) % 17;
};

for (let tenths = 1; tenths <= 300; tenths++) {
  const seconds = tenths / 10;
  const got = snapUp(Math.round(seconds * FPS));
  check(`snapUp(${seconds}s)`, got, oracle(seconds));
  check(`valid(${seconds}s)`, got % STRIDE, PHASE);
}

for (let frames = 0; frames < 600; frames++) {
  const got = snapUp(frames);
  check(`never shortens ${frames}`, got >= Math.max(frames, PHASE), true);
  check(`idempotent ${frames}`, snapUp(got), got);
}

check("48 frames rounds up, not down", snapUp(48), 56);
check("window length", length({ start: 24, end: 72, shots: [], moves: [], cues: [] }), 56);
check("window range", renderWindow({ start: 24, end: 72 }).join(","), "24,72");

if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
console.log("lattice.test.mjs: all checks passed");
