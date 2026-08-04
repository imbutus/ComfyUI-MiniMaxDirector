# MiniMaxDirector

A timeline director for the [MiniMax H3](https://github.com/comfyanonymous/ComfyUI) video
model in ComfyUI. Lay out shots and audio cues on a track, and it compiles them into the
single structured prompt H3 actually reads — then hands the model its conditioning and a
clip length the sampler will accept.

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
90, 107, 124, and so on. The timeline snaps to that lattice, and the linter says how many
frames of padding it added rather than leaving you to discover it in the output.

## Nodes

| Node | Purpose |
| --- | --- |
| `MiniMax Director` | Timeline editor; outputs `positive`, `latent`, the compiled `prompt`, the `length`, and a lint `report`. |
| `MiniMax Director — Compile` | The same compile step with no model attached, for reviewing or hand-editing a prompt first. |
| `MiniMax Director — Length` | Snaps a duration in seconds to a valid frame count. |

The director calls the core `MiniMaxH3ImageToVideo` / `MiniMaxH3ReferenceToVideo` nodes
rather than reimplementing them, resolving both by introspection so an upstream signature
change surfaces as a clear message instead of a stack trace. Reference slots are picked
automatically: wire nothing and you get text-to-video, wire `first_frame` and you get
image-to-video, wire any `picture_*` / `audio_1` / `video_1` and you get reference-to-video.

## Install

```
cd ComfyUI/custom_nodes
git clone https://github.com/<you>/minimax-director.git
```

Restart ComfyUI. Requires ComfyUI 0.30.0 or newer, which is where the MiniMax H3 nodes
landed.

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

## Layout

```
__init__.py              ComfyUI entry point
src/minimax_director/
  lattice.py             frame arithmetic; the 17-frame rule
  timeline.py            the timeline document and its JSON
  compile.py             timeline -> prompt
  lint.py                checks that run before sampling
  references.py          reference ordinals, in H3's presentation order
  core.py                adapter over ComfyUI's built-in H3 nodes
  nodes/                 the classes ComfyUI registers
web/                     the timeline widget: plain ES modules, no build step
tests/                   pure-Python tests and golden prompts
tests/graph/             in-process ComfyUI execution with the weights stubbed
```
