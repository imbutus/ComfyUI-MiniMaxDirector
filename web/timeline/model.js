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

/**
 * Which tracks a file of each kind may be dropped on.
 *
 * A clip is two things at once -- a picture sequence and a soundtrack -- and the prompt
 * addresses both. On MAIN it is the picture, with its own sound travelling beside it; on
 * AUDIO it is the sound alone, and the pictures are never handed to the model. The rest
 * have one place they can go, which is what `TRACK_FOR_MEDIA` says.
 */
export const TRACKS_FOR_MEDIA = { image: ["shots"], video: ["shots", "cues"], audio: ["cues"] };

/** Camera vocabulary; must match CAMERA_PROSE in timeline.py. */
/** The camera vocabulary. No empty entry: a move that contributes no sentence is a block
 *  that does nothing, and `static` already says "the camera holds still" out loud, which
 *  is what an author picking "none" actually means. Documents written before this still
 *  carry `""` and still compile -- the note alone is used, as it always was. */
export const CAMERAS = [
  "static", "zoom_in", "zoom_out", "dolly_in", "dolly_out",
  "pan_left", "pan_right", "truck_left", "truck_right",
  "tilt_up", "tilt_down", "pedestal_up", "pedestal_down",
  "orbit", "tracking", "pov", "roll_cw", "roll_ccw",
  "handheld", "shake_strongly",
];

/** The other two dimensions of a move: how far it travels, and how fast (base §4.3).
 *
 *  Empty is not "unset" -- the guide says medium amplitude and normal speed "are usually
 *  omitted", so saying nothing is already saying medium. The pickers show that as a
 *  labelled option rather than a blank, because a blank looks like a control nobody
 *  finished wiring up. */
export const AMPLITUDES = ["", "small", "large"];
export const SPEEDS = ["", "slow", "fast"];

/** What a document written before those two fields existed meant by its camera value.
 *  Mirrors `LEGACY_AMPLITUDE_SPEED` in timeline.py. */
const LEGACY_DYNAMICS = {
  dolly_in: ["small", "slow"],
  dolly_out: ["small", "slow"],
  crash_zoom: ["large", "fast"],
};

/** How a shot is entered. `cut` is the ordinary one; the rest are the three the guide
 *  allows "when explicitly requested by the user", which is what picking one is. */
export const TRANSITIONS = ["cut", "dissolve", "fade", "wipe"];

/** How much of a reference survives into the video, for `retention_analysis`.
 *
 *  Fixed English values in H3's full-reference output format, not prose -- these four and
 *  no others. Kept in step with `RETENTIONS` in `timeline.py`, which is what compiles. */
/** What an attached file is *for*. Kept in step with `ROLE_TASKS` in `timeline.py`, which
 *  maps each one to the task type the guide names for that job -- the compiler writes them
 *  into the summary's bracketed prefix, combined with ` + ` when a clip has several. */
export const ROLES = [
  "reference", "storyboard", "first frame", "keyframe", "last frame",
  "continue from", "edit",
];

/** The two roles the model has an input for: a block used as one of these *is* that frame
 *  of the clip, which is why it alone is fitted to the clip's shape. Kept in step with
 *  `ANCHOR_ROLES` in `timeline.py`. */
export const ANCHOR_ROLES = ["first frame", "last frame"];

/** How a keyframe is brought to the clip's shape when the two disagree. `crop` keeps the
 *  picture's proportions and loses its edges; `stretch` is what ComfyUI's core node does
 *  on its own -- the whole picture, squashed. Kept in step with `FITS` in `timeline.py`. */
export const FITS = ["crop", "stretch"];

/** How large a reference picture reaches the model. The node's own `ref_image_size` answers
 *  for the whole clip; a picture may say one of these instead, and blank means it does not.
 *  Core's two words, kept in step with `SIZINGS` in `timeline.py`. */
export const SIZINGS = ["match", "max"];

export const RETENTIONS = [
  "fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference",
];

/** The same question asked of an `<Audio N>`, in the words its own format uses (ref §4.2).
 *
 *  Not synonyms of the four above: `fully_copy` says the source *is* the final track and
 *  `reference` says the signal is never copied. Kept in step with `AUDIO_RETENTIONS` in
 *  timeline.py. */
export const AUDIO_RETENTIONS = [
  "fully_copy", "partially_copy", "reference", "weak_reference",
];

/**
 * Which set a file's marker is drawn from. Where it sits decides, never the author.
 *
 * A recording is graded in the audio words, and so is a clip on the AUDIO track: there it
 * is its soundtrack and nothing else, which is what `_markers` in compile.py reads off the
 * attachment's own kind. The same clip on MAIN is graded in the visual words.
 */
export const retentionsFor = (kind, track = null) =>
  (kind === "audio" || track === "cues" ? AUDIO_RETENTIONS : RETENTIONS);

/** One line, always: every run of whitespace becomes a single space.
 *
 * The twin of `timeline.flat()` in Python, and it exists in both languages for the same
 * reason the vocabularies do -- the compiler flattens what it is given, and a box that
 * shows four lines while the prompt carries one is the editor telling a small lie. The
 * editor applies it when a field is left; the compiler applies it again, because a
 * document can also arrive from somewhere the editor never touched.
 */
export const flat = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

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
    global_prompt: "",
    music: "",
    // Off on a blank canvas: most clips have no dialogue, and the cast and the block's
    // dialogue row are noise until one does.
    speech: false,
    speakers: [],
    shots: [],
    moves: [],
    cues: [],
    // Files that belong to the clip rather than to a moment in it: a face carried onto
    // whoever is on screen, a look held throughout. They are numbered with the rest and
    // described on a card, and no block is cut in half to hold them.
    sources: [],
    references: [],
  };
}

/** `"S1,S2"` -> `[1, 2]`. Anything unreadable is speaker 1. */
export function speakerNumbers(ids) {
  const found = String(ids || "")
    .split(",")
    .map((part) => parseInt(part.replace(/[^0-9]/g, ""), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return found.length ? found : [1];
}

export function speakerIds(numbers) {
  return numbers.map((n) => `S${n}`).join(",");
}

/** Parse a widget payload; anything unreadable degrades to an empty timeline. */
export function parse(text) {
  if (!text || !text.trim()) return emptyTimeline();
  try {
    const timeline = { ...emptyTimeline(), ...JSON.parse(text) };
    // A camera block with no move contributes no camera sentence, which makes it a block
    // that does nothing. Documents written before the empty value was dropped are read as
    // `static` -- the move they were already describing by holding still.
    for (const move of Array.isArray(timeline.moves) ? timeline.moves : []) {
      if (!move.camera) move.camera = "static";
      // Absent is a document from before amplitude and speed were fields, and its camera
      // value carried both of them inside its sentence. Empty is an author saying medium
      // and normal out loud, so only the absent case is filled in.
      if (move.amplitude === undefined && move.speed === undefined) {
        const [amplitude, speed] = LEGACY_DYNAMICS[move.camera] || ["", ""];
        move.amplitude = amplitude;
        move.speed = speed;
      }
    }

    // Before the cast existed the voice was written on each line. Those documents are read
    // by lifting the first description given for each number up to the document, which is
    // the same speaker the author meant -- and mirrors what `_speakers` does in Python, so
    // the editor and the compiler never disagree about who is in a clip.
    // A document written before the switch existed answers for itself: it has dialogue
    // if it contains spoken words. Mirrors `_speech` in timeline.py.
    if (typeof timeline.speech !== "boolean") {
      timeline.speech = (Array.isArray(timeline.shots) ? timeline.shots : [])
        .some((shot) => (shot.lines || []).some((line) => String(line.text || "").trim()));
    }

    if (!Array.isArray(timeline.speakers)) timeline.speakers = [];
    if (!timeline.speakers.length) {
      const found = new Map();
      for (const shot of Array.isArray(timeline.shots) ? timeline.shots : []) {
        for (const line of shot.lines || []) {
          const described = String(line.speaker || "").trim();
          if (!described) continue;
          for (const number of speakerNumbers(line.ids)) {
            if (!found.has(number)) found.set(number, described);
          }
        }
      }
      timeline.speakers = [...found.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([id, voice]) => ({ id, voice }));
    }

    return timeline;
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

/** Clip length: an explicit duration, else the content, snapped to the lattice.
 *  Mirrors `Timeline.length` in timeline.py -- these two must never disagree. */
export function length(timeline) {
  return snapUp(timeline.duration || span(timeline));
}

/**
 * The clip as it is edited: the duration as typed, else the content. Not snapped.
 *
 * `length` is what H3 renders, which is this rounded up to the lattice. Editing against
 * the rounded number put up to sixteen frames of empty timeline past the last block --
 * a gap nobody asked for, next to a duration box reading the number they did ask for.
 * The padding is a fact about the render, and the settings row is where it is said.
 */
export function extent(timeline) {
  return Math.max(timeline.duration || 0, span(timeline));
}

/**
 * The hard right edge nothing may cross.
 *
 * An explicit duration pins the clip, and segments live inside it: set the length of the
 * piece first, then arrange it. Without one the clip is content-sized, so there is
 * nothing to bump into and blocks grow the timeline as they go.
 */
export function ceiling(timeline) {
  return timeline.duration > 0 ? timeline.duration : Infinity;
}

/**
 * Put a new item on a track: at `at` if it fits there, otherwise after everything.
 *
 * A full clip is not a reason to refuse. Pressing Add and getting nothing reads as a
 * broken button, so the segment is added at its normal length and the clip stretches to
 * hold it -- the same rule a typed length follows.
 */
export function add(timeline, track, seconds = 1.5, at = null) {
  const list = items(timeline, track);
  const wanted = Math.max(1, Math.round(seconds * FPS));
  let start = list.reduce((end, item) => Math.max(end, item.start + item.length), 0);
  let size = wanted;

  // The playhead is where you are looking, so it is where a new block goes -- unless it
  // is standing inside one, where there is no room to put anything and appending is the
  // only answer that does not overlap. A gap shorter than the default is used as it is
  // rather than refused: a two-second block that does not fit is still a block.
  if (at !== null) {
    const frame = Math.max(0, Math.round(at));
    const inside = list.some((item) => frame >= item.start && frame < item.start + item.length);
    const next = list.reduce(
      (edge, item) => (item.start >= frame ? Math.min(edge, item.start) : edge), Infinity);
    if (!inside && next - frame >= 1) {
      start = frame;
      size = Math.min(wanted, next - frame);
    }
  }

  const item = { start, length: size, prompt: "" };
  // A camera block with no move is a camera block that does nothing -- the reason to add
  // one is to say how the camera behaves, and "holds a static shot" is the answer for a
  // shot nobody has decided about yet.
  if (track === "moves") Object.assign(item, { camera: "static", amplitude: "", speed: "" });
  // Written rather than left absent so the field exists to be read: an ordinary cut is a
  // choice the author has made by not making another one.
  if (track === "shots") item.transition = "cut";
  list.push(item);

  stretchFor(timeline, item);
  return list.length - 1;
}

/**
 * Grow the clip to hold a segment that runs past its end, landing on the lattice.
 *
 * H3 only renders lengths of `17n+5`, so a clip built to 144 frames is generated as 158
 * whatever the editor says. Stretching to the raw end left fourteen frames past the last
 * block with no shot describing them -- frames that are in the output. The block that
 * pushed the clip takes them instead: the timeline is then exactly what renders, and
 * every frame of it is described by something.
 *
 * Only for content that grows the clip. A duration typed by hand is a decision about the
 * length of the piece, and blocks are not resized behind it.
 */
export function stretchFor(timeline, item) {
  const end = item.start + item.length;
  if (end <= ceiling(timeline)) return;
  const snapped = snapUp(end);
  item.length += snapped - end;
  timeline.duration = snapped;
}

export function remove(timeline, track, index) {
  items(timeline, track).splice(index, 1);
}

/**
 * The free span around an item on its track: the gap its neighbours leave it.
 *
 * `ignore` holds indices that are moving with it, so a group drag is bounded by the
 * blocks it is passing rather than by its own members.
 */
export function bounds(timeline, track, index, ignore = []) {
  const [lower, upper] = neighbours(timeline, track, index, ignore);
  return [lower, Math.min(upper, ceiling(timeline))];
}

/**
 * The same gap, ignoring the end of the clip.
 *
 * Dragging is bounded by the duration -- a gesture aims at a place on screen, and the
 * clip is that screen. A typed number is not: it says how long the segment is, and the
 * clip grows to hold it. Both still refuse to overlap a neighbour.
 */
export function neighbours(timeline, track, index, ignore = []) {
  const list = items(timeline, track);
  const self = list[index];
  if (!self) return [0, Infinity];

  let lower = 0;
  let upper = Infinity;
  list.forEach((other, at) => {
    if (at === index || ignore.includes(at)) return;
    const end = other.start + other.length;
    if (end <= self.start) lower = Math.max(lower, end);
    else if (other.start >= self.start + self.length) upper = Math.min(upper, other.start);
  });
  return [lower, upper];
}

/** Move or resize, clamped so an item stays on screen and at least one frame long. */
export function reshape(item, { start, length: len }) {
  if (start !== undefined) item.start = Math.max(0, Math.round(start));
  if (len !== undefined) item.length = Math.max(1, Math.round(len));
  return item;
}

/** The subject records one file carries. Mirrors `attachments._named` in Python. */
export const entriesOf = (media) => {
  if (!media) return [];
  if (Array.isArray(media.subjects)) {
    return media.subjects.filter((entry) => entry && String(entry.name || "").trim());
  }
  const name = String(media.subject || "").trim();
  return name ? [{ name, subject_retention: media.subject_retention }] : [];
};

/**
 * Turn a file's single `subject` into the list form, in place.
 *
 * Called before any write. A document written before a file could hold two people keeps
 * compiling unchanged until something is edited, and converts the moment it is -- so the
 * two shapes never have to be handled by anything but this function.
 */
export const listOf = (media) => {
  if (!Array.isArray(media.subjects)) {
    media.subjects = entriesOf(media).map((entry) => ({ ...entry }));
    delete media.subject;
    delete media.subject_retention;
  }
  return media.subjects;
};

/**
 * Attached files in the order H3 numbers them: images first, then videos, each in time
 * order. A file with no subjects still takes its number, so the tokens on screen are the
 * tokens in the prompt.
 */
export const filesOf = (timeline) => {
  const shots = items(timeline, "shots")
    .map((shot, index) => ({ shot, index }))
    .sort((a, b) => a.shot.start - b.shot.start);
  const found = [];
  let pictures = 0;
  let videos = 0;
  for (const { shot, index } of shots) {
    if (shot.media?.kind !== "image") continue;
    pictures += 1;
    found.push({ token: `<Picture ${pictures}>`, media: shot.media, block: index });
  }
  // Then the clip's own files, which belong to no block. Same order as
  // `attachments.collect`, so a token here is the token in the prompt.
  for (const media of timeline?.sources || []) {
    if (media?.kind !== "image") continue;
    pictures += 1;
    found.push({ token: `<Picture ${pictures}>`, media, block: null });
  }
  for (const { shot, index } of shots) {
    if (shot.media?.kind !== "video") continue;
    videos += 1;
    found.push({ token: `<Video ${videos}>`, media: shot.media, block: index });
  }
  for (const media of timeline?.sources || []) {
    if (media?.kind !== "video") continue;
    videos += 1;
    found.push({ token: `<Video ${videos}>`, media, block: null });
  }
  return found;
};

/**
 * Everything the prompt addresses as `<Audio n>`, in the compiler's own order.
 *
 * A reference video carries its own soundtrack and the core node labels that immediately
 * before the video, so the videos' audio comes first and standalone cues follow. Mirrors
 * the audio half of `attachments.collect`.
 */
export const audioOf = (timeline) => {
  const byStart = (list) => [...list].sort((a, b) => a.start - b.start);
  const found = [];
  for (const shot of byStart(items(timeline, "shots"))) {
    if (shot.media?.kind !== "video") continue;
    found.push({ token: `<Audio ${found.length + 1}>`, media: shot.media, kind: "video" });
  }
  // A source clip's soundtrack is numbered with the blocks' clips, before the cues: it is
  // wired into the same `ref_videos` list. Mirrors `attachments.collect`.
  for (const media of timeline?.sources || []) {
    if (media?.kind !== "video") continue;
    found.push({ token: `<Audio ${found.length + 1}>`, media, kind: "video" });
  }
  // A cue carries a recording, or a clip that is on the AUDIO track for its sound alone.
  // Mirrors the cue half of `attachments.collect`.
  for (const cue of byStart(items(timeline, "cues"))) {
    if (cue.media?.kind !== "audio" && cue.media?.kind !== "video") continue;
    found.push({ token: `<Audio ${found.length + 1}>`, media: cue.media, kind: "audio" });
  }
  for (const media of timeline?.sources || []) {
    if (media?.kind !== "audio") continue;
    found.push({ token: `<Audio ${found.length + 1}>`, media, kind: "audio" });
  }
  return found;
};

/**
 * The `<Subject n>` labels this document defines, in the order the compiler numbers them.
 *
 * Mirrors `attachments.subjects` in Python. Written twice rather than shared because the
 * two run in different languages, and checked against each other by the compiled prompt.
 */
export const subjectsOf = (timeline) => {
  const found = [];
  for (const file of filesOf(timeline)) {
    entriesOf(file.media).forEach((entry, slot) => {
      found.push({
        index: found.length + 1,
        name: String(entry.name).trim(),
        entry,
        slot,
        block: file.block,
        media: file.media,
        source: file.token,
      });
    });
  }
  return found;
};

