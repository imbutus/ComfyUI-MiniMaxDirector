"""Checks that run before sampling, so mistakes surface in a second, not in ten minutes.

A wrong reference token or an accidental gap in the shot list costs a full generation to
discover. None of these checks need the model, so all of them are free.

Nothing here raises. The node reports issues and generates anyway -- a director that
refuses to render because two shots overlap by a frame would be worse than the problem.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterator

from .timeline import Timeline

TOKEN = re.compile(r"<(Picture|Audio|Video)\s+(\d+)>", re.IGNORECASE)
"""The reference form H3 understands. Case-insensitive on read, canonical on write."""


@dataclass(frozen=True, slots=True)
class Issue:
    level: str  # "error" | "warning"
    message: str

    def __str__(self) -> str:
        return f"{self.level}: {self.message}"


def lint(timeline: Timeline) -> list[Issue]:
    """Every problem found, errors first, then in the order they were detected."""
    issues = [
        *_check_references(timeline),
        *_check_coverage(timeline),
        *_check_content(timeline),
    ]
    return sorted(issues, key=lambda issue: issue.level != "error")


def _check_references(timeline: Timeline) -> Iterator[Issue]:
    """Prose and wiring must agree in both directions."""
    mentioned: set[tuple[str, int]] = set()
    for text in timeline.prose():
        for kind, index in TOKEN.findall(text or ""):
            mentioned.add((kind.lower(), int(index)))

    wired = {(ref.kind, ref.index) for ref in timeline.references}

    for kind, index in sorted(mentioned - wired):
        yield Issue(
            "error",
            f"<{kind.capitalize()} {index}> is used in the prompt but nothing is "
            f"connected to that slot.",
        )

    for kind, index in sorted(wired - mentioned):
        yield Issue(
            "warning",
            f"<{kind.capitalize()} {index}> is connected but never mentioned; the "
            f"model will most likely ignore it.",
        )


def _check_coverage(timeline: Timeline) -> Iterator[Issue]:
    """Shots should tile the clip: no overlaps, no holes, nothing before zero."""
    shots = timeline.ordered_shots()
    if not shots:
        yield Issue("warning", "The timeline has no shots; only the global prompt applies.")
        return

    if shots[0].start > 0:
        yield Issue(
            "warning",
            f"Nothing is described for the first {shots[0].start} frames.",
        )

    for earlier, later in zip(shots, shots[1:]):
        if later.start < earlier.end:
            yield Issue(
                "warning",
                f"Shots overlap between frames {later.start} and {earlier.end}.",
            )
        elif later.start > earlier.end:
            yield Issue(
                "warning",
                f"Gap of {later.start - earlier.end} frames before the shot at "
                f"frame {later.start}.",
            )

    for shot in shots:
        if shot.length <= 0:
            yield Issue("error", f"The shot at frame {shot.start} has no length.")
        if shot.start < 0:
            yield Issue("error", f"A shot starts before frame zero ({shot.start}).")

    if timeline.duration and timeline.start + timeline.duration < timeline.span:
        yield Issue(
            "warning",
            f"The clip is fixed at {timeline.duration} frames but the tracks run to "
            f"{timeline.span}; the tail will be cut.",
        )

    tail = timeline.length - shots[-1].end
    if tail > 0:
        yield Issue(
            "warning",
            f"The clip is padded by {tail} frames to reach a valid length; the last "
            f"shot will be held.",
        )


def _check_content(timeline: Timeline) -> Iterator[Issue]:
    """Empty text is almost always an editing slip rather than an intention."""
    if not timeline.global_prompt.strip() and not timeline.shots:
        yield Issue("error", "The timeline is empty.")

    for shot in timeline.shots:
        if not shot.text():
            yield Issue("warning", f"The shot at frame {shot.start} has no description.")

    for cue in timeline.cues:
        if not cue.prompt.strip():
            yield Issue("warning", f"The audio cue at frame {cue.start} has no text.")

    for move in timeline.moves:
        if not move.text():
            yield Issue("warning", f"The camera move at frame {move.start} is empty.")
