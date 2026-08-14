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


def test_official_format_matches_golden():
    compiled = compile_timeline(build())
    assert compiled.prompt == (GOLDEN / "alley_official.txt").read_text().strip()


def test_the_three_documented_fields_are_all_present():
    prompt = compile_timeline(build()).prompt
    assert prompt.startswith("integrated_multimodal_description: [Shot 1] ")
    assert "\n\noverall_soundscape: " in prompt
    assert "\n\nnon_diegetic_music: " in prompt


def test_the_first_shot_has_no_timestamp_and_later_ones_do():
    prompt = compile_timeline(build()).prompt
    assert "[Shot 1] At " not in prompt
    assert "[Shot 2] At 00:01.000, the camera cuts to " in prompt


def test_camera_work_is_written_into_the_shot_not_a_block_of_its_own():
    timeline = build(moves=[{"start": 0, "length": 24, "camera": "dolly_in"}])
    prompt = compile_timeline(timeline).prompt
    assert "Camera:" not in prompt
    body = prompt.split("overall_soundscape:")[0]
    assert "The camera pushes in with small amplitude at slow speed." in body


def test_music_is_na_when_unset_and_verbatim_when_set():
    assert "non_diegetic_music: N/A" in compile_timeline(build()).prompt
    scored = build(music="Sparse piano at a slow tempo.")
    assert "non_diegetic_music: Sparse piano at a slow tempo." in compile_timeline(scored).prompt


def test_the_authors_words_are_never_recapitalised():
    timeline = build(shots=[
        {"start": 0, "length": 24, "prompt": "first"},
        {"start": 24, "length": 24, "prompt": "Anna turns to the window."},
    ])
    assert "cuts to Anna turns to the window." in compile_timeline(timeline).prompt


def test_length_is_snapped_up_from_the_last_shot():
    compiled = compile_timeline(build())
    assert compiled.length == 73  # last shot ends at 60; 73 is the next valid length
    assert compiled.duration == pytest.approx(73 / 24)


def test_camera_becomes_prose_not_an_enum():
    compiled = compile_timeline(build())
    assert "The camera pushes in with small amplitude at slow speed." in compiled.prompt
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


def test_cues_become_the_soundscape_without_timestamps():
    """The field summarises the whole video; the guide gives it nowhere to put a time."""
    timeline = build(cues=[{"start": 0, "length": 48, "prompt": "Distant siren, then rain."}])
    prompt = compile_timeline(timeline).prompt
    assert "overall_soundscape: Distant siren, then rain." in prompt
    assert "[0s-2s]" not in prompt


def test_empty_shots_are_dropped_rather_than_emitted_blank():
    timeline = build(global_prompt="", shots=[{"start": 0, "length": 24, "prompt": "   "}])
    assert compile_timeline(timeline).prompt.startswith(
        "integrated_multimodal_description: [Shot 1]\n"
    )


def test_an_empty_timeline_compiles_to_the_bare_fields():
    compiled = compile_timeline(Timeline())
    assert compiled.prompt == (
        "integrated_multimodal_description: \n\n"
        "overall_soundscape: N/A\n\n"
        "non_diegetic_music: N/A"
    )
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


def test_a_move_combines_its_camera_and_its_note():
    timeline = build(moves=[{"start": 0, "length": 24, "camera": "orbit", "prompt": "around the sign"}])
    assert "The camera moves in an arc around the subject. around the sign" in compile_timeline(timeline).prompt


def test_moves_extend_the_clip_like_any_other_track():
    timeline = build(shots=[], moves=[{"start": 0, "length": 60, "camera": "pan_left"}])
    assert compile_timeline(timeline).length == 73


def test_empty_moves_are_dropped():
    timeline = build(
        global_prompt="", shots=[],
        moves=[{"start": 0, "length": 24, "camera": "", "prompt": "  "}],
    )
    assert compile_timeline(timeline).prompt.startswith(
        "integrated_multimodal_description: \n"
    )


def test_the_official_fields_are_ordered_body_soundscape_music():
    prompt = compile_timeline(build(cues=[{"start": 0, "length": 24, "prompt": "rain"}])).prompt
    assert (prompt.index("integrated_multimodal_description:")
            < prompt.index("overall_soundscape:")
            < prompt.index("non_diegetic_music:"))


def test_an_explicit_duration_sets_the_length_of_the_piece():
    timeline = build(duration=200)
    assert compile_timeline(timeline).length == 209  # 200 snapped up onto the lattice


def test_duration_zero_means_let_the_content_decide():
    assert compile_timeline(build(duration=0)).length == 73


def test_a_short_duration_still_lands_on_the_lattice():
    assert compile_timeline(build(duration=30)).length % 17 == 5


def test_a_cue_inside_one_shot_is_written_into_that_shot():
    """Timed sound belongs where timing exists.

    Measured 2026-08-05: a bell chime sent only to `overall_soundscape` was produced but
    landed on the video cuts, because that field carries no timing at all.
    """
    timeline = build(
        shots=[
            {"start": 0, "length": 24, "prompt": "The apple."},
            {"start": 24, "length": 24, "prompt": "The cube."},
        ],
        cues=[{"start": 0, "length": 24, "prompt": "One clear bell chime."}],
    )
    prompt = compile_timeline(timeline).prompt
    body = prompt.split("overall_soundscape:")[0]
    assert "The apple. One clear bell chime." in body
    assert "overall_soundscape: N/A" in prompt


def test_a_cue_spanning_several_shots_stays_ambience():
    timeline = build(
        shots=[
            {"start": 0, "length": 24, "prompt": "The apple."},
            {"start": 24, "length": 24, "prompt": "The cube."},
        ],
        cues=[{"start": 0, "length": 48, "prompt": "Quiet room tone."}],
    )
    prompt = compile_timeline(timeline).prompt
    assert "overall_soundscape: Quiet room tone." in prompt
    assert prompt.split("overall_soundscape:")[0].count("Quiet room tone") == 0


def test_a_cue_is_never_asked_for_twice():
    timeline = build(
        shots=[{"start": 0, "length": 24, "prompt": "The apple."}],
        cues=[{"start": 0, "length": 24, "prompt": "One clear bell chime."}],
    )
    assert compile_timeline(timeline).prompt.count("One clear bell chime") == 1


# -- pasted text -------------------------------------------------------------
#
# The compiled prompt uses newlines as structure: `subject_definitions` and
# `retention_analysis` are one entry per line, and the top-level fields are separated by a
# blank line. A paragraph pasted in from a document carries both, so every value somebody
# types is flattened on the way in.


def test_a_pasted_newline_never_reaches_the_prompt():
    timeline = build(
        global_prompt="Neon alley,\r\n\r\nrain everywhere.",
        shots=[{"start": 0, "length": 24, "prompt": "The apple\r\nturning.",
                "screen_text": "TWO\nWORDS"}],
        cues=[{"start": 0, "length": 24, "prompt": "One chime,\nthen silence."}],
        moves=[{"start": 0, "length": 24, "camera": "static", "prompt": "held\n still"}],
    )
    body = compile_timeline(timeline).prompt.split("overall_soundscape:")[0]
    assert "\r" not in body
    assert "The apple turning." in body
    assert "\n" not in body.split("detailed_description:")[-1].rstrip("\n")


def test_a_pasted_newline_never_splits_a_subject_definition():
    timeline = build(
        shots=[{"start": 0, "length": 24, "prompt": "A raccoon.",
                "media": {"kind": "image", "filename": "a.png", "role": "reference",
                          "retention": "fully_preserved",
                          "description": "the raccoon:\r\ngrey fur, a ringed tail"}}],
    )
    prompt = compile_timeline(timeline).prompt
    definitions = prompt.split("subject_definitions:\n")[1].split("\n\n")[0]
    assert definitions.count("\n") == 0
    assert definitions == "<Picture 1> is the raccoon: grey fur, a ringed tail."


def test_a_pasted_newline_never_breaks_a_dialogue_tag():
    timeline = build(
        shots=[{"start": 0, "length": 24, "prompt": "The apple.",
                "lines": [{"ids": "S1", "delivery": "says", "language": "English",
                           "text": "Line one.\r\nLine two."}]}],
        speakers=[{"id": 1, "voice": "A dry voice,\nclose to the microphone"}],
    )
    prompt = compile_timeline(timeline).prompt
    assert "<d>[English] Line one. Line two.</d>" in prompt
    assert "A dry voice, close to the microphone (S1) says" in prompt
