"""Spoken lines, task types, frame anchors and the alignment instruction.

Everything here is pinned against the wording in MiniMax's own guides
(`docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md` and `..._ref_en.md`), not against what
reads nicely. The model was trained on those fixed strings; improving the English is a
change of meaning, so these tests exist to make that change loud.
"""

from minimax_director.compile import compile_timeline
from minimax_director.lint import lint
from minimax_director.timeline import Timeline


def spoken(**line):
    return Timeline.from_dict({
        "duration": 124,
        "shots": [{"start": 0, "length": 124, "prompt": "A woman sits at a desk.",
                   "lines": [line]}],
    })


# -- the <d> form ------------------------------------------------------------


def test_a_line_renders_in_the_guides_exact_form():
    timeline = spoken(
        text="I get off at the next station.",
        speaker="The young woman with a quiet, breathy voice",
    )
    assert (
        "The young woman with a quiet, breathy voice (S1) says: "
        "<d>[English] I get off at the next station.</d>"
    ) in compile_timeline(timeline).prompt


def test_only_the_language_tag_and_the_words_are_inside_the_brackets():
    """The guide is explicit: identity, ID and delivery stay outside `<d>`."""
    prompt = compile_timeline(spoken(
        text="Wait for us!", speaker="The two children", ids="S1,S2",
        delivery="shout together")).prompt
    body = prompt[prompt.index("<d>") + 3:prompt.index("</d>")]
    assert body == "[English] Wait for us!"
    assert "The two children (S1,S2) shout together:" in prompt


def test_the_words_are_never_rewritten():
    """Punctuation, capitals and language are the author's, verbatim."""
    said = "¿Dónde está la estación...?  "
    prompt = compile_timeline(spoken(text=said, language="Spanish")).prompt
    assert "<d>[Spanish] ¿Dónde está la estación...?</d>" in prompt


def test_dialogue_follows_the_action_and_the_camera():
    timeline = Timeline.from_dict({
        "duration": 124,
        "shots": [{"start": 0, "length": 124, "prompt": "A woman sits at a desk",
                   "camera": "dolly_in",
                   "lines": [{"text": "Hello.", "speaker": "A woman"}]}],
    })
    prompt = compile_timeline(timeline).prompt
    assert prompt.index("A woman sits at a desk") < prompt.index("The camera pushes in")
    assert prompt.index("The camera pushes in") < prompt.index("<d>")


def test_a_blank_line_contributes_nothing():
    assert "<d>" not in compile_timeline(spoken(text="   ")).prompt


def test_lines_survive_a_round_trip():
    timeline = spoken(text="Hello.", speaker="A woman", ids="S2", delivery="whispers")
    restored = Timeline.from_json(timeline.to_json())
    assert compile_timeline(restored).prompt == compile_timeline(timeline).prompt


# -- task types --------------------------------------------------------------


def attached(role, kind="image", retention="fully_preserved"):
    media = {"kind": kind, "filename": f"a.{'png' if kind == 'image' else 'mp4'}",
             "description": "the raccoon", "retention": retention, "role": role}
    return Timeline.from_dict({
        "duration": 124,
        "shots": [{"start": 0, "length": 124, "prompt": "A raccoon.", "media": media}],
    })


def test_a_plain_reference_is_reference_generation():
    assert "[reference generation]" in compile_timeline(attached("reference")).prompt


def test_a_frame_anchor_is_keyframe_completion():
    assert "[keyframe completion]" in compile_timeline(attached("first frame")).prompt


def test_a_source_video_is_a_continuation():
    prompt = compile_timeline(attached("continue from", kind="video")).prompt
    # The video carries its own soundtrack, which is a second relationship of its own.
    assert prompt[prompt.index("["):].startswith("[video continuation + audio reuse]")


def test_task_types_combine_without_repeating():
    timeline = Timeline.from_dict({
        "duration": 248,
        "shots": [
            {"start": 0, "length": 124, "prompt": "A street.",
             "media": {"kind": "video", "filename": "a.mp4", "description": "the street",
                       "retention": "fully_preserved", "role": "continue from"}},
            {"start": 124, "length": 124, "prompt": "A raccoon.",
             "media": {"kind": "image", "filename": "b.png", "description": "the raccoon",
                       "retention": "fully_preserved", "role": "last frame"}},
        ],
    })
    prefix = compile_timeline(timeline).prompt
    prefix = prefix[prefix.index("["):prefix.index("]") + 1]
    assert prefix == "[keyframe completion + video continuation + audio reuse]"


def test_an_audio_reference_is_not_an_audio_reuse():
    timeline = Timeline.from_dict({
        "duration": 124,
        "shots": [{"start": 0, "length": 124, "prompt": "A room."}],
        "cues": [{"start": 0, "length": 124, "prompt": "<Audio 1> is the voice.",
                  "media": {"kind": "audio", "filename": "v.wav", "description": "a voice",
                            "retention": "weak_reference"}}],
    })
    assert "[audio reference]" in compile_timeline(timeline).prompt


# -- frame anchors in retention_analysis -------------------------------------


def test_a_frame_anchor_says_which_frame_it_is():
    prompt = compile_timeline(attached("first frame")).prompt
    assert "<Picture 1> ([Shot 1] first frame): fully_preserved" in prompt


def test_a_guidance_reference_still_says_appears_in():
    prompt = compile_timeline(attached("reference")).prompt
    assert "<Picture 1> (appears in [Shot 1]): fully_preserved" in prompt


# -- the alignment instruction -----------------------------------------------


def bare():
    return Timeline.from_dict({
        "duration": 124,
        "shots": [{"start": 0, "length": 62, "prompt": "A desk."},
                  {"start": 62, "length": 62, "prompt": "a chair"}],
    })


def test_no_keyframe_means_no_instruction():
    assert compile_timeline(bare()).prompt.startswith("integrated_multimodal_description:")


def test_a_first_frame_alone_uses_the_i2va_wording():
    prompt = compile_timeline(bare(), first_frame=True).prompt
    assert prompt.startswith(
        "For the target video, at 0.00 seconds into the target video, "
        "<Picture 1> (from [Shot 1]) is fully referenced.\n\n")


def test_a_last_frame_alone_uses_the_l2va_wording():
    prompt = compile_timeline(bare(), last_frame=True).prompt
    assert prompt.startswith(
        "How the reference pictures align with the target video — <Picture 1> "
        "(from [Shot 2]) aligns with the 5.17-second mark of the target video.\n\n")


def test_both_frames_use_the_fl2va_wording():
    prompt = compile_timeline(bare(), first_frame=True, last_frame=True).prompt
    assert prompt.startswith(
        "How the reference pictures align with the target video — Picture 1 (from Shot 1) "
        "aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 2) "
        "aligns with the 5.17-second mark of the target video.\n\n")


def test_the_duration_is_the_one_that_will_be_generated():
    """Two decimals, and the lattice-rounded length -- not what the author typed."""
    timeline = Timeline.from_dict({"duration": 100, "shots": [
        {"start": 0, "length": 100, "prompt": "A desk."}]})
    compiled = compile_timeline(timeline, last_frame=True)
    assert compiled.length == 107
    assert f"{107 / 24:.2f}-second mark" in compiled.prompt


def test_references_suppress_the_instruction():
    """That path has no keyframe inputs to align to, so announcing them would be a lie."""
    assert not compile_timeline(attached("reference"), first_frame=True).prompt.startswith(
        "For the target video")


# -- lint --------------------------------------------------------------------


def messages(timeline):
    return [issue.message for issue in lint(timeline)]


def test_an_undescribed_speaker_is_a_warning():
    assert any("S1 speaks with no description" in text
               for text in messages(spoken(text="Hello.")))


def test_a_described_speaker_is_not():
    assert not any("speaks with no description" in text
                   for text in messages(spoken(text="Hello.", speaker="A woman")))


def test_a_speaker_described_once_stays_known():
    timeline = Timeline.from_dict({
        "duration": 248,
        "shots": [
            {"start": 0, "length": 124, "prompt": "A woman.",
             "lines": [{"text": "Hello.", "speaker": "A woman with a low voice"}]},
            {"start": 124, "length": 124, "prompt": "she turns",
             "lines": [{"text": "Goodbye."}]},
        ],
    })
    assert not any("speaks with no description" in text for text in messages(timeline))
