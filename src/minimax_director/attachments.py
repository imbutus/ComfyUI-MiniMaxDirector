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

    # Sources come after the blocks and before the videos, so a picture on the timeline
    # keeps the number it had when a source is added beside it. They have no origin: the
    # file belongs to the clip rather than to a moment in it, which is exactly what
    # `_appears_in` reads when it decides whether to write a shot list.
    for record in timeline.sources:
        if record.get("kind") != "image":
            continue
        pictures += 1
        found.append(Attachment("picture", pictures, record, None))

    for shot in shots:
        if _kind(shot) != "video":
            continue
        # A reference video carries its own audio, and the core node labels that
        # soundtrack immediately before the video it belongs to.
        audio_count += 1
        found.append(Attachment("audio", audio_count, shot.media, None))
        video_count += 1
        found.append(Attachment("video", video_count, shot.media, ("shots", shot.start)))

    # A source clip is wired into the same `ref_videos` list, after the blocks' -- so its
    # soundtrack takes its `<Audio n>` here, before the standalone cues, exactly as a
    # block video's does. The core node pairs each soundtrack with the video it was loaded
    # beside, so this order is not a preference: it is what the model will be handed.
    for record in timeline.sources:
        if record.get("kind") != "video":
            continue
        audio_count += 1
        found.append(Attachment("audio", audio_count, record, None))
        video_count += 1
        found.append(Attachment("video", video_count, record, None))

    # A cue is a recording, or a clip dropped on the AUDIO track for its sound alone -- the
    # director hands the core node that clip's decoded soundtrack and none of its frames,
    # so it is one `<Audio n>` and no `<Video n>`. The same file on MAIN is the other
    # reading: the pictures, with their sound travelling beside them.
    for cue in timeline.ordered_cues():
        if _kind(cue) not in ("audio", "video"):
            continue
        audio_count += 1
        found.append(Attachment("audio", audio_count, cue.media, ("cues", cue.start)))

    # A source recording is the clip's, not a moment's -- a voice to follow throughout,
    # for instance -- and takes its number after the cues for the same reason a source
    # picture takes its number after the blocks.
    for record in timeline.sources:
        if record.get("kind") != "audio":
            continue
        audio_count += 1
        found.append(Attachment("audio", audio_count, record, None))

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
             "subject_retention": record.get("subject_retention"),
             "onto": record.get("onto")}]


def _receiver(timeline: Timeline, record: dict[str, Any]) -> str:
    """The tag of the card this one is carried onto, or "" when it is carried onto nobody.

    Only an `attribute_transfer` naming another *tagged* card counts. Free text in `onto`
    describes somebody the shot names rather than a card, and there is no definition to
    fold the feature into.
    """
    # `subject_retention` is what the cast writes (the card's own `keep it`); `retention`
    # is the older single-valued form, and the file's marker copied on as a fallback.
    marker = str(record.get("subject_retention", "")).strip() \
        or str(record.get("retention", "")).strip()
    if marker != "attribute_transfer":
        return ""
    onto = str(record.get("onto") or "").strip().rstrip(".").lower()
    if not onto:
        return ""
    for speaker in timeline.speakers:
        if speaker.name.strip().lower() == onto and speaker.uid:
            return speaker.uid
    return ""


def _all_named(timeline: Timeline) -> list[tuple[Any, dict[str, Any]]]:
    """Every named entry on every attached file, with the attachment it came from."""
    found = []
    for item in collect(timeline):
        # A video's own soundtrack shares the video's record, and a face is not abstracted
        # out of an audio track -- taking the names twice would define each subject twice.
        if item.kind == "audio":
            continue
        for entry in _named(item.record):
            found.append((item, entry))
    return found


def carried(timeline: Timeline) -> dict[str, list[tuple[str, dict[str, Any]]]]:
    """Features folded into somebody else's definition, keyed by the receiver's tag.

    MiniMax's guide: `<Subject N>` is "a content unit that will actually be used in the
    target video", and when one comes from several files the rule is to "combine the
    sources and state what each asset provides" -- `<Subject 1> is the woman whose
    appearance comes from <Picture 1> and whose walking motion comes from <Video 1>`.

    A face lifted out of a photograph and carried onto somebody is exactly that: a second
    source for one person, not a person of its own. Given its own `<Subject n>` it became
    a second content unit the video was supposed to contain, while the receiver was told
    to keep the face it already had -- and the model kept it.
    """
    folded: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for item, entry in _all_named(timeline):
        tag = _receiver(timeline, entry)
        if tag:
            folded.setdefault(tag, []).append((item.token, entry))
    return folded


def subjects(timeline: Timeline) -> list[Subject]:
    """Named subjects drawn from attached files, in the files' own order.

    Numbered across the whole document rather than per file, because `<Subject 3>` is what
    the prompt says and the model has one list.

    A feature carried onto somebody keeps a subject of its own. It is the thing the target
    video will contain -- the working example of a face swap defines the incoming identity
    as `<Subject 1>` and marks *it* `attribute_transfer`, while what it replaces is named
    only as the thing being overwritten. Folding it into the receiver instead left the
    prompt with nothing to point at where the new face was supposed to be.
    """
    found: list[Subject] = []
    for item, entry in _all_named(timeline):
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


def named_files(timeline: Timeline) -> list[str]:
    """Every file the document names, once each, as ComfyUI's loaders address it.

    A reference video is two attachments -- its pictures and its soundtrack -- and one
    file, so the list is deduplicated: whoever asks this is asking about files on disk,
    and a name reported twice is a file somebody goes looking for twice.

    Pure, so it can be tested without ComfyUI: whether any of these is actually there is
    a question about a folder, which is the node's business.
    """
    found: list[str] = []
    for item in collect(timeline):
        name = str(item.record.get("filename", "")).strip()
        if not name:
            continue
        subfolder = str(item.record.get("subfolder") or "").strip("/")
        path = f"{subfolder}/{name}" if subfolder else name
        if path not in found:
            found.append(path)
    return found


def missing_sentence(paths: list[str]) -> str:
    """What to say about files the clip names and the machine does not have.

    One wording, said in three places -- the run refused before it starts, the report the
    editor shows while writing, and the panel that repairs it -- because three phrasings of
    one problem read as three problems.
    """
    one = len(paths) == 1
    listed = ", ".join(paths[:6]) + (", …" if len(paths) > 6 else "")
    return (
        f"{len(paths)} file{'' if one else 's'} this clip names "
        f"{'is' if one else 'are'} not in ComfyUI's input folder: {listed}. "
        f"Open IMPORT / EXPORT on the director and re-upload {'it' if one else 'them'}, "
        f"or take whatever names {'it' if one else 'them'} off the clip."
    )
