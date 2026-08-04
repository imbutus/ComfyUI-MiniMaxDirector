"""Node registration."""

from __future__ import annotations

from .director import MiniMaxDirector, MiniMaxDirectorCompile, MiniMaxDirectorLength

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

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
