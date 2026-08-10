/**
 * Timelines that already say something, for an author facing an empty canvas.
 *
 * Not templates to fill in: each one compiles to a valid prompt as it stands, so pressing
 * a preset and queueing gives a real clip. The point is to make the *shape* of a good
 * document visible -- how long a shot runs, how much a `describes` should say, where the
 * dialogue goes -- which no amount of documentation teaches as fast as one worked example.
 *
 * Every duration is on H3's lattice already. The blocks carry no media: a file has to be
 * uploaded before it can be attached, and a preset that arrives with broken references is
 * worse than one that says where to put your own.
 */

const FPS = 24;

export const PRESETS = [
  {
    name: "Talking avatar",
    hint: "One shot, one speaker, no cuts — the layout H3 handles most reliably",
    build: () => ({
      duration: 192,
      global_prompt:
        "Live-action, a single medium close-up, soft even key light, shallow depth of "
        + "field, no cuts.",
      music: "",
      shots: [{
        start: 0,
        length: 192,
        prompt:
          "A woman sits at a desk facing the camera in a quiet room, shoulders still, "
          + "looking straight down the lens. Her mouth shapes the words as she speaks and "
          + "she blinks twice.",
        lines: [{
          text: "MiniMax H3 makes the voice and the picture in one pass. Nothing here was "
              + "dubbed on afterwards.",
          speaker: "A woman in her thirties with a warm, even voice at a measured pace",
          ids: "S1",
          delivery: "says",
          language: "English",
        }],
      }],
      moves: [{ start: 0, length: 192, camera: "static", prompt: "" }],
      cues: [{
        start: 0,
        length: 192,
        prompt: "A quiet room: faint air conditioning, no traffic, no music.",
      }],
    }),
  },
  {
    name: "Three-shot scene",
    hint: "Establish, subject, action — cuts on the eighths of an eight-second clip",
    build: () => ({
      duration: 192,
      global_prompt:
        "Live-action, cinematic, warm morning sunlight, shallow depth of field.",
      music: "A light pizzicato theme on plucked strings, with a brass flourish at the end.",
      shots: [
        { start: 0, length: 64, prompt: "A wide establishing view of the place, still and empty." },
        { start: 64, length: 64, prompt: "the subject arriving at the edge of the frame, seen from the waist up" },
        { start: 128, length: 64, prompt: "the subject reaching out and taking what it came for, the object lifting clear" },
      ],
      moves: [
        { start: 0, length: 64, camera: "dolly_in", prompt: "" },
        { start: 64, length: 64, camera: "static", prompt: "" },
        { start: 128, length: 64, camera: "crash_zoom", prompt: "onto the hands" },
      ],
      cues: [
        { start: 0, length: 128, prompt: "Quiet outdoor ambience: distant traffic, a light breeze." },
        { start: 128, length: 64, prompt: "A scrape, something tipping over, then one sharp crunch." },
      ],
    }),
  },
  {
    name: "Two-hander",
    hint: "Shot-reverse-shot, one speaker each — two blocks, because two voices are two blocks",
    build: () => ({
      duration: 192,
      global_prompt: "Live-action, two people at a table indoors, soft window light.",
      music: "",
      shots: [
        {
          start: 0,
          length: 96,
          prompt: "A man sits across a table, leaning forward on his elbows, looking off to the left of frame.",
          lines: [{
            text: "You already know what I am going to ask.",
            speaker: "A man in his fifties with a low, gravelled voice speaking slowly",
            ids: "S1", delivery: "says", language: "English",
          }],
        },
        {
          start: 96,
          length: 96,
          prompt: "the woman opposite him, hands flat on the table, meeting his eyes",
          lines: [{
            text: "And you already know the answer.",
            speaker: "A woman in her forties with a clear, level voice",
            ids: "S2", delivery: "answers", language: "English",
          }],
        },
      ],
      moves: [
        { start: 0, length: 96, camera: "static", prompt: "" },
        { start: 96, length: 96, camera: "static", prompt: "" },
      ],
      cues: [{ start: 0, length: 192, prompt: "A quiet room, faint street noise through glass." }],
    }),
  },
  {
    name: "Reference shot",
    hint: "One block waiting for an image — attach it, then fill describes and keep",
    build: () => ({
      duration: 124,
      global_prompt: "Live-action, cinematic, the look and grade of the reference kept throughout.",
      music: "",
      shots: [{
        start: 0,
        length: 124,
        prompt: "The subject of the reference image, moving for the first time: a slow turn "
              + "of the head and a shift of weight, everything else unchanged.",
      }],
      moves: [{ start: 0, length: 124, camera: "dolly_in", prompt: "" }],
      cues: [],
    }),
  },
];

/** A preset as a full document, ready to write into the widget. */
export function load(preset) {
  return { version: 1, fps: FPS, references: [], ...preset.build() };
}
