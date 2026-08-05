"""Timeline -> the single prompt string MiniMax H3 actually reads.

This module is the heart of the project and deliberately the dullest part of it: no
tensors, no ComfyUI imports, no I/O. A timeline in, a string out, deterministically.
That is what makes the whole director testable on a laptop with no GPU and no weights.

The output follows MiniMax's own `VIDEO_PROMPT_WRITING_GUIDE_base_en.md`, which specifies
three fields rather than a set of labelled blocks:

    integrated_multimodal_description: [Shot 1] Live-action, cinematic, a red apple ...
    The camera pushes in with small amplitude at slow speed. [Shot 2] At 00:01.708, the
    camera cuts to a blue cube ...

    overall_soundscape: One clear bell chime, then silence.

    non_diegetic_music: N/A

Three things about that shape are not obvious and were learned the expensive way:

* **Shots, camera and sound live in one field.** An earlier version of this compiler
  emitted `Timeline:`, `Camera:` and `Audio:` as separate blocks. Measured against real
  weights on 2026-08-05, the shot list was obeyed and the other two were not -- the model
  pushed in on a segment that asked to hold still, and put the loudest sound in the clip
  on a video cut rather than where the cue asked for it. Those labels are ours, not H3's.
* **The first shot carries no timestamp**; later shots open with a strictly increasing
  cut time in `MM:SS.mmm`.
* **Audio splits in two.** `overall_soundscape` is what the characters can hear;
  `non_diegetic_music` is the score only the audience hears, and is `N/A` when absent.

Wired inputs are addressed inline as `<Picture 1>` / `<Audio 1>`; slot numbers come from
the graph, so the prose and the wiring cannot disagree.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import attachments, lattice
from .timeline import Move, Shot, Timeline


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
    render = _render_legacy if timeline.dialect == "legacy" else _render_official
    length = timeline.length
    return Compiled(
        prompt=render(timeline),
        length=length,
        duration=lattice.to_seconds(length),
    )


# -- the documented format ---------------------------------------------------


def _render_official(timeline: Timeline) -> str:
    fields = [f"integrated_multimodal_description: {_description(timeline)}"]
    fields.append(f"overall_soundscape: {_soundscape(timeline) or 'N/A'}")
    fields.append(f"non_diegetic_music: {timeline.music.strip() or 'N/A'}")
    return "\n\n".join(fields)


def _description(timeline: Timeline) -> str:
    """The main body: every shot in playback order, camera and sound written into it."""
    tokens = attachments.tokens_by_segment(timeline)
    shots = timeline.ordered_shots()
    moves = timeline.ordered_moves()
    cues = timeline.ordered_cues()

    parts: list[str] = []
    preamble = timeline.global_prompt.strip()

    for number, shot in enumerate(shots, start=1):
        body = _with_tokens(shot.text(), tokens.get(("shots", shot.start), []))
        camera = " ".join(move.text() for move in _moves_in(moves, shot) if move.text())
        sound = " ".join(
            _sentence(_cue_text(cue, tokens)) for cue in _cues_in(cues, shot)
        )

        if number == 1:
            # The guide puts style and initial composition at the head of Shot 1, and
            # gives that shot no timestamp.
            opening = f"{preamble} {body}".strip() if preamble else body
            parts.append(f"[Shot 1] {opening}".rstrip())
        else:
            # The author's words go in verbatim. Lowercasing the opening word would read
            # better after "cuts to", but "A single apple" and "Anna turns" are the same
            # shape to any rule, and quietly renaming a character is the worse mistake.
            cut = _timecode(shot.start, timeline.fps)
            parts.append(f"[Shot {number}] At {cut}, the camera cuts to {body}")

        for addition in (camera, sound):
            if addition:
                parts[-1] = f"{_sentence(parts[-1])} {addition}"

    if not parts:
        # No shots, but the author may still have written a style, camera work or sound;
        # a prompt with an empty body would be silently ignored.
        leftover = " ".join(move.text() for move in moves if move.text())
        opening = " ".join(part for part in (preamble, leftover) if part)
        return f"[Shot 1] {opening}".rstrip() if opening else ""

    orphans = [
        move.text() for move in moves if move.text() and not _lands_in(move, shots)
    ]
    if orphans:
        parts[-1] = f"{_sentence(parts[-1])} {' '.join(orphans)}"

    return " ".join(parts)


def _cues_in(cues: list, shot: Shot) -> list:
    """Sound that belongs to this shot, and only to this shot.

    A cue confined to one shot is a timed event, and the guide puts timed diegetic sound
    in the shot description -- the part of the prompt the model demonstrably follows.
    Measured 2026-08-05: a bell chime written only into `overall_soundscape` was produced,
    but landed on the video cuts rather than in the span that asked for it, because that
    field carries no timing at all.

    A cue spanning more than one shot is left out: it is ambience, it goes to the
    soundscape, and repeating it inside every shot it touches would ask for the sound
    several times over.
    """
    return [
        cue for cue in cues
        if cue.start < shot.end and cue.end > shot.start
        and cue.start >= shot.start and cue.end <= shot.end
    ]


def _cue_text(cue, tokens: dict) -> str:
    return _with_tokens(cue.prompt.strip(), tokens.get(("cues", cue.start), []))


def _soundscape(timeline: Timeline) -> str:
    """Ambience: the cues that are not tied to a single shot.

    The guide asks for 1-4 sentences summarising the whole video, with no timing: this
    field describes what is heard, not when. Cue spans are still meaningful in the editor
    -- they say which part of the clip an author had in mind -- but they are deliberately
    not emitted, because a timestamp here is a timestamp the model has no field for.

    A cue that sits inside one shot has already been written into that shot, where timing
    exists; sending it here as well would ask for the same sound twice.
    """
    tokens = attachments.tokens_by_segment(timeline)
    shots = timeline.ordered_shots()
    lines = [
        _cue_text(cue, tokens)
        for cue in timeline.ordered_cues()
        if not any(cue in _cues_in([cue], shot) for shot in shots)
    ]
    return " ".join(_sentence(line) for line in lines if line)


def _moves_in(moves: list[Move], shot: Shot) -> list[Move]:
    """Camera work that overlaps this shot, so it is written inside it."""
    return [move for move in moves if move.start < shot.end and move.end > shot.start]


def _lands_in(move: Move, shots: list[Shot]) -> bool:
    return any(move.start < shot.end and move.end > shot.start for shot in shots)


def _timecode(frame: int, fps: int) -> str:
    """`00:03.500` -- the cut-time format the guide specifies."""
    seconds = frame / fps
    return f"{int(seconds // 60):02d}:{seconds % 60:06.3f}"


def _sentence(text: str) -> str:
    """Close a fragment so the next one does not run into it."""
    stripped = text.rstrip()
    return stripped if stripped.endswith((".", "!", "?", ":", ";")) else f"{stripped}."


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


# -- the shape this project used before the guide was read -------------------


def _render_legacy(timeline: Timeline) -> str:
    """Labelled blocks: `Timeline:` / `Camera:` / `Audio:`.

    Kept so the two can be compared on one GPU run. The shot list here does work; the
    camera and audio blocks measurably do not.
    """
    blocks: list[str] = []

    preamble = timeline.global_prompt.strip()
    if preamble:
        blocks.append(preamble)

    tokens = attachments.tokens_by_segment(timeline)

    shots = [
        (shot, _with_tokens(shot.text(), tokens.get(("shots", shot.start), [])))
        for shot in timeline.ordered_shots()
    ]
    shots = [(shot, text) for shot, text in shots if text]
    if shots:
        lines = [
            f"{_span(shot.start, shot.end, timeline.fps)} {text}" for shot, text in shots
        ]
        blocks.append("Timeline:\n" + "\n".join(lines))

    moves = [move for move in timeline.ordered_moves() if move.text()]
    if moves:
        lines = [
            f"{_span(move.start, move.end, timeline.fps)} {move.text()}" for move in moves
        ]
        blocks.append("Camera:\n" + "\n".join(lines))

    cues = [
        (cue, _with_tokens(cue.prompt.strip(), tokens.get(("cues", cue.start), [])))
        for cue in timeline.ordered_cues()
    ]
    cues = [(cue, text) for cue, text in cues if text]
    if cues:
        lines = [f"{_span(cue.start, cue.end, timeline.fps)} {text}" for cue, text in cues]
        blocks.append("Audio:\n" + "\n".join(lines))

    return "\n\n".join(blocks)


def _span(start: int, end: int, fps: int) -> str:
    """`[1s-2.5s]`, the bracket form the legacy blocks used."""
    first = lattice.format_seconds(start / fps)
    last = lattice.format_seconds(end / fps)
    return f"[{first}s-{last}s]"
