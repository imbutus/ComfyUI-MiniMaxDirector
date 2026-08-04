"""The frame lattice has to agree with ComfyUI's official H3 templates exactly.

Those templates carry the rule as an inline math expression. It is reproduced here as
an independent oracle, so a refactor of `lattice.snap_up` cannot quietly change what a
timeline compiles to.
"""

import pytest

from minimax_director import lattice


def oracle(seconds: float) -> int:
    """The expression from the official MiniMax H3 templates, verbatim."""
    n = max(5, round(seconds * 24))
    return n + (5 - (n % 17)) % 17


@pytest.mark.parametrize("seconds", [x / 10 for x in range(1, 301)])
def test_matches_the_official_expression(seconds):
    assert lattice.from_seconds(seconds) == oracle(seconds)


@pytest.mark.parametrize("seconds", [x / 10 for x in range(1, 301)])
def test_every_snapped_length_is_accepted(seconds):
    assert lattice.is_valid(lattice.from_seconds(seconds))


def test_snap_never_shortens():
    for frames in range(0, 500):
        assert lattice.snap_up(frames) >= max(frames, lattice.PHASE)


def test_snap_is_idempotent():
    for frames in range(0, 500):
        once = lattice.snap_up(frames)
        assert lattice.snap_up(once) == once


def test_ladder_is_the_valid_lengths():
    assert lattice.ladder(8) == [5, 22, 39, 56, 73, 90, 107, 124]
    assert all(lattice.is_valid(length) for length in lattice.ladder(50))


def test_shortest_clip_is_five_frames():
    assert lattice.from_seconds(0.001) == 5


@pytest.mark.parametrize(
    "seconds,expected",
    [(0, "0"), (1, "1"), (2.5, "2.5"), (2.50, "2.5"), (1.0 / 3, "0.33")],
)
def test_timestamps_read_as_prose(seconds, expected):
    assert lattice.format_seconds(seconds) == expected
