#!/usr/bin/env python3
"""Every control and every vocabulary value is named in at least one document.

The gap this exists for: a `shows` box lived on the FILE row for weeks while `AGENTS.md`
described its stored key as legacy with no writer left. Nothing was wrong with either the
code or the sentence on its own; they were only wrong about each other, and the drift is
invisible unless somebody greps for it.

So this greps for it. It reads the editor's own labels and the vocabularies the compiler
shares with the browser, and asks whether each string appears in any of the documents a
reader would look in. It cannot tell whether the sentence it finds is *true* -- only that
somebody wrote one, which is the failure that actually happens.

    tools/doc_coverage.py            report every surface and where it is documented
    tools/doc_coverage.py --check    exit 1 if any surface appears in no document

`--check` is deliberately weak: one mention anywhere passes. A stricter rule would fire on
the many controls that need no prose of their own, and a check people turn off catches
nothing at all.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DOCS = [
    ROOT / "docs" / "GUIDE.md",
    ROOT / "AGENTS.md",
    ROOT / "README.md",
]
WORKFLOW = ROOT / "examples" / "minimax-director.json"

#: Labels that are ordinary English before they are controls: a document mentioning them
#: proves nothing, and requiring a mention proves less. Checked by eye instead.
IGNORED = {
    "line", "how", "language", "camera", "start", "end", "length", "width", "height",
    "from", "onto", "duration", "resize", "fit",
}


def note_text() -> str:
    """The info note inside the shipped workflow -- the documentation most people read."""
    if not WORKFLOW.exists():
        return ""
    graph = json.loads(WORKFLOW.read_text(encoding="utf-8"))
    for node in graph.get("nodes", []):
        if node.get("type") == "MarkdownNote":
            values = node.get("widgets_values") or [""]
            return str(values[0])
    return ""


def labels() -> set[str]:
    """Every `<label …>name` in the editor: the words a reader sees beside a control."""
    source = (ROOT / "web" / "timeline" / "editor.js").read_text(encoding="utf-8")
    found = set()
    for match in re.finditer(r"<label\b[^>]*>\s*([a-z][a-z0-9 &-]{1,28}?)\s*(?:<|\$\{|\n)", source):
        name = match.group(1).strip()
        if name and name not in IGNORED:
            found.add(name)
    return found


def vocabularies() -> set[str]:
    """The value sets the editor and the compiler both hold, read off the JS side."""
    source = (ROOT / "web" / "timeline" / "model.js").read_text(encoding="utf-8")
    found = set()
    for name in ("ROLES", "RETENTIONS", "AUDIO_RETENTIONS", "FITS", "SIZINGS", "TRANSITIONS"):
        block = re.search(rf"export const {name} = \[(.*?)\];", source, re.S)
        if block:
            found.update(re.findall(r'"([^"]+)"', block.group(1)))
    return {value for value in found if value}


def main() -> int:
    checking = "--check" in sys.argv
    documents = {path.name: path.read_text(encoding="utf-8") for path in DOCS if path.exists()}
    documents["info note"] = note_text()

    surfaces = sorted(("control", name) for name in labels())
    surfaces += sorted(("value", name) for name in vocabularies())

    undocumented = []
    for kind, name in surfaces:
        # Only a *named* mention counts. Plain prose is not documentation: "the panel shows
        # one of four things" is not a sentence about the `shows` box, and counting it let
        # the very control this script exists for pass with no entry anywhere. The docs name
        # a control in backticks or bold, so that is what is searched for.
        forms = (f"`{name}`", f"**{name}**", f"**`{name}`**")
        seen = [where for where, text in documents.items()
                if any(form in text for form in forms)]
        if not seen:
            undocumented.append((kind, name))
        if not checking:
            print(f"{kind:8} {name:24} {', '.join(seen) if seen else '— NOWHERE'}")

    if undocumented:
        print(file=sys.stderr)
        for kind, name in undocumented:
            print(f"doc_coverage: {kind} {name!r} is in no document", file=sys.stderr)
        print(f"doc_coverage: {len(undocumented)} undocumented", file=sys.stderr)
        return 1
    if checking:
        print(f"doc_coverage: {len(surfaces)} surfaces, all documented")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
