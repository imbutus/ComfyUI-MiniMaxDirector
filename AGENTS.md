# AGENTS.md — how this project works, in full

Written for a model reading the repository cold. Everything here is checked against the
code; where something is unverified it says so.

## What it is

A ComfyUI node pack. One node, `MiniMaxDirector`, turns a timeline of shots into the
single structured prompt the MiniMax H3 video model reads, and hands the sampler
conditioning plus a starting latent. Two helper nodes expose the compile step and the
frame-length rule on their own.

The product is a **string**. Everything else is arithmetic around it.

## End-to-end data flow

```
timeline JSON  (one widget on the node)
     │
     ├── attachments.collect ──► reference ordinals + files to load
     ├── references.assign ────► ordinals for sockets wired by hand
     ▼
compile.compile_timeline ─────► prompt string + frame count
     │
     ▼
core.call("MiniMaxH3ReferenceToVideo" | "MiniMaxH3ImageToVideo")
     │                                   (ComfyUI core, not ours)
     ▼
(positive CONDITIONING, LATENT)  ──► BasicGuider ──► SamplerCustomAdvanced
                                          │
                    ┌─────────────────────┴──────────────────────┐
              VAEDecode(video vae)                    VAEDecodeAudio(audio vae)
                    └──────────────► CreateVideo ◄───────────────┘
                                          ▼
                                      SaveVideo
```

The same `LATENT` goes to both decoders: H3's latent carries video **and** audio
together. There is no separate audio branch to keep in sync.

## The model's hard constraints

These are the model's, not design choices. Verified in
`comfy_extras/nodes_minimax_h3.py` and independently in `deepbeepmeep/Wan2GP`.

| Constraint | Value | Consequence |
|---|---|---|
| Frame rate | fixed **24 fps** (`FPS = 24`) | no rate to expose; Wan2GP raises on anything else |
| Clip length | `length % 17 == 5` | 5, 22, 39, 56, 73, 90, 107, 124 … only 8s, 25s, 42s are whole seconds |
| Trained range | ~124–362 frames (5.2–15.1s) | the node accepts up to 3600, untested there |
| Reference caps | 9 images, 3 videos, 3 video-soundtracks, 3 audios | `io.Autogrow` templates |
| Guidance | CFG-free | official graphs use `BasicGuider`, never a negative prompt |

The 17 comes from the video VAE's time axis: the latent is a row of slots, 17 frames pack
into 5 of them after a 5-frame head worth 2 -- core writes it as
`((frames - 5) // 17) * 5 + 2` (`comfy_extras/nodes_minimax_h3.py:39`). A length off the
lattice needs a fraction of a slot. `lattice.snap_up` implements it and **never rounds
down**; `model.js:stretchFor` applies it in the editor, so the document is already on the
lattice before it reaches the compiler.

## The two core nodes, and why the choice matters

| | `MiniMaxH3ImageToVideo` | `MiniMaxH3ReferenceToVideo` |
|---|---|---|
| keyframes | `first_frame`, `last_frame` | **none** |
| references | none | `ref_images`, `ref_videos`, `ref_video_audios`, `ref_audios` |
| audio vae | not taken | required |
| checkpoint | `minimax_h3_fl2va_*` | `minimax_h3_ref2va_*` |

`MiniMaxDirector.execute` picks the reference node when any reference is present,
otherwise the keyframe node. **The checkpoints are not interchangeable** — loading
`ref2va` and taking the keyframe path is a silent mismatch the graph cannot detect.

Because the reference node has no `first_frame`, wiring both is impossible to honour;
the node reports an error rather than dropping the keyframe quietly.

## The timeline document

One JSON object in one widget. It is the only state; the editor is a view over it.

```json
{
  "version": 1,
  "fps": 24,
  "dialect": "timeline",
  "duration": 124,
  "global_prompt": "Style and scene constants for the whole clip.",
  "shots": [
    { "start": 0, "length": 41, "prompt": "…", "camera": "dolly_in",
      "transition": "cut", "screen_text": "OPEN 24H",
      "lines": [ { "text": "I get off at the next station.", "ids": "S1",
                   "delivery": "says", "language": "English",
                   "offscreen": false, "carries": false } ],
      "media": { "kind": "image", "filename": "a.png", "subfolder": "" } }
  ],
  "moves": [ { "start": 0, "length": 41, "camera": "pan_right", "prompt": "…",
               "amplitude": "large", "speed": "fast" } ],
  "cues":  [ { "start": 0, "length": 41, "prompt": "…", "media": { "kind": "audio", … } } ],
  "references": []
}
```

- **Frames are authoritative.** Seconds are derived at compile time only.
- `duration` 0 means "as long as the content needs". The rendered length is
  `snap_up(duration or span)`. A new timeline starts at **124** rather than 0, so the
  clip is a fixed thing you arrange segments inside from the first click.
- **The duration bounds dragging, and typing bounds the duration.** A drag stops at the
  end of the clip -- a gesture aims at a place on screen. A typed length or a new segment
  stretches the clip instead, because refusing them leaves no way to lengthen a block
  except editing the duration first and the block second. `bounds()` is the drag limit,
  `neighbours()` the typed one; neither permits an overlap.
- **Content that grows the clip lands on the lattice, and takes the padding with it.**
  `stretchFor` snaps the new end up to `17n+5` and adds the difference to the block that
  pushed it, so `span == duration == length` and no frame of the output is undescribed. A
  duration typed by hand snaps too, but never resizes a block: that is a statement about
  the piece.
- `references` is rebuilt from what is actually connected before compiling; the stored
  copy is never trusted.
- Unknown keys survive a round trip through the editor.
- A shot's `lines` is a list, one entry per spoken line: `text` sent verbatim, `ids` the
  guide's `(S1)` or `(S1,S2)`, `delivery` the verb, `language` the tag. Two speakers on
  one line is a chorus; two lines is a conversation. A wordless line is kept, not dropped
  at the door, so `lint` can say the half-filled row exists.
- `offscreen` on a line is a voiceover, and writes **both** halves of the guide's fixed
  form: the exact phrase `says in an off-screen voiceover`, and the clause required after
  every one -- lips remain completely closed.
- `carries` says the line does not end inside its block. Which tag that becomes is not
  authored: `<scenetrans>` on both sides of the cut when a shot follows, `<cutoff>` when
  none does. `Shot.text` takes `carried` and `cutoff` for exactly this, because neither
  fact is visible from inside a shot.
- `amplitude` and `speed` on a move are the guide's other two camera dimensions. **Absent
  is not empty**: absent means a document from before the fields existed, whose camera
  value carried both inside its sentence, and `_dynamics` / `LEGACY_AMPLITUDE_SPEED` fill
  in what it meant. Empty is an author saying medium and normal out loud.
- `transition` defaults to `cut` and is ignored on the first shot, which is entered from
  nowhere. `screen_text` is quoted verbatim into the shot's prose.

## The cast document

A second widget, parsed by `cast.py` and folded into the timeline before compiling. One
card per person: `name`, `file` (which attachment they are drawn from), `description`,
`voice`, `keep` (their own `subject_retention`), `onto`, `motion_from`, `voice_from`, and
a stable `uid`.

- A card **with** a file and a description appends a subject to that file's `subjects`;
  every card appends a speaker. Both ends carry the card's `uid`, so the `<Subject n>` a
  voice belongs to survives the renumbering that dragging a block causes.
- `onto` is the receiver of an `attribute_transfer`, and only means anything for that
  marker. `compile.py` appends `, transferred onto <onto>` to the subject's retention
  line; without it the model is told to move a trait and never told where.
- The person and the file they came from are two retentions, deliberately: a photo can be
  `fully_preserved` while the face lifted out of it is an `attribute_transfer`.
- `_only_defines` in `compile.py` suppresses a file's own `<Picture n>` entry — in both
  `subject_definitions` and `retention_analysis` — when its role is `reference` and a
  subject is drawn from it. That is the guide's rule: an image used only to define a
  character is cited inside the `<Subject n>` line instead. A frame anchor, a continuation
  source or an edit target keeps its entry however many people it defines.
- `motion_from` and `voice_from` are the guide's many-to-many case (§2.1): one subject
  defined by several assets. Both are **filenames**, for the same reason `file` is --
  `<Video 1>` is computed from where blocks sit -- and `compile.py` resolves them to
  tokens at the last moment. `motion_from` lands on the subject entry as `motion_file`
  and changes the subject's sentence to name what each asset supplies; `voice_from` lands
  on the speaker and marks the audio's own record with a `voices` entry, which is what
  lets `_retention` tell "nothing was said" from "this is a timbre reference".

## What the compiler emits

Two formats, chosen by whether anything is attached -- never by a widget. Nothing attached
is the base guide's three fields; anything attached routes the graph to
`MiniMaxH3ReferenceToVideo` and takes its six-section form.

```
integrated_multimodal_description: [Shot 1] <global> <shot text> <tokens> <camera> <sound>
[Shot 2] At 00:01.708, the camera cuts to <shot text> …

overall_soundscape: <cues that span more than one shot>

non_diegetic_music: <music, or N/A>
```

```
subject_definitions:
<Picture 1> is …
<Subject 1> is …, from <Picture 1>.

summary:
[reference generation + audio reference] A two-shot clip of …

retention_analysis:
<Picture 1> (appears in [Shot 1]): fully_preserved - …

detailed_description: <global>
[Shot 1] <shot text> …

overall_soundscape: …

non_diegetic_music: …
```

The shot body is one string in both (§5.1), with one deliberate difference: the global
prompt opens `[Shot 1]` in the base format and sits on its own line above it in the
reference format (§5.2). That is what `_description(style_apart=)` selects.

Camera work is written **inside** the shot it overlaps, not in a section of its own --
measured 2026-08-05, a separate `Camera:` block was ignored. It stays a separate track in
the editor because a move can straddle a cut, and folding it into a shot line at authoring
time would silently pick a side.

## Reference numbering — the subtle part

H3 addresses references from the prose as `<Picture i>`, `<Video k>`, `<Audio j>`,
1-based per type. The order is **presentation order**, not slot order:

1. every image, in timeline order;
2. then each video, **preceded by its own soundtrack's `<Audio j>`**;
3. then standalone audio, continuing the same `j` counter.

So one video with sound plus one standalone clip yields `<Audio 1>` (soundtrack),
`<Video 1>`, `<Audio 2>`. Numbering per slot index instead points the prompt at the wrong
file — it does not crash, it generates the wrong video. `attachments.py` and
`references.py` both implement this; `tests/test_references.py` pins it.

Files on the timeline are numbered first, sockets after. The compiler appends a
segment's token to its line unless the author already wrote it, because H3 only uses a
reference the prose points at.

## Module map

| File | Owns | Imports ComfyUI? |
|---|---|---|
| `lattice.py` | frame arithmetic, the 17-frame rule | no |
| `timeline.py` | the document, its JSON | no |
| `compile.py` | document → prompt | no |
| `lint.py` | pre-flight checks | no |
| `cast.py` | the cast document, merged into the timeline | no |
| `attachments.py` | files on segments, their ordinals | no |
| `references.py` | files on sockets, their ordinals | no |
| `core.py` | adapter over ComfyUI's H3 nodes | yes |
| `nodes/director.py` | the registered node classes | yes |
| `web/` | the editor: plain ES modules, no build step | browser only |

The first six are the whole product and run under `pytest` with no torch, no ComfyUI,
no weights, in about 0.2 seconds.

## Invariants — break these and something silently misbehaves

1. **The lattice exists in two languages.** `lattice.py` and `web/timeline/model.js` must
   agree. JavaScript's `%` keeps the sign of its left operand, so `(5 - 14) % 17` is `-9`
   there and `8` in Python; the JS needs `((x % n) + n) % n`. Getting this wrong rounds
   *down* onto a valid-looking length. `tests/js/lattice.test.mjs` checks both.
2. **Every CSS class is `mmd-` prefixed.** ComfyUI ships utility classes; a plain
   `.fixed` inherited `position: fixed` and printed on top of its own label. A descendant
   selector does not protect you — it only wins for properties it declares.
3. **A custom node cannot replace a core node.** `init_external_custom_nodes` snapshots
   `base_node_names` before loading and passes it as `ignore`. Display names have no such
   guard, so the UI will happily lie about which class is running.
4. **The settings row updates in place.** Rebuilding its markup destroys whatever is
   being typed; never write into an element that has focus.
5. **Selection is a class toggle, not a re-render.** Re-rendering on pointerdown replaces
   the element mid-gesture and a double-click never lands.
6. **Tensors are not booleans.** `any(list_of_tensors)` raises; test `is not None`.
7. **The segment panel rebuilds only when its shape changes.** `panelShape` guards it.
   Rebuilding on every render tears out the focused input, ComfyUI hands focus back to
   the canvas, and the next Delete is no longer aimed at a field -- so it deletes a
   block instead of a character. The failure looks nothing like its cause.
8. **A number input reads as `""` while half-typed.** `"2."` is not a number yet.
   Treating that as `0` clamps to one frame and writes the result back over what is
   being typed. Ignore values until they parse.
9. **Every fixed vocabulary exists in two languages too.** `CAMERA_MOTION`, `RETENTIONS`,
   `AUDIO_RETENTIONS`, `ROLES`, `TRANSITIONS`, `AMPLITUDES`, `SPEEDS` are written in
   `timeline.py` and mirrored in `web/timeline/model.js`. A value the editor offers and
   the compiler has never heard of does not raise -- it compiles to *itself*, the raw enum
   key, in the middle of a sentence sent to the model as prose. `tests/test_vocabulary.py`
   reads `model.js` as text and compares the lists.
10. **An audio marker is not a visual marker.** H3's format defines `fully_copy /
    partially_copy / reference / weak_reference` for `<Audio N>` and the four
    `*_preserved` values for everything visible. They overlap only at `weak_reference`.
    `_markers()` picks by the attachment's kind, and `RETENTION_ACROSS` translates rather
    than resets -- which matters twice: for old documents, and for a reference video's
    soundtrack, which shares the video's record and so carries a visual marker by nature.
11. **A shape key that misses a conditional control shows it one selection late.** The
    panel's `shape` string must name every fact that adds or removes markup -- today
    whether this is the first shot (no transition) and whether the camera is static (no
    amplitude or speed). Values alone are repainted; structure is rebuilt.

## Calling into ComfyUI

`core.call(name, **kwargs)` resolves the class from `NODE_CLASS_MAPPINGS`, reads its
entry point from `FUNCTION`, drops arguments the installed version does not declare, and
unwraps the result. The H3 nodes use ComfyUI's **V3 schema**: `FUNCTION` is
`EXECUTE_NORMALIZED` and the return is a `NodeOutput` carrying values on `.result`.
Autogrow inputs arrive as **dicts** — `ref_images={"ref_image_0": tensor}` — not as flat
keyword arguments.

## Tests

```bash
pytest                                  # the compiler and its rules, no dependencies
node tests/js/lattice.test.mjs          # the lattice on the JavaScript side
COMFYUI_PATH=~/dev/ComfyUI $COMFYUI_PATH/.venv/bin/python -m pytest tests/graph
```

The graph tests import ComfyUI in-process, patch the registry with stubs from
`tests/graph/stubs.py`, and drive `execution.validate_prompt` and
`execution.PromptExecutor` directly. `CreateVideo` and `SaveVideo` are deliberately not
stubbed, so a pass leaves a real h264+aac mp4 whose duration is `length / 24`.

## Keeping this file true

**This file is part of the code. A change that makes it wrong is an incomplete change.**

Documentation that lags the code is worse than none: it is read with the same trust and
answers with the wrong facts. So the rule is not "update the docs when convenient", it is
that the following pairs land in the same commit.

| When you change | Also update |
|---|---|
| a node's inputs, outputs or name | the module map and the two-core-nodes table here; `README.md` node table; `docs/GUIDE.md` |
| anything a user can see or press | `docs/GUIDE.md` — buttons, panel fields, tracks, the camera table |
| the timeline JSON schema | the document section here; `docs/ARCHITECTURE.md` |
| the lattice, fps, or any model limit | the constraints table here; `README.md`; **both** `lattice.py` and `web/timeline/model.js` |
| reference ordering or token rules | the numbering section here; `tests/test_references.py`, `tests/test_attachments.py` |
| how ComfyUI is called (`core.py`) | the calling section here |
| anything that fails silently when broken | add it to the invariants list here |
| a fact moving from unverified to measured | the "never been verified" list — shrink it, do not leave it stale |
| **any new feature at all** | the four places below, in the same commit |

### Every new feature updates four places

Not a checklist to consult when it seems worth it — the feature is not finished until all
four say the same thing. A feature the docs do not mention is a feature nobody finds, and
the info note is the only documentation most people ever read, because it is already on
the canvas when they open the workflow.

1. **The info node** — the `Note` inside `examples/minimax-director.json` *and*
   `examples/minimax-director-turbo.json`. Both, identically; they are two copies of one
   text and drifting them apart is how the turbo workflow ends up describing an older
   build.
2. **The local docs** — `docs/GUIDE.md` for anything an author can see or press,
   `README.md` when the feature changes what the pack is, this file for schema, flow and
   invariants.
3. **The-project docs** — `~/Projects/experiments/the-project/comfyui/examples/video-minimaxh3/`
   holds the shipped copies `minimaxh3-director.json` and `minimaxh3-director-turbo.json`.
   Their info notes are the same text as (1) and are updated in the same pass.
4. **The recording plan** —
   `~/Projects/experiments/the-project-promotion/socials/youtube/imbutus-media/minimax-director/actions.md`,
   whenever the feature is something a viewer would see happen on screen.

Write the JSON copies with `json.dump(..., indent=2, ensure_ascii=False)` and a trailing
newline, so a workflow file never shows up in review as one rewritten line.

If a GPU run answers one of the open questions, that answer belongs here in the same
sitting. The value of the list is that it is honest about its own edges; a stale entry
destroys that in a way a missing entry does not.

## Measured against real weights — 2026-08-05

One clip, 832x480, 124 frames, `timeline` dialect: three shots with a reference image
each (apple / cube / bottle), three camera moves, two audio cues.

**Confirmed.** The premise holds — H3 reads the shot list and obeys it.

- Output was exactly 124 frames at 24 fps, 5.167s. The lattice arithmetic is right
  end to end.
- The three subjects appeared **in the written order**, with exactly two cuts, each
  matching its attached reference image.
- One pass produced h264 **and** AAC stereo from the one latent. The channels genuinely
  differ (difference signal 18 dB below the content), though the image is narrow.
- Cut 2 landed at 3.375s against 3.417s asked for -- one frame early.

**Partly.** Cut 1 landed at 2.083s against 1.708s asked for: **9 frames late**. So
segment boundaries are approximate, not exact. Do not promise frame-accurate cuts.

**Not honoured: per-segment camera.** `dolly_in` on shot 1 did push in (subject grew
2.15x), but `static` on shot 3 pushed in as well -- and was in fact the *most* active
segment of the three (5.3% mean frame-to-frame change, against 2.3% for the segment that
asked for a dolly). `pan_right` on shot 2 produced no consistent horizontal drift. The
`Camera:` block reads as one overall mood rather than a per-span instruction.

**Not honoured: audio cues.** Cue 1 asked for "one clear bell chime, then silence" over
0-1.71s; the clip's loudest event was a broadband burst at 2.07s, within 0.02s of the
**video cut** at 2.083s. The model scored the picture rather than read the `Audio:` block.

## Measured again -- 2026-08-05, documented format

Same timeline, `dialect: official`. **The camera fix landed.**

| segment | asked | run 1 | run 2 |
|---|---|---|---|
| shot 1 | `dolly_in` | 2.29% | 1.61% -- bbox grows 339->510px, pushing in |
| shot 2 | `pan_right` | 1.79% | 3.97% -- subject drifts left 479->416px |
| shot 3 | `static` | 5.29% | **0.23%** -- frozen |

(mean frame-to-frame change; direction verified by bounding box, not just motion.)

Cut 1 also went from 9 frames late to **exact** (1.708s asked, 1.708s measured). Cut 2
stayed one frame early. Shot order and references were right again.

**Audio: the cue was produced, in the wrong place.** Two bell transients, -93 to -14 dB at
1.696s and -93 to -4.9 dB at 3.424s -- both on the cuts -- with digital silence through
the 0-1.71s span that asked for one. So `overall_soundscape` reaches the model and is
used, but being an untimed field, the model synced the event to the only structure it
could see. Hence the split above: a cue inside one shot is written into that shot.

## Measured a third time -- 2026-08-05, cue inside the shot

**The audio fix landed.** Same timeline at 158 frames.

```
one onset, t=0.064s, -80.2 -> -13.9 dB
all loud content between 0.064s and 0.992s
nothing at either cut (1.708s, 3.333s)
```

One bell, at the start, inside the shot that asked for it. Run 2 fired it twice on the
cuts. Camera held: 1.12% / 5.29% / **0.21%** for dolly_in / pan_right / static, and the
static shot is pixel-identical across four seconds. Cuts at 1.708s (exact) and 3.333s.

So the rule holds for both faculties the model was ignoring: **anything timed belongs in
`integrated_multimodal_description`.** Sections of our own invention are not read, and
untimed fields get synced to the picture.

## What has never been verified

- **Whether `non_diegetic_music` does anything.** Never exercised -- every run so far has
  left the field empty, so its `N/A` output tells us nothing.
- whether `ref_image_size: match` behaves as its tooltip describes;
- how the model behaves outside its trained length range;
- whether cut timing can be made exact, or is always approximate to within a few frames.

Claims about *interfaces* -- node signatures, the lattice, reference ordering -- are read
from the source.
