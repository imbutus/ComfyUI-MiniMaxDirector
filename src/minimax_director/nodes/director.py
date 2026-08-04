"""The nodes ComfyUI sees."""

from __future__ import annotations

from .. import core, lattice
from ..compile import compile_timeline
from ..lint import lint
from ..timeline import Reference, Timeline

CATEGORY = "MiniMaxDirector"

MAX_PICTURES = 3
MAX_AUDIO = 1
MAX_VIDEO = 1
"""Slot counts the official reference template wires. Raise them once a real run
confirms the model accepts more."""


def _references(kwargs: dict) -> list[Reference]:
    """Which reference slots are actually connected, in token order."""
    found: list[Reference] = []
    for kind, count, prefix in (
        ("picture", MAX_PICTURES, "picture"),
        ("audio", MAX_AUDIO, "audio"),
        ("video", MAX_VIDEO, "video"),
    ):
        for index in range(1, count + 1):
            if kwargs.get(f"{prefix}_{index}") is not None:
                found.append(Reference(kind=kind, index=index))  # type: ignore[arg-type]
    return found


def _report(issues) -> str:
    return "\n".join(str(issue) for issue in issues)


class MiniMaxDirector:
    """Compile a timeline and hand H3 its conditioning and starting latent."""

    @classmethod
    def INPUT_TYPES(cls):
        pictures = {
            f"picture_{index}": ("IMAGE",) for index in range(1, MAX_PICTURES + 1)
        }
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "timeline": ("STRING", {"multiline": True, "default": ""}),
                "width": ("INT", {"default": 1344, "min": 64, "max": 4096, "step": 32}),
                "height": ("INT", {"default": 768, "min": 64, "max": 4096, "step": 32}),
            },
            "optional": {
                "audio_vae": ("VAE",),
                "first_frame": ("IMAGE",),
                "last_frame": ("IMAGE",),
                "audio_1": ("AUDIO",),
                "video_1": ("IMAGE",),
                **pictures,
            },
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT", "STRING", "INT", "STRING")
    RETURN_NAMES = ("positive", "latent", "prompt", "length", "report")
    FUNCTION = "direct"
    CATEGORY = CATEGORY
    DESCRIPTION = __doc__

    def direct(self, clip, vae, timeline, width, height, **optional):
        document = Timeline.from_json(timeline).with_references(_references(optional))
        compiled = compile_timeline(document)
        report = _report(lint(document))

        shared = {
            "clip": clip,
            "vae": vae,
            "prompt": compiled.prompt,
            "width": width,
            "height": height,
            "length": compiled.length,
        }

        references = {
            "audio_vae": optional.get("audio_vae"),
            "ref_image_0": optional.get("picture_1"),
            "ref_image_1": optional.get("picture_2"),
            "ref_image_2": optional.get("picture_3"),
            "ref_video_0": optional.get("video_1"),
            "ref_audio_0": optional.get("audio_1"),
        }

        if any(value is not None for value in references.values()):
            positive, latent = core.call(
                "MiniMaxH3ReferenceToVideo", **shared, **references
            )
        else:
            positive, latent = core.call(
                "MiniMaxH3ImageToVideo",
                **shared,
                first_frame=optional.get("first_frame"),
                last_frame=optional.get("last_frame"),
            )

        return positive, latent, compiled.prompt, compiled.length, report


class MiniMaxDirectorCompile:
    """Compile a timeline to text without touching the model.

    The same code path the director takes, exposed on its own so a prompt can be
    reviewed, diffed, or edited by hand before it costs a generation.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "timeline": ("STRING", {"multiline": True, "default": ""}),
            }
        }

    RETURN_TYPES = ("STRING", "INT", "FLOAT", "STRING")
    RETURN_NAMES = ("prompt", "length", "seconds", "report")
    FUNCTION = "build"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True
    DESCRIPTION = __doc__

    def build(self, timeline):
        document = Timeline.from_json(timeline)
        compiled = compile_timeline(document)
        report = _report(lint(document))
        return compiled.prompt, compiled.length, compiled.duration, report


class MiniMaxDirectorLength:
    """Snap a duration in seconds to a length H3 accepts.

    Replaces the inline math expression the official templates carry, and says out loud
    what it is doing.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seconds": ("FLOAT", {"default": 5.0, "min": 0.2, "max": 120.0, "step": 0.1}),
            }
        }

    RETURN_TYPES = ("INT", "FLOAT")
    RETURN_NAMES = ("length", "seconds")
    FUNCTION = "snap"
    CATEGORY = CATEGORY
    DESCRIPTION = __doc__

    def snap(self, seconds):
        length = lattice.from_seconds(seconds)
        return length, lattice.to_seconds(length)
