"""The editor's word lists and the compiler's must be the same word lists.

They are written twice because they run in two languages, and there is no build step to
share them. That is fine as long as nothing can drift: a camera value the editor offers
and the compiler has never heard of compiles to itself -- the raw enum key, in the middle
of a sentence, sent to the model as prose. It looks like nothing until you read the prompt.

So this test reads `model.js` as text and compares. A regex over source is cruder than
importing it, and it is the only way to check a file no Python process can execute.
"""

import re
from pathlib import Path

import pytest

from minimax_director.timeline import (
    ANCHOR_ROLES, AUDIO_RETENTIONS, AMPLITUDES, CAMERA_MOTION, FITS, RETENTIONS, ROLES,
    SPEEDS, TRANSITIONS,
)

MODEL = (Path(__file__).parents[1] / "web" / "timeline" / "model.js").read_text()


def listed(name: str) -> list[str]:
    """The string entries of `export const NAME = [...]` in model.js."""
    match = re.search(rf"export const {name} = \[(.*?)\];", MODEL, re.S)
    assert match, f"{name} is not exported from model.js"
    return re.findall(r'"([^"]*)"', match.group(1))


def test_the_camera_vocabulary_is_the_same_on_both_sides():
    offered = listed("CAMERAS")
    unknown = [name for name in offered if name not in CAMERA_MOTION]
    assert not unknown, f"the editor offers camera values the compiler cannot read: {unknown}"


def test_the_editor_offers_every_motion_worth_offering():
    """Everything except the one alias kept only so old documents still read."""
    assert set(listed("CAMERAS")) == set(CAMERA_MOTION) - {"crash_zoom"}


def test_amplitude_and_speed_agree():
    # The editor carries an extra empty entry: it has to draw the guide's unwritten
    # default as a real option, and the compiler expresses the same thing by omission.
    assert listed("AMPLITUDES") == ["", *AMPLITUDES]
    assert listed("SPEEDS") == ["", *SPEEDS]


@pytest.mark.parametrize("name,expected", [
    ("RETENTIONS", RETENTIONS),
    ("AUDIO_RETENTIONS", AUDIO_RETENTIONS),
    ("ROLES", ROLES),
    ("TRANSITIONS", tuple(TRANSITIONS)),
    ("ANCHOR_ROLES", ANCHOR_ROLES),
    ("FITS", FITS),
])
def test_the_fixed_vocabularies_agree(name, expected):
    assert listed(name) == list(expected)
