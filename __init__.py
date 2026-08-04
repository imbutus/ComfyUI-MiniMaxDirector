"""ComfyUI entry point.

ComfyUI imports this package directly from `custom_nodes/`, so the library under `src/`
has to be reachable without an install step.

Only `comfy_entrypoint` is exported. ComfyUI's loader takes the first thing it finds and
`NODE_CLASS_MAPPINGS` would win, dropping us onto the V1 path where `io.Autogrow` does
not exist -- and the reference sockets would then cover the whole node.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

WEB_DIRECTORY = "./web"


async def comfy_entrypoint():
    """Imported lazily: the node module needs `comfy_api`, which only exists inside
    ComfyUI, and pytest collects this file from the repository root."""
    from minimax_director.nodes import MiniMaxDirectorExtension

    return MiniMaxDirectorExtension()


__all__ = ["comfy_entrypoint", "WEB_DIRECTORY"]
