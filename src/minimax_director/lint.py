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

from . import attachments, lattice
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
        *_check_subjects(timeline),
        *_check_dialogue(timeline),
        *_check_clip_lengths(timeline),
    ]
    return sorted(issues, key=lambda issue: issue.level != "error")


def _check_subjects(timeline: Timeline) -> Iterator[Issue]:
    """An attached file with nothing said about it.

    Attachments compile to the full-reference format, where every token gets a line in
    `subject_definitions` saying what it is and what to keep. Undescribed, that line falls
    back to the filename -- valid, but it tells the model nothing about what has to stay
    the same, which is the entire reason the section exists.
    """
    for item in attachments.collect(timeline):
        if str(item.record.get("description", "")).strip():
            continue
        name = str(item.record.get("filename", "")) or item.kind
        yield Issue(
            "warning",
            f"{item.token} ({name}) has no description, so nothing tells the model what "
            f"to keep from it. Describe it on the block that carries it.",
        )


def _check_clip_lengths(timeline: Timeline) -> Iterator[Issue]:
    """Reference videos and audio outside the 2-15 second window H3 documents.

    The editor measures a file when it is attached and records the result. Nothing is said
    about a file whose length was never read -- an unknown duration is not a wrong one, and
    a warning that fires on every hand-written document would train people to ignore this.

    H3 does not refuse an out-of-range clip; it quietly uses what it can, which is the kind
    of failure that only shows up in the finished video.
    """
    # A reference video is collected twice -- once as its own soundtrack, once as the
    # video -- from one record. That is one file and deserves one warning.
    seen: set[int] = set()
    for item in attachments.collect(timeline):
        if item.record.get("kind") == "image" or id(item.record) in seen:
            continue
        seen.add(id(item.record))
        length = item.record.get("seconds")
        if not isinstance(length, (int, float)) or length <= 0:
            continue
        if 2 <= length <= 15:
            continue
        name = str(item.record.get("filename", "")) or item.kind
        yield Issue(
            "warning",
            f"{name} runs {length:g}s. H3 takes reference clips of 2-15 seconds; "
            f"{'shorter' if length < 2 else 'longer'} ones are used only in part.",
        )


def _check_dialogue(timeline: Timeline) -> Iterator[Issue]:
    """Spoken lines the model will hear but cannot place.

    H3 fixes a voice from what the prompt says about the speaker -- age, gender, pitch,
    timbre, accent. With nothing said, the first line still gets a voice; it is just not
    one anybody chose, and it changes between runs.

    A second check catches an ID that speaks before it has been described. The guide asks
    for the identifying detail the *first* time a speaker appears, and a clip whose S1 is
    introduced in shot three has two shots of an unknown voice before it.
    """
    voices = timeline.voices()
    # Nothing to check on a clip with the dialogue switch off: the lines are not compiled,
    # so an unfinished one is a control left as it was found rather than a mistake.
    if voices is None:
        return

    # Which shot each subject is attached to, so a speaker bound to one can be checked
    # against the shot they are talking in.
    pairs = attachments.bound(timeline)

    for number, shot in enumerate(timeline.ordered_shots(), start=1):
        for speaking in shot.lines:
            if not speaking.text.strip():
                continue
            for person in speaking.numbers:
                subject = pairs.get(person)
                home = subject.origin[1] if subject and subject.origin else None
                if subject and home is not None and home != shot.start:
                    yield Issue(
                        "warning",
                        f"[Shot {number}] S{person} is {subject.token}, which is "
                        f"attached to a different shot. The model is being told the person "
                        f"on screen here is the one talking.",
                    )

        for line in shot.lines:
            # Who is talking, with nothing to say. The voice and the speaker describe the
            # performer; without words there is no performance, and the block compiles as
            # if the row had never been filled in -- which looks like the editor ignoring
            # you rather than a sentence waiting to be written.
            if not line.text.strip():
                if line.numbers != (1,) or any(voices.get(n) for n in line.numbers):
                    yield Issue(
                        "warning",
                        f"[Shot {number}] has a voice but nothing is said. Type the words "
                        f"into `line`, or the dialogue is left out of the prompt.",
                    )
                continue
            unknown = [
                f"S{n}" for n in line.numbers
                if not voices.get(n) and not line.speaker.strip()
            ]
            if not unknown:
                continue
            yield Issue(
                "warning",
                f"[Shot {number}] {_join_ids(unknown)} speaks with no description, so the "
                f"voice is whatever the model picks. Describe them in the cast: age, "
                f"gender, pitch, timbre, accent.",
            )


def _join_ids(ids: list[str]) -> str:
    return ids[0] if len(ids) == 1 else ", ".join(ids[:-1]) + f" and {ids[-1]}"


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

    if timeline.duration and timeline.duration < timeline.span:
        yield Issue(
            "warning",
            f"The clip is fixed at {timeline.duration} frames but the tracks run to "
            f"{timeline.span}; the tail will be cut.",
        )

    unused = (timeline.duration or timeline.span) - timeline.span
    if unused > 0:
        yield Issue(
            "warning",
            f"The clip runs {unused} frames ({unused / lattice.FPS:.2f}s) past the last "
            f"shot; nothing is described for that tail.",
        )

    padding = timeline.length - max(timeline.duration, timeline.span)
    if padding > 0:
        yield Issue(
            "warning",
            f"The clip is padded by {padding} frames to reach a valid length; the last "
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
