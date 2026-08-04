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
