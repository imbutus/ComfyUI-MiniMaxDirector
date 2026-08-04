"""Timeline -> the single prompt string MiniMax H3 actually reads.

This module is the heart of the project and deliberately the dullest part of it: no
tensors, no ComfyUI imports, no I/O. A timeline in, a string out, deterministically.
That is what makes the whole director testable on a laptop with no GPU and no weights.

The output shape follows the official H3 templates. A global preamble establishes style
and the constant parts of the scene, then a shot list carries the changes:

    Vaporwave title sequence look: pink and blue gradient palette, ...

    Timeline:
    [0s-1s] VHS static opens the frame, the title appears with RGB split.
    [1s-2.5s] Hard cut to a plaster bust, the camera dollies slowly in.

Wired inputs are addressed inline as `<Picture 1>` / `<Audio 1>`; slot numbers come
from the graph, so the prose and the wiring cannot disagree.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import lattice
from .timeline import Timeline


@dataclass(frozen=True, slots=True)
class Compiled:
    """What the node hands to the sampler, plus what it shows the author."""

    prompt: str
    length: int
    duration: float

    def __str__(self) -> str:
        return self.prompt


def compile_timeline(timeline: Timeline) -> Compiled:
    """Render `timeline` to a prompt and a valid frame count."""
    blocks: list[str] = []

    preamble = timeline.global_prompt.strip()
    if preamble:
        blocks.append(preamble)

    shots = _render_shots(timeline)
    if shots:
        blocks.append(shots)

    moves = _render_moves(timeline)
    if moves:
        blocks.append(moves)

    cues = _render_cues(timeline)
    if cues:
        blocks.append(cues)

    length = timeline.length
    return Compiled(
        prompt="\n\n".join(blocks),
        length=length,
        duration=lattice.to_seconds(length),
    )


def _render_shots(timeline: Timeline) -> str:
    shots = [shot for shot in timeline.ordered_shots() if shot.text()]
    if not shots:
        return ""

    if timeline.dialect == "shots":
        return "\n".join(
            f"SHOT {number}: {shot.text()}"
            for number, shot in enumerate(shots, start=1)
        )

    lines = [f"{_span(shot.start, shot.end, timeline.fps)} {shot.text()}" for shot in shots]
    return "Timeline:\n" + "\n".join(lines)


def _render_moves(timeline: Timeline) -> str:
    """The camera track, as its own block.

    Camera work is emitted separately rather than folded into the shot lines because a
    move can straddle a cut, and flattening it into one shot would silently pick a side.
    """
    moves = [move for move in timeline.ordered_moves() if move.text()]
    if not moves:
        return ""

    lines = [
        f"{_span(move.start, move.end, timeline.fps)} {move.text()}" for move in moves
    ]
    return "Camera:\n" + "\n".join(lines)


def _render_cues(timeline: Timeline) -> str:
    cues = [cue for cue in timeline.ordered_cues() if cue.prompt.strip()]
    if not cues:
        return ""

    lines = [
        f"{_span(cue.start, cue.end, timeline.fps)} {cue.prompt.strip()}"
        for cue in cues
    ]
    return "Audio:\n" + "\n".join(lines)


def _span(start: int, end: int, fps: int) -> str:
    """`[1s-2.5s]`, the bracket form used by the official templates."""
    first = lattice.format_seconds(start / fps)
    last = lattice.format_seconds(end / fps)
    return f"[{first}s-{last}s]"
