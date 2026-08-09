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


def _register_routes():
    """Expose the compiler to the editor.

    The `prompt` output only fills in when the graph runs. The editor posts the timeline
    here on every edit pause instead, so the string H3 will receive is readable while it
    is still being written -- no sampler, no GPU.

    Guarded: pytest collects this file from the repository root, where neither `server`
    nor `aiohttp` exists.
    """
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return

    from minimax_director.preview import compile_preview

    @PromptServer.instance.routes.post("/minimax_director/compile")
    async def compile_route(request):
        payload = await request.json()
        return web.json_response(compile_preview(payload.get("timeline", "")))


_register_routes()


async def comfy_entrypoint():
    """Imported lazily: the node module needs `comfy_api`, which only exists inside
    ComfyUI, and pytest collects this file from the repository root."""
    from minimax_director.nodes import MiniMaxDirectorExtension

    return MiniMaxDirectorExtension()


__all__ = ["comfy_entrypoint", "WEB_DIRECTORY"]
