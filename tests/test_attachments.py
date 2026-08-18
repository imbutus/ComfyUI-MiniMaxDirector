"""Files on the timeline decide their own reference numbers."""

from minimax_director import Timeline, compile_timeline
from minimax_director.attachments import collect, of_kind, tokens_by_segment


def image(name):
    return {"kind": "image", "filename": name, "subfolder": ""}


def audio(name):
    return {"kind": "audio", "filename": name, "subfolder": ""}


def video(name):
    return {"kind": "video", "filename": name, "subfolder": ""}


def build(**parts):
    document = {"global_prompt": "g", "shots": [], "cues": []}
    document.update(parts)
    return Timeline.from_dict(document)


def tokens(timeline):
    return [item.token for item in collect(timeline)]


def test_images_number_in_timeline_order():
    timeline = build(shots=[
        {"start": 48, "length": 24, "prompt": "second", "media": image("b.png")},
        {"start": 0, "length": 24, "prompt": "first", "media": image("a.png")},
    ])
    assert tokens(timeline) == ["<Picture 1>", "<Picture 2>"]
    assert [a.record["filename"] for a in of_kind(timeline, "image")] == ["a.png", "b.png"]


def test_moving_a_block_renumbers_its_reference():
    early = build(shots=[
        {"start": 0, "length": 24, "prompt": "x", "media": image("a.png")},
        {"start": 48, "length": 24, "prompt": "y", "media": image("b.png")},
    ])
    assert of_kind(early, "image")[0].record["filename"] == "a.png"

    late = build(shots=[
        {"start": 96, "length": 24, "prompt": "x", "media": image("a.png")},
        {"start": 48, "length": 24, "prompt": "y", "media": image("b.png")},
    ])
    assert of_kind(late, "image")[0].record["filename"] == "b.png"


def test_a_video_is_preceded_by_its_own_soundtrack():
    timeline = build(shots=[{"start": 0, "length": 24, "prompt": "v", "media": video("c.mp4")}])
    assert tokens(timeline) == ["<Audio 1>", "<Video 1>"]


def test_standalone_audio_continues_the_counter():
    timeline = build(
        shots=[{"start": 0, "length": 24, "prompt": "v", "media": video("c.mp4")}],
        cues=[{"start": 0, "length": 24, "prompt": "rain", "media": audio("r.mp3")}],
    )
    assert tokens(timeline) == ["<Audio 1>", "<Video 1>", "<Audio 2>"]


def test_the_prompt_names_an_attached_file_without_being_asked():
    timeline = build(shots=[
        {"start": 0, "length": 24, "prompt": "the alley", "media": image("a.png")},
    ])
    assert "the alley. <Picture 1>" in compile_timeline(timeline).prompt


def test_a_token_the_author_placed_is_not_repeated():
    """In the shot body. The reference sections name every token by design -- that is
    what `subject_definitions` and `retention_analysis` are for -- so the count is taken
    over the body alone, which is where a duplicate would read as two separate files."""
    timeline = build(shots=[
        {"start": 0, "length": 24, "prompt": "hold <Picture 1> steady", "media": image("a.png")},
    ])
    prompt = compile_timeline(timeline).prompt
    body = prompt.split("detailed_description:")[-1].split("overall_soundscape:")[0]
    assert body.count("<Picture 1>") == 1


def test_an_attached_audio_names_itself_in_the_audio_block():
    timeline = build(
        shots=[{"start": 0, "length": 24, "prompt": "x"}],
        cues=[{"start": 0, "length": 24, "prompt": "siren", "media": audio("r.mp3")}],
    )
    assert "siren. <Audio 1>" in compile_timeline(timeline).prompt


def test_segments_without_media_are_untouched():
    timeline = build(shots=[{"start": 0, "length": 24, "prompt": "plain"}])
    assert collect(timeline) == []
    assert "<Picture" not in compile_timeline(timeline).prompt


def test_tokens_map_back_to_their_segments():
    timeline = build(shots=[
        {"start": 0, "length": 24, "prompt": "x", "media": image("a.png")},
        {"start": 48, "length": 24, "prompt": "y", "media": image("b.png")},
    ])
    assert tokens_by_segment(timeline) == {
        ("shots", 0): ["<Picture 1>"], ("shots", 48): ["<Picture 2>"],
    }


def test_a_source_file_is_numbered_with_the_blocks_and_has_no_shot():
    """A file the whole clip carries: numbered like any other, with no `appears in`.

    Forcing such a file onto a block cut the clip in two at a seam nobody asked for --
    the model changes what it is doing on either side of one -- and the shot list said the
    face arrived halfway through, which is exactly what came back.
    """
    timeline = Timeline.from_dict({
        "duration": 96,
        "shots": [{"start": 0, "length": 96, "prompt": "He waits.",
                   "media": {"kind": "image", "filename": "him.png"}}],
        "sources": [{"kind": "image", "filename": "face.jpg",
                     "description": "the face in face.jpg"}],
    })
    found = collect(timeline)
    assert [(item.token, item.origin) for item in found] == [
        ("<Picture 1>", ("shots", 0)),
        ("<Picture 2>", None),
    ]
    prompt = compile_timeline(timeline).prompt
    assert "<Picture 2> (appears in" not in prompt
    assert "<Picture 2>: " in prompt or "<Picture 2> is" in prompt


def test_a_source_clip_is_numbered_with_the_blocks_clips_and_its_soundtrack_before_the_cues():
    """The order is the core node's, not a preference.

    `MiniMaxH3ReferenceToVideo` reads every reference video from one list and labels each
    soundtrack immediately before the video it was loaded beside. A source clip is wired
    into that same list after the blocks', so its `<Audio n>` falls there too -- ahead of
    a standalone cue, which the node emits last.
    """
    timeline = Timeline.from_dict({
        "duration": 96,
        "shots": [{"start": 0, "length": 48, "prompt": "The street.",
                   "media": {"kind": "video", "filename": "street.mp4"}}],
        "cues": [{"start": 0, "length": 48, "prompt": "Rain.",
                  "media": {"kind": "audio", "filename": "rain.mp3"}}],
        "sources": [{"kind": "video", "filename": "walk.mp4"}],
    })
    assert [(item.token, item.record["filename"], item.origin) for item in collect(timeline)] == [
        ("<Audio 1>", "street.mp4", None),
        ("<Video 1>", "street.mp4", ("shots", 0)),
        ("<Audio 2>", "walk.mp4", None),
        ("<Video 2>", "walk.mp4", None),
        ("<Audio 3>", "rain.mp3", ("cues", 0)),
    ]


def test_a_clip_on_the_audio_track_is_a_soundtrack_and_not_a_video():
    """The same file, two readings, decided by the track it was dropped on.

    On MAIN a clip is its pictures, with its own sound travelling beside them. On AUDIO it
    is the sound alone: the director hands the core node that clip's decoded soundtrack and
    none of its frames, so there is no `<Video n>` for the model to reproduce.
    """
    timeline = Timeline.from_dict({
        "duration": 96,
        "shots": [{"start": 0, "length": 96, "prompt": "He waits."}],
        "cues": [{"start": 0, "length": 96, "prompt": "The room he is in.",
                  "media": {"kind": "video", "filename": "room.mp4"}}],
    })
    assert [(item.token, item.origin) for item in collect(timeline)] == [
        ("<Audio 1>", ("cues", 0)),
    ]
    prompt = compile_timeline(timeline).prompt
    assert "<Audio 1>" in prompt
    assert "<Video 1>" not in prompt


def test_a_face_carried_onto_somebody_is_named_where_they_appear():
    """Take 1's shape: the photograph the face comes from sits on no block.

    Stated only in `retention_analysis`, the transfer was never asked for in the sentence
    that draws the frame -- the shot named the man and the room and nothing else, and the
    model kept the face it already had.
    """
    timeline = Timeline.from_dict({
        "speech": True,
        "speakers": [{"id": 1, "voice": "A man in his forties", "name": "SPEAKER",
                      "uid": "u-speaker"}],
        "shots": [{"start": 0, "length": 48, "prompt": "He sits at the desk.",
                   "media": {"kind": "image", "filename": "one.png", "subjects": [
                       {"name": "the man in the navy suit", "uid": "u-speaker"}]}}],
        "sources": [{"kind": "image", "filename": "two.jpg", "subjects": [
            {"name": "the face", "retention": "attribute_transfer", "onto": "SPEAKER"}]}],
    })
    assert tokens_by_segment(timeline)[("shots", 0)] == \
        ["<Subject 1>", "<Subject 2>"]


def test_a_subject_onto_nobody_is_named_only_where_its_own_file_is():
    timeline = Timeline.from_dict({
        "shots": [{"start": 0, "length": 48, "prompt": "He sits.",
                   "media": {"kind": "image", "filename": "one.png",
                             "subjects": [{"name": "the man"}]}}],
        "sources": [{"kind": "image", "filename": "two.jpg", "subjects": [
            {"name": "the face", "retention": "attribute_transfer"}]}],
    })
    assert tokens_by_segment(timeline)[("shots", 0)] == ["<Subject 1>"]
