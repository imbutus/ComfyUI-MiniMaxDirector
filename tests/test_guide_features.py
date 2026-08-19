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
             "media": {"kind": "audio", "filename": "voice.wav",
                       "retention": "reference"}},
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
            "motion comes from <Video 1>") in prompt


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


def test_a_card_that_reaches_the_prompt_as_nothing_is_flagged():
    """A card is a `<Subject n>` or a voice. With neither it is neither, and the editor
    draws a filled-in row either way."""
    merged = cast.merge(clip().to_dict(), {"cards": [
        {"id": 1, "uid": "a", "name": "football ball", "file": "", "description": "",
         "keep": "fully_preserved", "voice": ""},
    ]})
    assert any("compiles to nothing" in note
               for note in messages(Timeline.from_dict(merged)))


@pytest.mark.parametrize("card", [
    # A voice is enough on its own: that is every speaker with no photograph.
    {"voice": "a low, gravelled voice"},
    {"voice": "", "voice_from": "voice.wav"},
])
def test_a_card_with_a_voice_is_not_flagged(card):
    merged = cast.merge(clip().to_dict(), {"cards": [
        {"id": 1, "uid": "a", "name": "MAN", "file": "", "description": "",
         "keep": "fully_preserved", **card},
    ]})
    assert not any("compiles to nothing" in note
                   for note in messages(Timeline.from_dict(merged)))


def test_a_silent_card_drawn_from_a_file_is_not_flagged():
    """A prop or a place never speaks, and is a subject all the same."""
    document = clip(shots=[
        {"start": 0, "length": 24, "prompt": "A ball on the grass.",
         "media": {"kind": "image", "filename": "ball.png", "role": "reference",
                   "retention": "fully_preserved"}},
    ]).to_dict()
    merged = cast.merge(document, {"speech": False, "cards": [
        {"id": 1, "uid": "a", "name": "BALL", "file": "ball.png",
         "description": "a worn leather football", "keep": "fully_preserved", "voice": ""},
    ]})
    assert not any("compiles to nothing" in note
                   for note in messages(Timeline.from_dict(merged)))


def test_a_voice_nobody_speaks_with_is_flagged():
    """A timbre reference for a speaker the model is never asked to voice."""
    merged = cast.merge(clip().to_dict(), {"cards": [
        {"id": 1, "uid": "a", "name": "BALL", "file": "", "description": "",
         "keep": "fully_preserved", "voice": "a squeaky cartoon voice"},
    ]})
    assert any("says nothing" in note for note in messages(Timeline.from_dict(merged)))


def test_a_voice_with_a_line_is_not_flagged():
    document = clip(shots=[
        {"start": 0, "length": 24, "prompt": "A ball on the grass.",
         "lines": [{"text": "Not again.", "ids": "S1"}]},
    ]).to_dict()
    merged = cast.merge(document, {"cards": [
        {"id": 1, "uid": "a", "name": "BALL", "file": "", "description": "",
         "keep": "fully_preserved", "voice": "a squeaky cartoon voice"},
    ]})
    assert not any("says nothing" in note for note in messages(Timeline.from_dict(merged)))


def test_a_timbre_reference_goes_away_when_nobody_speaks():
    """`they speak` off compiles no dialogue, so a voice reference instructs nothing."""
    document = clip(cues=[
        {"start": 0, "length": 24, "prompt": "Crowd.",
         "media": {"kind": "audio", "filename": "voice.mp3", "role": "reference",
                   "retention": "reference"}},
    ]).to_dict()
    card = {"id": 1, "uid": "a", "name": "BALL", "file": "", "description": "",
            "keep": "fully_preserved", "voice": "", "voice_from": "voice.mp3"}

    quiet = compile_timeline(Timeline.from_dict(
        cast.merge(document, {"speech": False, "cards": [card]}))).prompt
    assert "voice-timbre reference" not in quiet

    talking = compile_timeline(Timeline.from_dict(
        cast.merge(document, {"speech": True, "cards": [card]}))).prompt
    assert "voice-timbre reference" in talking


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


# -- a face carried onto somebody: one subject, two sources ------------------


def _swapped(**receiver):
    """The face from one photograph, carried onto the person in another."""
    return Timeline.from_dict({
        "duration": 124, "speech": True,
        "global_prompt": "A press room.",
        "speakers": [{"id": 1, "name": "SPEAKER", "uid": "u1", "voice": "a warm, even voice"}],
        "shots": [{"start": 0, "length": 124, "prompt": "He sits at the desk.",
                   "lines": [{"text": "Hello.", "ids": "S1"}],
                   "media": {"kind": "image", "filename": "man.png", "subjects": [
                       {"name": "the man in the navy suit: his build and greying hair",
                        "retention": "fully_preserved", "uid": "u1", **receiver}]}}],
        "sources": [{"kind": "image", "filename": "face.jpg", "subjects": [
            {"name": "the face: bone structure, eyes, nose and jawline",
             "retention": "attribute_transfer", "onto": "SPEAKER"}]}],
    })


def test_the_incoming_face_is_a_subject_of_its_own():
    """The shape a working identity replacement uses: the face being brought in is the
    subject, and the summary says what it replaces."""
    prompt = compile_timeline(_swapped()).prompt
    assert ("<Subject 1> is the man in the navy suit: his build and greying hair, from "
            "<Picture 1>") in prompt
    assert "<Subject 2> is the face: bone structure, eyes, nose and jawline, from <Picture 2>." in prompt
    assert ("<Subject 1>'s face is replaced by <Subject 2>, from <Picture 2>, and nothing "
            "else about <Subject 1> changes.") in prompt


def test_the_body_opens_the_shot_with_the_replacement():
    """§5.3: a subject is described where it appears, with its characteristics and its
    current action -- and the working example opens its shot with the incoming identity in
    the original's place. Appended after the author's sentence, the frame was drawn as the
    original man first and the swap read as an afterthought."""
    body = compile_timeline(_swapped()).prompt
    body = body[body.index("detailed_description:"):]
    assert ("[Shot 1] <Subject 2>, the face: bone structure, eyes, nose and jawline, "
            "replaces <Subject 1>'s face and is mapped onto the same head") in body


def test_the_photograph_a_face_comes_from_keeps_no_entry_of_its_own():
    """Cited inside the definition it feeds, the guide's rule for a defining image. Its own
    entry said the whole photograph was preserved, beside a sentence taking one feature."""
    prompt = compile_timeline(_swapped()).prompt
    assert "<Picture 2> is" not in prompt
    assert "<Picture 2>:" not in prompt


def test_the_receiver_is_analysed_as_the_transfer():
    prompt = compile_timeline(_swapped()).prompt
    # The marker rides the subject being brought in, and what the receiver keeps is
    # enumerated with the replaced region named as excluded.
    assert ("<Subject 2> (appears in [Shot 1]): attribute_transfer - the face: bone "
            "structure, eyes, nose and jawline, from <Picture 2>, replaces <Subject 1>'s "
            "face only, mapped onto the same position and framing at every moment") in prompt
    # partially_preserved, though the card says fully: the guide's own definition of the
    # marker is content still used with some characteristics changed, and a person whose
    # face is replaced is that. Marked fully beside a sentence excluding the face, the
    # prompt gave the model a contradiction and the model took the marker.
    assert ("<Subject 1> (appears in [Shot 1]): partially_preserved - the man in the navy "
            "suit: his build and greying hair are retained from <Picture 1>; the face is "
            "not retained from <Picture 1> and comes from <Subject 2> instead.") in prompt
