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
| Reference caps | 9 images, 3 videos, 3 video-soundtracks, 3 audios | the core node's own autogrow templates; the director has no reference sockets and sends what its timeline holds |
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

Both keyframes come off the timeline: a block whose `used as` is one of `ANCHOR_ROLES`
(`first frame`, `last frame`) has its image loaded into that argument instead of into the
reference list — the first block claiming each role takes it. The director declares no
sockets for them, or for references. Because the reference node has no `first_frame`, a
timeline holding an anchor *and* a reference is impossible to honour; the node reports an
error rather than dropping the keyframe quietly.

`keyframe` is deliberately outside `ANCHOR_ROLES`. There is no third input to load it
into, so a block used as one stays in the reference list; only its `ROLE_TASKS` entry
(`keyframe completion`) and its `_appears_in` suffix (`([Shot n] keyframe)`) change.
Naming it an anchor would promise placement the model has no way to honour.

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
  "sources": [ { "kind": "image", "filename": "face.jpg", "retention": "weak_reference" } ],
  "references": []
}
```

- **Frames are authoritative.** Seconds are derived at compile time only.
- A **reference video's soundtrack** is skipped by `_subject_definitions`,
  `_retention_analysis` and `_task_types` when nothing in the author's text names its token
  (`_rides_along`). It shares the video's record, so declaring it wrote the picture's
  description and the file's `fully_copy` as claims about the sound. Only for `role` =
  `reference`: a continuation or frame anchor carries its audio on purpose.
- A **subject's** shot list is not its file's. `_appears_in` unions the block the file sits
  on with every shot whose own words name the token (`_named_in`), because that is how the
  guide keeps one thing the same thing across a cut: the author writes `<Subject 1>` into
  each shot it appears in, with the chips. A file's shot list is unchanged — it is where
  the file is, not where the thing it defines is.
- `sources` are media records that belong to the clip rather than to a block. They are
  collected by `attachments.collect` after the blocks of their kind, with `origin=None`,
  which is what `_appears_in` reads when it decides whether to write `(appears in [Shot
  n])` — so a source has a number and a retention line and no shot list. A source video is
  wired into the same `ref_videos` list as the blocks', after them, so its soundtrack takes
  its `<Audio n>` there too — before the cues, which the core node emits last. A **video on
  the cues track** is one `<Audio n>` and no `<Video n>`: `collect` takes cue media of kind
  `audio` or `video`, and the director loads `_load(record)[1]` — the decoded soundtrack —
  into `ref_audios`, never its frames. `_markers` already grades it by the attachment's
  kind, so the audio vocabulary applies without a special case. A file whose
  job is to be carried onto whoever is on screen has no moment, and putting it on a block cut
  the clip at a seam the model then acted on. `tokens_by_segment` skips them: there is no
  block whose line could carry the token, so the author names it with a chip or a card
  draws a subject out of it, and `_check_sources` warns when neither happened. The editor
  writes them from the **Files** list (`+ file`, any of the three kinds), and dragging one
  out of that list onto a track moves the record from `sources` into a block — the same
  document either way, so nothing downstream knows which button the author used.
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
  duration typed by hand snaps too.
- **A shortened clip brings its tracks inside, and the tail pays for the cut.** `clamp()`
  in `model.js` walks each track backwards from the new end: a block straddling it keeps
  its start and loses the overhang, a block starting past it is squeezed to `FLOOR` (10)
  frames and the block in front gives up exactly that much. When the room runs out --
  `floor(duration / FLOOR)` blocks, at least one -- the latest blocks are removed and
  their media records handed back, so the caller can `keepFile` them the way deleting a
  block does. Raising a duration clamps nothing. Tested in `tests/js/clamp.test.mjs`.
- `references` is rebuilt from what is actually connected before compiling; the stored
  copy is never trusted.
- Unknown keys survive a round trip through the editor.
- A shot's `lines` is a list, one entry per spoken line: `text` sent verbatim, `ids` the
  guide's `(S1)` or `(S1,S2)`, `delivery` the verb, `language` the tag. Two speakers on
  one line is a chorus, and there may be any number -- Cmd/Ctrl-click adds one, a plain
  click replaces the list, the same modifier the canvas uses for its own selection; two
  lines is a conversation. A wordless line is kept, not dropped
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

## Heights

Two numbers, and one function that writes each.

- **The node's height is its content**, up and down, measured once by
  `contentHeightOf` and applied by `fitPulled`. Every path goes through it: load,
  tab switch, a card edit, a prompt box growing. The node's own corner cannot: the height is
  clamped back to the content inside `onResize`, in the same frame, on every tab.
- **The card list's height is stored**, in `node.properties.castHeight`, written only by
  `setListHeight` and only from one gesture: the list's own grip. With none stored the list
  is as tall as its cards.

It was not always two. There were six: a fixed-height box fed by a `--mmd-cast-height`
variable remembered from the *timeline* panel, an `absorb` that handed the node's spare
height to that box, a `growWithPrompts` that added deltas straight to the node, a `fitNode`
measuring children while `fitPulled` measured scrollHeight, a grow-only rule at load, and a
`fitBox` that measured overflow -- which a stretching flex child never reports, so it could
only ever grow. They ratcheted against each other: a pass that ran before layout settled
asked for the same room twice, the box kept it, the next measurement read it back as
content, and the node opened several screens tall with empty space under the last card. If
you are tempted to add a third number here, that is what happens.

## The WHO & WHAT document

A second widget, parsed by `cast.py` and folded into the timeline before compiling. One
card per subject -- shown as the **WHO & WHAT** tab, and not only people: a costume, a prop,
a place or a style out of the same photograph is a card too, with the voice fields left
empty. Fields: `name`, `file` (which attachment it is drawn from), `description`, `voice`,
`keep` (its own `subject_retention`), `onto`, `motion_from`, `voice_from`, and a stable
`uid`. Several cards may name one file; each is numbered separately, and the block's
FILE row makes them: `editor.definedBy` lists the subjects drawn from that file with
`edit` beside each, and **+ another card** calls `CastEditor.addSubject(filename)`
through `editor.onAddCard`.

- A card **with** a file and a description appends a subject to that file's `subjects`,
  and lends its sentence to the file's own `description` when the record has none -- the
  editor has no description box on the block, so a file whose role keeps it an entry
  would otherwise have nothing to say about itself. Every card appends a speaker. Both ends carry the card's `uid`, so the `<Subject n>` a
  voice belongs to survives the renumbering that dragging a block causes.
- `editor.subjectStrip` draws the numbered cards as the block panel's **SUBJECTS** row --
  one chip per card, thumbnail plus token -- and clicking one calls `writeToken`, which
  splices `<Subject n>` in at the caret of SEGMENT PROMPT. `paintSubjects` lights the
  chips the text already names, and runs on every keystroke rather than rebuilding the row,
  because rebuilding it takes the caret with it. The strip is a convenience, so it is
  wrapped in a `try/catch` that logs and returns empty: a throw while the panel is being
  built otherwise takes timing, shot, file and dialogue down with it. Note `filesOf`
  returns an **array**, not a map -- calling `.get` on it is what emptied the row once.
- A card reaches the prompt as a `<Subject n>` (it names a file) or as the words in front
  of `(S1)` (it describes a voice). With neither it is byte-for-byte absent, so
  `_check_speakers` says so and the card draws the same sentence on screen. That half of
  the check must **not** read `timeline.speech`: `cast.merge` derives that flag as "some
  card has a voice", which is false in exactly the case it exists for.
- `voice_from` is dropped by `cast.merge` when `they speak` is off, and the editor hides
  the whole voice row with it. A timbre reference is an instruction about a voice; with no
  dialogue compiled the prompt was saying a recording was the reference for a speaker it
  never asked the model to voice. `.mmd-card-sid` — the `Sn` badge on a card and the `S1…Sn`
  line of the legend — is hidden by the same rule, for the same reason.
- The other half is the reverse -- a voice, and no line naming its `S`. `voice_from` makes
  it a wrong statement rather than an idle one: the prompt says a recording is the timbre
  reference for a speaker nothing ever asks the model to voice. This half *is* guarded on
  `speech`, because with the switch off no line is compiled at all.
- `onto` is the receiver of an `attribute_transfer`, and only means anything for that
  marker. When it names another **card**, `attachments.carried` folds this entry into that
  card: the entry keeps its own `<Subject n>` and **carries the marker itself**, while
  `compile._receivers` pairs it with the subject it is written over. Four places say so:
  its `retention_analysis` line (`attribute_transfer - ... replaces <Subject 1>'s face
  only, mapped onto the same position and framing at every moment`), the receiver's line
  (what its picture supplies, with the replaced region named as excluded, and
  **`partially_preserved` however the card is set** -- the guide defines that marker as
  content still used with some characteristics changed, and `fully_preserved` beside a
  sentence excluding the face is a contradiction the model resolves in favour of the
  marker), `_replacements` in the summary, and `_in_frame` at the **head** of the shot. That is the shape of a working
  identity replacement; two others failed on three paid runs -- folding the feature into
  the receiver left nothing to point at where the new face belonged, and before that the
  receiver was `fully_preserved` over the whole person beside a transfer onto it. `_only_defines` counts a
  carried entry too, so the photograph the feature comes from keeps no entry of its own.
  §2.1 is the authority: `<Subject N>` is "a content unit that will actually be used in the
  target video", and "when the same subject comes from multiple assets, combine the sources
  and state what each asset provides" — the guide never gives the feature a subject of its
  own, and doing so asked for a second person while the receiver was `fully_preserved`,
  which is the face swap that did not happen. `cast.numbering` skips the same cards, or the
  tab would offer a chip for a token the prompt never defines.
- Free text in `onto` names nobody the cast knows, so there is no definition to fold into:
  it still compiles as `, transferred onto the woman at the desk` on the subject's own
  line (`_named_subject` remains for documents written before the fold).
- `lint._carried_into` reads `onto` through the same lookup, for the opposite purpose. A
  speaker whose card hangs off one block and who speaks on another is normally worth a
  warning -- the model is being told the person on screen is the one talking. When a card
  *on that block* transfers its feature onto them, the document has already said they are
  on screen, and the warning is noise. Take 1 of the scenario is exactly that shape:
  `SPEAKER` is defined on segment 1, `FACE` on segment 2 is `attribute_transfer` onto
  `SPEAKER`, and the line is on segment 2.
- The person and the file they came from are two retentions, deliberately: a photo can be
  `fully_preserved` while the face lifted out of it is an `attribute_transfer`.
- **No lint rule reads the author's prose for words.** There used to be one --
  `_check_transfers`, warning when a receiver's description named the very feature carried
  onto it -- and it was removed on 2026-08-19 at the author's instruction. Matching words
  inside free text cannot be made reliable: it found `hair` inside `chair` and told an
  author to delete a description that was already correct. Do not add another rule of that
  shape. Describing the receiver without the feature being replaced is still the right
  advice; it belongs in the guide, not in the report.
- `compile._spoken_by` writes a bound speaker's voice onto that subject's
  `subject_definitions` line. The body prints `<Subject 1> (S1)` rather than prose for a
  speaker a file defines (`_voices`), so before this the `how they sound` typed on any card
  with a file reached the model nowhere at all and H3 chose the voice itself. A card with
  no file is untouched: its voice *is* its description, and the body still prints it.
- The editor dims `keep file` on a block whose file is `used as` `reference` and has cards
  describing it, for the same reason `_only_defines` drops that file's entry: the marker is
  the card's `keep it`, and a control that silently does nothing is worse than one that
  says why.
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
<Subject 1> (appears in [Shot 1], [Shot 2] and [Shot 3]): fully_preserved - …

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

## The two preview nodes

`MiniMaxDirectorPrompt` and `MiniMaxDirectorReport` are the same node with a different
field of the same reply. `preview.py:compile_preview` runs the compile and the lint
together and returns both, so a second panel costs one more line rather than a second
request; `attachPromptView(node, field)` picks which one it paints, and `node.promptField`
is what `paintPromptView` reads.

`PreviewAny` would show either string, but only after a run -- it fills from execution
results. That is why these exist: a warning that arrives after the render arrives after
the cost, and every check the linter makes is free.

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
| `cast.py` | the WHO & WHAT document, merged into the timeline | no |
| `attachments.py` | files on segments, their ordinals | no |
| `references.py` | files on sockets, their ordinals | no |
| `core.py` | adapter over ComfyUI's H3 nodes | yes |
| `nodes/director.py` | the registered node classes | yes |
| `web/` | the editor: plain ES modules, no build step | browser only |

The first six are the whole product and run under `pytest` with no torch, no ComfyUI,
no weights, in about 0.2 seconds.

`NODES` is three long -- `MiniMaxDirector`, `MiniMaxDirectorPrompt`, `MiniMaxDirectorReport`
-- and the director outputs `positive`, `latent`, `prompt`, `report`. Three things were
removed in 0.10.0 and should not come back without a new reason: a `Compile` node (the
compile step with no model), a `Length` node (seconds to a legal frame count), and the
director's `length` output. The product is the whole workflow, not parts wired by hand:
the timeline's clock reads frames and seconds, the rounded length rides in the `latent`,
and the editor compiles and lints on every edit pause, so each was a second route to
something already on screen. Dropping an output renumbers the slots after it, which breaks
the links in already-saved graphs -- do it at a version bump and re-save `examples/`.

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
8. **A number input reads as `""` while half-typed, and commits on `change`, never on
   `input`.** `"2."` is not a number yet, and a half-typed `144` is `1` for one keystroke:
   clamped live, the clamp lands on the intermediate value and is written back over what
   is being typed, so an existing number cannot be cleared and replaced. `start`, `end`
   `editor.numberField(element, apply, shown)` is the one place that rule lives, and every
   number box in the editor goes through it -- `duration`, `width`, `height`, the
   selection panel's `same length`, and a block's `start` / `end` / `length`. It binds
   `change` (which fires on blur and on Enter) plus a keydown that blurs on Enter, ignores
   a value until it parses, and repaints the box from `shown()` afterwards, because what
   is set is not always what was asked for. A new number field uses it; a second dialect
   is how these two behaviours drifted apart in the first place. Enter behaves the same
   in *every* field: a delegated keydown on each root (`editor`, `cast`) blurs any input
   or textarea, prompt boxes included, since `timeline.flat()` means a typed newline can
   never reach the model -- and a `change` delegate on the same roots rewrites the field
   with `model.flat()`, the JS twin, so the box shows what will compile. Setting `.value`
   in script fires no event, so it dispatches `input` for the listener that owns the
   field. `tests/js/lattice.test.mjs` checks the twin.
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
12. **`selection` is derived and its setter replaces the list.** `editor.selection` reads
    back `selected[0]` only when exactly one thing is selected, and assigning it writes
    `selected = [value]` -- so writing it after building a multi-block selection throws
    that selection away, even when the value written is the one it already held. Write
    `selected`; never both.
13. **The segment box hides itself when its textarea is disabled.**
    `.mmd-prompt:has(> textarea:disabled)` is `display:none`, which is right for "nothing
    selected" and wrong for "several selected" -- both disable the textarea, and only one
    of them wants the box gone. The bulk panel opts out with `.mmd-bulk`.
14. **What a picker shows is what the document holds.** An attached file is given its
    `role` and `retention` when it is attached, rather than left absent for a compiler
    default to fill in: a select shows the first value of its set either way, and a
    compiler falling back to a different one puts a value on screen the prompt never used.
15. **One file, one description, written on a subject card.** A file used to define
    something gets no `subject_definitions` line of its own (`_only_defines` in
    `compile.py`), so a `describes` box on the block fed nothing -- two boxes for one
    file, and nothing on screen saying which won. The block's box is gone: the FILE panel
    shows `editor.definedBy`, a read-only reading of the cards drawn from that file, and
    `cast.merge` lends the first card's sentence to `media["description"]` so a file whose
    role *does* keep it an entry is still described. `media["description"]` is still read
    by the compiler and still carried by older documents, which is why the panel shows it
    greyed rather than pretending it is not there.
16. **Never lay the timeline out while its tab is hidden.** Track widths come from
    `stage.clientWidth`, which is 0 under `.mmd-hide { display:none }`, and `width()`
    falls back to a 200px floor -- so a `render()` triggered from the WHO & WHAT tab (a card
    edit repaints the blocks, which carry its chips) left the whole clip drawn into a
    corner, still there when the tab came back. `showTab` re-renders on the way into
    `timeline`, one frame later so layout has caught up with the class it just removed.
17. **Newlines are structure, so no typed value may contain one.** `subject_definitions`
    and `retention_analysis` are one entry per line and the top-level fields are joined by
    a blank line, so a paragraph pasted in from a document fabricated a subject entry and
    could open what read as a field of its own. `timeline.flat()` collapses every run of
    whitespace to one space, applied in `Timeline.from_dict` -- including `_media`, which
    reaches the record's `description`, `subject`, `onto` and each `subjects[]` entry --
    so the rest of the compiler never has to defend itself. Text arriving any other way
    (a new field, a new record key) needs the same treatment at the door.

18. **A keyframe leaves this node already at the clip's size, unless asked otherwise.**
    `MiniMaxH3ImageToVideo` fits `first_frame` with `crop="disabled"` -- a plain scale to
    `width` x `height`, which squashes any picture whose shape is not the clip's. The block
    carries a `fit` of its own (`FITS` in `timeline.py`, mirrored in `model.js`, offered on
    `ANCHOR_ROLES` only): `crop`, the default and what a silent document means, has
    `director._fit` cover-crop from the centre (`common_upscale(..., "lanczos", "center")`,
    core's own treatment of `last_frame`) so core's resize has nothing left to do;
    `stretch` hands the picture over untouched and lets core squash it on purpose.
    `director._refitted` reports the cost in the words of whichever was chosen. Both ask
    `_skewed` first, whose tolerance is 2% of the clip's ratio: a picture already of the
    clip's shape is passed through as loaded -- one resize instead of two -- and nothing is
    said. Reference images are untouched by all of this: their sizing is `ref_image_size`,
    both of whose options keep the ratio and only ever shrink, which is why that control
    goes dead when the timeline holds no reference image — a reference *video* is sized by
    `adapt_canvas` and never reads it. What it trades is token count: a reference is encoded
    into tokens that ride through every sampling step, so `match` (the clip's own pixel
    area) is fast and coarse where `max` (2048 px short edge) is slow and keeps identity.
    A picture may answer for itself: `media.resize` (`SIZINGS` in `timeline.py`, mirrored
    in `model.js`, offered on a reference picture only) overrides the node's socket for
    that one file. It is a property of the *file*, so both controls that offer it -- the
    Files row and the block's FILE row -- go through `editor.patchFile`, which writes it to
    every record of that filename, sources included. Per-placement it would let one
    photograph on two blocks disagree with itself about a size the model only applies once. Core has a single `ref_image_size` for its whole `ref_images` loop, so
    `director._sized` does the resize -- core's own arithmetic, copied so the result is a
    fixed point of that loop -- and the node then asks core for `max`, whose branch is
    scale-down only and therefore leaves sized pictures alone. Sizing them here and asking
    core for the clip's value instead would size every picture twice. An unplaced picture
    has no FILE row and takes the clip's value.

19. **`width` and `height` change only when the author changes them.** They used to follow
    the first reference picture whenever `ref_image_size` was `match`, inside `attach` --
    a model setting driving two unrelated widgets, and a picture attached later or used as
    a keyframe never got it. The convenience is now a button on the block,
    `.mmd-f-size` ("set width & height"), drawn for `kind === "image"` and calling
    `media.fitGeneration` on the file's own dimensions. Anything that would move the clip's
    size on its own belongs here as a control, not as a side effect of another field.

## Calling into ComfyUI

`core.call(name, **kwargs)` resolves the class from `NODE_CLASS_MAPPINGS`, reads its
entry point from `FUNCTION`, drops arguments the installed version does not declare, and
unwraps the result. The H3 nodes use ComfyUI's **V3 schema**: `FUNCTION` is
`EXECUTE_NORMALIZED` and the return is a `NodeOutput` carrying values on `.result`.
Autogrow inputs arrive as **dicts** — `ref_images={"ref_image_0": tensor}` — not as flat
keyword arguments. The director declares none of them; it builds those dicts with
`references.slots()` from the files on its timeline.

## Tests

```bash
pytest                                  # the compiler and its rules, no dependencies
node --test tests/js/*.mjs              # the lattice and the clamp, JavaScript side
./tools/loadcheck.sh                    # the web extension, imported as the browser does
COMFYUI_PATH=~/dev/ComfyUI $COMFYUI_PATH/.venv/bin/python -m pytest tests/graph
tools/release.sh <x.y.z> <notes.md>      # all four suites, then commit, tag and push
```

A release goes through `tools/release.sh` and nowhere else. The version lives in
`pyproject.toml`, in `VERSION` in `web/build.js` and in the `BUILD` stamp beside it, and
v0.14.1 was cut by hand with two of the three moved -- the pod ran the fix while the node
painted the old number, which is indistinguishable from a fix that never shipped. The
script moves all three, gates on the suites above, and refuses to move a tag that already
exists unless passed `--retag`.

Run `loadcheck` after every edit to `web/`. `node --check` parses these files as *scripts*
and cannot see the one mistake this codebase keeps making: a backtick inside a template
literal -- in a tooltip, in a CSS comment -- which closes the literal early and takes the
whole editor down to raw widgets. `loadcheck` imports the real module graph against stubs
for ComfyUI's own scripts, so a broken file fails there instead of on the node.

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

1. **The info node** — the `MarkdownNote` inside `examples/minimax-director.json`. One
   file now: turbo is a switch in that graph rather than a second copy of it, which is what
   the old pair kept drifting over.
2. **The local docs** — `docs/GUIDE.md` for anything an author can see or press,
   `README.md` when the feature changes what the pack is, this file for schema, flow and
   invariants.
3. **The-project copy** — `~/Projects/experiments/the-project/comfyui/examples/video-minimaxh3/minimaxh3-director.json`.
   **One graph, everywhere.** It carries both switches, Turbo and Upscale, and the public
   `examples/minimax-director.json` is the same graph. Edit the-project's copy, then run
   `tools/sync_workflow.py` — it rewrites the public file and adds the two things only an
   outside user needs, `cnr_id` on our nodes and `properties.models` on the loaders.
   `tools/sync_workflow.py --check` fails if the two have drifted; never hand-edit the
   public file, and re-run it after a version bump — `release.sh` does, because the stamp it
   writes is the version. Opening the graph without `Comfyui_Minimax_h3_latent_Upscaler`
   installed shows a Missing Node Types dialog and one red node,
   `MinimaxH3LatentUpscaler3D` — a name the pack changed once already, on 2026-08-19, which is
   why the pod's onstart pins its clone to a commit rather than tracking `main`; with the Upscale switch off the graph still runs,
   because nothing downstream of it is used. That pack and its model are documented in
   README's Install, which is the only place an outside user is told to fetch them.
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
