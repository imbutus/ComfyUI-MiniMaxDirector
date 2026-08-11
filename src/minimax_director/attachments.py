"""Files attached to segments, in the order MiniMax H3 presents them.

Dropping a picture on a shot should be enough. Nothing else about it -- which reference
slot it lands in, what ordinal the prompt has to call it by, whether the prose mentions
it at all -- is a decision worth asking an author to make, because every one of those has
exactly one right answer given where the file sits on the timeline.

So the timeline is the source of truth: this module reads it and produces the reference
list, the tokens, and the mapping back to the segments that need them. `references.py`
does the same job for files wired into sockets by hand; both feed the same presentation
order, because the model has only one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .timeline import Timeline

KINDS = ("image", "video", "audio")


@dataclass(frozen=True, slots=True)
class Attachment:
    """One file, the ordinal H3 will know it by, and where it came from."""

    kind: str
    """`picture`, `video` or `audio` -- the token's word, not the file's type."""
    index: int
    record: dict[str, Any]
    origin: tuple[str, int] | None = None
    """Track and start frame of the segment carrying it, or None for a video's own
    soundtrack, which belongs to the video rather than to a segment of its own."""

    @property
    def token(self) -> str:
        return f"<{self.kind.capitalize()} {self.index}>"


def _kind(segment) -> str | None:
    media = getattr(segment, "media", None)
    return media.get("kind") if isinstance(media, dict) else None


def collect(timeline: Timeline) -> list[Attachment]:
    """Every attached file, numbered the way the core node will present it.

    Images first, then each reference video preceded by its own soundtrack, then
    standalone audio -- the order `MiniMaxH3ReferenceToVideo` builds its reference list
    in. Segments are read in time order, so moving a block on the timeline renumbers its
    reference exactly as a viewer would expect.
    """
    found: list[Attachment] = []
    pictures = video_count = audio_count = 0

    shots = timeline.ordered_shots()

    for shot in shots:
        if _kind(shot) != "image":
            continue
        pictures += 1
        found.append(Attachment("picture", pictures, shot.media, ("shots", shot.start)))

    for shot in shots:
        if _kind(shot) != "video":
            continue
        # A reference video carries its own audio, and the core node labels that
        # soundtrack immediately before the video it belongs to.
        audio_count += 1
        found.append(Attachment("audio", audio_count, shot.media, None))
        video_count += 1
        found.append(Attachment("video", video_count, shot.media, ("shots", shot.start)))

    for cue in timeline.ordered_cues():
        if _kind(cue) != "audio":
            continue
        audio_count += 1
        found.append(Attachment("audio", audio_count, cue.media, ("cues", cue.start)))

    return found


@dataclass(frozen=True, slots=True)
class Subject:
    """Something abstracted *out of* a file, tracked separately from the file itself.

    The guide's fourth label. `<Picture 2>` is a photograph; `<Subject 1>` is the face in
    it, which can be carried onto a different person in a different shot. Saying "keep the
    face from this photo" needs both -- the picture as provenance, the subject as the thing
    that survives -- and with only the file labels the two collapse into one claim about
    the whole frame.
    """

    index: int
    name: str
    """What it is, in the author's words: `the man's face`."""
    source: str
    """The token it was abstracted from: `<Picture 2>`."""
    record: dict[str, Any]
    origin: tuple[str, int] | None = None

    @property
    def token(self) -> str:
        return f"<Subject {self.index}>"


def _named(record: dict[str, Any]) -> list[dict[str, Any]]:
    """The subject records of one file, newest form first.

    `subjects` is a list because one frame holds more than one person: a two-shot defines
    both of them, and asking for a second block carrying the same file to name the second
    face made the timeline lie about how many references there are. `subject` is the
    original single-valued form and is still read, so a document written before the list
    existed compiles to exactly what it did then.
    """
    # The file's own marker is copied onto every entry as the fallback: a subject with no
    # marker of its own is retained the way the file it came out of is.
    entries = record.get("subjects")
    if isinstance(entries, list):
        return [{"retention": record.get("retention"), **entry} for entry in entries
                if isinstance(entry, dict) and str(entry.get("name", "")).strip()]

    name = str(record.get("subject", "")).strip()
    if not name:
        return []
    return [{"retention": record.get("retention"), "name": name,
             "subject_retention": record.get("subject_retention")}]


def subjects(timeline: Timeline) -> list[Subject]:
    """Named subjects drawn from attached files, in the files' own order.

    Numbered across the whole document rather than per file, because `<Subject 3>` is what
    the prompt says and the model has one list.
    """
    found: list[Subject] = []
    for item in collect(timeline):
        # A video's own soundtrack shares the video's record, and a face is not abstracted
        # out of an audio track -- taking the names twice would define each subject twice.
        if item.kind == "audio":
            continue
        for entry in _named(item.record):
            found.append(Subject(len(found) + 1, str(entry["name"]).strip(),
                                 item.token, entry, item.origin))
    return found


def bound(timeline: Timeline) -> dict[int, Subject]:
    """Which subject each speaker is, by tag first and by number second.

    The tag is what the cast writes on both ends, and it survives the renumbering that
    dragging a block causes. The number is what documents written before tags existed
    carry, and it still answers for them.
    """
    found = subjects(timeline)
    by_tag = {str(subject.record.get("uid", "")): subject
              for subject in found if subject.record.get("uid")}
    by_index = {subject.index: subject for subject in found}

    pairs: dict[int, Subject] = {}
    for speaker in timeline.speakers:
        subject = by_tag.get(speaker.uid) if speaker.uid else None
        if subject is None:
            subject = by_index.get(speaker.subject)
        if subject is not None:
            pairs[speaker.id] = subject
    return pairs


def tokens_by_segment(timeline: Timeline) -> dict[tuple[str, int], list[str]]:
    """Which tokens each segment should mention, keyed by track and start frame."""
    named: dict[str, list[Subject]] = {}
    for subject in subjects(timeline):
        named.setdefault(subject.source, []).append(subject)

    mapping: dict[tuple[str, int], list[str]] = {}
    for item in collect(timeline):
        if item.origin is None:
            continue
        # A file that exists to supply subjects is mentioned as those subjects. Naming both
        # in one sentence asks the model to reproduce the photograph *and* to lift one
        # feature out of it, which are different instructions.
        found = named.get(item.token)
        mapping.setdefault(item.origin, []).extend(
            [subject.token for subject in found] if found else [item.token])
    return mapping


def of_kind(timeline: Timeline, kind: str) -> list[Attachment]:
    """Attachments whose *file* is of `kind`, in presentation order.

    Note this filters on the file, not the token: a reference video contributes both an
    `<Audio j>` and a `<Video k>`, and only the latter is wanted when collecting videos.
    """
    wanted = {"image": "picture", "video": "video", "audio": "audio"}[kind]
    return [
        item for item in collect(timeline)
        if item.kind == wanted and item.record.get("kind") == kind
    ]
