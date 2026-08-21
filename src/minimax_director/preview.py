"""Compile a timeline for the editor, without running anything.

The `prompt` output only fills in when the graph runs, so the one string H3 actually
receives stays invisible while you are writing the timeline. The editor calls this on
every edit pause instead, which needs a compile that never raises: a timeline being
typed is briefly malformed, and an exception there would leave the panel stuck on stale
text with no way to say why.
"""

from __future__ import annotations

from . import attachments
from .cast import merge_json
from .compile import compile_timeline
from .lint import Issue, lint
from .timeline import Timeline


def missing_files(timeline_json: str, cast_json: str = "") -> list[str]:
    """Files the document names that are not in ComfyUI's input folder.

    The list of names is pure (`attachments.named_files`); only "is it there?" is asked of
    ComfyUI, and only when ComfyUI is what we are running inside. Outside it -- the test
    suite, a REPL -- the answer is "nothing is missing", because a file list is not
    evidence about a folder that is not there.
    """
    try:
        import folder_paths
    except ImportError:
        return []

    try:
        document = Timeline.from_json(merge_json(timeline_json, cast_json))
    except Exception:  # noqa: BLE001 -- a half-typed document is the compiler's to report
        return []
    return [path for path in attachments.named_files(document)
            if not folder_paths.exists_annotated_filepath(path)]


def compile_preview(timeline_json: str, cast_json: str = "",
                    missing: list[str] | tuple[str, ...] = ()) -> dict:
    """Compile `timeline_json` to the fields the editor's prompt panel shows.

    Always returns a dict. A payload that cannot be parsed comes back as
    `{"ok": False, "error": ...}` rather than raising, because the caller is a
    keystroke-driven request and half-typed JSON is expected traffic.

    `missing` is passed in rather than looked up: this module says what a document means,
    and what is on disk is a question only the process serving the files can answer.
    """
    try:
        document = Timeline.from_json(merge_json(timeline_json, cast_json))
        compiled = compile_timeline(document)
        issues = lint(document)
    except Exception as error:  # malformed payload; the panel shows the reason
        return {"ok": False, "error": f"{type(error).__name__}: {error}"}

    # First, above every other issue: nothing else in the report can be acted on while a
    # file the clip names is not on the machine that has to read it.
    if missing:
        issues.insert(0, Issue("error", attachments.missing_sentence(list(missing))))

    return {
        "ok": True,
        "prompt": compiled.prompt,
        "length": compiled.length,
        "seconds": compiled.duration,
        "report": "\n".join(str(issue) for issue in issues),
    }
