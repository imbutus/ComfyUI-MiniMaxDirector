"""The editor compiles on every edit pause, so this path must never raise."""

import json

from minimax_director.preview import compile_preview

TIMELINE = {
    "global_prompt": "Neon-lit alley after rain.",
    "shots": [{"start": 0, "length": 24, "prompt": "Wide shot of the alley."}],
}


def test_compiles_the_same_prompt_the_node_would_send():
    from minimax_director import Timeline, compile_timeline

    result = compile_preview(json.dumps(TIMELINE))

    assert result["ok"] is True
    assert result["prompt"] == compile_timeline(Timeline.from_dict(TIMELINE)).prompt


def test_reports_length_and_seconds():
    result = compile_preview(json.dumps(TIMELINE))

    assert isinstance(result["length"], int)
    assert result["seconds"] > 0


def test_empty_payload_is_an_empty_timeline_not_an_error():
    assert compile_preview("")["ok"] is True


def test_half_typed_json_answers_instead_of_raising():
    result = compile_preview('{"shots": [')

    assert result["ok"] is False
    assert "JSONDecodeError" in result["error"]


def test_structurally_wrong_payload_answers_instead_of_raising():
    result = compile_preview('{"shots": "not a list"}')

    assert result["ok"] is False
    assert result["error"]


def test_report_carries_lint_issues_as_text():
    assert isinstance(compile_preview(json.dumps(TIMELINE))["report"], str)
