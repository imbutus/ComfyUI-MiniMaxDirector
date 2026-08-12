"""The cast, authored on a node of its own and merged into the timeline to compile.

A character is a face, a name, what must stay the same about them and how they sound --
four things that live in two different places in the document: a subject record on the
file they were drawn from, and a speaker in the cast list. Authoring them apart is what
made the old fields confusing, so they are authored together on one node and taken apart
here, at the last moment, into the shape the compiler already reads.

The join back to the timeline is by *filename*, not by ordinal. `<Picture 2>` is computed
from where blocks sit and changes when one is dragged; a filename does not, and a card
that silently re-pointed at somebody else's photograph because a block moved would be the
worst kind of bug -- one you only see in the render.
"""

from __future__ import annotations

import json
from typing import Any

VERSION = 1

EMPTY = json.dumps({"version": VERSION, "speech": True, "cards": []}, indent=2)


def parse(payload: str | dict | None) -> dict[str, Any]:
    """A cast document, whatever arrives. Never raises: this is keystroke-driven traffic."""
    if isinstance(payload, dict):
        document = payload
    else:
        try:
            document = json.loads(payload or "{}")
        except (TypeError, ValueError):
            return {"version": VERSION, "speech": True, "cards": []}
    if not isinstance(document, dict):
        return {"version": VERSION, "speech": True, "cards": []}

    cards = document.get("cards")
    return {
        "version": VERSION,
        "speech": document.get("speech", True) is not False,
        "cards": [card for card in cards if isinstance(card, dict)]
        if isinstance(cards, list) else [],
    }


def _files(timeline: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Media records on the timeline, by filename, first attachment winning."""
    found: dict[str, dict[str, Any]] = {}
    for track in ("shots", "cues"):
        for item in timeline.get(track) or []:
            media = item.get("media") if isinstance(item, dict) else None
            if not isinstance(media, dict):
                continue
            name = str(media.get("filename", "")).strip()
            if name and name not in found:
                found[name] = media
    return found


def merge(timeline: dict[str, Any], payload: str | dict | None) -> dict[str, Any]:
    """Fold a cast document into a timeline document, returning a new one.

    Cards with a file add a subject to that file; every card adds a speaker. Both ends
    carry the card's tag, so the `<Subject n>` a voice belongs to survives the renumbering
    that dragging a block causes.
    """
    document = parse(payload)
    if not document["cards"]:
        return timeline

    merged = json.loads(json.dumps(timeline))  # nothing upstream is touched
    files = _files(merged)

    speakers: list[dict[str, Any]] = []
    for position, card in enumerate(document["cards"], start=1):
        number = int(card.get("id") or position)
        tag = str(card.get("uid") or f"c{number}")

        media = files.get(str(card.get("file", "")).strip())
        described = str(card.get("description", "")).strip()
        if media is not None and described:
            entries = media.setdefault("subjects", [])
            if isinstance(entries, list):
                entries.append({
                    "name": described,
                    "subject_retention": str(card.get("keep", "")),
                    "onto": str(card.get("onto", "")).strip(),
                    "uid": tag,
                })

        speakers.append({
            "id": number,
            "voice": str(card.get("voice", "")),
            "name": str(card.get("name", "")),
            "subject": 0,
            "uid": tag,
        })

    merged["speakers"] = speakers
    merged["speech"] = document["speech"] and any(
        str(card.get("voice", "")).strip() for card in document["cards"])
    return merged


def merge_json(timeline_json: str, payload: str | dict | None) -> str:
    """The same fold, from JSON to JSON, for the nodes that only handle text."""
    if not payload:
        return timeline_json
    try:
        timeline = json.loads(timeline_json or "{}")
    except (TypeError, ValueError):
        return timeline_json
    if not isinstance(timeline, dict):
        return timeline_json
    return json.dumps(merge(timeline, payload))
