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

Three tracks, and each block on them describes a span of the clip.

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

### Duration comes first

Set the clip length in the **duration** box, then arrange blocks inside it.

- **Dragging** a block stops at the end of the clip. A drag aims at a place on screen,
  and the clip is that screen.
- **Typing** a length in the panel — or pressing an Add button — stretches the clip if it
  has to. A typed number is an instruction, not a gesture.
- **Neither** lets two blocks on one track overlap. Two descriptions of the same frames
  is not something the prompt can express.

### Editing a block

Select it and the panel below shows:

- **SEGMENT PROMPT** — what happens in it
- **TIMING** — `start`, `end` and `length` in frames, each with a read-only seconds
  reading beside it. Frames are what the document stores and what H3 is given.
- **CAMERA** — the move; CAMERA blocks only. A shot describes what is on screen, a
  camera block describes how it is filmed, and a move is free to straddle a cut.
- **DIALOGUE** — MAIN blocks only: the `line`, the `speaker` who says it, `how` it is
  said, and its `language`. Who the speakers *are* is written once in the CAST box
  further down, not here — see below.
- **FILE** — blocks carrying one: `used as`, `supplies`, `describes`, `keep`, and
  **detach media**, which removes the file without removing the block

### The cast

**CAST** sits beside GLOBAL PROMPT: one row per person who speaks, holding a number and
how they sound — age, gender, pitch, timbre, accent, on screen or off. H3 fixes the voice
from that description, so an empty one is a voice nobody chose and the linter says so.

It lives on the document rather than on each line because a speaker is not a property of
one shot. Describing the same `S1` two different ways in two blocks was possible before,
and to the model that reads as two people sharing one label.

Removing a speaker leaves the lines that used their number alone. Renumbering to close the
gap would quietly reassign every later line to a different person.

Double-click a block to edit its text in place. Drag its edges to resize, its middle to
move, and drag a box over several to select them together. `Delete` removes the
selection; `S` cuts it in two at the playhead; `Cmd/Ctrl+C` / `Cmd/Ctrl+V` copy and paste
it, keeping its spacing; `Cmd/Ctrl+D` duplicates; `Cmd/Ctrl+Z` undoes.

**Clear** in the toolbar empties the timeline — every block, the global prompt and the
music. The **preset** dropdown beside it replaces the timeline with a worked example that
compiles and runs as it stands — a talking avatar, a three-shot scene, a two-hander, a
reference shot.

The red playhead is the timeline's one landmark. Click empty track to move it, and it
becomes where new blocks land, what a drag snaps to, and what `+` / `-` zoom around.

---

## The frame lattice, and why lengths jump

H3 only accepts clip lengths satisfying `length % 17 == 5`, at a fixed 24 fps:

```
5, 22, 39, 56, 73, 90, 107, 124, 141, 158, 175, ...
```

The 17 comes from the temporal VAE, which compresses in blocks of 17 frames plus a
5-frame head. Only **8s, 25s and 42s** land on whole seconds.

The editor always rounds **up** to the next legal length and tells you how much it added.
Ask for 5.13s and you get 124 frames — 5.17s. That is not a bug and it is not avoidable;
a length off the lattice is refused by the model.

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

---

## Camera moves

Each mode contributes one sentence, in the vocabulary MiniMax documents (`Push In`,
`Pan Left`, `Arc Shot`, `Static Shot`, with `with small/large amplitude` and
`at slow/fast speed`). H3 reads prose, not enum values:

| Mode | Sentence sent |
|---|---|
| `—` | *nothing — your note alone is used* |
| `static` | The camera holds a static shot. |
| `dolly_in` | The camera pushes in with small amplitude at slow speed. |
| `dolly_out` | The camera pulls out with small amplitude at slow speed. |
| `pan_left` | The camera pans left. |
| `pan_right` | The camera pans right. |
| `tilt_up` | The camera tilts up. |
| `tilt_down` | The camera tilts down. |
| `orbit` | The camera moves in an arc around the subject. |
| `handheld` | The camera shakes slightly. |
| `crash_zoom` | The camera zooms in with large amplitude at fast speed. |

A note is appended after the sentence: `dolly_in` + *"closing on the apple"* becomes
*"The camera dollies slowly in. closing on the apple"*.

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

---

## The outputs

| Output | Use |
|---|---|
| `positive` | into `BasicGuider` |
| `latent` | into `SamplerCustomAdvanced` |
| `prompt` | **read this** — the exact string the model receives |
| `length` | frames, after rounding up to the lattice |
| `report` | linter findings: unmentioned references, gaps, overlaps, padding added |

Wire `prompt` and `report` to a preview node while you are learning the tool. Almost
every "why did it do that" question is answered by looking at them.

---

## The other two nodes

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
