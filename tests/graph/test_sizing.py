"""Per-file `resize`: one picture's size is the file's own answer, not the clip's.

Core sizes every reference picture by one socket value, so the director sizes them itself
and hands core pictures its own loop leaves alone. These check both halves of that: the
arithmetic matches core's, and a picture already at that size is a fixed point.
"""

from __future__ import annotations

import pytest

from .harness import boot, comfy_path

pytestmark = pytest.mark.skipif(comfy_path() is None, reason="COMFYUI_PATH is not set")


@pytest.fixture(scope="module")
def sized():
    boot()
    from minimax_director.nodes.director import _sized

    return _sized


def picture(wide: int, tall: int):
    import torch

    return torch.zeros(1, tall, wide, 3)


def shape(image) -> tuple[int, int]:
    return int(image.shape[2]), int(image.shape[1])


def test_match_comes_down_to_about_the_clips_pixel_count(sized):
    out = sized(picture(4000, 3000), "match", 448, 256)
    wide, tall = shape(out)
    assert wide * tall <= 448 * 256 * 1.2
    assert wide % 32 == 0 and tall % 32 == 0
    # And the proportions are the picture's, not the clip's.
    assert abs(wide / tall - 4 / 3) < 0.05


def test_max_caps_the_short_side_and_keeps_more_than_match(sized):
    out = sized(picture(4000, 3000), "max", 448, 256)
    wide, tall = shape(out)
    assert min(wide, tall) <= 2048
    assert wide * tall > 448 * 256


def test_max_never_enlarges(sized):
    out = sized(picture(320, 256), "max", 448, 256)
    assert shape(out) == (320, 256)


def test_a_sized_picture_is_what_cores_own_loop_would_leave_alone(sized):
    """The whole scheme rests on this: core is asked for `max` after the sizing, and a
    picture that its `max` branch would change is one sized twice."""
    import math

    once = sized(picture(4000, 3000), "match", 448, 256)
    wide, tall = shape(once)
    scale = min(1.0, 2048 / min(wide, tall))
    assert scale == 1.0
    assert (max(32, round(wide * scale / 32) * 32),
            max(32, round(tall * scale / 32) * 32)) == (wide, tall)
    assert math.isclose(wide / tall, 4 / 3, rel_tol=0.05)
