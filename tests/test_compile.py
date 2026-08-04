"""What reaches the text encoder is the whole product. These tests pin it down."""

from pathlib import Path

import pytest

from minimax_director import Timeline, compile_timeline

GOLDEN = Path(__file__).parent / "golden"


def build(**overrides):
    document = {
        "global_prompt": "Neon-lit alley after rain, cyan and magenta signage, 35mm grain.",
        "shots": [
            {
                "start": 0,
                "length": 24,
                "prompt": "Wide shot of the alley, puddles holding the sign reflections.",
                "camera": "dolly_in",
            },
            {
                "start": 24,
                "length": 36,
                "prompt": "Close on <Picture 1>, rain beading on the collar.",
            },
        ],
    }
    document.update(overrides)
    return Timeline.from_dict(document)


def test_timeline_dialect_matches_golden():
    compiled = compile_timeline(build())
    assert compiled.prompt == (GOLDEN / "alley_timeline.txt").read_text().strip()


def test_shots_dialect_matches_golden():
    compiled = compile_timeline(build(dialect="shots"))
    assert compiled.prompt == (GOLDEN / "alley_shots.txt").read_text().strip()


def test_length_is_snapped_up_from_the_last_shot():
    compiled = compile_timeline(build())
    assert compiled.length == 73  # last shot ends at 60; 73 is the next valid length
    assert compiled.duration == pytest.approx(73 / 24)


def test_camera_becomes_prose_not_an_enum():
    compiled = compile_timeline(build())
    assert "The camera dollies slowly in." in compiled.prompt
    assert "dolly_in" not in compiled.prompt


def test_unknown_camera_passes_through_untouched():
    timeline = build(
        shots=[{"start": 0, "length": 24, "prompt": "A face.", "camera": "vertigo pull"}]
    )
    assert "vertigo pull" in compile_timeline(timeline).prompt


def test_shots_are_ordered_by_time_not_by_edit_order():
    timeline = build(
        shots=[
            {"start": 24, "length": 24, "prompt": "second"},
            {"start": 0, "length": 24, "prompt": "first"},
        ]
    )
    prompt = compile_timeline(timeline).prompt
    assert prompt.index("first") < prompt.index("second")


def test_audio_cues_get_their_own_block():
    timeline = build(cues=[{"start": 0, "length": 48, "prompt": "Distant siren, then rain."}])
    prompt = compile_timeline(timeline).prompt
    assert "Audio:\n[0s-2s] Distant siren, then rain." in prompt


def test_empty_shots_are_dropped_rather_than_emitted_blank():
    timeline = build(shots=[{"start": 0, "length": 24, "prompt": "   "}])
    assert "Timeline:" not in compile_timeline(timeline).prompt


def test_an_empty_timeline_compiles_to_an_empty_prompt():
    compiled = compile_timeline(Timeline())
    assert compiled.prompt == ""
    assert compiled.length == 5


def test_compilation_is_deterministic():
    first = compile_timeline(build()).prompt
    second = compile_timeline(build()).prompt
    assert first == second


def test_round_trip_through_json_changes_nothing():
    original = build()
    restored = Timeline.from_json(original.to_json())
    assert compile_timeline(restored).prompt == compile_timeline(original).prompt


def test_a_fifty_shot_timeline_stays_on_the_lattice():
    shots = [
        {"start": index * 12, "length": 12, "prompt": f"beat {index}"}
        for index in range(50)
    ]
    compiled = compile_timeline(build(shots=shots))
    assert compiled.length % 17 == 5
    assert compiled.length >= 600


def test_camera_moves_get_their_own_block():
    timeline = build(moves=[{"start": 0, "length": 24, "camera": "dolly_in"}])
    assert "Camera:\n[0s-1s] The camera dollies slowly in." in compile_timeline(timeline).prompt


def test_a_move_combines_its_camera_and_its_note():
    timeline = build(moves=[{"start": 0, "length": 24, "camera": "orbit", "prompt": "around the sign"}])
    assert "The camera orbits the subject. around the sign" in compile_timeline(timeline).prompt


def test_moves_extend_the_clip_like_any_other_track():
    timeline = build(shots=[], moves=[{"start": 0, "length": 60, "camera": "pan_left"}])
    assert compile_timeline(timeline).length == 73


def test_empty_moves_are_dropped():
    timeline = build(moves=[{"start": 0, "length": 24, "camera": "", "prompt": "  "}])
    assert "Camera:" not in compile_timeline(timeline).prompt


def test_blocks_are_ordered_shots_camera_then_audio():
    timeline = build(
        moves=[{"start": 0, "length": 24, "camera": "orbit"}],
        cues=[{"start": 0, "length": 24, "prompt": "rain"}],
    )
    prompt = compile_timeline(timeline).prompt
    assert prompt.index("Timeline:") < prompt.index("Camera:") < prompt.index("Audio:")


def test_an_explicit_duration_overrides_the_content_length():
    timeline = build(duration=200)
    assert compile_timeline(timeline).length == 209  # 200 snapped up onto the lattice


def test_duration_zero_means_let_the_content_decide():
    assert compile_timeline(build(duration=0)).length == 73


def test_a_short_duration_still_lands_on_the_lattice():
    assert compile_timeline(build(duration=30)).length % 17 == 5


def test_a_render_window_crops_and_rebases_the_prompt():
    timeline = build(start=24, end=60)
    compiled = compile_timeline(timeline)
    assert "Wide establishing shot" not in compiled.prompt  # ends at 24, outside
    assert "[0s-1.5s] Close on <Picture 1>" in compiled.prompt  # rebased to zero
    assert compiled.length == 39  # 36 frames snapped up


def test_a_window_clips_a_shot_that_straddles_its_edge():
    timeline = build(start=12, end=36)
    compiled = compile_timeline(timeline)
    assert "[0s-0.5s]" in compiled.prompt  # first shot, cropped to 12 frames
    assert compiled.length == 39


def test_no_window_leaves_the_prompt_untouched():
    assert compile_timeline(build(start=0, end=0)).prompt == compile_timeline(build()).prompt


def test_the_window_length_is_always_on_the_lattice():
    for start in range(0, 40, 7):
        for end in range(start + 5, start + 60, 11):
            assert compile_timeline(build(start=start, end=end)).length % 17 == 5


def test_end_is_always_start_plus_length():
    for start in (0, 12, 40):
        for duration in (0, 30, 124):
            timeline = build(start=start, duration=duration)
            first, last = timeline.window
            assert last - first == timeline.length
            assert first == start


def test_an_end_in_the_document_is_read_as_a_duration():
    from_end = Timeline.from_dict({"start": 24, "end": 72, "shots": []})
    assert from_end.duration == 48
    assert from_end.window == (24, 24 + 56)  # 48 snapped up to 56


def test_duration_wins_when_both_are_given():
    both = Timeline.from_dict({"start": 0, "end": 200, "duration": 48, "shots": []})
    assert both.duration == 48


def test_end_is_not_stored():
    assert "end" not in build(start=10, duration=60).to_dict()


def test_advancing_moves_the_window_to_the_next_piece():
    timeline = build(duration=124)          # a 124-frame window from zero
    following = timeline.advanced()
    assert timeline.window == (0, 124)
    assert following.window == (124, 248)
    assert following.duration == 124        # the window keeps its size


def test_overlap_starts_the_next_window_inside_the_previous_one():
    following = build(duration=124).advanced(overlap=6)
    assert following.start == 118


def test_advancing_preserves_the_document():
    timeline = build(duration=124)
    following = timeline.advanced()
    assert following.shots == timeline.shots
    assert following.global_prompt == timeline.global_prompt


def test_exhausted_reports_when_the_content_has_run_out():
    shots = [{"start": 0, "length": 300, "prompt": "long"}]
    timeline = build(shots=shots, duration=124)
    assert not timeline.exhausted                       # 0..124
    assert not timeline.advanced().exhausted            # 124..248
    assert not timeline.advanced().advanced().exhausted  # 248..372, still inside 300
    assert timeline.advanced().advanced().advanced().exhausted  # starts at 372


def test_windows_tile_the_whole_timeline():
    shots = [{"start": 0, "length": 400, "prompt": "long"}]
    timeline = build(shots=shots, duration=124)
    covered, guard = [], 0
    while not timeline.exhausted and guard < 20:
        covered.append(timeline.window)
        timeline = timeline.advanced()
        guard += 1
    assert covered[0][0] == 0
    assert all(b[0] == a[1] for a, b in zip(covered, covered[1:]))  # no gaps
    assert covered[-1][1] >= 400
