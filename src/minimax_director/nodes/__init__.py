"""Node registration.

Under `MINIMAX_DIRECTOR_MOCK=1` the mock classes are registered *under the real core
node names*, which is what lets the untouched production workflow run on a laptop.
"""

from __future__ import annotations

from .director import MiniMaxDirector, MiniMaxDirectorCompile, MiniMaxDirectorLength
from . import mocks

NODE_CLASS_MAPPINGS: dict[str, type] = {
    "MiniMaxDirector": MiniMaxDirector,
    "MiniMaxDirectorCompile": MiniMaxDirectorCompile,
    "MiniMaxDirectorLength": MiniMaxDirectorLength,
}

NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {
    "MiniMaxDirector": "MiniMax Director",
    "MiniMaxDirectorCompile": "MiniMax Director — Compile",
    "MiniMaxDirectorLength": "MiniMax Director — Length",
}

if mocks.enabled():
    NODE_CLASS_MAPPINGS.update(mocks.REPLACEMENTS)
    NODE_DISPLAY_NAME_MAPPINGS.update(
        {name: f"{name} (mock)" for name in mocks.REPLACEMENTS}
    )

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
