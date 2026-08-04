"""ComfyUI entry point.

ComfyUI imports this package directly from `custom_nodes/`, so the library under `src/`
has to be reachable without an install step. Adding it to `sys.path` here keeps the
import path identical whether the project is dropped into `custom_nodes/` or installed
with pip for the test suite.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

from minimax_director.nodes import (  # noqa: E402
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
)

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
