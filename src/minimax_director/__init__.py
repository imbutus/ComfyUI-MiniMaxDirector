"""MiniMaxDirector — a timeline editor for the MiniMax H3 video model.

The public surface is deliberately small and free of ComfyUI imports, so the parts
worth testing can be tested with `pytest` and nothing else::

    >>> from minimax_director import Timeline, compile_timeline
    >>> compile_timeline(Timeline.from_json(payload)).prompt
"""

from .compile import Compiled, compile_timeline
from .lattice import FPS, PHASE, STRIDE, from_seconds, is_valid, snap_up, to_seconds
from .lint import Issue, lint
from .timeline import Cue, Move, Reference, Shot, Timeline

__version__ = "0.1.0"

__all__ = [
    "Compiled",
    "Cue",
    "FPS",
    "Issue",
    "Move",
    "PHASE",
    "Reference",
    "STRIDE",
    "Shot",
    "Timeline",
    "compile_timeline",
    "from_seconds",
    "is_valid",
    "lint",
    "snap_up",
    "to_seconds",
    "__version__",
]
