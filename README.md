# MiniMaxDirector

A timeline director for the [MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3)
video model in ComfyUI. Lay out shots, camera moves and audio cues on a track, and it
compiles them into the single structured prompt H3 actually reads — then hands the model
its conditioning and a clip length the sampler will accept.

H3 makes the picture and the voices in one pass, so the editor has a **WHO & WHAT** tab: one
card per thing the prompt has to name, holding its face, its voice, how much of it survives
from a reference, and — for a face swap — who the face is transferred onto. Not only
people: a costume, a prop, a place or a style out of the same photograph is a card too,
and several cards may point at one file. A card can also take a person's motion from a
video and their voice timbre from a recording, which is the guide's one-subject-several-
assets case. A shot then only says who speaks and what they say.

A card is also the one place a file is described — there is no second description box on
the block, because a file used to define something is cited inside that thing's definition
rather than given a line of its own.

The compiler covers MiniMax's published prompt guides rather than a subset of them: the
full camera vocabulary as motion type × amplitude × speed, voiceovers in the exact form
the model was trained on, dialogue that crosses a cut or is cut off by the end of the
clip, on-screen text quoted verbatim, storyboard references, the separate marker
vocabulary audio uses, and a linter that checks the rules the guides state outright.

It ships as a whole workflow, not just a node pack: `examples/minimax-director.json` is a
complete graph — timeline, live compiled-prompt view, loaders, sampler, both VAE decodes
and video out. Install it, open it, start writing shots. See **[Install](#install)**.

MIT licensed. No dependencies beyond ComfyUI itself.

## Where this came from

I loved [LTXDirector](https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI). Directing
a video by laying shots out on a timeline, instead of cramming everything into one prompt
box and hoping, is the right idea — and WhatDreamsCost got there first and built it
properly. Thank you for it.

MiniMaxDirector is that idea carried over to MiniMax H3. It is not a port: none of
LTXDirector's code is here, and the two models want different things. LTX needs keyframes
injected into latent space because it has no notion of a shot list; H3's text encoder is a
32B vision-language model that reads one itself, so the same idea comes out as a compiler
rather than a guide injector. The debt is to the concept, and it is a large one.

If you work with LTX, use LTXDirector — it is more mature than this, and it is the
original.

People searching for an LTXDirector for MiniMax H3 tend to land here, so to be clear:
this is not that. It is a separate project, written from scratch for a different model,
built on an idea LTXDirector had first.

## Why a compiler rather than latent guides

H3's text encoder is a 32B vision-language model, and it parses a shot list on its own:

```
Neon-lit alley after rain, cyan and magenta signage, 35mm grain.

Timeline:
[0s-1s] Wide shot of the alley, puddles holding the sign reflections. The camera dollies slowly in.
[1s-2.5s] Close on <Picture 1>, rain beading on the collar.
```

So the interesting work is not injecting guides into latent space — it is producing that
text correctly, addressing wired inputs as `<Picture 1>` / `<Audio 1>`, and keeping the
clip on the frame lattice H3 requires. All of that is ordinary logic, which is why the
core of this project is pure Python with no tensors in it and runs in a fifth of a second
on a laptop.

## The frame lattice

H3 only accepts clip lengths satisfying `length % 17 == 5` at 24 fps — 5, 22, 39, 56, 73,
90, 107, 124, and so on. The model denoises a latent whose time axis is a row of slots, and
the video VAE packs 17 frames into 5 of them (after a 5-frame head worth 2); a length off
the lattice would need a fraction of a slot.

The editor lands on it while you build rather than at render time: a block that grows the
clip takes the padding, and a typed duration snaps up on its own. So the timeline you
arrange is the clip that is generated, with no frames on the end that no shot describes.

## Nodes

| Node | Purpose |
| --- | --- |
| `MiniMax Director` | Timeline editor; outputs `positive`, `latent`, the compiled `prompt`, the `length`, and a lint `report`. |
| `MiniMax Director — Prompt` | Shows the compiled prompt as the timeline is edited, without running anything. Wire the director's `prompt` output to it. |
| `MiniMax Director — Report` | Shows the linter's findings as the timeline is edited. Wire the director's `report` output to it. |
| `MiniMax Director — Compile` | The same compile step with no model attached, for reviewing or hand-editing a prompt first. |
| `MiniMax Director — Length` | Snaps a duration in seconds to a valid frame count. |

The director calls the core `MiniMaxH3ImageToVideo` / `MiniMaxH3ReferenceToVideo` nodes
rather than reimplementing them, resolving both by introspection so an upstream signature
change surfaces as a clear message instead of a stack trace. Reference slots are picked
automatically: wire nothing and you get text-to-video, wire `first_frame` and you get
image-to-video, wire any `picture_*` / `audio_1` / `video_1` and you get reference-to-video.

## Install

Three steps: the nodes, the weights, the workflow. The nodes on their own leave you with a
timeline and nothing to render it — the graph around them is the product, and it ships here
as `examples/minimax-director.json`.

Requires ComfyUI 0.30.0 or newer, which is where the MiniMax H3 nodes landed.

**1. The nodes.**

```
cd ComfyUI/custom_nodes
git clone https://github.com/imbutus/ComfyUI-MiniMaxDirector.git
```

Restart ComfyUI.

**2. The weights.** Four files, all from
[`Comfy-Org/MiniMax-H3`](https://huggingface.co/Comfy-Org/MiniMax-H3). These are the exact
filenames the example workflow asks for; ComfyUI matches loaders to files by name, so a
differently named copy shows up as an empty dropdown rather than an error.

| File | Goes in |
| --- | --- |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `models/text_encoders/` |
| `minimax_h3_video_vae_fp16.safetensors` | `models/vae/` |
| `minimax_h3_audio_vae_fp32.safetensors` | `models/vae/` |

Two VAEs is not a mistake. H3 generates picture and sound together, and they decode
separately.

**3. The workflow.** Drag `examples/minimax-director.json` onto the ComfyUI canvas, or open
it from the Workflows sidebar. It wires up:

- **MiniMax Director** — the timeline you work in.
- **MiniMax Director — Prompt** — the compiled prompt, beside it, updating as you type.
- **MiniMax Director — Report** — the linter's findings, above it. Almost every
  "why did it do that" is answered by those two panels.
- the loaders, sampler, both VAE decodes, `CreateVideo` and `SaveVideo` — everything
  needed to get an mp4 with sound out the other end.

Select a block, describe what happens in it, queue.

**Faster, optional.** `examples/minimax-director-turbo.json` is the same graph with
[larryvrh's Turbo LoRA](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora) between the
model loader and the sampler: 6 steps instead of 20, so a draft costs roughly a fifth of
the GPU time. It needs one extra file in `models/loras/`
(`minimax_h3_turbo_v4_step600_ema.safetensors`) and the
[ComfyUI-MiniMax-H3-Turbo](https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo) nodes.
Kept as a separate file on purpose: the workflow above depends on nothing but ComfyUI and
this pack.

## Development

The parts worth testing need neither a GPU nor a single byte of weights.

```
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/pytest
```

For the graph itself, point `COMFYUI_PATH` at a ComfyUI checkout and the graph tests run a
real prompt through ComfyUI's own validator and executor — no server, no GPU, no model
files:

```
COMFYUI_PATH=~/dev/ComfyUI $COMFYUI_PATH/.venv/bin/python -m pytest tests/graph
```

The weight-bearing nodes are stubbed; `CreateVideo` and `SaveVideo` are not, so the run
ends with an actual mp4 on disk. The stubs record every prompt handed to H3, which makes
the one question that matters — *what string reached the text encoder?* — directly
assertable without renting anything.

The stubs live in `tests/`, not in the package, and they have to: ComfyUI snapshots its
built-in node names before loading custom nodes and refuses to let a pack replace any of
them (`nodes.py`, `base_node_names` passed as `ignore`). A test process has no such
restriction, because it owns the registry.

## Documentation

- **[docs/GUIDE.md](docs/GUIDE.md)** — how to use it: the tracks and buttons, the duration
  rules, reference tokens, the camera vocabulary, the frame lattice, and what to check
  when the output looks wrong. Start here.
- **[AGENTS.md](AGENTS.md)** — the same ground for a model reading the code cold: data
  flow, document schema, numbering rules, the invariants that break silently, and what
  has never been verified against real weights.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — why the design is shaped this way.

## Layout

```
__init__.py              ComfyUI entry point
src/minimax_director/
  lattice.py             frame arithmetic; the 17-frame rule
  timeline.py            the timeline document and its JSON
  compile.py             timeline -> prompt
  cast.py                the cast document, merged in before compiling
  lint.py                checks that run before sampling
  references.py          reference ordinals for wired sockets
  attachments.py         reference ordinals for files on the timeline
  core.py                adapter over ComfyUI's built-in H3 nodes
  nodes/                 the classes ComfyUI registers
web/                     the timeline widget: plain ES modules, no build step
examples/                the ready-to-run workflow
tests/                   pure-Python tests and golden prompts
tests/graph/             in-process ComfyUI execution with the weights stubbed
AGENTS.md                how it all works, for contributors and coding agents
```
