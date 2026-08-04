"""Node registration.

ComfyUI's loader checks for `NODE_CLASS_MAPPINGS` first and stops there, so the root
package deliberately exports only `comfy_entrypoint` -- the V3 path, which is what makes
`io.Autogrow` available. The mapping below exists for the test harness, which needs to
put these classes into the registry itself.
"""

from __future__ import annotations

from .director import (
    NODES,
    MiniMaxDirector,
    MiniMaxDirectorChain,
    MiniMaxDirectorCompile,
    MiniMaxDirectorExtension,
    MiniMaxDirectorLength,
)

NODE_CLASS_MAPPINGS: dict[str, type] = {node.__name__: node for node in NODES}

__all__ = [
    "NODES",
    "NODE_CLASS_MAPPINGS",
    "MiniMaxDirector",
    "MiniMaxDirectorChain",
    "MiniMaxDirectorCompile",
    "MiniMaxDirectorExtension",
    "MiniMaxDirectorLength",
]
