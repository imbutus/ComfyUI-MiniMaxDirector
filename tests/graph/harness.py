"""Run a real ComfyUI graph in-process, with the weight-bearing nodes stubbed.

Point `COMFYUI_PATH` at a ComfyUI checkout and this executes an actual prompt through
ComfyUI's own validator and executor -- no server, no GPU, no model files. Without that
variable the graph tests skip, so the pure-Python suite still runs anywhere.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import sys
import uuid
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[2]


def comfy_path() -> Path | None:
    raw = os.environ.get("COMFYUI_PATH")
    if not raw:
        return None
    path = Path(raw).expanduser()
    return path if (path / "nodes.py").is_file() else None


def _await(value):
    return asyncio.run(value) if inspect.iscoroutine(value) else value


def boot():
    """Import ComfyUI, load every node, and swap in the stubs. Idempotent."""
    root = comfy_path()
    if root is None:
        raise RuntimeError("COMFYUI_PATH is not set to a ComfyUI checkout")

    for entry in (str(root), str(PACKAGE / "src")):
        if entry not in sys.path:
            sys.path.insert(0, entry)

    import nodes as comfy_nodes

    if not getattr(comfy_nodes, "_minimax_director_booted", False):
        _await(comfy_nodes.init_extra_nodes(init_api_nodes=False))
        comfy_nodes._minimax_director_booted = True

    from minimax_director.nodes import NODE_CLASS_MAPPINGS as ours

    from . import stubs

    # The package's own nodes register normally; the stubs go in by force, which is
    # exactly what a custom node pack is not allowed to do.
    comfy_nodes.NODE_CLASS_MAPPINGS.update(ours)
    comfy_nodes.NODE_CLASS_MAPPINGS.update(stubs.REPLACEMENTS)

    # The loaders are stubbed, so a file named by a test graph is never opened -- and the
    # director refuses to run while a file it names is not in the input folder. That check
    # is about the real world; in here the input folder is as fictional as the weights, so
    # it is answered the same way everything else in this harness is. A name containing
    # `missing` is the one file this pretend folder does not have, which is what lets the
    # refusal itself be tested.
    import folder_paths

    folder_paths.exists_annotated_filepath = lambda name: "missing" not in str(name)
    return comfy_nodes


def rejection(prompt: dict) -> str:
    """Why ComfyUI refuses this graph, as one string. Empty when it does not."""
    boot()

    import execution

    valid = _await(execution.validate_prompt(str(uuid.uuid4()), prompt, None))
    if valid[0]:
        return ""
    return str(valid[1]) + str(valid[3] if len(valid) > 3 else "")


class _Server:
    """The smallest object ComfyUI's executor will accept in place of its server."""

    client_id = None
    last_node_id = None
    last_prompt_id = None

    def send_sync(self, *args, **kwargs):
        pass

    async def send(self, *args, **kwargs):
        pass

    def queue_updated(self):
        pass


def run(prompt: dict, outputs: list[str]) -> dict:
    """Validate and execute `prompt`, returning the executor's status.

    Raises if validation fails, so a malformed graph is a test failure with ComfyUI's
    own message rather than a silent no-op.
    """
    boot()

    import execution

    from . import stubs

    stubs.CALLS.clear()

    prompt_id = str(uuid.uuid4())
    valid = _await(execution.validate_prompt(prompt_id, prompt, None))
    if not valid[0]:
        raise AssertionError(f"ComfyUI rejected the graph: {valid[1]}")

    # Same shape main.py builds; the executor reads "ram" and "ram_inactive" directly.
    executor = execution.PromptExecutor(
        _Server(),
        cache_type=execution.CacheType.CLASSIC,
        cache_args={"lru": 0, "ram": 16.0, "ram_inactive": 8.0},
    )
    executor.execute(prompt, prompt_id, {}, outputs)

    if not executor.success:
        raise AssertionError(f"Execution failed: {executor.status_messages}")

    return {"calls": list(stubs.CALLS), "messages": executor.status_messages}


def output_dir() -> Path:
    boot()
    import folder_paths

    return Path(folder_paths.get_output_directory())
