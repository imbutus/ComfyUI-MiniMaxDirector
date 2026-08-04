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
from . import attachments
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


def _with_tokens(text: str, tokens: list[str]) -> str:
    """Make sure a segment's line names the files attached to it.

    A file dropped on a shot is meant to be used in that shot, and H3 only uses a
    reference if the prose points at it. Rather than making the author remember to type
    `<Picture 1>`, the token is appended where it is missing -- and left alone where they
    have already placed it deliberately.
    """
    missing = [token for token in tokens if token.lower() not in text.lower()]
    if not missing:
        return text
    joined = " ".join(missing)
    return f"{text} {joined}" if text else joined


def _render_shots(timeline: Timeline) -> str:
    tokens = attachments.tokens_by_segment(timeline)
    entries = [
        (shot, _with_tokens(shot.text(), tokens.get(("shots", shot.start), [])))
        for shot in timeline.ordered_shots()
    ]
    entries = [(shot, text) for shot, text in entries if text]
    if not entries:
        return ""

    if timeline.dialect == "shots":
        return "\n".join(
            f"SHOT {number}: {text}" for number, (_, text) in enumerate(entries, start=1)
        )

    lines = [
        f"{_span(shot.start, shot.end, timeline.fps)} {text}" for shot, text in entries
    ]
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
    tokens = attachments.tokens_by_segment(timeline)
    entries = [
        (cue, _with_tokens(cue.prompt.strip(), tokens.get(("cues", cue.start), [])))
        for cue in timeline.ordered_cues()
    ]
    entries = [(cue, text) for cue, text in entries if text]
    if not entries:
        return ""

    lines = [f"{_span(cue.start, cue.end, timeline.fps)} {text}" for cue, text in entries]
    return "Audio:\n" + "\n".join(lines)


def _span(start: int, end: int, fps: int) -> str:
    """`[1s-2.5s]`, the bracket form used by the official templates."""
    first = lattice.format_seconds(start / fps)
    last = lattice.format_seconds(end / fps)
    return f"[{first}s-{last}s]"
