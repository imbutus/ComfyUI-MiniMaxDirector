"""The linter exists to turn a wasted ten-minute generation into a one-second warning."""

from minimax_director import Reference, Timeline, lint


def levels(timeline):
    return [(issue.level, issue.message) for issue in lint(timeline)]


def messages(timeline):
    return " ".join(message for _, message in levels(timeline))


def test_a_token_with_nothing_wired_is_an_error():
    timeline = Timeline(global_prompt="Use <Picture 1> as the hero frame.")
    assert "error" in [level for level, _ in levels(timeline)]
    assert "<Picture 1> is used in the prompt but nothing is connected" in messages(timeline)


def test_a_wired_input_nobody_mentions_is_a_warning():
    timeline = Timeline(
        global_prompt="A quiet room.",
        references=[Reference("picture", 1)],
    )
    reported = levels(timeline)
    assert ("warning", "<Picture 1> is connected but never mentioned; the model will most likely ignore it.") in reported


def test_a_matched_pair_reports_nothing_about_references():
    timeline = Timeline(
        global_prompt="Hold <Picture 1> as the establishing frame.",
        references=[Reference("picture", 1)],
    )
    assert "<Picture 1>" not in messages(timeline)


def test_a_file_on_a_block_is_never_reported_as_unmentioned():
    """The director registers every attached file as a reference before it lints.

    The compiler appends the block's token to its own line, so the model is pointed at the
    file whether or not the author typed the token. Reporting it as ignored was a warning
    every run produced and no author could act on.
    """
    timeline = Timeline.from_dict(
        {
            "global_prompt": "A quiet room.",
            "shots": [
                {"start": 0, "length": 30, "prompt": "He waits.",
                 "media": {"kind": "image", "filename": "face.png"}},
            ],
        }
    ).with_references([Reference("picture", 1)])
    assert "never mentioned" not in messages(timeline)


def test_a_token_for_a_file_on_a_block_is_not_an_error():
    """The editor lints with nothing wired, so the block itself has to answer for it."""
    timeline = Timeline.from_dict(
        {
            "global_prompt": "Hold on <Picture 1>.",
            "shots": [
                {"start": 0, "length": 30, "prompt": "He waits.",
                 "media": {"kind": "image", "filename": "face.png"}},
            ],
        }
    )
    assert "nothing is connected" not in messages(timeline)


def test_tokens_are_matched_case_insensitively():
    timeline = Timeline(
        global_prompt="Reuse <picture 1>.",
        references=[Reference("picture", 1)],
    )
    assert "<Picture 1>" not in messages(timeline)


def test_overlapping_shots_are_reported():
    timeline = Timeline.from_dict(
        {
            "global_prompt": "x",
            "shots": [
                {"start": 0, "length": 30, "prompt": "a"},
                {"start": 20, "length": 30, "prompt": "b"},
            ],
        }
    )
    assert "Shots overlap between frames 20 and 30." in messages(timeline)


def test_a_hole_in_the_shot_list_is_reported():
    timeline = Timeline.from_dict(
        {
            "global_prompt": "x",
            "shots": [
                {"start": 0, "length": 10, "prompt": "a"},
                {"start": 30, "length": 10, "prompt": "b"},
            ],
        }
    )
    assert "Gap of 20 frames before the shot at frame 30." in messages(timeline)


def test_lattice_padding_is_explained_rather_than_silent():
    timeline = Timeline.from_dict(
        {"global_prompt": "x", "shots": [{"start": 0, "length": 60, "prompt": "a"}]}
    )
    assert "padded by 13 frames" in messages(timeline)


def test_a_clip_longer_than_its_content_is_reported():
    timeline = Timeline.from_dict({
        "global_prompt": "x", "duration": 248,
        "shots": [{"start": 0, "length": 124, "prompt": "a"}],
    })
    assert "runs 124 frames (5.17s) past the last shot" in messages(timeline)


def test_an_empty_timeline_is_an_error():
    assert ("error", "The timeline is empty.") in levels(Timeline())


def test_errors_are_listed_before_warnings():
    timeline = Timeline(
        global_prompt="Use <Picture 2>.",
        references=[Reference("picture", 1)],
    )
    reported = [level for level, _ in levels(timeline)]
    assert reported == sorted(reported, key=lambda level: level != "error")
    assert reported[0] == "error"


def test_linting_never_raises_on_malformed_input():
    timeline = Timeline.from_dict(
        {"shots": [{"start": -5, "length": 0, "prompt": ""}], "cues": [{"prompt": ""}]}
    )
    assert lint(timeline)


def test_an_exact_window_reports_no_tail():
    timeline = Timeline.from_dict({
        "global_prompt": "x", "duration": 124,
        "shots": [{"start": 0, "length": 124, "prompt": "a"}],
    })
    assert "past the last shot" not in messages(timeline)
    assert "padded by" not in messages(timeline)


def test_padding_is_reported_on_its_own():
    timeline = Timeline.from_dict(
        {"global_prompt": "x", "shots": [{"start": 0, "length": 60, "prompt": "a"}]}
    )
    assert "padded by 13 frames" in messages(timeline)
    assert "past the last shot" not in messages(timeline)


def test_a_source_nothing_points_at_is_reported():
    """A source has no block to name it, so the prose or a card has to.

    H3 only uses a reference the prompt points at, and a file with neither a mention nor
    a card is one the model is handed and told nothing about.
    """
    timeline = Timeline.from_dict({
        "global_prompt": "A quiet room.",
        "shots": [{"start": 0, "length": 30, "prompt": "He waits."}],
        "sources": [{"kind": "image", "filename": "face.jpg"}],
    })
    assert "<Picture 1> (face.jpg) is a source file" in messages(timeline)


def test_a_source_the_prose_names_is_not_reported():
    timeline = Timeline.from_dict({
        "global_prompt": "Everything in the manner of <Picture 1>.",
        "shots": [{"start": 0, "length": 30, "prompt": "He waits."}],
        "sources": [{"kind": "image", "filename": "face.jpg"}],
    })
    assert "is a source file" not in messages(timeline)


def test_a_source_clip_nothing_points_at_is_reported_but_its_soundtrack_is_not():
    """The clip answers for both halves of itself.

    A video's soundtrack is spoken for by the video it belongs to, so warning about it
    separately is one file reported twice under two tokens -- and only one of them is
    something the author can act on.
    """
    timeline = Timeline.from_dict({
        "global_prompt": "A quiet room.",
        "shots": [{"start": 0, "length": 30, "prompt": "He waits."}],
        "sources": [{"kind": "video", "filename": "walk.mp4"}],
    })
    reported = messages(timeline)
    assert "<Video 1> (walk.mp4) is a source file" in reported
    assert "<Audio 1> (walk.mp4) is a source file" not in reported


def carried(onto):
    """Take 1's shape: the speaker's card hangs off shot 1, the line is on shot 2.

    Shot 2 carries a face lifted out of its own photograph, and `onto` says whose face it
    becomes. With the box filled in the document already states that this person is the
    one on screen; with it empty nothing does, and the warning is the only thing that
    would tell the author the model is about to guess.
    """
    return Timeline.from_dict({
        "global_prompt": "A press room.",
        "speech": True,
        "speakers": [{"id": 1, "voice": "A man in his forties", "name": "SPEAKER",
                      "uid": "u-speaker"}],
        "shots": [
            {"start": 0, "length": 24, "prompt": "He sits at the desk.",
             "media": {"kind": "image", "filename": "one.png", "subjects": [
                 {"name": "the man in the navy suit", "uid": "u-speaker"}]}},
            {"start": 24, "length": 24, "prompt": "The same man, still speaking.",
             "media": {"kind": "image", "filename": "two.jpg", "subjects": [
                 {"name": "the face", "retention": "attribute_transfer", "onto": onto}]},
             "lines": [{"text": "This face was never in the room.", "ids": "S1"}]},
        ],
    })


def test_a_speaker_from_another_shot_is_reported():
    assert "attached to a different shot" in messages(carried(""))


def test_a_face_carried_onto_the_speaker_answers_for_them():
    assert "attached to a different shot" not in messages(carried("SPEAKER"))


def _swap_document(*, with_video: bool):
    """A face and a voice asked to replace somebody, with and without a reference video.

    The failing shape from 2026-08-31: a still supplies a face, an mp3 supplies a timbre,
    and a reference video supplies the person they are meant to replace.
    """
    shot = {
        "start": 0, "length": 90,
        "prompt": "<Subject 1> stands in a concrete yard with a phone at his ear.",
        "lines": [{"text": "It's done.", "ids": "S1"}],
        "media": {"kind": "video", "filename": "clip.mp4", "role": "reference",
                  "retention": "partially_preserved"},
    }
    if not with_video:
        shot["media"] = {"kind": "image", "filename": "face.png", "role": "reference",
                         "retention": "fully_preserved"}
    timeline = {
        "duration": 90, "speech": True, "global_prompt": "A concrete yard.",
        "shots": [shot],
        "cues": [{"start": 0, "length": 90, "prompt": "A recording of the voice.",
                  "media": {"kind": "audio", "filename": "voice.mp3", "role": "reference",
                            "retention": "reference", "description": "a voice recording"}}],
        "sources": ([{"kind": "image", "filename": "face.png", "role": "reference",
                      "retention": "attribute_transfer"}] if with_video else []),
    }
    cards = {"cards": [
        {"id": 1, "uid": "c1", "name": "MAN", "file": "face.png",
         "description": "the face and head",
         "keep": "attribute_transfer" if with_video else "fully_preserved",
         "onto": "SCENE" if with_video else "",
         "voice": "a low gravelly man", "voice_from": "voice.mp3"},
    ]}
    if with_video:
        cards["cards"].append(
            {"id": 2, "uid": "c2", "name": "SCENE", "file": "clip.mp4",
             "description": "the framing, the backdrop and the choreography",
             "keep": "partially_preserved", "onto": "", "voice": ""})
    from minimax_director import cast
    return Timeline.from_dict(cast.merge(timeline, cards))


def test_a_transfer_against_a_reference_video_is_warned_about():
    """Eight renders said the video wins, so the linter says so before the GPU is booked."""
    reported = messages(_swap_document(with_video=True))
    assert "a reference video wins that" in reported
    assert "describe its scene and action in the prompt" in reported


def test_a_voice_reference_against_a_reference_video_is_warned_about():
    reported = messages(_swap_document(with_video=True))
    assert "A voice reference is set while <Video 1> is attached" in reported
    assert "outweighs the recording" in reported


def test_neither_warning_fires_without_a_reference_video():
    """The shape that was verified to work must lint clean, or the warning is noise."""
    reported = messages(_swap_document(with_video=False))
    assert "reference video wins" not in reported
    assert "A voice reference is set while" not in reported


def test_the_editor_says_the_same_two_sentences_as_the_linter():
    """One problem said once. The report and the card must not phrase it differently.

    `attachments.missing_sentence` exists for the same reason: three phrasings of one
    problem read as three problems. The linter is Python and the card is JavaScript, so
    nothing but this test holds the two ends together.
    """
    from pathlib import Path

    card = (Path(__file__).resolve().parents[1] / "web" / "timeline" / "cast.js").read_text()
    reported = messages(_swap_document(with_video=True))
    for phrase in (
        "is carried onto what",
        "and a reference video wins that: measured over eight renders, the face in",
        "the video came back every time whatever the retention said. Take the video off the",
        "timeline and describe its scene and action in the prompt.",
        "A voice reference is set while",
        "A reference video's own soundtrack rides along with it and outweighs",
        "the recording",
        "Take the video off the",
        "timeline, or let the video supply the voice and clear",
    ):
        assert phrase in card, f"cast.js has drifted from the linter: {phrase!r}"
        assert phrase.replace("  ", " ") in reported.replace("  ", " ") or phrase in reported
