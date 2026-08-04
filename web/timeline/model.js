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

/** The three editable tracks, in the order they are drawn. */
export const TRACKS = [
  { key: "shots", label: "MAIN", noun: "shot", media: ["image", "video"] },
  { key: "moves", label: "CAMERA", noun: "camera move", media: [] },
  { key: "cues", label: "AUDIO", noun: "audio cue", media: ["audio"] },
];

/** Which track a piece of media belongs on. */
export const TRACK_FOR_MEDIA = { image: "shots", video: "shots", audio: "cues" };

/** Camera vocabulary; must match CAMERA_PROSE in timeline.py. */
export const CAMERAS = [
  "", "static", "dolly_in", "dolly_out", "pan_left", "pan_right",
  "tilt_up", "tilt_down", "orbit", "handheld", "crash_zoom",
];

/** Round a frame count up to a length MiniMax H3 accepts (`length % 17 === 5`).
 *
 * The double modulo is not redundant. JavaScript's `%` keeps the sign of the left
 * operand, so `(5 - 14) % 17` is `-9` here and `8` in Python. Without the correction
 * this rounds *down* for any input where `frames % 17 > 5` -- silently shortening the
 * clip while still landing on the lattice, which makes it look correct.
 */
export function snapUp(frames) {
  const floored = Math.max(PHASE, Math.round(frames));
  return floored + (((PHASE - (floored % STRIDE)) % STRIDE) + STRIDE) % STRIDE;
}

export function fromSeconds(seconds) {
  return snapUp(Math.round(seconds * FPS));
}

export function toSeconds(frames) {
  return frames / FPS;
}

/** `0`, `1`, `2.5` — the timestamp form the H3 prompt templates use. */
export function formatSeconds(seconds) {
  return String(Math.round(seconds * 100) / 100);
}

export function emptyTimeline() {
  return {
    version: 1,
    fps: FPS,
    dialect: "timeline",
    global_prompt: "",
    shots: [],
    moves: [],
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

export function items(timeline, track) {
  if (!Array.isArray(timeline[track])) timeline[track] = [];
  return timeline[track];
}

/** Last frame covered by any track. */
export function span(timeline) {
  const ends = TRACKS.flatMap(({ key }) =>
    items(timeline, key).map((item) => item.start + item.length));
  return ends.length ? Math.max(...ends) : 0;
}

/** Clip length: an explicit duration, else the content past `start`, snapped to the
 *  lattice. Mirrors `Timeline.length` in timeline.py -- these must never disagree. */
export function length(timeline) {
  const start = Math.max(0, timeline.start || 0);
  return snapUp(duration(timeline) || Math.max(0, span(timeline) - start));
}

/** An explicit duration, accepting a legacy `end` as a way of stating one.
 *  Mirrors `_duration` in timeline.py. */
export function duration(timeline) {
  if (timeline.duration) return timeline.duration;
  if (timeline.end) return Math.max(0, timeline.end - Math.max(0, timeline.start || 0));
  return 0;
}

/** The half-open frame range that will be rendered. Mirrors `Timeline.window`.
 *  The end is derived, never stored, so start/end/duration cannot contradict. */
export function renderWindow(timeline) {
  const start = Math.max(0, timeline.start || 0);
  return [start, start + length(timeline)];
}

/** Append an item to a track, starting where that track currently ends. */
export function add(timeline, track, seconds = 1.5) {
  const list = items(timeline, track);
  const start = list.reduce((end, item) => Math.max(end, item.start + item.length), 0);
  const item = { start, length: Math.max(1, Math.round(seconds * FPS)), prompt: "" };
  if (track !== "cues") item.camera = "";
  list.push(item);
  return list.length - 1;
}

export function remove(timeline, track, index) {
  items(timeline, track).splice(index, 1);
}

/** Move or resize, clamped so an item stays on screen and at least one frame long. */
export function reshape(item, { start, length: len }) {
  if (start !== undefined) item.start = Math.max(0, Math.round(start));
  if (len !== undefined) item.length = Math.max(1, Math.round(len));
  return item;
}
