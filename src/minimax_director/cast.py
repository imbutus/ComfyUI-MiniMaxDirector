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
        motion = str(card.get("motion_from", "")).strip()
        if media is not None and described:
            entries = media.setdefault("subjects", [])
            if isinstance(entries, list):
                entries.append({
                    "name": described,
                    "subject_retention": str(card.get("keep", "")),
                    "onto": str(card.get("onto", "")).strip(),
                    # A second asset for the same person: the still says what they look
                    # like, the clip says how they move. Carried as a filename for the
                    # reason everything else here is -- tokens move when a block does.
                    **({"motion_file": motion} if motion else {}),
                    "uid": tag,
                })
            # The editor has one description box per file and it lives on the card, so a
            # file that keeps an entry of its own -- a frame anchor, an edit source, and
            # anything not used purely to define somebody -- would otherwise have nothing
            # to say about itself. The first card to name it lends its sentence; a
            # description already on the record is left alone, because it was written
            # about the file rather than about a person in it.
            if not str(media.get("description", "")).strip():
                media["description"] = described

        # An audio the voice is taken from is marked on its own record too, so the
        # compiler can tell "nothing was said about this file" from "this file is a
        # timbre reference" without going back through the cast.
        voice_from = str(card.get("voice_from", "")).strip()
        heard = files.get(voice_from)
        if heard is not None:
            listeners = heard.setdefault("voices", [])
            if isinstance(listeners, list):
                listeners.append(tag)

        speakers.append({
            "id": number,
            "voice": str(card.get("voice", "")),
            "name": str(card.get("name", "")),
            "subject": 0,
            "uid": tag,
            **({"voice_from": voice_from} if voice_from else {}),
        })

    merged["speakers"] = speakers
    # A card whose voice is an audio reference has described its voice as fully as one
    # with a paragraph of prose -- more so -- so it counts as somebody who can speak.
    merged["speech"] = document["speech"] and any(
        str(card.get("voice", "")).strip() or str(card.get("voice_from", "")).strip()
        for card in document["cards"])
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
