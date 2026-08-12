"""The six-section format H3 wants once anything is attached.

Source of truth: `skills/h3-prompt-writing/references/ref-en.txt` in MiniMax's own repo,
and the skill file that points at it -- "Ref2VA rewrites use `subject_definitions`,
`summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and
`non_diegetic_music` in that order. Preserve the exact field names, section order, labels,
and timing notation."

These tests pin the field names and the order, because those are the part a refactor can
break silently: a prompt with the wrong section names still compiles, still reaches the
sampler, and still produces a video -- just not the one that was asked for.
"""

from pathlib import Path

from minimax_director import Timeline, compile_timeline
from minimax_director.lint import lint

GOLDEN = Path(__file__).parent / "golden"

SECTIONS = [
    "subject_definitions:",
    "summary:",
    "retention_analysis:",
    "detailed_description:",
    "overall_soundscape:",
    "non_diegetic_music:",
]


def image(name, **extra):
    return {"kind": "image", "filename": name, "subfolder": "", **extra}


def build(**overrides):
    document = {
        "global_prompt": "Live-action, cinematic, warm morning sunlight on a cafe terrace.",
        "music": "A jaunty pizzicato caper theme on plucked strings.",
        "duration": 192,
        "shots": [
            {
                "start": 0, "length": 64,
                "prompt": "A basket of golden croissants sits on a marble cafe table.",
                "media": image(
                    "mmdv-croissant.png",
                    description="the basket of golden croissants on a marble cafe table",
                ),
            },
            {
                "start": 64, "length": 64,
                "prompt": "a raccoon rising over the red wooden fence, both paws on the rail.",
                "media": image(
                    "mmdv-raccoon.png",
                    description="the raccoon, grey and black with a striped tail and a masked face",
                    retention="fully_preserved",
                ),
            },
        ],
        "moves": [{"start": 0, "length": 64, "camera": "dolly_in"}],
        "cues": [{"start": 0, "length": 128, "prompt": "A quiet sunny cafe terrace."}],
    }
    document.update(overrides)
    return Timeline.from_dict(document)


def test_attachments_choose_the_format():
    """Nothing an author can set changes this. The graph routes a timeline with
    attachments to `MiniMaxH3ReferenceToVideo`, so the prompt has to follow -- a
    disagreement here is invisible until the video comes out wrong."""
    assert compile_timeline(build()).prompt.startswith("subject_definitions:")


def test_a_timeline_with_nothing_attached_is_unchanged():
    bare = build(shots=[{"start": 0, "length": 64, "prompt": "An empty terrace."}], moves=[])
    assert compile_timeline(bare).prompt.startswith("integrated_multimodal_description:")


def test_every_section_is_present_and_in_the_documented_order():
    prompt = compile_timeline(build()).prompt
    found = [(prompt.index(name), name) for name in SECTIONS if name in prompt]
    assert [name for _, name in sorted(found)] == SECTIONS


def test_the_shot_body_is_the_same_string_the_base_format_carries():
    """§5.1: the reference guide shares the base guide's shot grammar. The body is a
    rename, not a rewrite -- shot numbering, cut times and camera prose stay put."""
    prompt = compile_timeline(build()).prompt
    body = prompt.split("detailed_description: ")[1].split("\n\noverall_soundscape:")[0]
    assert "[Shot 1] A basket of golden croissants" in body
    assert "[Shot 2] At 00:02.667, the camera cuts to a raccoon rising" in body


def test_the_style_is_stated_before_shot_one():
    """§5.2: in full-reference mode the style is established in one or two sentences
    *before* `[Shot 1]`, not folded into it the way the base format asks for."""
    body = compile_timeline(build()).prompt.split("detailed_description: ")[1]
    style, rest = body.split("\n", 1)
    assert style == "Live-action, cinematic, warm morning sunlight on a cafe terrace."
    assert rest.startswith("[Shot 1] ")


def test_every_token_is_defined_and_analysed():
    prompt = compile_timeline(build()).prompt
    definitions = prompt.split("summary:")[0]
    analysis = prompt.split("retention_analysis:")[1].split("detailed_description:")[0]
    for token in ("<Picture 1>", "<Picture 2>"):
        assert token in definitions
        assert token in analysis


def test_retention_defaults_to_fully_preserved_and_names_the_shot():
    analysis = compile_timeline(build()).prompt.split("retention_analysis:")[1]
    assert "<Picture 1> (appears in [Shot 1]): fully_preserved -" in analysis
    assert "<Picture 2> (appears in [Shot 2]): fully_preserved -" in analysis


def test_an_unknown_retention_marker_falls_back_rather_than_reaching_the_model():
    """The markers are a fixed vocabulary in the output format. A typo from a hand-edited
    document must not be passed through as if it meant something."""
    timeline = build(shots=[{
        "start": 0, "length": 64, "prompt": "x",
        "media": image("a.png", description="a thing", retention="mostly_ish"),
    }])
    assert "mostly_ish" not in compile_timeline(timeline).prompt


def test_an_undescribed_attachment_still_compiles_and_is_linted():
    timeline = build(shots=[{
        "start": 0, "length": 64, "prompt": "x", "media": image("lonely.png"),
    }])
    prompt = compile_timeline(timeline).prompt
    assert "<Picture 1> is the picture in lonely.png." in prompt
    warnings = [str(i) for i in lint(timeline) if "no description" in i.message]
    assert len(warnings) == 1


def test_the_summary_opens_with_the_task_type():
    summary = compile_timeline(build()).prompt.split("summary:\n")[1].split("\n\n")[0]
    assert summary.startswith("[reference generation] ")
    assert "<Picture 1> and <Picture 2>" in summary


def test_matches_golden():
    compiled = compile_timeline(build())
    assert compiled.prompt == (GOLDEN / "cafe_reference.txt").read_text().strip()
