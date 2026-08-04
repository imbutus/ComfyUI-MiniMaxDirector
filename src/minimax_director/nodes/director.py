"""The nodes ComfyUI sees."""

from __future__ import annotations

from .. import core, lattice, references
from ..compile import compile_timeline
from ..lint import lint
from ..timeline import Timeline

CATEGORY = "MiniMaxDirector"

MAX_PICTURES = 9
MAX_VIDEOS = 3
MAX_AUDIOS = 3
"""Slot counts declared by the core node's autogrow templates
(`ref_image_` 0-9, `ref_video_` 0-3, `ref_video_audio_` 0-3, `ref_audio_` 0-3)."""


def _wired(prefix: str, count: int, given: dict) -> list:
    """Slot values in order, `None` where nothing is connected."""
    return [given.get(f"{prefix}_{index}") for index in range(1, count + 1)]


def _report(issues) -> str:
    return "\n".join(str(issue) for issue in issues)


class MiniMaxDirector:
    """Compile a timeline and hand H3 its conditioning and starting latent."""

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            "audio_vae": ("VAE",),
            "first_frame": ("IMAGE",),
            "last_frame": ("IMAGE",),
        }
        for index in range(1, MAX_PICTURES + 1):
            optional[f"picture_{index}"] = ("IMAGE",)
        for index in range(1, MAX_VIDEOS + 1):
            optional[f"video_{index}"] = ("IMAGE",)
            optional[f"video_audio_{index}"] = ("AUDIO",)
        for index in range(1, MAX_AUDIOS + 1):
            optional[f"audio_{index}"] = ("AUDIO",)

        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "timeline": ("STRING", {"multiline": True, "default": ""}),
                "width": ("INT", {"default": 1344, "min": 32, "max": 4096, "step": 32}),
                "height": ("INT", {"default": 768, "min": 32, "max": 4096, "step": 32}),
                "ref_image_size": (["match", "max"], {"default": "match"}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT", "STRING", "INT", "STRING")
    RETURN_NAMES = ("positive", "latent", "prompt", "length", "report")
    FUNCTION = "direct"
    CATEGORY = CATEGORY
    DESCRIPTION = __doc__

    def direct(self, clip, vae, timeline, width, height, ref_image_size="match", **optional):
        pictures = _wired("picture", MAX_PICTURES, optional)
        videos = _wired("video", MAX_VIDEOS, optional)
        video_audios = _wired("video_audio", MAX_VIDEOS, optional)
        audios = _wired("audio", MAX_AUDIOS, optional)

        document = Timeline.from_json(timeline).with_references(
            references.assign(pictures, videos, video_audios, audios)
        )
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

        # Autogrow inputs arrive as dicts keyed by slot name; a video's soundtrack is
        # paired to it by the numeric suffix, so slot numbers are preserved.
        ref_images = references.slots("ref_image_", pictures)
        ref_videos = references.slots("ref_video_", videos)
        ref_video_audios = references.slots("ref_video_audio_", video_audios)
        ref_audios = references.slots("ref_audio_", audios)

        if ref_images or ref_videos or ref_audios:
            positive, latent = core.call(
                "MiniMaxH3ReferenceToVideo",
                **shared,
                audio_vae=optional.get("audio_vae"),
                ref_image_size=ref_image_size,
                ref_images=ref_images or None,
                ref_videos=ref_videos or None,
                ref_video_audios=ref_video_audios or None,
                ref_audios=ref_audios or None,
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
