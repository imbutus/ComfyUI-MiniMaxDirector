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

```
cd ComfyUI/custom_nodes
git clone https://github.com/imbutus/ComfyUI-MiniMaxDirector.git
```

Restart ComfyUI. Requires **ComfyUI 0.30.0 or newer**, which is where the MiniMax H3
nodes landed. No pip install, no dependencies.

You also need the H3 model files: the `ref2va` diffusion model, the Qwen3-VL text
encoder, and **two** VAEs — one for video, one for audio. H3 produces both in one pass.

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
- **start** — the frame it begins on
- **seconds** and **frames** — two views of the same length; type in either, the other
  follows. The document stores frames only.
- **camera** — the move, on CAMERA blocks
- **detach media** — removes the file without removing the block

Double-click a block to edit its text in place. Drag its edges to resize, its middle to
move, and drag a box over several to select them together. `Delete` removes the
selection; `Cmd/Ctrl+Z` undoes.

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

Each mode contributes one sentence. H3 reads prose, not enum values:

| Mode | Sentence sent |
|---|---|
| `—` | *nothing — your note alone is used* |
| `static` | The camera holds still. |
| `dolly_in` | The camera dollies slowly in. |
| `dolly_out` | The camera pulls slowly back. |
| `pan_left` | The camera pans left. |
| `pan_right` | The camera pans right. |
| `tilt_up` | The camera tilts up. |
| `tilt_down` | The camera tilts down. |
| `orbit` | The camera orbits the subject. |
| `handheld` | Loose handheld movement. |
| `crash_zoom` | A fast crash zoom snaps in. |

A note is appended after the sentence: `dolly_in` + *"closing on the apple"* becomes
*"The camera dollies slowly in. closing on the apple"*.

Camera work is its own block rather than folded into the shot line, because a move can
straddle a cut — merging them would silently pick a side.

---

## Dialects

Two ways of writing the shot list, chosen with the **dialect** dropdown:

**`timeline`** — timestamps:

```
Timeline:
[0s-1.7s] Wide shot of the alley, puddles holding the sign reflections.
[1.7s-3.4s] Close on <Picture 1>, rain beading on the collar.
```

**`shots`** — ordinals:

```
SHOT 1: Wide shot of the alley, puddles holding the sign reflections.
SHOT 2: Close on <Picture 1>, rain beading on the collar.
```

**Which one H3 actually honours has not been measured.** Nothing in this repository has
run against real weights. If you test both with the same seed, that result is worth
sharing — it is the one open question that changes what this node should default to.

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
to confirm the shot list is really there, then try the other dialect.

**The video looks fine but there is no sound.** The audio VAE is not connected, or the
latent only reaches `VAEDecode`. Both decoders take the *same* latent.

**A block won't get longer by dragging.** It has hit the end of the clip or a neighbour.
Type the length instead — typing grows the clip; dragging does not.

---

## What has never been tested

Nothing here has run against real H3 weights. Interfaces — node signatures, the lattice,
reference numbering — are read from ComfyUI's source and are reliable. Anything about
**output quality** is untested, including whether H3 honours the timestamps, whether
`ref_image_size: match` behaves as its tooltip says, and how the model behaves outside
its trained length range.

`AGENTS.md` keeps the current version of that list.
