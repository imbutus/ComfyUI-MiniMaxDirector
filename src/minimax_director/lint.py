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
        *_check_sources(timeline),
        *_check_dialogue(timeline),
        *_check_clip_lengths(timeline),
        *_check_reference_counts(timeline),
        *_check_image_shape(timeline),
        *_check_description_length(timeline),
        *_check_cut_worthiness(timeline),
        *_check_silence(timeline),
        *_check_voice_references(timeline),
        *_check_continuity(timeline),
        *_check_speakers(timeline),
    ]
    return sorted(issues, key=lambda issue: issue.level != "error")


def _check_description_length(timeline: Timeline) -> Iterator[Issue]:
    """The body far outside the guide's 350-500 word band for a generation task.

    Ref §5.2 gives that range for generation, and exempts editing tasks and dialogue-dense
    content, which "prioritizes fitting the complete spoken timeline rather than
    mechanically reaching a word count". Both exemptions are honoured here, because a
    warning that fires on work the guide explicitly allows is a warning people turn off.

    A short body is the common real fault: three words per shot is a prompt H3 fills in
    from its own priors, and the result is not what anybody asked for.
    """
    from .compile import _description  # local: compile imports nothing from here

    if any(str(item.record.get("role", "")).strip() == "edit"
           for item in attachments.collect(timeline)):
        return
    if any(line.text.strip() for shot in timeline.shots for line in shot.lines):
        return

    words = len(_description(timeline).split())
    if not words:
        return
    if words < 350:
        yield Issue(
            "warning",
            f"The description is {words} words. MiniMax asks for 350-500 for a generation "
            f"task; below that the model fills in the rest from its own priors.",
        )
    elif words > 500:
        yield Issue(
            "warning",
            f"The description is {words} words, past the 350-500 the guide asks for. "
            f"Detail beyond it competes with itself for the model's attention.",
        )


FRAMING = {
    "a", "an", "the", "of", "on", "in", "at", "shot", "angle", "view", "from",
    "wide", "medium", "close", "closeup", "close-up", "extreme", "long", "full",
    "tight", "slightly", "slight", "high", "low", "eye", "level", "framing",
}
"""Words that describe how a shot is framed rather than what is in it.

Used to answer one question: do two adjacent shots say the same thing about the world?
Anything left after these are removed is content, and two shots with identical content
differ only in framing -- which base §4.2 says should be a camera move, not a cut."""


def _content_words(text: str) -> tuple[str, ...]:
    stripped = re.sub(r"[^\w\s-]", " ", text.lower())
    return tuple(word for word in stripped.split() if word not in FRAMING)


def _check_cut_worthiness(timeline: Timeline) -> Iterator[Issue]:
    """Two shots in a row that describe the same thing from a different distance.

    Base §4.2: "A cut should introduce new information about the subject, space, state,
    viewpoint, or time. If only the distance or a slight angle needs to change, prefer
    camera motion." A cut that introduces nothing costs a second of the clip and gives the
    model licence to change everything else across it.
    """
    shots = timeline.ordered_shots()
    for number, (earlier, later) in enumerate(zip(shots, shots[1:]), start=1):
        words = _content_words(earlier.prompt)
        if not words or words != _content_words(later.prompt):
            continue
        yield Issue(
            "warning",
            f"[Shot {number}] and [Shot {number + 1}] describe the same thing at a "
            f"different framing. A cut should introduce something new; for distance "
            f"alone, one shot with a camera move reads better.",
        )


def _check_silence(timeline: Timeline) -> Iterator[Issue]:
    """`overall_soundscape: N/A` said without meaning it.

    Base §4.6 is exact: use `N/A` "only when the user explicitly requests complete silence
    throughout the video". An empty AUDIO track compiles to `N/A` and so states, in H3's
    own vocabulary, that the clip is silent -- which is a much stronger claim than "nobody
    wrote anything here yet", and it is obeyed.
    """
    if timeline.cues or not timeline.shots:
        return
    written = " ".join(timeline.prose()).lower()
    if "silen" in written or "quiet" in written:
        return
    yield Issue(
        "warning",
        "Nothing is on the AUDIO track, so overall_soundscape compiles to N/A -- which "
        "tells H3 the clip is completely silent. Add a cue, or say so on purpose.",
    )


def _check_voice_references(timeline: Timeline) -> Iterator[Issue]:
    """A voice-timbre reference marked as a copy, and a voiceover nobody is described for.

    The first is a contradiction the guide draws itself (ref §4.2): `reference` means the
    signal is *not* copied, and it is the marker a timbre reference takes. Asking for the
    timbre and for a 1:1 copy of the recording at once leaves the model to pick one.
    """
    bound = {str(speaker.voice_from).strip()
             for speaker in timeline.speakers if str(speaker.voice_from).strip()}
    for item in attachments.collect(timeline):
        if item.kind != "audio":
            continue
        name = str(item.record.get("filename", "")).strip()
        if name not in bound:
            continue
        # A reference video and its soundtrack are one record: `collect` hands the same
        # `media` dict out twice, once as the audio and once as the video. So the `keep`
        # on it is the one the author set for the *picture*, and there is no second
        # control to set for the sound. Reading it as the audio's marker asked for a
        # value the editor cannot express, and the only way to clear the warning was to
        # weaken the face the same record defines.
        if str(item.record.get("kind", "")).strip() == "video":
            continue
        marker = str(item.record.get("retention", "")).strip()
        if marker in ("fully_copy", "partially_copy", "fully_preserved"):
            yield Issue(
                "warning",
                f"{item.token} ({name}) is a voice reference but its keep is {marker}, "
                f"which asks for the recording itself. Use reference: the timbre is "
                f"followed, the signal is not copied.",
            )


def _check_continuity(timeline: Timeline) -> Iterator[Issue]:
    """`carries over` and voiceover, checked against where the block actually sits."""
    shots = timeline.ordered_shots()
    for number, shot in enumerate(shots, start=1):
        for line in shot.lines:
            if not line.text.strip():
                continue
            # A guessed word in reused dialogue. Ref §5.4 asks for `[unclear]` and never a
            # guess; a question mark in brackets is what a guess looks like when typed.
            if re.search(r"\(\s*\?+\s*\)|\?{2,}", line.text):
                yield Issue(
                    "warning",
                    f"[Shot {number}] a line is marked as uncertain. If the source was "
                    f"unintelligible the guide asks for [unclear] rather than a guess.",
                )
            if line.carries and number == len(shots):
                yield Issue(
                    "warning",
                    f"[Shot {number}] a line carries over, but nothing follows it. It "
                    f"compiles as <cutoff> -- speech truncated by the end of the clip.",
                )


def _cited_inside_a_subject(timeline: Timeline) -> set[str]:
    """Tokens that reach the prose inside a subject's definition rather than on their own.

    The picture a card is drawn from, and the video a card takes its motion from: the
    compiler writes both into that subject's sentence and gives neither an entry of its
    own, so a rule asking for them to be described or named elsewhere is asking for
    something the prompt does not have room for.
    """
    found: set[str] = set()
    for subject in attachments.subjects(timeline):
        found.add(subject.source)
        motion = str(subject.record.get("motion_file", "")).strip()
        if not motion:
            continue
        for item in attachments.collect(timeline):
            if (str(item.record.get("filename", "")).strip() == motion
                    and item.kind != "audio"):
                found.add(item.token)
    return found


def _check_subjects(timeline: Timeline) -> Iterator[Issue]:
    """An attached file with nothing said about it.

    Attachments compile to the full-reference format, where every token gets a line in
    `subject_definitions` saying what it is and what to keep. Undescribed, that line falls
    back to the filename -- valid, but it tells the model nothing about what has to stay
    the same, which is the entire reason the section exists.
    """
    cited = _cited_inside_a_subject(timeline)
    for item in attachments.collect(timeline):
        if str(item.record.get("description", "")).strip():
            continue
        # Nothing to describe on a token the prompt does not carry. A reference video's
        # soundtrack is left out entirely unless the author names it, and a file a card
        # draws on -- the picture, or the video a subject's motion comes from -- is cited
        # inside that subject's own sentence rather than given a line to fill in.
        if item.kind == "audio" and item.record.get("kind") == "video":
            continue
        if item.token in cited:
            continue
        name = str(item.record.get("filename", "")) or item.kind
        yield Issue(
            "warning",
            f"{item.token} ({name}) has no description, so nothing tells the model what "
            f"to keep from it. Describe it on a subject card pointed at this file.",
        )


def _check_sources(timeline: Timeline) -> Iterator[Issue]:
    """A source file nothing in the prompt points at.

    A file on a block is written into that block's own line by the compiler. A source has
    no block to speak for it, so the only ways it reaches the prose are a card that draws
    a subject out of it and the author naming its token. With neither it is a reference
    the prompt never mentions, and H3 only uses a reference the prose points at.
    """
    if not timeline.sources:
        return
    named: set[str] = set()
    for text in timeline.prose():
        for kind, index in TOKEN.findall(text or ""):
            named.add(f"<{kind.capitalize()} {index}>")

    defines = _cited_inside_a_subject(timeline)
    # A file whose card is carried onto somebody is named inside *their* definition, which
    # is the prose pointing at it -- exactly what this check is asking for.
    defines |= {token for entries in attachments.carried(timeline).values()
                for token, _ in entries}
    for item in attachments.collect(timeline):
        if item.origin is not None or item.token in named or item.token in defines:
            continue
        # A reference video's soundtrack has no origin either, and it is spoken for by the
        # video it belongs to rather than by anything the author writes. The video itself
        # still answers for both, source or not, so only the soundtrack is skipped here.
        if item.kind == "audio" and item.record.get("kind") == "video":
            continue
        name = str(item.record.get("filename", "")) or item.kind
        yield Issue(
            "warning",
            f"{item.token} ({name}) is a source file, so no block names it: point at it "
            f"from a prompt with its chip, or describe it on a subject card.",
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


def _check_reference_counts(timeline: Timeline) -> Iterator[Issue]:
    """More reference material than H3 accepts.

    The model card and the platform API reference give the same ceilings for Ref2VA: nine
    reference images, three videos and three audio clips, fifteen seconds of video and of
    audio in total, and twelve files across all three kinds. Over any of them the request
    is rejected rather than trimmed, so the cost of finding out is a whole run.

    Frame anchors are counted apart. They are handed to the keyframe inputs rather than to
    the reference list, so they do not eat into the nine -- and the two modes cannot be
    mixed at all, which `execute` refuses outright.

    Buckets are built the way `execute` builds them, so the numbers warned about here are
    the numbers the model is handed.
    """
    claimed: set[str] = set()
    pictures = []
    for item in attachments.of_kind(timeline, "image"):
        role = str(item.record.get("role", "")).strip()
        if role in ("first frame", "last frame") and role not in claimed:
            claimed.add(role)
            continue
        pictures.append(item)
    videos = attachments.of_kind(timeline, "video")
    audios = [
        item for item in attachments.collect(timeline)
        if item.kind == "audio"
        and item.origin is not None and item.origin[0] == "cues"
    ]

    for what, items, ceiling in (
        ("reference images", pictures, 9),
        ("reference videos", videos, 3),
        ("reference audio files", audios, 3),
    ):
        if len(items) > ceiling:
            yield Issue(
                "warning",
                f"{len(items)} {what}. H3 takes at most {ceiling}, and refuses the rest "
                f"of the request with them.",
            )

    total = len(pictures) + len(videos) + len(audios)
    if total > 12:
        yield Issue(
            "warning",
            f"{total} reference files. H3 takes at most 12 across pictures, video and "
            f"audio together.",
        )

    # Only what was actually measured. An unread duration is not a wrong one, and a sum
    # built out of guesses would fire on documents that are perfectly legal.
    for what, items in (("video", videos), ("audio", audios)):
        seen: set[int] = set()
        run = 0.0
        for item in items:
            if id(item.record) in seen:
                continue
            seen.add(id(item.record))
            length = item.record.get("seconds")
            if isinstance(length, (int, float)) and length > 0:
                run += float(length)
        if run > 15:
            yield Issue(
                "warning",
                f"{run:g}s of reference {what}. H3 takes 15 seconds in total, however "
                f"many clips it is split across.",
            )


def _check_image_shape(timeline: Timeline) -> Iterator[Issue]:
    """A picture outside the shape H3 accepts.

    The platform API gives every `image_url` the same two bounds: each side within
    256-5760 px, and a width-to-height ratio within 0.4-2.5. A panorama or a tall strip is
    refused rather than letter-boxed, and the editor takes it happily, so without this the
    first news of it is a failed run.

    The dimensions are the ones the browser read when the file was attached. A picture
    from an older document carries none, and an unknown size is not a wrong one.
    """
    seen: set[str] = set()
    for item in attachments.of_kind(timeline, "image"):
        name = str(item.record.get("filename", ""))
        if name in seen:
            continue
        seen.add(name)
        wide = item.record.get("width")
        tall = item.record.get("height")
        if not isinstance(wide, (int, float)) or not isinstance(tall, (int, float)):
            continue
        if wide <= 0 or tall <= 0:
            continue
        label = name or "a picture"
        if not (256 <= wide <= 5760 and 256 <= tall <= 5760):
            yield Issue(
                "warning",
                f"{label} is {wide:g}x{tall:g}. H3 takes pictures between 256 and 5760 "
                f"pixels on each side.",
            )
        ratio = wide / tall
        if not 0.4 <= ratio <= 2.5:
            yield Issue(
                "warning",
                f"{label} is {wide:g}x{tall:g}, a ratio of {ratio:.2f}. H3 takes pictures "
                f"between 0.4 and 2.5 wide-to-tall.",
            )


def _carried_into(timeline: Timeline, subject) -> bool:
    """Whether anything is carried onto `subject`.

    A face lifted out of one photograph and carried onto the person from another says that
    person is who is on screen -- so a speaker whose own card hangs off a different block
    is not the mistake the warning is looking for. The feature is folded into their
    definition (`attachments.carried`), which is where the claim lives.
    """
    wanted = str(subject.record.get("uid", ""))
    if not wanted:
        return False
    # Anything carried onto them at all: the feature comes off a file that may sit on no
    # block, and the receiver being on screen is what the carrying says.
    return bool(attachments.carried(timeline).get(wanted))


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
                    # Unless this shot carries a card that moves its feature *onto* them:
                    # that is the author saying, in the document, that this person is the
                    # one on screen here -- which is what the warning was asking about.
                    if _carried_into(timeline, subject):
                        continue
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
                f"voice is whatever the model picks. Describe them on their subject card: age, "
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

    # A file on a block names itself. The compiler appends that block's token to its line
    # wherever the author has not typed it, so the model is pointed at the file either
    # way. Counting it as both connected and named is what keeps an ordinary timeline
    # quiet: the director registers every attached file as a reference before linting, so
    # without this every run reported a token nobody had typed.
    attached = {(item.kind, item.index) for item in attachments.collect(timeline)}
    wired = {(ref.kind, ref.index) for ref in timeline.references} | attached

    for kind, index in sorted(mentioned - wired):
        yield Issue(
            "error",
            f"<{kind.capitalize()} {index}> is used in the prompt but nothing is "
            f"connected to that slot.",
        )

    for kind, index in sorted(wired - mentioned - attached):
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


def _check_speakers(timeline: Timeline) -> Iterator[Issue]:
    """A subject card that reaches the prompt as nothing at all.

    A card earns its place two ways: it names a file, which makes it a `<Subject n>` with
    a definition and a retention marker, or it describes a voice, which becomes the words
    in front of `(S1)`. With neither, the compiled prompt is byte-for-byte what it would
    be with no card there -- and the editor draws a filled-in row either way, which reads
    as work that has been done.

    The second half is the reverse: a voice, and no line anywhere that names it. A voice
    is an instruction about how somebody sounds, and with nothing spoken it instructs
    nothing -- while `voice_from` goes further and tells the model an attached recording
    is the timbre reference for a speaker it is never asked to voice.

    A third check is the one that costs an author words: a card with no voice does not
    speak, so `cast.merge` takes its lines out of the document, and lines that leave
    without a word about it are how a scene goes missing. The count rides back on the
    speaker and is said out loud here.

    The first half is deliberately *not* guarded on `speech`: that flag is derived --
    `cast.merge` sets it false precisely when no card has a voice -- so reading it there
    would silence the check in the one case it exists for. The second half is guarded,
    because with the switch off no line is compiled and an unused voice is a control left
    as it was found.
    """
    bound = attachments.bound(timeline)
    spoken = {number
              for shot in timeline.shots
              for line in shot.lines if line.text.strip()
              for number in line.numbers}
    # A card carried onto somebody else is not a `<Subject n>` and never will be -- it is
    # written into that person's own line -- so it compiles to something without being one.
    folded = {str(entry.get("uid", ""))
              for entries in attachments.carried(timeline).values()
              for _, entry in entries}

    for speaker in timeline.speakers:
        voiced = bool(str(speaker.voice).strip() or str(speaker.voice_from).strip())
        described = bound.get(speaker.id) is not None or speaker.uid in folded
        name = str(speaker.name).strip() or f"S{speaker.id}"

        if speaker.muted_lines:
            # Said before anything else about this card: the other warnings are about a
            # prompt that could be better, this one is about words that are gone.
            count = speaker.muted_lines
            yield Issue(
                "warning",
                f"{name} has {count} written line{'' if count == 1 else 's'} that "
                f"{'is' if count == 1 else 'are'} not compiled: the card describes no "
                f"voice, so it does not speak. Say how they sound to bring the words "
                f"back, or untick their face on the dialogue rows.",
            )

        if not voiced and not described:
            yield Issue(
                "warning",
                f"The subject card {name} compiles to nothing: it names no file, so it is "
                f"not a <Subject n>, and it describes no voice, so it is not heard. Point "
                f"its from at a file, or say how it sounds.",
            )
        elif voiced and timeline.speech and speaker.id not in spoken:
            # A voice is an instruction about how somebody sounds, and with no line it is
            # an instruction about nothing. `voice_from` makes it worse than idle: the
            # prompt states that an attached recording is the timbre reference for a
            # speaker the model is never asked to voice.
            yield Issue(
                "warning",
                f"{name} has a voice but says nothing: no line names S{speaker.id}, so "
                f"the voice is never used. Tick their face on a shot's dialogue row, or "
                f"clear the voice.",
            )
