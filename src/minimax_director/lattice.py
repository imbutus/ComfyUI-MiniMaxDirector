"""Frame arithmetic for MiniMax H3.

H3 does not accept an arbitrary frame count. Its temporal VAE compresses in blocks of
17 frames plus a 5-frame head, so a valid clip length always satisfies::

    length % 17 == 5

giving 5, 22, 39, 56, 73, 90, 107, 124, ... at a fixed 24 fps. The official ComfyUI
templates enforce this with an inline math expression::

    max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17

`snap_up` is that expression, named. Everything here is integer frame math -- no
floating point creeps into a length that the sampler will later trust.
"""

from __future__ import annotations

FPS = 24
"""Frame rate of every H3 clip. Not configurable in the model."""

STRIDE = 17
"""Temporal VAE block size."""

PHASE = 5
"""Head frames that sit outside the blocks; also the shortest legal clip."""


def is_valid(frames: int) -> bool:
    """True when `frames` is a length H3 will accept."""
    return frames >= PHASE and frames % STRIDE == PHASE


def snap_up(frames: int) -> int:
    """Round `frames` up to the next valid length.

    Never rounds down, so a shot list is never silently truncated.
    """
    frames = max(PHASE, int(frames))
    return frames + (PHASE - frames % STRIDE) % STRIDE


def from_seconds(seconds: float) -> int:
    """Wall-clock seconds -> a valid frame count."""
    return snap_up(round(seconds * FPS))


def to_seconds(frames: int) -> float:
    """Frame index or count -> wall-clock seconds."""
    return frames / FPS


def ladder(count: int) -> list[int]:
    """The first `count` valid lengths, shortest first.

    Useful for building a UI that can only express legal durations.
    """
    return [PHASE + STRIDE * step for step in range(count)]


def format_seconds(seconds: float) -> str:
    """Format a timestamp the way the H3 prompt templates do: `0`, `1`, `2.5`.

    Trailing zeros are dropped because the text encoder reads these as prose, and
    `2.50s` reads worse than `2.5s`.
    """
    rounded = round(seconds, 2)
    if rounded == int(rounded):
        return str(int(rounded))
    return f"{rounded:g}"
