/**
 * What a shortened clip does to the blocks that no longer fit.
 *
 * The rule the author asked for: nothing is dropped for being late. The blocks nearest
 * the end pay for the cut, down to a floor of ten frames each, and the block in front of
 * them is shortened to make that room.
 *
 *   node tests/js/clamp.test.mjs
 */

import { clamp, FLOOR } from "../../web/timeline/model.js";

let failures = 0;
const check = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL ${name}: got ${a}, want ${b}`); failures++; }
};

const shots = (...pairs) => ({ shots: pairs.map(([start, length]) => ({ start, length })) });
const spans = (timeline) => timeline.shots.map((s) => [s.start, s.length]);

// A single block straddling the new end keeps its start and loses the overhang.
{
  const timeline = shots([0, 192]);
  const { touched, dropped } = clamp(timeline, 141);
  check("one block trimmed", spans(timeline), [[0, 141]]);
  check("one block touched", [touched, dropped.length], [true, 0]);
}

// A block that starts past the end is squeezed to the floor, and the one before it is
// cut back by exactly that much rather than being left overlapping.
{
  const timeline = shots([0, 150], [150, 42]);
  clamp(timeline, 141);
  check("the late block gets the floor", spans(timeline), [[0, 141 - FLOOR], [141 - FLOOR, FLOOR]]);
}

// The block that started past the end gets the floor; the one in front of it only loses
// the overhang that creates, and the one in front of that is already inside and untouched.
{
  const timeline = shots([0, 100], [100, 50], [150, 42]);
  clamp(timeline, 141);
  check("two late blocks", spans(timeline),
        [[0, 100], [100, 31], [131, FLOOR]]);
}

// Blocks already inside the clip are left exactly as they were.
{
  const timeline = shots([0, 60], [60, 40]);
  const { touched } = clamp(timeline, 141);
  check("nothing to do", spans(timeline), [[0, 60], [60, 40]]);
  check("nothing touched", touched, false);
}

// Duration zero means "follow the content", which is not a length to clamp to.
{
  const timeline = shots([0, 192]);
  const { touched } = clamp(timeline, 0);
  check("no duration, no clamp", spans(timeline), [[0, 192]]);
  check("no duration, untouched", touched, false);
}

// The front of the clip is reached: what cannot stand is removed, and its file comes back
// so the caller can keep it on the clip.
{
  const timeline = { shots: [
    { start: 0, length: 20, media: { filename: "a.png", kind: "image" } },
    { start: 20, length: 20, media: { filename: "b.png", kind: "image" } },
    { start: 40, length: 20, media: { filename: "c.png", kind: "image" } },
  ] };
  const { dropped } = clamp(timeline, 15);
  check("only what fits stands", spans(timeline), [[0, 15]]);
  check("the rest hand back their files",
        dropped.map((m) => m.filename).sort(), ["b.png", "c.png"]);
}

// Every track is clamped, not just MAIN.
{
  const timeline = { shots: [{ start: 0, length: 192 }], cues: [{ start: 0, length: 192 }],
                     moves: [{ start: 0, length: 192 }] };
  clamp(timeline, 141);
  check("all three tracks",
        [timeline.shots[0].length, timeline.cues[0].length, timeline.moves[0].length],
        [141, 141, 141]);
}

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("clamp: ok");
