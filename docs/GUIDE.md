# Using MiniMaxDirector

A guide for people. `AGENTS.md` is the same territory written for a model reading the
code; this one assumes you want to make a video and would rather not read Python.

---

## What the node actually does

MiniMax H3's text encoder is a 32B vision-language model. It does not need keyframes
injected into latent space to understand a shot list — it reads one, written out in
prose. So this node is a **compiler**: you arrange blocks on a timeline, and it writes
the single structured prompt H3 wants.

Nothing is hidden. The `prompt` output is the exact string sent to the model. If the
video is wrong, read that string first — it usually explains itself.

---

## Installing

See **[Install in the README](../README.md#install)** — the nodes, the four model files
with the exact names and directories, and the workflow that wires them together. It is
kept in one place so the two cannot drift apart.

The short version: ComfyUI 0.30.0 or newer, no pip install, no dependencies, and **two**
VAEs rather than one — H3 produces picture and sound in the same pass.

---

## Wiring it up

The example workflow in `examples/` is already wired; open it and swap in your files.
Built by hand, the chain is:

```
UNETLoader ─┐
CLIPLoader ─┼─► MiniMax Director ─► BasicGuider ─► SamplerCustomAdvanced ─┬─► VAEDecode ──────┐
VAELoader  ─┤        (positive,                                           │   (video vae)     ├─► CreateVideo ─► SaveVideo
VAELoader  ─┘         latent)                                             └─► VAEDecodeAudio ─┘
                                                                              (audio vae)
```

Two things people get wrong here:

**The same latent goes to both decoders.** H3's latent carries picture and sound
together. There is no second sampler and no separate audio branch to keep in sync.

**No negative prompt.** H3 is CFG-free — `BasicGuider`, not `CFGGuider`. If you find
yourself looking for the negative input, there isn't one.

---

## The timeline

Three tracks, and each block on them describes a span of the clip. The node's own title
bar carries the pack's version and build date at its right end, so a screenshot of a
misbehaving graph says which build drew it.

| Track | Holds | Becomes |
|---|---|---|
| **MAIN** | shots — what is on screen | the `Timeline:` / `SHOT n:` block |
| **CAMERA** | camera moves | the `Camera:` block |
| **AUDIO** | sound cues | the `Audio:` block |

### The six buttons

Three write a description; three attach a file.

| Button | Track | What it makes |
|---|---|---|
| **Add Video Prompt** | MAIN | a shot described in words |
| **Add Sound Prompt** | AUDIO | a sound described in words — H3 generates it |
| **Add Camera Prompt** | CAMERA | a move from the dropdown, plus an optional note |
| **Add Image** | MAIN | a shot with a reference image on it |
| **Add Audio** | AUDIO | a cue with a real audio file |
| **Add Video** | MAIN | a shot with a reference video |

Every Add appends a new block after the last one on that track. Adding never overwrites
a block you already have.

**An attached audio or video takes the span it actually runs for.** The file is measured
before its block is placed, so an eight-second recording gets eight seconds of clip rather
than a default two — bounded by the block after it and by the end of the clip, so
attaching an album does not produce a two-hour timeline. Its `keep file` and `used as` are
written down at the same moment, so what the pickers show is what the prompt uses.

### Duration comes first

Set the clip length in the **duration** box, then arrange blocks inside it.

- **Dragging** a block stops at the end of the clip. A drag aims at a place on screen,
  and the clip is that screen.
- **Typing** a length in the panel — or pressing an Add button — stretches the clip if it
  has to. A typed number is an instruction, not a gesture.
- **Neither** lets two blocks on one track overlap. Two descriptions of the same frames
  is not something the prompt can express.

**The clip is always a length H3 can render.** The lattice below is `17n+5`, so 144 frames
is not a length that exists: it generates as 158 whatever the editor says. Rather than let
those fourteen frames sit in the output with no shot describing them, the editor lands on
the lattice as you work:

- A block that grows the clip — added, dragged past the end, or given a longer `length` —
  takes the padding itself. Your last block ends up a few frames longer, and the timeline
  is exactly what renders.
- A **duration** typed by hand snaps up on its own, and leaves the blocks alone: that is a
  decision about the piece, not about a segment. Empty means "follow the content".

The timeline is drawn to the clip, not past it, so there is nothing empty on the end. The
settings row's `renders 124 f = 5.17s · 120 f rounded up` is the fallback for the cases
that still round — a clip following its content — and stays silent otherwise.

### The three tabs

The panel under the toolbar shows one of three things, and remembers which one across a
reload:

- **TIMELINE** — the tracks, and the fields of whatever block is selected
- **WHO & WHAT** — one card per thing the prompt has to name
- **GLOBAL** — GLOBAL PROMPT and GLOBAL MUSIC, the two things that are set once for the
  whole piece and then left alone

### Editing a block

Select it — with nothing selected there is no block to edit, and the segment fields are
not on screen — and the TIMELINE tab shows:

- **SEGMENT PROMPT** — what happens in it
- **TIMING** — `start`, `end` and `length` in frames, each with a read-only seconds
  reading beside it, and one line underneath reading the whole span the same way:
  `Start: 0 f | End: 96 f | Length: 96 f = 4.00s`. Frames come first everywhere in the
  editor, including the playhead clock, because frames are what the document stores and
  what H3 is given; seconds are the translation.
- **SHOT** — MAIN blocks only. `enter with` is how the cut into this shot is written —
  `cut` unless you ask for `dissolve`, `fade` or `wipe`; it is not offered on the first
  shot, which is entered from nowhere. `on-screen text` is any words actually visible in
  frame — a sign, a banner, a label — sent in double quotes, verbatim and untranslated,
  the same service the dialogue row does for the spoken words.
- **SUBJECTS** — one chip per card WHO & WHAT has numbered, each with the file's thumbnail
  and the token it became: `<Subject 1> man`. Click one and the token is written into
  SEGMENT PROMPT at the caret; a chip whose token the text already names is lit. Typing
  the number by hand is the alternative, and getting it wrong is silent — the prompt then
  cites a subject that does not exist and nothing on screen says so. A card with no
  description takes no number and so has no chip, and the row is absent until WHO & WHAT
  has at least one numbered card.
- **CAMERA** — the move; CAMERA blocks only. A shot describes what is on screen, a
  camera block describes how it is filmed, and a move is free to straddle a cut.
  `amplitude` and `speed` sit beside it: how far the framing travels and how fast. Both
  default to *medium* and *normal*, which the guide writes by saying nothing, so those
  options contribute no words. A static shot has neither, and the two pickers go away.
- **DIALOGUE** — MAIN blocks only. One row per line: the `line` itself, the faces of who
  says it, `how` it is said, its `language`, and two switches — **off-screen** and
  **carries over**. **+ line** adds another row, so a block can hold a conversation; the
  red bin at the end of a row removes it — the same delete button the subject cards use.
  The last lit face cannot be unticked, and says why on hover: an empty speaker list is
  compiled as `(S1)`, so a line with nobody ticked would be given to speaker 1 rather than
  to nobody. A line nobody says is a line removed. Who the speakers *are* is written once in the WHO & WHAT tab, not here — see
  below.
- **FILE** — blocks carrying one: `used as`, `keep file`, **detach media**, and a
  read-only `describes` list — one subject per line, `edit` beside each, and
  **+ another card** under them, which makes a card already pointed at this file. That is
  how one photograph holds several subjects: a person, their coat, the room behind them. There is no description box here: what a file *is* is
  written once, on a subject card, and this line shows the card's sentence beside the
  `<Subject n>` it became with a link to the WHO & WHAT tab. It said `nothing describes
  this file yet` until you add one. The guide asks for a file used to define something to
  be cited inside that thing's definition rather than given an entry of its own, so a
  second box here was a field the prompt threw away — which is exactly how it behaved.
  Text typed on the block by an older build still compiles and is shown greyed, with the
  card's sentence taking over the moment there is one.

**Several blocks selected** turns the panel into a selection panel, offering only what
applies to all of them: `camera` / `amplitude` / `speed` when they are all camera moves,
`enter with` when they are all shots, `used as` and `keep file` when they all carry a file
of one kind. Each picker starts on *leave as is* and writes nothing until you choose.

**Timing** is always there, whatever the mix, because a frame count means the same thing
on every track: `same length` gives every selected block one length (each still stopped by
its own neighbours), and **close the gaps** butts them up against each other, track by
track, leaving the first of each where it is.

Two more actions, for shots:

- **merge into one shot** — adjacent shots become one, prose joined, dialogue kept in the
  order it was heard. This is what MiniMax asks for when a cut only changes the distance
  or the angle, and it is the fix for the linter's warning about exactly that.
- **make the speech continuous** — marks the last spoken line of every selected shot but
  the last as `carries over`, so one sentence is written across the cuts with
  `<scenetrans>` on both sides of each.

`used as` says what the file is *for*, and that decides the task type the prompt opens
with: `reference` (guidance), `storyboard` (a plan of the framing rather than content —
it compiles as *"<Picture 3> is a storyboard reference for [Shot 1], defining viewpoint,
subject placement, and shot order."*), `first frame` / `keyframe` / `last frame` (a real
frame of the target video), `continue from`, `edit`.

`keep file` says how much of it survives. An **audio** file is graded in its own words,
because H3's format defines a different set for sound: `fully_copy` (this recording is the
finished soundtrack), `partially_copy`, `reference` (only the timbre or texture is
followed, the signal is not copied), `weak_reference`. Everything visible keeps
`fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference`. The
picker follows the file, so there is nothing to get wrong — and an older document holding
a visual marker on an audio file is translated rather than reset.

A dialogue row with no words in it dims — the row and its background both — so an empty
row reads as what it is: ignored by the compiler until you type something.

Along the bottom edge of a block sit its chips: the file it carries (`IMAGE · face.jpg`),
and one per transfer taken out of that file — `FACE → SPEAKER`, or amber `FACE → ?` while
nobody has been named to receive it. A face swap is a thing you can see on the timeline
rather than something buried in a card.

Two faces lit on **one** row is the guide's `(S1,S2)`: the same words spoken by both at
the same instant. Two rows is a conversation — they speak in turn. Speech with no agreed
words, an argument or a crowd, is neither: describe it in the segment prompt and put the
sound in an AUDIO cue.

**off-screen** makes the line a voiceover. MiniMax fixes both halves of that form and the
switch writes both: the exact phrase `says in an off-screen voiceover`, and the clause
that has to follow every one of them — *while their lips remain completely closed*. The
second half is the one people forget by hand, and without it the model animates a mouth
to match the words.

**carries over** says the line does not finish inside this block. With a shot after it,
both sides of the cut are marked `<scenetrans>` and the prompt states that the audio
continues across it; with nothing after it, the same switch compiles as `<cutoff>` —
speech truncated by the end of the clip — and the linter says so, in case that was not
what you meant. Write the two halves as two lines in two blocks and tick the first.

### WHO & WHAT

The **WHO & WHAT** tab is one card per thing the prompt has to name, and the tab itself
carries the count. Usually a person — but the guide's subjects are not only people: a
costume, a prop, a place or a style lifted out of the same photograph is a subject too,
with a retention marker of its own, and it fills in the same card with the voice row left
empty. Several cards may point at one file; that is how a single photograph names several
things, each numbered separately.

Two tokens appear on every card, and they are MiniMax's, not ours:

- **`S1…Sn`** — a **speaker**: who says a line. The card supplies the voice; the words
  themselves are written on a shot's dialogue row. `S` is for speaker, which is why it is
  not `V`.
- **`<Subject 1…n>`** — a **subject**: a person, a costume, a prop, a place, a look the
  model must keep. A card is one only with a file **and** a description; without a file
  there is nothing on screen for the prompt to point at, so it can only be a voice and it
  shows a hollow `no <Subject>` in place of the token.

A card can be one, the other, or both. This is also the only place a file is described.
A card holds:

- **name it** — a short name, yours, so the chips on a dialogue row are readable
- **from** — which file on the timeline this subject is drawn from, if any, and the only
  place that file is described. The binding is what makes a face and a voice one person:
  the card then shows the `<Subject n>` badge the prompt will use. Several cards may point
  at one file — a person, their coat, the room behind them — each numbered separately.
- **what it is** — the sentence that becomes this subject's definition, and the only
  description of that file anywhere. A line under the box says which `<Subject n>` it
  became and that the file has no entry of its own. When the file's role does keep it an
  entry — a frame anchor, an edit source — this sentence fills that in too.
- **keep it** — how much of *the subject* survives, compiled as `subject_retention`. Not
  the same field as the block's `keep file`: the photo may be `fully_preserved` while the
  face taken out of it is an `attribute_transfer` onto somebody else.
- **onto** — who receives that transfer. It appears only when `keep it` is
  `attribute_transfer`, and it is what turns "a face" into a face swap: the pick list
  offers the other cards and each shot's subject, or you type a receiver the shot
  describes but no card names. Filled, it compiles as
  `<Subject 2> …: attribute_transfer - the face…, transferred onto SPEAKER.` Empty, the
  model is told to move a trait and never told where, and the block's chip stays amber.
- **motion from** — a second file for the same person, supplying how they move rather than
  what it looks like. A still says nothing about a walk, so pointing the card at a video
  as well compiles as `<Subject 1> is the woman, whose appearance comes from <Picture 1>
  and whose motion comes from <Video 1>.` Shown once there is a video on the timeline.
- **what it is** — for a card with a file; becomes its `subject_definitions` line
- **how they sound** — age, gender, pitch, timbre, accent, on screen or off. H3 fixes the
  voice from this, so an empty one is a voice nobody chose and the linter says so.
- **voice from** — or take the timbre from a recording instead of describing it. Point the
  card at an `<Audio n>` on the timeline and the prompt says
  `<Audio 1> is the voice-timbre reference for <Subject 1> (S1).`, with the file marked
  `reference`: the timbre and the delivery are followed, the signal itself is never
  copied. Setting that file's `keep file` to `fully_copy` asks for both at once, and the
  linter calls it what it is.

**A card that is doing nothing looks like it.** A card counts when it names a file *and*
says what that file is — that is a `<Subject n>` — or when it describes a voice something
actually speaks. Short of either, the compiled prompt is byte-for-byte what it would be
with no card there, so the card goes flat: transparent, dashed, dimmed, with the reason in
amber across it and the same line in `report`.

| The card says | Because |
|---|---|
| this card compiles to nothing | no file and no voice: neither a subject nor a speaker |
| nothing is written about `<Picture 1>` yet | a file is picked, but with nothing said about it the card takes no number |
| nobody speaks this card's lines | it has a voice, and no shot's dialogue row ticks its face |
| no file: this card gives a voice and nothing else | fine, and deliberate — a speaker with no photograph |

A green **`[Shot n]`** badge says where the card is heard, which is otherwise only visible
from the TIMELINE tab.

**Add** adds a card. **they speak** switches dialogue off for the whole clip: the rows and
every `<d>` go at once, and the cards stay — a character can be in a clip without saying
anything. The voice row goes with them, `voice from` included: a timbre reference is an
instruction about a voice, and with nobody speaking the compiler drops it rather than
telling the model a recording is the reference for a speaker it never voices.

WHO & WHAT lives on the document rather than on each line because a speaker is not a property
of one shot. Describing the same `S1` two different ways in two blocks was possible before,
and to the model that reads as two people sharing one label.

Removing a speaker leaves the lines that used their number alone. Renumbering to close the
gap would quietly reassign every later line to a different person.

Double-click a block to edit its text in place. Drag its edges to resize, its middle to
move, and drag a box over several to select them together. Clicking one member of a
selection singles it out; `Cmd/Ctrl`-clicking one takes it out and leaves the rest. `Delete` removes the
selection; `Cmd/Ctrl+A` selects every block on every track; `S` cuts the selection in two
at the playhead; `Cmd/Ctrl+C` / `Cmd/Ctrl+V` copy and paste
it, keeping its spacing; `Cmd/Ctrl+D` duplicates; `Cmd/Ctrl+Z` undoes.

**Clear** in the toolbar empties the timeline — every block, the global prompt and the
music. One undo step puts it back.

The red playhead is the timeline's one landmark. Click empty track to move it, and it
becomes where new blocks land, what a drag snaps to, and what `+` / `-` zoom around.

---

## The frame lattice, and why lengths jump

H3 only accepts clip lengths satisfying `length % 17 == 5`, at a fixed 24 fps:

```
5, 22, 39, 56, 73, 90, 107, 124, 141, 158, 175, ...
```

**Where the 17 comes from.** The model does not denoise frames; it denoises a latent — a
compressed video whose time axis is a row of slots. H3's video VAE packs **17 frames into
5 slots**, after a 5-frame head that costs 2, which ComfyUI writes as
`((frames - 5) // 17) * 5 + 2` (`comfy_extras/nodes_minimax_h3.py`). Decoding runs the
other way: each slot becomes 3.4 frames. A length off the lattice would need a fraction of
a slot, which cannot exist, so 124 frames is 37 slots and 130 frames is nothing at all.

Only **8s (192 f), 25s (600 f) and 42s (1008 f)** land on whole seconds.

The editor always rounds **up**, never down, and does it while you build rather than at
render time: see *Duration comes first* above.

The trained range is roughly **124–362 frames** (5.2–15.1s). Shorter and longer are
accepted by the node but untested.

---

## References: `<Picture 1>` and friends

H3 addresses reference material from inside the prose. A picture that nothing points at
is a picture the model ignores.

Attach a file to a block and the token is appended to that block's line for you. You do
not need to type it — and if you do type it, it is not added twice.

The numbering is **presentation order**, not slot order:

1. every image, in timeline order — `<Picture 1>`, `<Picture 2>`, …
2. then each video, preceded by its own soundtrack's `<Audio j>`
3. then standalone audio, continuing the same `j`

So one video with sound plus one standalone clip gives `<Audio 1>` (the soundtrack),
`<Video 1>`, `<Audio 2>`. Getting this wrong does not crash anything — it generates the
wrong video, quietly. The `prompt` output shows the numbering that was actually used.

Limits, from the model: **9 images, 3 videos, 3 video soundtracks, 3 standalone audio**.

**A picture that only exists to define somebody gets no entry of its own.** MiniMax's
guide is explicit: if an image is used only to establish a character, a scene, a costume
or a style, cite it inside the `<Subject n>` definition instead of writing a standalone
picture entry. So a `reference` image whose whole job is feeding a subject card is described
once, as the subject drawn from it — asking for the picture *and* the person is asking for
two different things at once. An image used as a `first frame` keeps its own entry either
way: it is a real frame of the target video, whoever else it defines.

---

## Camera moves

A move is three choices, which is how MiniMax documents it: **motion type**, **amplitude**
and **speed**. H3 reads prose, not enum values, so the three become one sentence.

| Motion | Sentence sent |
|---|---|
| `static` | The camera holds a static shot. |
| `zoom_in` / `zoom_out` | The camera zooms in / out. |
| `dolly_in` / `dolly_out` | The camera pushes in / pulls out. |
| `pan_left` / `pan_right` | The camera pans left / right. |
| `truck_left` / `truck_right` | The camera trucks left / right. |
| `tilt_up` / `tilt_down` | The camera tilts up / down. |
| `pedestal_up` / `pedestal_down` | The camera rises straight up / lowers straight down. |
| `orbit` | The camera moves in an arc around the subject. |
| `tracking` | The camera follows the moving subject. |
| `pov` | The camera takes the subject's point of view. |
| `roll_cw` / `roll_ccw` | The camera rolls clockwise / counterclockwise. |
| `handheld` | The camera shakes slightly. |
| `shake_strongly` | The camera shakes strongly. |

Zoom and push-in are not the same move. A zoom changes the focal length with the camera
standing still; a push-in moves the camera body, and the background changes size with the
subject. The model knows the difference, so it is worth picking the right one.

**amplitude** (`small` / `large`) and **speed** (`slow` / `fast`) are added to the
sentence when set: `dolly_in` + `small` + `slow` compiles as *"The camera pushes in with
small amplitude at slow speed."* Both default to *medium* and *normal*, which the guide
writes by leaving them out — so those options add nothing, on purpose.

A note typed into the block is appended after the sentence: `dolly_in` + *"closing on the
apple"* becomes *"The camera pushes in. closing on the apple"* — write it as a
continuation, not as a sentence of its own.

Documents from before amplitude and speed were fields are read as what they meant:
`dolly_in` was always *small, slow* and the retired `crash_zoom` always *large, fast*, so both keep
those values on load and compile to exactly the sentence they always did.

A camera block is written into whichever shots it overlaps. It stays a separate track in
the editor because a move can straddle a cut, but the prompt puts the sentence inside the
shot, which is where the model reads it.

---

## What the compiler writes

MiniMax publishes the prompt format in
[`VIDEO_PROMPT_WRITING_GUIDE_base_en.md`](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md).
It is three fields, not a set of labelled blocks, and this is what you get:

```
integrated_multimodal_description: [Shot 1] Locked-off studio shot. A single red apple
sits alone on the table. <Picture 1>. The camera pushes in with small amplitude at slow
speed. [Shot 2] At 00:01.708, the camera cuts to A single blue cube sits alone on the
table. <Picture 2>.

overall_soundscape: One clear bell chime, then silence.

non_diegetic_music: Sparse piano notes at a slow tempo.
```

Three consequences worth knowing:

- **Camera work is written inside its shot**, not in a section of its own.
- **The first shot has no timestamp**; later ones open with their cut time.
- **Audio has two fields.** `overall_soundscape` is everything the characters can hear;
  the MUSIC box is `non_diegetic_music`, the score only the audience hears, and compiles
  to `N/A` when empty.

Attach a file and the prompt switches to H3's six-section full-reference format instead —
`subject_definitions`, `summary`, `retention_analysis`, `detailed_description`,
`overall_soundscape`, `non_diegetic_music`. The shot list is the same string under a
different name, with one difference the guide asks for: the GLOBAL PROMPT is stated on its
own line **above** `[Shot 1]` rather than folded into it.

---

## The outputs

| Output | Use |
|---|---|
| `positive` | into `BasicGuider` |
| `latent` | into `SamplerCustomAdvanced` |
| `prompt` | **read this** — the exact string the model receives |
| `length` | frames, after rounding up to the lattice |
| `report` | linter findings: unmentioned references, gaps, overlaps, padding added |

Both are already wired in the shipped workflow: the compiled prompt to the right of the
director, the linter's findings underneath it. Almost every "why did it do that" question
is answered by looking at those two panels.

`report` also carries the checks MiniMax's guides hand out for free, each a warning and
never a refusal:

- the description outside the **350–500 words** the guide asks for on a generation task —
  skipped for dialogue-heavy clips and for editing tasks, which it exempts by name
- two adjacent shots that **describe the same thing at a different framing**; the guide
  asks for a camera move rather than a cut when only the distance changes
- an empty AUDIO track, because `overall_soundscape: N/A` tells H3 the clip is
  **completely silent**, which is a stronger claim than "nobody wrote anything yet"
- a **voice reference** whose `keep file` asks for the recording to be copied
- a line marked **carries over** with nothing after it, which compiles as `<cutoff>`
- a **guessed word** in a reused line — the guide wants `[unclear]`, never a guess
- a **subject card that compiles to nothing**: no file, so it is not a `<Subject n>`,
  and no voice, so it is never heard. The card is a filled-in row either way
- the reverse: a card with a **voice nobody speaks with** — no line names its `S`, so
  the voice instructs nothing, and a `voice from` recording is named as the timbre
  reference for a speaker the model is never asked to voice

---

## The other two nodes

**MiniMax Director — Prompt** and **MiniMax Director — Report** show the compiled prompt
and the linter's findings while you write, without running anything. Both are already in
the shipped workflow. They exist rather than a generic preview node for one reason: a
preview fills from a *run*, and a warning that arrives after the render arrives after the
cost.

**MiniMax Director — Compile** does the compile step with no model attached. Use it to
review or hand-edit a prompt before spending GPU time.

**MiniMax Director — Length** snaps a duration in seconds to a legal frame count. Useful
for feeding other nodes that need to agree about clip length.

---

## When something looks wrong

**The clip is a different length than I asked for.** It was rounded up to the lattice.
`report` says by how much.

**My reference image is ignored.** The prose has to point at it. Check `prompt` for the
`<Picture n>` token, and check the number matches the image you meant.

**Everything is one continuous shot.** That is the model, not the node — check `prompt`
to confirm the shot list is really there, with a cut time opening every shot after the
first.

**The video looks fine but there is no sound.** The audio VAE is not connected, or the
latent only reaches `VAEDecode`. Both decoders take the *same* latent.

**A block won't get longer by dragging.** It has hit the end of the clip or a neighbour.
Type the length instead — typing grows the clip; dragging does not.

---

## What is measured, and what is not

Tested against real weights on 2026-08-05, one clip:

- **Shot order works.** Three shots with a reference image each came out in the written
  order, with the right subject in each.
- **Cuts are approximate.** One boundary landed a frame early, the other nine frames
  late. Do not plan on frame-accurate cuts.
- **Per-segment camera does not work.** A segment asking for `static` pushed in anyway,
  and moved more than the segment that asked for a dolly. Treat the camera track as a
  hint about the whole clip, not a per-span instruction.
- **Audio cues land when they sit inside one shot.** A cue confined to a single shot is
  written into that shot and arrives there: a bell asked for in the first 1.7s fired at
  0.064s and nowhere else. A cue spanning several shots becomes untimed ambience, and the
  model will place it where it likes -- earlier runs put it on the cuts.

Both failures were traced to the prompt format: the compiler was emitting `Camera:` and
`Audio:` blocks, which are this project's invention and not labels H3 is trained on. It
now emits MiniMax's documented three-field format instead. **That fix has not itself been
tested on a GPU** — it is reasoned from the official guide, not measured.

Still untested: `non_diegetic_music` (the MUSIC box has been empty in every run so far),
whether `ref_image_size: match` behaves as its tooltip says, and behaviour outside the
trained length range. `AGENTS.md` keeps the current version of that list.
