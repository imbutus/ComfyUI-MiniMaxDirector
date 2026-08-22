"""Spoken lines, task types, frame anchors and the alignment instruction.

Everything here is pinned against the wording in MiniMax's own guides
(`docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md` and `..._ref_en.md`), not against what
reads nicely. The model was trained on those fixed strings; improving the English is a
change of meaning, so these tests exist to make that change loud.
"""

import json

from minimax_director.cast import merge_json as cast_merge
from minimax_director.compile import compile_timeline
from minimax_director.lint import lint
from minimax_director.timeline import Timeline


def spoken(**line):
    """A one-shot clip with the dialogue switch on -- the state the editor produces once
    anything in the dialogue row has been touched."""
    return Timeline.from_dict({
        "duration": 124,
        "speech": True,
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
    # From the summary line rather than the first bracket in the document: a frame anchor
    # names its shot in `subject_definitions` now, so the first `[` in the prompt is that
    # `[Shot n]` and not the task type this test is about.
    summary = compile_timeline(timeline).prompt.split("summary:\n", 1)[1]
    prefix = summary[summary.index("["):summary.index("]") + 1]
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


def test_a_frame_anchor_does_not_suppress_the_instruction():
    """The anchor is where the keyframe comes from: a block used as a first frame *is*
    that frame, not a reference standing beside one."""
    assert compile_timeline(attached("first frame"), first_frame=True).prompt.startswith(
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


# -- <Subject N> -------------------------------------------------------------


def with_subject(**media):
    record = {"kind": "image", "filename": "face.png",
              "description": "a full-face and profile photo of a man",
              "retention": "weak_reference", "subject": "the man's face"}
    record.update(media)
    return Timeline.from_dict({
        "duration": 124,
        "shots": [{"start": 0, "length": 124, "prompt": "A man turns to the camera.",
                   "media": record}],
    })


def test_a_named_subject_gets_its_own_definition_naming_its_source():
    prompt = compile_timeline(with_subject()).prompt
    assert "<Subject 1> is the man's face, from <Picture 1>." in prompt


def test_a_subject_carries_its_own_retention():
    prompt = compile_timeline(with_subject(subject_retention="attribute_transfer")).prompt
    assert "<Subject 1> (appears in [Shot 1]): attribute_transfer - the man's face." in prompt


def test_a_picture_that_only_defines_somebody_has_no_entry_of_its_own():
    """The guide: an image used only to define a character gets no standalone entry --
    its source is cited inside the subject it defines. Two entries said the photograph
    itself was a weak reference *and* that a face was lifted out of it, which is one
    reference described twice."""
    prompt = compile_timeline(with_subject()).prompt
    assert "<Subject 1> is the man's face, from <Picture 1>." in prompt
    assert "<Picture 1> is" not in prompt
    assert "<Picture 1> (appears in [Shot 1])" not in prompt


def test_a_frame_anchor_keeps_its_entry_even_when_it_defines_somebody():
    """A first frame is *in* the video, not behind it: it is a concrete frame the model
    has to reproduce, so it stays analysed however many people are drawn from it."""
    prompt = compile_timeline(with_subject(role="first frame")).prompt
    assert "<Picture 1> is" in prompt
    assert "<Subject 1> is the man's face, from <Picture 1>." in prompt


def test_a_transfer_names_who_receives_it():
    """`attribute_transfer` moves a feature onto somebody; the guide wants that somebody
    named, or the prompt says a face travels and never says where it lands."""
    prompt = compile_timeline(with_subject(
        subject_retention="attribute_transfer", onto="the woman at the desk")).prompt
    assert ("<Subject 1> (appears in [Shot 1]): attribute_transfer - the man's face, "
            "transferred onto the woman at the desk.") in prompt


def test_a_transfer_onto_another_card_names_who_it_is_written_over():
    """The `onto` picker writes the other card's name, which is a label of the editor's.

    The carried feature keeps its own `<Subject n>` -- it is what the target video will
    show where the receiver's own face was -- and the prompt states the replacement in the
    summary, in `retention_analysis` and in the body. Said only as "transferred onto
    <Subject 1>" beside a receiver preserved wholesale, the model kept the face it had.
    """
    timeline = Timeline.from_json(cast_merge(json.dumps({
        "duration": 96,
        "shots": [
            {"start": 0, "length": 48, "prompt": "He waits.",
             "media": {"kind": "image", "filename": "him.png"}},
            {"start": 48, "length": 48, "prompt": "The same man.",
             "media": {"kind": "image", "filename": "face.jpg"}},
        ],
    }), json.dumps({"speech": True, "cards": [
        {"id": 1, "name": "SPEAKER", "file": "him.png", "keep": "fully_preserved",
         "description": "the man in the navy suit", "voice": "A man in his forties"},
        {"id": 2, "name": "FACE", "file": "face.jpg", "keep": "attribute_transfer",
         "onto": "SPEAKER", "description": "the face in face.jpg"},
    ]})))
    prompt = compile_timeline(timeline).prompt
    assert "<Subject 1> is the man in the navy suit, from <Picture 1>" in prompt
    assert "<Subject 2> is the face in face.jpg, from <Picture 2>." in prompt
    assert ("<Subject 1>'s face in face.jpg is replaced by <Subject 2>, from <Picture 2>, "
            "and nothing else about <Subject 1> changes.") in prompt
    # The photograph itself is still cited inside the definition it feeds rather than
    # described as a thing the video contains.
    assert "<Picture 2> is" not in prompt
    assert "transferred onto SPEAKER" not in prompt


def test_a_subject_without_its_own_marker_follows_the_file():
    assert "<Subject 1> (appears in [Shot 1]): weak_reference" in compile_timeline(
        with_subject()).prompt


def test_the_shot_mentions_the_subject_rather_than_the_picture():
    """Naming both asks the model to reproduce the frame *and* lift one feature out of it."""
    body = compile_timeline(with_subject()).prompt
    body = body[body.index("detailed_description:"):]
    assert "<Subject 1>" in body
    assert "<Picture 1>" not in body


def test_no_subject_means_no_subject_label():
    assert "<Subject" not in compile_timeline(with_subject(subject="")).prompt


def test_subjects_are_numbered_across_files():
    timeline = Timeline.from_dict({
        "duration": 248,
        "shots": [
            {"start": 0, "length": 124, "prompt": "A man.",
             "media": {"kind": "image", "filename": "a.png", "description": "a man",
                       "subject": "the man's face"}},
            {"start": 124, "length": 124, "prompt": "A jacket.",
             "media": {"kind": "image", "filename": "b.png", "description": "a jacket",
                       "subject": "the red jacket"}},
        ],
    })
    prompt = compile_timeline(timeline).prompt
    assert "<Subject 1> is the man's face, from <Picture 1>." in prompt
    assert "<Subject 2> is the red jacket, from <Picture 2>." in prompt


def test_a_dialogue_tag_is_not_given_a_second_full_stop():
    """The stop is inside `<d>` with the words, where the author typed it."""
    timeline = Timeline.from_dict({
        "duration": 124,
        "shots": [{"start": 0, "length": 124, "prompt": "A woman.",
                   "lines": [{"text": "Hello.", "speaker": "A woman"}]}],
        "moves": [{"start": 0, "length": 124, "camera": "static"}],
    })
    assert "</d>." not in compile_timeline(timeline).prompt


def test_a_reference_clip_outside_two_to_fifteen_seconds_warns_once():
    timeline = Timeline.from_dict({
        "duration": 124,
        "shots": [{"start": 0, "length": 124, "prompt": "A street.",
                   "media": {"kind": "video", "filename": "a.mp4",
                             "description": "the street", "seconds": 22.4}}],
    })
    warned = [text for text in messages(timeline) if "2-15 seconds" in text]
    assert len(warned) == 1
    assert "22.4s" in warned[0]


def test_a_clip_of_unknown_length_is_not_second_guessed():
    timeline = Timeline.from_dict({
        "duration": 124,
        "shots": [{"start": 0, "length": 124, "prompt": "A street.",
                   "media": {"kind": "video", "filename": "a.mp4",
                             "description": "the street"}}],
    })
    assert not any("2-15 seconds" in text for text in messages(timeline))


def test_a_shot_is_closed_before_the_next_one_opens():
    """A camera note is a continuation, so it arrives without a stop of its own."""
    timeline = Timeline.from_dict({
        "duration": 124,
        "shots": [{"start": 0, "length": 62, "prompt": "A table."},
                  {"start": 62, "length": 62, "prompt": "a chair"}],
        "moves": [{"start": 0, "length": 62, "camera": "dolly_in",
                   "prompt": "closing on the croissants"}],
    })
    assert "closing on the croissants. [Shot 2]" in compile_timeline(timeline).prompt


def test_an_empty_shot_is_not_given_punctuation_around_nothing():
    timeline = Timeline.from_dict({
        "shots": [{"start": 0, "length": 24, "prompt": "   "}]})
    assert "[Shot 1]." not in compile_timeline(timeline).prompt


def test_a_voice_with_nothing_said_is_a_warning_not_a_line():
    timeline = spoken(text="", speaker="a young woman", ids="S2")
    assert "<d>" not in compile_timeline(timeline).prompt
    assert any("nothing is said" in text for text in messages(timeline))


def test_an_untouched_dialogue_row_says_nothing_at_all():
    timeline = spoken(text="")
    assert not any("nothing is said" in text for text in messages(timeline))


# -- the dialogue switch -----------------------------------------------------


def test_speech_off_leaves_the_words_out():
    timeline = Timeline.from_dict({
        "duration": 124, "speech": False,
        "speakers": [{"id": 1, "voice": "a woman"}],
        "shots": [{"start": 0, "length": 124, "prompt": "A room.",
                   "lines": [{"text": "Hello.", "ids": "S1"}]}],
    })
    prompt = compile_timeline(timeline).prompt
    assert "<d>" not in prompt
    assert "A room." in prompt


def test_a_document_with_dialogue_defaults_to_speech_on():
    """Written before the switch existed: the answer is what it already contains."""
    assert Timeline.from_dict({"shots": [
        {"start": 0, "length": 24, "prompt": "x",
         "lines": [{"text": "Hello."}]}]}).speech


def test_a_document_without_dialogue_defaults_to_speech_off():
    assert not Timeline.from_dict({"shots": [
        {"start": 0, "length": 24, "prompt": "x"}]}).speech


def test_an_explicit_switch_beats_the_contents():
    assert not Timeline.from_dict({"speech": False, "shots": [
        {"start": 0, "length": 24, "prompt": "x",
         "lines": [{"text": "Hello."}]}]}).speech


def test_a_speaker_bound_to_a_subject_is_written_as_the_guide_asks():
    """`<Subject 1> (S1) says: …` — the picture and the voice are one person."""
    timeline = Timeline.from_dict({
        "duration": 124, "speech": True,
        "speakers": [{"id": 1, "voice": "a man with a low voice", "subject": 1}],
        "shots": [{"start": 0, "length": 124, "prompt": "A man at a desk.",
                   "media": {"kind": "image", "filename": "f.png", "description": "a face sheet",
                             "subject": "the man's face"},
                   "lines": [{"text": "Hello.", "ids": "S1"}]}],
    })
    assert "<Subject 1> (S1) says: <d>[English] Hello.</d>" in compile_timeline(timeline).prompt


def test_an_unbound_speaker_still_uses_their_description():
    timeline = Timeline.from_dict({
        "duration": 124, "speech": True,
        "speakers": [{"id": 1, "voice": "a man with a low voice"}],
        "shots": [{"start": 0, "length": 124, "prompt": "A man at a desk.",
                   "lines": [{"text": "Hello.", "ids": "S1"}]}],
    })
    assert "a man with a low voice (S1) says:" in compile_timeline(timeline).prompt


def test_a_binding_to_a_subject_that_does_not_exist_is_ignored():
    timeline = Timeline.from_dict({
        "duration": 124, "speech": True,
        "speakers": [{"id": 1, "voice": "a man with a low voice", "subject": 4}],
        "shots": [{"start": 0, "length": 124, "prompt": "A man at a desk.",
                   "lines": [{"text": "Hello.", "ids": "S1"}]}],
    })
    assert "a man with a low voice (S1) says:" in compile_timeline(timeline).prompt


def _two_in_one_frame(**media):
    return Timeline.from_dict({
        "duration": 124, "speech": True,
        "speakers": [
            {"id": 1, "voice": "a woman with a clear voice", "subject": 1},
            {"id": 2, "voice": "a man, hoarse and slow", "subject": 2},
        ],
        "shots": [{"start": 0, "length": 124, "prompt": "Two people at a table.",
                   "media": {"kind": "image", "filename": "pair.png",
                             "description": "a two-shot", **media},
                   "lines": [{"text": "Hello.", "ids": "S1"}]}],
    })


def test_one_file_can_define_two_subjects():
    """A two-shot is two people, and asking for a second block to name the second one
    made the timeline claim references the clip does not have."""
    prompt = compile_timeline(_two_in_one_frame(subjects=[
        {"name": "the woman on the left"}, {"name": "the man on the right"},
    ])).prompt
    # The speaker's voice follows on the same line, so the sentence does not end here.
    assert "<Subject 1> is the woman on the left, from <Picture 1>" in prompt
    assert "<Subject 2> is the man on the right, from <Picture 1>" in prompt
    assert "<Subject 1> (S1) says: <d>[English] Hello.</d>" in prompt


def test_a_subject_in_the_list_keeps_its_own_retention():
    prompt = compile_timeline(_two_in_one_frame(retention="weak_reference", subjects=[
        {"name": "the woman on the left", "subject_retention": "attribute_transfer"},
        {"name": "the man on the right"},
    ])).prompt
    assert "<Subject 1> (appears in [Shot 1]): attribute_transfer" in prompt
    # No marker of its own: retained the way the file it came out of is.
    assert "<Subject 2> (appears in [Shot 1]): weak_reference" in prompt


def test_an_unnamed_entry_defines_nothing():
    """A card exists before it is filled in, and an empty one must not take a number."""
    prompt = compile_timeline(_two_in_one_frame(subjects=[
        {"name": ""}, {"name": "the man on the right"},
    ])).prompt
    assert "<Subject 1> is the man on the right" in prompt
    assert "<Subject 2>" not in prompt


def test_the_single_subject_form_still_compiles():
    prompt = compile_timeline(_two_in_one_frame(subject="the woman on the left")).prompt
    # The speaker's voice follows on the same line, so the sentence does not end here.
    assert "<Subject 1> is the woman on the left, from <Picture 1>" in prompt
    assert "<Subject 2>" not in prompt


def test_a_voice_typed_on_a_card_with_a_file_reaches_the_model():
    """The body prints `<Subject 1> (S1)`, not prose, so the voice has to live somewhere.

    H3 fixes a voice from what the prompt says about the speaker. Bound to a subject, the
    speaker's own description was replaced by their token and the voice typed on the card
    reached the model nowhere at all -- so every clip whose people came out of photographs
    got a voice nobody chose.
    """
    timeline = Timeline.from_dict({
        "duration": 124, "speech": True,
        "speakers": [{"id": 1, "uid": "w1",
                      "voice": "a woman in her thirties, hoarse and slow"}],
        "shots": [{"start": 0, "length": 124, "prompt": "Two people at a table.",
                   "media": {"kind": "image", "filename": "pair.png",
                             "subjects": [{"name": "the woman on the left", "uid": "w1"}]},
                   "lines": [{"text": "Hello.", "ids": "S1"}]}],
    })
    prompt = compile_timeline(timeline).prompt
    assert ("<Subject 1> is the woman on the left, from <Picture 1>, and sounds like this: "
            "a woman in her thirties, hoarse and slow.") in prompt
    # And the body still names her by token, which is the guide's form.
    assert "<Subject 1> (S1) says:" in prompt


def test_a_card_with_no_file_still_says_the_voice_in_the_body():
    """Nothing changes for a voice-only card: it has no subject line to move into."""
    timeline = Timeline.from_dict({
        "speech": True,
        "speakers": [{"id": 1, "voice": "a young porter, bright and nervous"}],
        "shots": [{"start": 0, "length": 48, "prompt": "A corridor.",
                   "lines": [{"text": "Room service.", "ids": "S1"}]}],
    })
    assert "a young porter, bright and nervous (S1) says:" in compile_timeline(timeline).prompt
