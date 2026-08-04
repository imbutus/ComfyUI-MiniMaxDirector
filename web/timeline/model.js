/**
 * The timeline document, in the browser.
 *
 * A deliberate mirror of `src/minimax_director/lattice.py` and `timeline.py`: same
 * frame lattice, same field names, same JSON. The editor and the compiler must never
 * disagree about what a valid length is, so the rule is written twice and tested on
 * both sides rather than guessed on one.
 *
 * Frames are authoritative. Seconds exist only for display.
 */

export const FPS = 24;
export const STRIDE = 17;
export const PHASE = 5;

/** Round a frame count up to a length MiniMax H3 accepts (`length % 17 === 5`). */
export function snapUp(frames) {
  const floored = Math.max(PHASE, Math.round(frames));
  return floored + ((PHASE - (floored % STRIDE)) % STRIDE);
}

export function fromSeconds(seconds) {
  return snapUp(Math.round(seconds * FPS));
}

export function toSeconds(frames) {
  return frames / FPS;
}

/** `0`, `1`, `2.5` — the timestamp form the H3 prompt templates use. */
export function formatSeconds(seconds) {
  const rounded = Math.round(seconds * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

export function emptyTimeline() {
  return {
    version: 1,
    fps: FPS,
    dialect: "timeline",
    global_prompt: "",
    shots: [],
    cues: [],
    references: [],
  };
}

/** Parse a widget payload; anything unreadable degrades to an empty timeline. */
export function parse(text) {
  if (!text || !text.trim()) return emptyTimeline();
  try {
    return { ...emptyTimeline(), ...JSON.parse(text) };
  } catch {
    return emptyTimeline();
  }
}

export function serialize(timeline) {
  return JSON.stringify(timeline, null, 2);
}

/** Last frame covered by any track. */
export function span(timeline) {
  const ends = [...timeline.shots, ...timeline.cues].map((item) => item.start + item.length);
  return ends.length ? Math.max(...ends) : 0;
}

/** Clip length: the span, snapped up to the lattice. */
export function length(timeline) {
  return snapUp(span(timeline));
}

/** Append a shot after the current end, one second long by default. */
export function addShot(timeline, seconds = 1) {
  const start = span(timeline);
  timeline.shots.push({
    start,
    length: Math.max(1, Math.round(seconds * FPS)),
    prompt: "",
    camera: "",
  });
  return timeline;
}

export function addCue(timeline, seconds = 1) {
  timeline.cues.push({
    start: 0,
    length: Math.max(1, Math.round(seconds * FPS)),
    prompt: "",
  });
  return timeline;
}

export function removeItem(timeline, track, index) {
  timeline[track].splice(index, 1);
  return timeline;
}

/** Move or resize an item, keeping it on screen and at least one frame long. */
export function reshape(item, { start, length: len }) {
  if (start !== undefined) item.start = Math.max(0, Math.round(start));
  if (len !== undefined) item.length = Math.max(1, Math.round(len));
  return item;
}
