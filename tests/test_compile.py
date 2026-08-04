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
