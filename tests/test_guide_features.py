"""The parts of MiniMax's two guides the compiler learned after the first release.

Every assertion here quotes a rule from `VIDEO_PROMPT_WRITING_GUIDE_base_en.md` or
`..._ref_en.md` rather than a preference of ours: these are fixed forms in a format the
model was trained on, and an equivalent sentence is a worse sentence.
"""

import pytest

from minimax_director import Timeline, cast, compile_timeline
from minimax_director.lint import lint
from minimax_director.timeline import (
    AUDIO_RETENTIONS, CAMERA_MOTION, RETENTIONS, camera_sentence,
)


def clip(**overrides):
    document = {
        "global_prompt": "Live-action, cinematic.",
        "shots": [
            {"start": 0, "length": 24, "prompt": "A woman at a window."},
            {"start": 24, "length": 24, "prompt": "The street below."},
        ],
    }
    document.update(overrides)
    return Timeline.from_dict(document)


def body(timeline):
    """The shot list, whichever of the two formats this timeline compiles to."""
    prompt = compile_timeline(timeline).prompt
    field = ("detailed_description: " if "detailed_description: " in prompt
             else "integrated_multimodal_description: ")
    return prompt.split(field)[1].split("\n\noverall_soundscape:")[0]


# -- camera: motion type x amplitude x speed (base §4.3) ---------------------


def test_every_motion_type_in_the_guide_has_a_verb():
    """The guide's table, in full. A missing type is a move an author cannot ask for."""
    for name in ("zoom_in", "zoom_out", "dolly_in", "dolly_out", "pan_left", "pan_right",
                 "truck_left", "truck_right", "tilt_up", "tilt_down", "pedestal_up",
                 "pedestal_down", "orbit", "tracking", "pov", "roll_cw", "roll_ccw",
                 "static", "handheld", "shake_strongly"):
        assert CAMERA_MOTION[name], name


def test_amplitude_and_speed_are_written_in_the_guides_word_order():
    assert camera_sentence("dolly_in", "small", "slow") == (
        "The camera pushes in with small amplitude at slow speed.")
    assert camera_sentence("pan_right", "large", "fast") == (
        "The camera pans right with large amplitude at fast speed.")


def test_medium_and_normal_are_written_by_saying_nothing():
    """§4.3: "medium amplitude and normal speed are usually omitted"."""
    assert camera_sentence("dolly_in") == "The camera pushes in."
    assert camera_sentence("dolly_in", "small") == (
        "The camera pushes in with small amplitude.")


def test_a_static_shot_takes_neither():
    assert camera_sentence("static", "large", "fast") == "The camera holds a static shot."


def test_an_unknown_camera_value_is_passed_through_untouched():
    assert camera_sentence("drifts sideways past the door") == (
        "drifts sideways past the door")


def test_a_move_written_before_the_fields_existed_keeps_its_sentence():
    """`dolly_in` used to *mean* small and slow -- the sentence said so. Reading such a
    document with both fields empty would quietly change the instruction."""
    old = Timeline.from_dict(
        {"moves": [{"start": 0, "length": 24, "camera": "dolly_in"}]})
    assert old.moves[0].amplitude == "small"
    assert old.moves[0].speed == "slow"
    assert old.moves[0].text() == "The camera pushes in with small amplitude at slow speed."


def test_a_move_that_says_medium_out_loud_is_left_alone():
    fresh = Timeline.from_dict(
        {"moves": [{"start": 0, "length": 24, "camera": "dolly_in",
                    "amplitude": "", "speed": ""}]})
    assert fresh.moves[0].text() == "The camera pushes in."


# -- transitions and on-screen text (base §4.2, §4.5) -----------------------


def test_an_ordinary_cut_is_the_default_wording():
    assert "[Shot 2] At 00:01.000, the camera cuts to" in body(clip())


def test_a_requested_transition_replaces_it():
    timeline = clip(shots=[
        {"start": 0, "length": 24, "prompt": "A woman at a window."},
        {"start": 24, "length": 24, "prompt": "The street below.", "transition": "fade"},
    ])
    assert "[Shot 2] At 00:01.000, the shot fades to" in body(timeline)


def test_on_screen_text_is_quoted_verbatim():
    timeline = clip(shots=[
        {"start": 0, "length": 24, "prompt": "A shopfront.", "screen_text": "OPEN 24H"},
    ])
    assert 'The words "OPEN 24H" are visible on screen.' in body(timeline)


def test_quotes_the_author_typed_are_not_doubled():
    timeline = clip(shots=[
        {"start": 0, "length": 24, "prompt": "A shopfront.", "screen_text": '"营业中"'},
    ])
    assert 'The words "营业中" are visible on screen.' in body(timeline)


# -- voiceover, and dialogue across a cut (base §4.4) -----------------------


def speaking(**line):
    said = {"text": "I still remember that road.", "ids": "S1", "delivery": "says",
            "language": "English"}
    said.update(line)
    return clip(
        speech=True,
        speakers=[{"id": 1, "voice": "The man"}],
        shots=[
            {"start": 0, "length": 24, "prompt": "A car on a road.", "lines": [said]},
            {"start": 24, "length": 24, "prompt": "The road at night."},
        ],
    )


def test_a_voiceover_uses_the_exact_phrase_and_the_clause_after_it():
    written = body(speaking(offscreen=True))
    assert "The man (S1) says in an off-screen voiceover: <d>[English] I still remember " \
           "that road.</d> while their lips remain completely closed." in written


def test_an_ordinary_line_gains_neither_half():
    written = body(speaking())
    assert "off-screen voiceover" not in written
    assert "lips remain" not in written


def test_a_line_that_carries_over_marks_both_sides_of_the_cut():
    timeline = clip(
        speech=True,
        speakers=[{"id": 1, "voice": "The man"}],
        shots=[
            {"start": 0, "length": 24, "prompt": "A car.",
             "lines": [{"text": "I still remember", "ids": "S1", "carries": True}]},
            {"start": 24, "length": 24, "prompt": "The road.",
             "lines": [{"text": "that road.", "ids": "S1"}]},
        ],
    )
    written = body(timeline)
    assert "<scenetrans> The line continues seamlessly across the cut." in written
    assert "<scenetrans> The man (S1) says: <d>[English] that road.</d>" in written


def test_a_line_the_clip_ends_underneath_is_a_cutoff_instead():
    timeline = clip(
        speech=True,
        speakers=[{"id": 1, "voice": "The man"}],
        shots=[{"start": 0, "length": 24, "prompt": "A car.",
                "lines": [{"text": "I still remember", "ids": "S1", "carries": True}]}],
    )
    written = body(timeline)
    assert "<cutoff> The speech is truncated by the end of the video." in written
    assert "<scenetrans>" not in written


# -- the reference dialect ---------------------------------------------------


def referenced(**overrides):
    document = {
        "global_prompt": "Live-action, cinematic.",
        "shots": [
            {"start": 0, "length": 24, "prompt": "A raccoon on a fence.",
             "media": {"kind": "image", "filename": "raccoon.png",
                       "description": "the raccoon", "retention": "fully_preserved"}},
        ],
    }
    document.update(overrides)
    return Timeline.from_dict(document)


def test_the_style_sits_above_shot_one_in_reference_mode():
    """§5.2: the style is established "before [Shot 1]" -- the base guide puts it inside."""
    written = body(referenced())
    assert written.startswith("Live-action, cinematic.\n[Shot 1] ")


def test_the_style_stays_inside_shot_one_in_the_base_format():
    assert body(clip()).startswith("[Shot 1] Live-action, cinematic. ")


def test_an_audio_reference_is_marked_in_its_own_vocabulary():
    """§4.2: audio has four markers of its own, and `fully_preserved` is not one."""
    timeline = referenced(cues=[
        {"start": 0, "length": 24, "prompt": "A bell.",
         "media": {"kind": "audio", "filename": "bell.wav", "description": "one bell chime",
                   "retention": "reference"}},
    ])
    analysis = compile_timeline(timeline).prompt.split("retention_analysis:")[1]
    assert "<Audio 1> (heard in [Shot 1]): reference - one bell chime." in analysis


def test_a_visual_marker_stored_on_an_audio_file_is_translated_not_dropped():
    """A document written before the two sets were told apart still meant something."""
    timeline = referenced(cues=[
        {"start": 0, "length": 24, "prompt": "A bell.",
         "media": {"kind": "audio", "filename": "bell.wav", "description": "one chime",
                   "retention": "weak_reference"}},
    ])
    analysis = compile_timeline(timeline).prompt.split("retention_analysis:")[1]
    assert "<Audio 1> (heard in [Shot 1]): weak_reference" in analysis

    timeline = referenced(cues=[
        {"start": 0, "length": 24, "prompt": "A bell.",
         "media": {"kind": "audio", "filename": "bell.wav", "description": "one chime",
                   "retention": "fully_preserved"}},
    ])
    analysis = compile_timeline(timeline).prompt.split("retention_analysis:")[1]
    assert "<Audio 1> (heard in [Shot 1]): fully_copy" in analysis


def test_the_two_marker_sets_do_not_overlap_where_it_would_matter():
    assert set(AUDIO_RETENTIONS) & set(RETENTIONS) == {"weak_reference"}


def test_a_storyboard_picture_says_what_it_plans_rather_than_what_it_shows():
    """§2.2: a shot-planning image is a plan of the framing, not content to reproduce."""
    timeline = referenced(shots=[
        {"start": 0, "length": 24, "prompt": "A raccoon on a fence.",
         "media": {"kind": "image", "filename": "board.png", "role": "storyboard",
                   "description": "a pencil frame", "retention": "weak_reference"}},
    ])
    prompt = compile_timeline(timeline).prompt
    assert ("<Picture 1> is a storyboard reference for [Shot 1], defining viewpoint, "
            "subject placement, and shot order.") in prompt
    assert "<Picture 1> (storyboard for [Shot 1]): weak_reference" in prompt


# -- the cast's extra assets (ref §2.1, §2.4) --------------------------------


def voiced(**card):
    """A clip with a face on shot 1, an audio cue, and one cast card joining them."""
    timeline = {
        "global_prompt": "Live-action.",
        "shots": [
            {"start": 0, "length": 24, "prompt": "A woman speaks.",
             "media": {"kind": "image", "filename": "face.png",
                       "description": "the woman", "retention": "fully_preserved"}},
        ],
        "cues": [
            {"start": 0, "length": 24, "prompt": "Her voice.",
             "media": {"kind": "audio", "filename": "voice.wav"}},
        ],
    }
    one = {"id": 1, "uid": "c1", "name": "WOMAN", "file": "face.png",
           "description": "the woman", "keep": "fully_preserved", "voice": ""}
    one.update(card)
    merged = cast.merge(timeline, {"version": 1, "speech": True, "cards": [one]})
    return Timeline.from_dict(merged)


def test_an_audio_can_be_a_speakers_voice_timbre():
    prompt = compile_timeline(voiced(voice_from="voice.wav")).prompt
    assert "is the voice-timbre reference for <Subject 1> (S1)" in prompt


def test_a_voice_reference_is_analysed_as_a_reference_not_a_copy():
    prompt = compile_timeline(voiced(voice_from="voice.wav")).prompt
    analysis = prompt.split("retention_analysis:")[1]
    assert ("<Audio 1> (heard in [Shot 1]): reference - the target speaker follows "
            "<Audio 1>'s voice timbre and delivery without copying the original signal."
            ) in analysis


def test_an_audio_nobody_borrows_a_voice_from_is_untouched():
    prompt = compile_timeline(voiced()).prompt
    assert "voice-timbre reference" not in prompt


def test_a_subject_can_be_drawn_from_two_files_with_a_job_each():
    """§2.1: one subject, several assets -- and the sentence says which supplies what."""
    timeline = {
        "global_prompt": "Live-action.",
        "shots": [
            {"start": 0, "length": 24, "prompt": "A woman walks.",
             "media": {"kind": "image", "filename": "face.png",
                       "description": "the woman", "retention": "fully_preserved"}},
            {"start": 24, "length": 24, "prompt": "She keeps walking.",
             "media": {"kind": "video", "filename": "walk.mp4",
                       "description": "a walking cycle", "retention": "weak_reference"}},
        ],
    }
    merged = cast.merge(timeline, {"version": 1, "speech": True, "cards": [
        {"id": 1, "uid": "c1", "name": "WOMAN", "file": "face.png",
         "description": "the woman", "keep": "fully_preserved", "voice": "warm",
         "motion_from": "walk.mp4"},
    ]})
    prompt = compile_timeline(Timeline.from_dict(merged)).prompt
    assert ("<Subject 1> is the woman, whose appearance comes from <Picture 1> and whose "
            "motion comes from <Video 1>.") in prompt


# -- the checks the guides hand us for free ----------------------------------


def messages(timeline):
    return [issue.message for issue in lint(timeline)]


def test_a_silent_soundscape_is_only_claimed_on_purpose():
    """§4.6: `N/A` is for a clip the author asked to be silent, not an empty track."""
    assert any("completely silent" in note for note in messages(clip()))
    quiet = clip(global_prompt="A silent room, no sound at all.")
    assert not any("completely silent" in note for note in messages(quiet))


def test_two_shots_that_differ_only_in_framing_are_flagged():
    """§4.2: "If only the distance or a slight angle needs to change, prefer camera
    motion"."""
    timeline = clip(shots=[
        {"start": 0, "length": 24, "prompt": "A wide shot of the red door."},
        {"start": 24, "length": 24, "prompt": "A close shot of the red door."},
    ])
    assert any("describe the same thing at a different framing" in note
               for note in messages(timeline))


def test_two_shots_that_say_different_things_are_not():
    timeline = clip(shots=[
        {"start": 0, "length": 24, "prompt": "A wide shot of the red door."},
        {"start": 24, "length": 24, "prompt": "A close shot of the brass handle."},
    ])
    assert not any("different framing" in note for note in messages(timeline))


def test_a_thin_description_is_measured_against_the_guides_band():
    assert any("350-500" in note for note in messages(clip()))


def test_a_voice_reference_asked_to_be_copied_is_a_contradiction():
    timeline = voiced(voice_from="voice.wav")
    for cue in timeline.cues:
        cue.media["retention"] = "fully_copy"
    assert any("voice reference but its keep is fully_copy" in note
               for note in messages(timeline))


def test_a_line_carrying_over_the_end_of_the_clip_is_reported():
    timeline = clip(
        speech=True,
        speakers=[{"id": 1, "voice": "The man"}],
        shots=[{"start": 0, "length": 24, "prompt": "A car.",
                "lines": [{"text": "I still remember", "ids": "S1", "carries": True}]}],
    )
    assert any("nothing follows it" in note for note in messages(timeline))


def test_a_guessed_word_is_pointed_at_the_unclear_marker():
    timeline = clip(
        speech=True,
        speakers=[{"id": 1, "voice": "The man"}],
        shots=[{"start": 0, "length": 24, "prompt": "A car.",
                "lines": [{"text": "I remember that (?) road.", "ids": "S1"}]}],
    )
    assert any("[unclear]" in note for note in messages(timeline))


# -- round trips -------------------------------------------------------------


@pytest.mark.parametrize("document", [
    {"shots": [{"start": 0, "length": 24, "prompt": "A door.", "transition": "wipe",
                "screen_text": "EXIT",
                "lines": [{"text": "Hello.", "ids": "S1", "offscreen": True,
                           "carries": True}]}]},
    {"moves": [{"start": 0, "length": 24, "camera": "truck_left",
                "amplitude": "large", "speed": "fast"}]},
    {"speakers": [{"id": 1, "voice": "warm", "voice_from": "voice.wav"}]},
])
def test_the_new_fields_survive_a_round_trip(document):
    once = Timeline.from_dict(document)
    assert Timeline.from_dict(once.to_dict()) == once
