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
from .timeline import (
    ANCHOR_ROLES, AUDIO_RETENTIONS, FRAME_ROLES, RETENTION_ACROSS, RETENTIONS, ROLE_TASKS,
    Move, Shot, Timeline,
)


@dataclass(frozen=True, slots=True)
class Compiled:
    """What the node hands to the sampler, plus what it shows the author."""

    prompt: str
    length: int
    duration: float

    def __str__(self) -> str:
        return self.prompt


def compile_timeline(
    timeline: Timeline, first_frame: bool = False, last_frame: bool = False,
) -> Compiled:
    """Render `timeline` to a prompt and a valid frame count.

    `first_frame` and `last_frame` say whether those inputs are wired on the node. They
    are not part of the document -- an image dropped on the graph is not a block on the
    timeline -- but the guide requires the prompt to announce them, so the two facts meet
    here.
    """
    render = _renderer(timeline)
    length = timeline.length
    body = render(timeline)
    instruction = _alignment(timeline, length, first_frame, last_frame)
    return Compiled(
        prompt=f"{instruction}\n\n{body}" if instruction else body,
        length=length,
        duration=lattice.to_seconds(length),
    )


def _alignment(timeline: Timeline, length: int, first: bool, last: bool) -> str:
    """The keyframe-alignment sentence, which the guide makes the prompt's first line.

    Three wordings for three cases, quoted from the base guide rather than paraphrased --
    they are fixed strings there, and a model trained on a fixed string is not the place
    to improve on the English. `S.SS` is the effective duration to exactly two decimals,
    and `N` the index of the real final shot.

    Nothing is emitted for a timeline carrying references: that path routes to
    `MiniMaxH3ReferenceToVideo`, which has no keyframe inputs to align to. The frame
    anchors themselves are the exception -- they are where `first` and `last` come from,
    and a block used as one is the keyframe rather than a reference beside it.
    """
    others = [item for item in attachments.collect(timeline)
              if str(item.record.get("role", "")).strip() not in ANCHOR_ROLES]
    if not (first or last) or others:
        return ""

    shots = len(timeline.ordered_shots()) or 1
    seconds = f"{lattice.to_seconds(length):.2f}"

    if first and not last:
        return ("For the target video, at 0.00 seconds into the target video, "
                "<Picture 1> (from [Shot 1]) is fully referenced.")
    if last and not first:
        return ("How the reference pictures align with the target video — "
                f"<Picture 1> (from [Shot {shots}]) aligns with the {seconds}-second "
                "mark of the target video.")
    return ("How the reference pictures align with the target video — "
            "Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target "
            f"video; Picture 2 (from Shot {shots}) aligns with the {seconds}-second "
            "mark of the target video.")


def _renderer(timeline: Timeline):
    """Which shape this timeline compiles to.

    Attachments decide it, and nothing else does. Anything attached sends the graph to
    `MiniMaxH3ReferenceToVideo`, and that model wants the six-section full-reference
    format; with nothing attached the three-field format from MiniMax's own guide is what
    H3 was written to read.
    """
    return _render_reference if attachments.collect(timeline) else _render_official


# -- the documented format ---------------------------------------------------


def _render_official(timeline: Timeline) -> str:
    fields = [f"integrated_multimodal_description: {_description(timeline)}"]
    fields.append(f"overall_soundscape: {_soundscape(timeline) or 'N/A'}")
    fields.append(f"non_diegetic_music: {timeline.music.strip() or 'N/A'}")
    return "\n\n".join(fields)


# -- full-reference format ---------------------------------------------------


def _render_reference(timeline: Timeline) -> str:
    """The six sections H3 asks for when the prompt carries references.

    Only the three new sections are new work: §5.1 of the reference guide says the shot
    body follows the base guide exactly, so `detailed_description` is the same string
    `integrated_multimodal_description` would have carried, under a different name.

    One subject per attached file. The guide allows many-to-many -- one subject drawn from
    several pictures, one picture supplying several subjects -- but the editor attaches
    files to blocks, so that relationship has nowhere to be authored yet. The common case,
    *this picture is the raccoon and it stays the raccoon*, is expressible as it stands.
    """
    fields = [
        f"subject_definitions:\n{_subject_definitions(timeline)}",
        f"summary:\n{_summary(timeline)}",
        f"retention_analysis:\n{_retention_analysis(timeline)}",
        # §5.2: in full-reference mode the style is established "in one or two English
        # sentences before [Shot 1]", and the guide's own example opens that way. In the
        # base format it belongs at the head of Shot 1 instead -- two dialects, two places,
        # and folding it into Shot 1 here was writing the base form under a ref heading.
        f"detailed_description: {_description(timeline, style_apart=True)}",
        f"overall_soundscape: {_soundscape(timeline) or 'N/A'}",
        f"non_diegetic_music: {timeline.music.strip() or 'N/A'}",
    ]
    return "\n\n".join(fields)


def _author_text(timeline: Timeline) -> str:
    """Everything the author typed, as one string.

    Used to answer one question: did they point at this token by hand?
    """
    parts: list[str] = [timeline.global_prompt, timeline.music]
    for shot in timeline.shots:
        parts.extend([shot.prompt, shot.screen_text])
        parts.extend(line.text for line in shot.lines)
    parts.extend(cue.prompt for cue in timeline.cues)
    parts.extend(move.prompt for move in timeline.moves)
    return " ".join(str(part or "") for part in parts)


def _rides_along(timeline: Timeline, item) -> bool:
    """A reference video's own soundtrack, which nothing in the prose points at.

    The core node wires that soundtrack in beside the frames, so it has a token whether or
    not anybody wanted it -- and it shares the video's record. Everything written about the
    picture therefore reads as a claim about the sound: a film stock as the description of
    a waveform, and the file's `fully_copy` promising the video's audio as the whole clip's
    final track when all the author took from it was the grain. A style source is the
    ordinary case here, so the soundtrack is declared only when the prose asks for it.
    """
    if item.kind != "audio" or str(item.record.get("kind", "")).strip() != "video":
        return False
    # Only a plain reference. A video the clip continues from, or takes a frame from, is a
    # video whose sound is part of what is being carried over -- the guide's own
    # `video continuation + audio reuse` pairing -- and its soundtrack is not a stowaway.
    if str(item.record.get("role", "reference") or "reference") != "reference":
        return False
    return item.token not in _author_text(timeline)


def _only_defines(timeline: Timeline, item) -> bool:
    """Is this file here purely to define somebody, rather than to be a frame of the video?

    The guide: "If an image is used only to define a character, scene, costume, or style,
    do not create a standalone picture entry. Instead, cite the image source inside the
    corresponding `<Subject N>` definition." A file used as a frame anchor, a continuation
    source or an edit target is a different thing -- it is in the video, not behind it --
    and keeps its own entry however many people are drawn from it.
    """
    if str(item.record.get("role", "reference") or "reference") != "reference":
        return False
    if any(subject.source == item.token for subject in attachments.subjects(timeline)):
        return True
    # A second asset a card draws on -- the video a subject's motion comes from -- is cited
    # inside that subject's definition by the same rule. Given an entry of its own it read
    # as a clip to reproduce: `fully_preserved - the video in walk.mp4`, next to a sentence
    # that had already said all it was wanted for was the movement.
    if any(_token_for(timeline, str(subject.record.get("motion_file", "")).strip()) == item.token
           for subject in attachments.subjects(timeline)):
        return True
    # A file whose only card is carried onto somebody else is cited inside *their*
    # definition, which is the same rule -- and given an entry of its own it said the whole
    # photograph was preserved, right beside the sentence taking one feature out of it.
    return any(token == item.token
               for entries in attachments.carried(timeline).values()
               for token, _ in entries)


def _subject_definitions(timeline: Timeline) -> str:
    """One line per attached file: what its token denotes and what to follow.

    An attachment with nothing written about it still gets a line. A missing definition
    would leave a token referenced in the body and defined nowhere, which the guide calls
    out as an error; a thin line at least keeps the document consistent, and `lint` says
    what is missing.
    """
    lines = []
    for item in attachments.collect(timeline):
        if _only_defines(timeline, item) or _rides_along(timeline, item):
            continue
        if str(item.record.get("role", "")).strip() == "storyboard":
            # The guide's own sentence for a shot-planning image (§2.2). It matters that
            # this is not phrased as content: a storyboard frame is a plan of the framing,
            # and described like an ordinary reference the model tries to reproduce it.
            covers = _shots_named(timeline, item)
            lines.append(
                f"{item.token} is a storyboard reference{f' for {covers}' if covers else ''}, "
                f"defining viewpoint, subject placement, and shot order.")
            continue
        described = _described(item)
        voiced = _voice_clause(timeline, item)
        lines.append(f"{item.token} is {described}{voiced}.")
    spoken = _spoken_by(timeline)
    for subject in attachments.subjects(timeline):
        # Provenance named on the subject's own line, which is what the guide asks for
        # when a picture is only there to supply something else.
        lines.append(f"{subject.token} is {subject.name.rstrip('.')}"
                     f"{_sources(timeline, subject)}{spoken.get(subject.token, '')}.")
    return "\n".join(lines)


def _spoken_by(timeline: Timeline) -> dict[str, str]:
    """How each subject sounds, for the subjects a speaker was bound to.

    H3 fixes a voice from what the prompt says about the speaker, and the description of a
    speaker the guide knows as `<Subject 1>` is that subject's line -- the body prints the
    token there, not prose, so a voice typed on a card with a file used to reach the model
    nowhere at all. A card with no file is unaffected: its voice *is* its description, and
    the body still prints it before the `(Sn)`.

    A muted card is skipped. With no line of theirs compiled, how they sound is an
    instruction about nothing -- the same reason their timbre reference is dropped.
    """
    if timeline.voices() is None:
        return {}
    said: dict[str, str] = {}
    for number, subject in attachments.bound(timeline).items():
        voice = next((speaker.voice.strip() for speaker in timeline.speakers
                      if speaker.id == number and speaker.speaks), "")
        if voice:
            said[subject.token] = f", and sounds like this: {voice.rstrip('.')}"
    return said


def _sources(timeline: Timeline, subject) -> str:
    """Where a subject comes from -- one asset, or several with a job each (§2.1).

    One file is the ordinary case and keeps the short form. A second asset makes the
    sentence name what each supplies, because "from <Picture 1> and <Video 1>" leaves the
    model to decide which of them the walk comes from.
    """
    motion = _token_for(timeline, str(subject.record.get("motion_file", "")).strip())
    if not motion:
        return f", from {subject.source}"
    return (f", whose appearance comes from {subject.source} and whose motion comes "
            f"from {motion}")


def _receivers(timeline: Timeline) -> dict[str, tuple]:
    """For each carried subject's token, the subject it is written over.

    The working example of an identity replacement puts `attribute_transfer` on the
    subject being *brought in* and says what it overwrites -- "Deadpool's suit, mask ...
    replace the original performer's visual identity only, mapped exactly onto his same
    body position". Both halves of that sentence need the pair, so it is computed once.
    """
    people = attachments.subjects(timeline)
    by_tag = {str(person.record.get("uid", "")): person
              for person in people if person.record.get("uid")}
    pairs: dict[str, tuple] = {}
    for tag, taken in attachments.carried(timeline).items():
        receiver = by_tag.get(tag)
        if receiver is None:
            continue
        for token, entry in taken:
            # By the card's own tag. `carried` and `subjects` each rebuild their entry
            # dicts from the file record, so the two are equal and never identical.
            wanted = str(entry.get("uid", "")).strip()
            for person in people:
                same = (str(person.record.get("uid", "")).strip() == wanted if wanted
                        else person.source == token
                        and person.name.strip() == str(entry.get("name", "")).strip())
                if same:
                    pairs[person.token] = (person, receiver)
                    break
    return pairs


def _region(subject, bare: bool = False) -> str:
    """The head of a subject's description: `the face`, out of `the face: bone structure...`

    What is replaced has to be nameable in a sentence about the receiver, and the author
    has already written it -- everything before the colon is the thing, everything after
    describes it. `bare` drops the author's article for the possessive positions, where
    "<Subject 1>'s the face" would otherwise come out.
    """
    head = str(subject.name).partition(":")[0].strip().rstrip(".")
    head = head or str(subject.name).strip()
    if bare and head.lower().startswith("the "):
        head = head[4:]
    return head


def _token_for(timeline: Timeline, filename: str) -> str:
    """The token an attached file is addressed by, found from its name.

    The cast binds by filename precisely because tokens move when a block is dragged, so
    this is where the two meet -- once, at compile time, against the numbering the prompt
    is about to use.
    """
    if not filename:
        return ""
    for item in attachments.collect(timeline):
        if str(item.record.get("filename", "")).strip() == filename and item.kind != "audio":
            return item.token
    return ""


def _voices_from(timeline: Timeline, item) -> list[tuple[str, int]]:
    """Who this audio lends its timbre to: `(subject token or "", speaker number)`.

    A card with a picture is a `<Subject n>` and the guide names it; a card that is only a
    voice has no subject to name, and `(S1)` alone still identifies the speaker.
    """
    if item.kind != "audio":
        return []
    bound = attachments.bound(timeline)
    found = []
    for speaker in timeline.speakers:
        if str(speaker.voice_from).strip() != str(item.record.get("filename", "")).strip():
            continue
        subject = bound.get(speaker.id)
        found.append((subject.token if subject else "", speaker.id))
    return found


def _voice_clause(timeline: Timeline, item) -> str:
    """`, and is the voice-timbre reference for <Subject 1> (S1)` -- the guide's §2.4 form.

    Folded into the file's own line rather than added as a second one: two sentences both
    opening `<Audio 1> is` read as two different claims about the same token.
    """
    pairs = _voices_from(timeline, item)
    if not pairs:
        return ""
    named = _join([f"{token} (S{number})" if token else f"the speaker (S{number})"
                   for token, number in pairs])
    return f", and is the voice-timbre reference for {named}"


def _shots_named(timeline: Timeline, item) -> str:
    """`[Shot 1]`, or `[Shot 1] and [Shot 2]` -- every shot this file's block overlaps."""
    if item.origin is None:
        return ""
    track, start = item.origin
    if track != "shots":
        return ""
    here = next((shot for shot in timeline.ordered_shots() if shot.start == start), None)
    if here is None:
        return ""
    covered = [f"[Shot {number}]"
               for number, shot in enumerate(timeline.ordered_shots(), start=1)
               if shot.start < here.end and shot.end > here.start]
    return _join(covered)


def _task_types(timeline: Timeline) -> str:
    """The bracketed prefix: every relationship this timeline actually has, joined by ` + `.

    The guide names six types and says to combine them without repeats, so a video the
    clip continues from *and* keeps the audio of is `[video continuation + audio reuse]`.
    Reading them off the attachments is the only honest way to write this line: hard-coding
    `reference generation` told the model to treat a continuation source as loose guidance,
    which is a wrong instruction rather than a missing one.

    Order is the guide's own, not the order they were discovered, so two timelines with the
    same relationships produce the same prefix.
    """
    found: set[str] = set()

    for item in attachments.collect(timeline):
        # A soundtrack that rides along with a style video is not a relationship the author
        # asked for: undeclared below, it would still have put `audio reuse` in this line.
        if _rides_along(timeline, item):
            continue
        role = str(item.record.get("role", "")).strip()
        marker = _retention(item)
        if item.kind == "audio":
            # The two audio types are the same distinction the retention marker already
            # draws: copied, or merely alluded to.
            found.add("audio reuse" if marker in ("fully_copy", "partially_copy")
                      else "audio reference")
        elif item.kind == "video":
            found.add(ROLE_TASKS.get(role, "reference generation"))
        else:
            found.add(ROLE_TASKS.get(role, "reference generation"))

    if not found:
        found.add("reference generation")

    order = ["keyframe completion", "reference generation", "video editing",
             "video continuation", "audio reuse", "audio reference"]
    return " + ".join(name for name in order if name in found)


def _summary(timeline: Timeline) -> str:
    """One paragraph, opening with the bracketed task type."""
    # A soundtrack nobody asked for is not a reference this clip was generated from, and
    # naming it here while `subject_definitions` leaves it out is a token defined nowhere.
    tokens = [item.token for item in attachments.collect(timeline)
              if not _rides_along(timeline, item)]
    shots = len(timeline.ordered_shots())
    scene = timeline.global_prompt.strip().rstrip(".")

    # "A 0-shot clip" is arithmetic, not English. Nothing on the timeline yet is a clip
    # whose shot count is not a fact worth stating.
    opening = f"[{_task_types(timeline)}] A {_count(shots)} clip" if shots else (
        f"[{_task_types(timeline)}] A clip")
    if scene:
        opening += f" of {scene[0].lower()}{scene[1:]}"
    if tokens:
        opening += f", generated with reference to {_join(tokens)}"
    return f"{opening}.{_replacements(timeline)}"


def _replacements(timeline: Timeline) -> str:
    """What the target video replaces, said in the summary as well as in the analysis.

    The working example's summary carries the whole point of the edit -- "in which only
    the performer's visual identity is replaced by <Subject 1>". Ours said nothing about a
    replacement anywhere except one line of `retention_analysis`.
    """
    said = [
        f" {receiver.token}'s {_region(incoming, bare=True)} is replaced by "
        f"{incoming.token}, "
        f"from {incoming.source}, and nothing else about {receiver.token} changes."
        for incoming, receiver in _receivers(timeline).values()
    ]
    return "".join(said)


def _retention_analysis(timeline: Timeline) -> str:
    """One line per token: where it appears, how much of it survives, and why."""
    lines = []
    for item in attachments.collect(timeline):
        # Nothing to analyse for a file that has no entry of its own: it was cited inside
        # the subject it defines, and that subject's own line is below.
        if _only_defines(timeline, item) or _rides_along(timeline, item):
            continue
        marker = _retention(item)
        where = _appears_in(timeline, item)
        # The guide's own gloss for a voice reference: what is followed, and what is not
        # copied. An author's `describes` says what the recording is; this says what the
        # model is meant to do with it, which is the question this section asks.
        if marker == "reference" and _voices_from(timeline, item):
            lines.append(
                f"{item.token}{where}: {marker} - the target speaker follows "
                f"{item.token}'s voice timbre and delivery without copying the original "
                f"signal.")
            continue
        lines.append(
            f"{item.token}{where}: {marker} - "
            f"{_copy_clause(item, marker) or _described(item)}.")
    people = attachments.subjects(timeline)
    pairs = _receivers(timeline)
    written = {receiver.token: incoming
               for incoming, receiver in pairs.values()}
    for subject in people:
        where = _appears_in(timeline, subject)
        if subject.token in pairs:
            # The marker belongs to the subject being brought in, and the line says what
            # it overwrites and what it leaves alone -- the shape of the transfer that is
            # known to work. Marked on the receiver instead, with the receiver preserved
            # wholesale in the same breath, the model kept the face it already had.
            incoming, receiver = pairs[subject.token]
            # Its own file sits in the clip rather than on a block, so it has no shots of
            # its own -- it is on screen exactly where the subject it replaces is.
            where = where or _appears_in(timeline, receiver)
            lines.append(
                f"{subject.token}{where}: attribute_transfer - {subject.name.rstrip('.')}, "
                f"from {subject.source}, replaces {receiver.token}'s "
                f"{_region(subject, bare=True)} only, mapped onto the same position and "
                f"framing at every moment; no other part of {receiver.token} and nothing "
                f"about the scene changes.")
            continue
        if subject.token in written:
            # The receiver. What its own file supplies is listed, and the region being
            # written over is named as excluded -- the working example enumerates exactly
            # what survives and leaves the replaced identity out of that list.
            incoming = written[subject.token]
            # Not `fully_preserved`, whatever the card says. The guide defines
            # `partially_preserved` as "the referenced content is still used, but some
            # defined characteristics are changed or only partially retained", which is
            # what a person whose face is replaced is. Marked `fully_preserved` beside a
            # sentence excluding the face, the prompt said keep-everything and
            # keep-everything-but-the-face at once, and the model took the marker.
            marker = _retention(subject)
            if marker == "fully_preserved":
                marker = "partially_preserved"
            lines.append(
                f"{subject.token}{where}: {marker} - "
                f"{subject.name.rstrip('.')} are retained from {subject.source}; "
                f"{_region(incoming)} is not retained from {subject.source} and comes "
                f"from {incoming.token} instead.")
            continue
        # An `attribute_transfer` that names nobody the cast knows: the feature moves, and
        # the free text in `onto` is the only word on where it lands.
        onto = str(subject.record.get("onto") or "").strip().rstrip(".")
        onto = _named_subject(timeline, people, onto) or onto
        moved = f", transferred onto {onto}" if onto else ""
        lines.append(
            f"{subject.token}{where}: {_retention(subject)} - "
            f"{subject.name.rstrip('.')}{moved}.")
    return "\n".join(lines)


def _named_subject(timeline: Timeline, people: list, onto: str) -> str:
    """`<Subject n>` for a card named by `onto`, or "" when it names nobody.

    The picker beside the `onto` box lists the other cards by the name the author filed
    them under -- `SPEAKER` -- and writes that name into the box. The model is never told
    that name: a person reaches it as `<Subject n>` and nothing else, so
    "transferred onto SPEAKER" asked for a face to be moved onto somebody who does not
    exist in the prompt, and the face stayed where it was. Free text describing whoever
    the shot is about is left exactly as typed, because that the model can read.
    """
    wanted = onto.strip().lower()
    if not wanted:
        return ""
    by_uid = {str(person.record.get("uid", "")): person for person in people
              if person.record.get("uid")}
    for speaker in timeline.speakers:
        if speaker.name.strip().lower() != wanted:
            continue
        person = by_uid.get(speaker.uid)
        if person is not None:
            return person.token
    return ""


def _described(item) -> str:
    """What the author said this reference is, or the filename as a last resort.

    A video's soundtrack shares the video's record, and a description written for the
    picture is not a description of the sound -- so it falls straight through to the
    filename rather than claiming the frames' words.
    """
    if item.kind == "audio" and str(item.record.get("kind", "")).strip() == "video":
        described = ""
    else:
        described = str(item.record.get("description", "")).strip().rstrip(".")
    if described:
        return described
    name = str(item.record.get("filename", "")).strip()
    return f"the {item.kind} in {name}" if name else f"an unnamed {item.kind} reference"


#: What each audio marker asks the model to do, in the guide's own words (ref guide 4.2 and
#: its examples). A recording nobody has described otherwise compiles to "the audio in
#: x.mp3", which repeats the filename and says nothing about the copy relationship -- and
#: the relationship is the entire content of these markers.
COPY_MEANS = {
    "fully_copy": "{token} is reused 1:1 as the target video's complete final audio track",
    "partially_copy": "part of {token} is copied into the target video's audio track, with "
                      "the rest added, removed or replaced",
    "reference": "the target video follows {token}'s timbre, rhythm and delivery without "
                 "copying the original signal",
    "weak_reference": "only the broad category and atmosphere of {token} are kept",
}


def _copy_clause(item, marker: str) -> str:
    """The relationship sentence for an audio marker, when nothing better was written."""
    if str(item.record.get("description", "")).strip():
        return ""
    return COPY_MEANS.get(marker, "").format(token=item.token)


def _markers(item) -> tuple[str, ...]:
    """Which fixed vocabulary this token's marker is drawn from.

    An `<Audio N>` is graded on whether the signal is copied; everything visible is graded
    on how much of the subject survives. A subject is always visible -- a face is not
    lifted out of a waveform -- so it takes the visual set whatever it came from.
    """
    if isinstance(item, attachments.Subject):
        return RETENTIONS
    return AUDIO_RETENTIONS if item.kind == "audio" else RETENTIONS


def _retention(item) -> str:
    """The marker for this token.

    A subject gets its own: the picture may be fully preserved as a frame while the face
    lifted out of it is an `attribute_transfer` onto somebody else. Absent, it falls back
    to the file's, which is the answer for the ordinary case where they agree.

    A marker from the other vocabulary is translated rather than discarded. Two cases
    reach that branch: a document written before the audio set existed, and a reference
    video's soundtrack, which shares the video's record and so carries a visual marker by
    nature. Both meant something, and dropping to `fully_copy` would say something else.
    """
    markers = _markers(item)
    key = "subject_retention" if isinstance(item, attachments.Subject) else "retention"
    marker = str(item.record.get(key, "")).strip()
    if marker not in markers and key == "subject_retention":
        marker = str(item.record.get("retention", "")).strip()
    if marker in markers:
        return marker
    if markers is AUDIO_RETENTIONS and marker in RETENTION_ACROSS:
        return RETENTION_ACROSS[marker]
    return markers[0]


def _named_in(timeline: Timeline, token: str) -> list[int]:
    """Every shot whose own words name this token, in playback order.

    The guide keeps a thing consistent across a cut by naming the same `<Subject n>` in
    each shot it appears in -- so a basket written into Shot 2 and Shot 3 is the same
    basket, not a new one each time. The author does that naming with the subject chips;
    this reads it back, so the retention line covers every shot rather than only the one
    the file happens to sit on.
    """
    found = []
    for number, shot in enumerate(timeline.ordered_shots(), start=1):
        words = " ".join([shot.prompt or "", shot.screen_text or ""]
                         + [line.text or "" for line in shot.lines])
        if token in words:
            found.append(number)
    return found


def _appears_in(timeline: Timeline, item) -> str:
    """`(appears in [Shot 2])`, or `([Shot 1] first frame)` for a concrete frame anchor.

    A reference video's own soundtrack has no origin of its own -- it belongs to the video
    rather than to a block on the timeline -- so it gets no shot list.
    """
    if isinstance(item, attachments.Subject):
        # The shot its file sits on, plus every shot whose words name it. In the first the
        # compiler writes the token itself, so the author's prose does not carry it and
        # `_named_in` alone would leave that shot out of its own subject's line.
        covers = set(_named_in(timeline, item.token))
        if item.origin and item.origin[0] == "shots":
            for number, shot in enumerate(timeline.ordered_shots(), start=1):
                if shot.start == item.origin[1]:
                    covers.add(number)
        if covers:
            here = _join([f"[Shot {number}]" for number in sorted(covers)])
            return f" (appears in {here})"
    if item.origin is None:
        return ""
    role = str(item.record.get("role", "")).strip()
    if role == "storyboard":
        covers = _shots_named(timeline, item)
        return f" (storyboard for {covers})" if covers else " (storyboard)"
    track, start = item.origin
    for number, shot in enumerate(timeline.ordered_shots(), start=1):
        if track == "shots" and shot.start == start:
            if role in FRAME_ROLES:
                return f" ([Shot {number}] {role})"
            return f" (appears in [Shot {number}])"
        if track == "cues" and shot.start <= start < shot.end:
            return f" (heard in [Shot {number}])"
    return ""


def _count(shots: int) -> str:
    words = {1: "one-shot", 2: "two-shot", 3: "three-shot", 4: "four-shot", 5: "five-shot"}
    return words.get(shots, f"{shots}-shot")


def _join(parts: list[str]) -> str:
    if len(parts) == 1:
        return parts[0]
    return f"{', '.join(parts[:-1])} and {parts[-1]}"


def _description(timeline: Timeline, style_apart: bool = False) -> str:
    """The main body: every shot in playback order, camera and sound written into it.

    `style_apart` puts the global prompt on its own line above `[Shot 1]` instead of at the
    head of it -- the full-reference dialect's shape (§5.2). The base guide asks for the
    opposite, so which one is right depends only on which format is being written.
    """
    tokens = attachments.tokens_by_segment(timeline)
    described = _in_frame(timeline)
    voices = _voices(timeline)
    shots = timeline.ordered_shots()
    moves = timeline.ordered_moves()
    cues = timeline.ordered_cues()

    parts: list[str] = []
    preamble = timeline.global_prompt.strip()

    for number, shot in enumerate(shots, start=1):
        # A line the shot before left open, and whether there is anywhere for this shot's
        # own open line to continue into. Neither is knowable from inside a shot.
        carried = number > 1 and shots[number - 2].carries_over()
        here = list(tokens.get(("shots", shot.start), []))
        # A subject written over somebody belongs in the shot that somebody is in: its own
        # file sits in the clip rather than on a block, so nothing else would name it, and
        # a replacement the body never mentions is one the frame never shows.
        #
        # It goes *before* the author's sentence, not after it. The working example opens
        # its shot with the incoming identity in the original's place; appended at the end,
        # the frame was drawn as the original man for a whole sentence, and the swap read
        # as an afterthought to a scene already described without it.
        opens = []
        for incoming, receiver in _receivers(timeline).values():
            if receiver.token in here and incoming.token not in here:
                opens.append(incoming.token)
        body = _with_tokens(
            shot.text(voices, carried=carried, cutoff=number == len(shots)),
            here, described)
        if opens:
            body = " ".join(
                [_sentence(f"{token}, {described[token]}") for token in opens]
                + ([body] if body else []))
        camera = " ".join(move.text() for move in _moves_in(moves, shot) if move.text())
        # A cue covering the shot end to end is the video's ambience and belongs to
        # `overall_soundscape`; written here as well, the author's room tone was sent twice.
        heard = []
        for cue in _cues_in(cues, shot):
            if _is_ambient(cue, shots):
                continue
            said = _cue_text(cue, tokens)
            # A recording with nothing typed on it compiles to its own token. When the
            # shot's own prose already points at that recording -- "following the words of
            # <Audio 1>" -- appending it again put a bare `<Audio 1>.` after the sentence
            # and said nothing the model did not already have.
            if said and said.strip() in body:
                continue
            if said:
                heard.append(_sentence(said))
        sound = " ".join(heard)

        if number == 1:
            # The guide puts style and initial composition at the head of Shot 1, and
            # gives that shot no timestamp.
            opening = body if style_apart or not preamble else f"{preamble} {body}".strip()
            parts.append(f"[Shot 1] {opening}".rstrip())
        else:
            # The author's words go in verbatim. Lowercasing the opening word would read
            # better after "cuts to", but "A single apple" and "Anna turns" are the same
            # shape to any rule, and quietly renaming a character is the worse mistake.
            cut = _timecode(shot.start, timeline.fps)
            parts.append(f"[Shot {number}] At {cut}, {shot.opener()} {body}")

        for addition in (camera, sound):
            if addition:
                parts[-1] = f"{_sentence(parts[-1])} {addition}"

        # Close the shot before the next `[Shot n]` opens. A camera note is written as a
        # continuation of the sentence before it, so it usually arrives without a stop of
        # its own -- and left open it ran straight into the next shot marker. A shot with
        # nothing in it is left alone: `[Shot 1].` is punctuation around an absence.
        if body or camera or sound:
            parts[-1] = _sentence(parts[-1])

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

    body = " ".join(parts)
    # Its own line, not its own sentence run together with the first shot: the guide's
    # example puts a newline between them, and `[Shot 1]` has to open a line to be found.
    return f"{_sentence(preamble)}\n{body}" if style_apart and preamble else body


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


def _is_ambient(cue, shots) -> bool:
    """Sound belonging to the whole video rather than to a moment in it.

    The base guide, §4.6, wants the full video's ambience in `overall_soundscape` and
    reserves `N/A` for silence the author explicitly asked for. Only a cue running under
    *every* shot is that ambience. A cue covering one shot of several is still timed --
    measured 2026-08-05, a bell chime sent to `overall_soundscape` landed on the cuts,
    because that field carries no timing at all -- so it stays in the shot it covers.
    """
    if not shots:
        return True
    if all(cue.start <= shot.start
           and cue.start + cue.length >= shot.start + shot.length
           for shot in shots):
        return True
    # Otherwise it is ambience only if it belongs to no single shot: one that sits inside
    # a shot is timed, and timing exists there and nowhere else.
    return not any(cue in _cues_in([cue], shot) for shot in shots)


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

    lines = [_cue_text(cue, tokens) for cue in timeline.ordered_cues()
             if _is_ambient(cue, shots)]
    return " ".join(_sentence(line) for line in lines if line)


def _moves_in(moves: list[Move], shot: Shot) -> list[Move]:
    """Camera work that overlaps this shot, so it is written inside it."""
    return [move for move in moves if move.start < shot.end and move.end > shot.start]


def _lands_in(move: Move, shots: list[Shot]) -> bool:
    return any(move.start < shot.end and move.end > shot.start for shot in shots)


def _voices(timeline: Timeline) -> dict[int, str] | None:
    """What to print before each speaker's `(Sx)`.

    A description for a speaker no reference defines, and the subject's own token for one
    that a file does: the guide asks for `<Subject 1> (S1) says: ...` when the subject on
    screen is the one talking, so that the picture and the voice are known to be the same
    person rather than two things that happen to be in the same shot.
    """
    voices = timeline.voices()
    if voices is None:
        return None

    for number, subject in attachments.bound(timeline).items():
        voices[number] = subject.token
    return voices


def _timecode(frame: int, fps: int) -> str:
    """`00:03.500` -- the cut-time format the guide specifies."""
    seconds = frame / fps
    return f"{int(seconds // 60):02d}:{seconds % 60:06.3f}"


def _sentence(text: str) -> str:
    """Close a fragment so the next one does not run into it.

    `</d>` counts as closed. The full stop lives inside the tag with the words, where the
    author typed it, and the guide forbids touching what is in there -- so a second one
    outside leaves `</d>.` in the prompt.
    """
    stripped = text.rstrip()
    ended = stripped.endswith((".", "!", "?", ":", ";", "</d>"))
    return stripped if ended else f"{stripped}."


def _in_frame(timeline: Timeline) -> dict[str, str]:
    """What to say about each subject where it appears in the body.

    A subject brought in over somebody else says so here too: the working example repeats
    the replacement at every beat rather than stating it once in `retention_analysis`.
    """
    pairs = _receivers(timeline)
    said: dict[str, str] = {}
    for subject in attachments.subjects(timeline):
        name = subject.name.rstrip(".")
        if subject.token in pairs:
            _, receiver = pairs[subject.token]
            said[subject.token] = (
                f"{name}, replaces {receiver.token}'s "
                f"{_region(subject, bare=True)} and is mapped onto the same head, in the "
                f"same position and framing, at every moment")
        else:
            said[subject.token] = name
    return said


def _with_tokens(text: str, tokens: list[str], described: dict[str, str] | None = None) -> str:
    """Make sure a segment's line names the files attached to it, and says what they are.

    A file dropped on a shot is meant to be used in that shot, and H3 only uses a
    reference if the prose points at it. Rather than making the author remember to type
    `<Picture 1>`, the token is appended where it is missing -- and left alone where they
    have already placed it deliberately.

    The token alone is not enough. §5.3: "At the first clear appearance of an important
    `<Subject N>`, describe its referenced characteristics, position in the frame, and
    current action" -- and the guide's own example writes every subject as
    `<Subject 3> (S1), the young woman with long blonde hair ..., sits on the sofa`. A bare
    `<Subject 2>.` at the end of the line is the label without any of that, in the section
    that draws the frame.
    """
    missing = [token for token in tokens if token.lower() not in text.lower()]
    if not missing:
        return text
    described = described or {}
    joined = " ".join(
        _sentence(f"{token}, {described[token]}") if described.get(token) else token
        for token in missing)
    # Closed first, or the author's sentence and the tokens read as one phrase: "cuts to
    # second one pmpt <Subject 1>" says the prompt describes the subject. The dialogue path
    # closes it on the way past, so without this the same shot was punctuated one way with
    # a speaking cast and another way with a silent one.
    return f"{_sentence(text)} {joined}" if text else joined
