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
from .timeline import FRAME_ROLES, RETENTIONS, ROLE_TASKS, Move, Shot, Timeline


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

    Nothing is emitted for a timeline with references: that path routes to
    `MiniMaxH3ReferenceToVideo`, which has no keyframe inputs to align to.
    """
    if not (first or last) or attachments.collect(timeline):
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
        f"detailed_description: {_description(timeline)}",
        f"overall_soundscape: {_soundscape(timeline) or 'N/A'}",
        f"non_diegetic_music: {timeline.music.strip() or 'N/A'}",
    ]
    return "\n\n".join(fields)


def _subject_definitions(timeline: Timeline) -> str:
    """One line per attached file: what its token denotes and what to follow.

    An attachment with nothing written about it still gets a line. A missing definition
    would leave a token referenced in the body and defined nowhere, which the guide calls
    out as an error; a thin line at least keeps the document consistent, and `lint` says
    what is missing.
    """
    lines = []
    for item in attachments.collect(timeline):
        described = _described(item)
        lines.append(f"{item.token} is {described}.")
    for subject in attachments.subjects(timeline):
        # Provenance named on the subject's own line, which is what the guide asks for
        # when a picture is only there to supply something else.
        lines.append(f"{subject.token} is {subject.name.rstrip('.')}, from {subject.source}.")
    return "\n".join(lines)


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
        role = str(item.record.get("role", "")).strip()
        marker = _retention(item)
        if item.kind == "audio":
            # The two audio types are the same distinction the retention marker already
            # draws: copied, or merely alluded to.
            found.add("audio reuse" if marker == "fully_preserved" else "audio reference")
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
    tokens = [item.token for item in attachments.collect(timeline)]
    shots = len(timeline.ordered_shots())
    scene = timeline.global_prompt.strip().rstrip(".")

    opening = f"[{_task_types(timeline)}] A {_count(shots)} clip"
    if scene:
        opening += f" of {scene[0].lower()}{scene[1:]}"
    if tokens:
        opening += f", generated with reference to {_join(tokens)}"
    return f"{opening}."


def _retention_analysis(timeline: Timeline) -> str:
    """One line per token: where it appears, how much of it survives, and why."""
    lines = []
    for item in attachments.collect(timeline):
        marker = _retention(item)
        where = _appears_in(timeline, item)
        lines.append(f"{item.token}{where}: {marker} - {_described(item)}.")
    for subject in attachments.subjects(timeline):
        where = _appears_in(timeline, subject)
        lines.append(
            f"{subject.token}{where}: {_retention(subject)} - {subject.name.rstrip('.')}.")
    return "\n".join(lines)


def _described(item) -> str:
    """What the author said this reference is, or the filename as a last resort."""
    described = str(item.record.get("description", "")).strip().rstrip(".")
    if described:
        return described
    name = str(item.record.get("filename", "")).strip()
    return f"the {item.kind} in {name}" if name else f"an unnamed {item.kind} reference"


def _retention(item) -> str:
    """The marker for this token.

    A subject gets its own: the picture may be fully preserved as a frame while the face
    lifted out of it is an `attribute_transfer` onto somebody else. Absent, it falls back
    to the file's, which is the answer for the ordinary case where they agree.
    """
    key = "subject_retention" if isinstance(item, attachments.Subject) else "retention"
    marker = str(item.record.get(key, "")).strip()
    if marker not in RETENTIONS and key == "subject_retention":
        marker = str(item.record.get("retention", "")).strip()
    return marker if marker in RETENTIONS else RETENTIONS[0]


def _appears_in(timeline: Timeline, item) -> str:
    """`(appears in [Shot 2])`, or `([Shot 1] first frame)` for a concrete frame anchor.

    A reference video's own soundtrack has no origin of its own -- it belongs to the video
    rather than to a block on the timeline -- so it gets no shot list.
    """
    if item.origin is None:
        return ""
    role = str(item.record.get("role", "")).strip()
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


def _description(timeline: Timeline) -> str:
    """The main body: every shot in playback order, camera and sound written into it."""
    tokens = attachments.tokens_by_segment(timeline)
    voices = _voices(timeline)
    shots = timeline.ordered_shots()
    moves = timeline.ordered_moves()
    cues = timeline.ordered_cues()

    parts: list[str] = []
    preamble = timeline.global_prompt.strip()

    for number, shot in enumerate(shots, start=1):
        body = _with_tokens(shot.text(voices), tokens.get(("shots", shot.start), []))
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
