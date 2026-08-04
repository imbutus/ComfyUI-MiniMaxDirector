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


def tokens_by_segment(timeline: Timeline) -> dict[tuple[str, int], list[str]]:
    """Which tokens each segment should mention, keyed by track and start frame."""
    mapping: dict[tuple[str, int], list[str]] = {}
    for item in collect(timeline):
        if item.origin is None:
            continue
        mapping.setdefault(item.origin, []).append(item.token)
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
