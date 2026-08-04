"""Adapter over the MiniMax H3 nodes that ship inside ComfyUI.

`MiniMaxH3ImageToVideo` and `MiniMaxH3ReferenceToVideo` are core nodes
(`comfy_extras/nodes_minimax_h3.py`, ComfyUI 0.30.0 and later). We call them instead of
reimplementing conditioning, so an upstream change to how H3 is encoded reaches this
project for free.

Because they are upstream, their signature is theirs to change. Everything here is
resolved by introspection -- the node class is looked up by name, its declared entry
point is read from `FUNCTION`, and arguments are filtered against its own
`INPUT_TYPES()`. An upstream rename then produces a clear error at the call site rather
than a `TypeError` from somewhere deep in a stack trace.
"""

from __future__ import annotations

from typing import Any


class CoreNodeMissing(RuntimeError):
    """Raised when ComfyUI is too old, or the H3 extra failed to import."""


def resolve(name: str) -> type:
    """Find a core node class by its registered name."""
    try:
        from nodes import NODE_CLASS_MAPPINGS  # ComfyUI's global registry
    except ImportError as exc:  # pragma: no cover - only outside ComfyUI
        raise CoreNodeMissing(
            "ComfyUI is not importable; MiniMaxDirector nodes only run inside ComfyUI."
        ) from exc

    node = NODE_CLASS_MAPPINGS.get(name)
    if node is None:
        raise CoreNodeMissing(
            f"{name} is not registered. MiniMax H3 needs ComfyUI 0.30.0 or newer "
            f"(comfy_extras/nodes_minimax_h3.py)."
        )
    return node


def accepted(node: type) -> set[str]:
    """Every argument name the node declares, required and optional alike."""
    spec = node.INPUT_TYPES()
    names: set[str] = set()
    for section in ("required", "optional"):
        names.update(spec.get(section, {}))
    return names


def call(name: str, **kwargs: Any) -> tuple:
    """Invoke a core node, passing only the arguments it declares.

    Arguments that are `None`, and arguments the installed version does not know, are
    dropped. That keeps one call site working across ComfyUI versions that add or
    rename optional inputs.
    """
    node = resolve(name)
    allowed = accepted(node)
    payload = {
        key: value
        for key, value in kwargs.items()
        if value is not None and key in allowed
    }
    return getattr(node(), node.FUNCTION)(**payload)
