"""Stand-ins for the parts of the graph that need weights.

These live in the test suite, not in the package, because ComfyUI refuses to let a
custom node pack replace a built-in node: `nodes.init_external_custom_nodes` snapshots
`base_node_names` before loading custom nodes and passes it as `ignore`, so
`NODE_CLASS_MAPPINGS[name] = cls` is skipped for every core name.

The test process has no such restriction. It owns the registry and patches it directly,
which is why the mocks belong here.

Everything a stub returns is a real tensor of the right shape, so the nodes downstream
of it -- `CreateVideo`, `SaveVideo` -- are the genuine article and really do write an
mp4.
"""

from __future__ import annotations

import math

import torch

SAMPLE_RATE = 44100
CHANNELS = 2
FPS = 24

CATEGORY = "testing"

CALLS: list[dict] = []
"""Every stubbed invocation, in order. The graph test asserts against this."""


class Stub:
    """A named placeholder standing in for a loaded weight file."""

    def __init__(self, name: str):
        self.name = name

    def __repr__(self) -> str:
        return f"<stub {self.name}>"


class _Loader:
    RETURN_TYPES = ()
    FUNCTION = "load"
    CATEGORY = CATEGORY
    ARGUMENT = "name"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {cls.ARGUMENT: ("STRING", {"default": "stub"})}}

    def load(self, **kwargs):
        return (Stub(str(next(iter(kwargs.values()), "stub"))),)


class UNETLoader(_Loader):
    ARGUMENT = "unet_name"
    RETURN_TYPES = ("MODEL",)


class CLIPLoader(_Loader):
    ARGUMENT = "clip_name"
    RETURN_TYPES = ("CLIP",)


class VAELoader(_Loader):
    ARGUMENT = "vae_name"
    RETURN_TYPES = ("VAE",)


class _H3:
    """Records what the director asked for, then returns a latent of that geometry."""

    NAME = "MiniMaxH3"
    EXTRA: tuple[str, ...] = ()
    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "LATENT")
    FUNCTION = "encode"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "prompt": ("STRING", {"multiline": True, "default": ""}),
                "width": ("INT", {"default": 1344}),
                "height": ("INT", {"default": 768}),
                "length": ("INT", {"default": 124}),
            },
            "optional": {name: ("*",) for name in cls.EXTRA},
        }

    def encode(self, clip, vae, prompt, width, height, length, **extra):
        CALLS.append(
            {
                "node": self.NAME,
                "prompt": prompt,
                "width": width,
                "height": height,
                "length": length,
                "slots": _slot_names(extra),
            }
        )
        latent = {
            "samples": torch.zeros(1, 4, max(1, length // 17), height // 32, width // 32),
            "geometry": {"width": width, "height": height, "length": length},
        }
        return ([[torch.zeros(1, 8, 4096), {}]], latent)


def _slot_names(extra: dict) -> list[str]:
    """Flatten autogrow dicts back to the slot names the real node would have seen."""
    names: list[str] = []
    for key, value in extra.items():
        if value is None:
            continue
        if isinstance(value, dict):
            names.extend(name for name, item in value.items() if item is not None)
        elif isinstance(value, str):
            continue  # ref_image_size and friends are settings, not slots
        else:
            names.append(key)
    return sorted(names)


class MiniMaxH3ImageToVideo(_H3):
    NAME = "MiniMaxH3ImageToVideo"
    EXTRA = ("first_frame", "last_frame")


class MiniMaxH3ReferenceToVideo(_H3):
    NAME = "MiniMaxH3ReferenceToVideo"
    EXTRA = (
        "audio_vae",
        "ref_image_size",
        "ref_images",
        "ref_videos",
        "ref_video_audios",
        "ref_audios",
    )


class RandomNoise:
    RETURN_TYPES = ("NOISE",)
    FUNCTION = "get"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"noise_seed": ("INT", {"default": 0})}}

    def get(self, noise_seed):
        return (Stub(f"noise:{noise_seed}"),)


class KSamplerSelect:
    RETURN_TYPES = ("SAMPLER",)
    FUNCTION = "get"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"sampler_name": ("STRING", {"default": "res_multistep"})}}

    def get(self, sampler_name):
        return (Stub(f"sampler:{sampler_name}"),)


class BasicScheduler:
    RETURN_TYPES = ("SIGMAS",)
    FUNCTION = "get"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "scheduler": ("STRING", {"default": "simple"}),
                "steps": ("INT", {"default": 20}),
                "denoise": ("FLOAT", {"default": 1.0}),
            }
        }

    def get(self, model, scheduler, steps, denoise):
        return (torch.linspace(1.0, 0.0, steps + 1),)


class BasicGuider:
    RETURN_TYPES = ("GUIDER",)
    FUNCTION = "get"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "conditioning": ("CONDITIONING",)}}

    def get(self, model, conditioning):
        return (Stub("guider"),)


class SamplerCustomAdvanced:
    """Passes the latent through. Every shape assertion downstream still runs."""

    RETURN_TYPES = ("LATENT", "LATENT")
    RETURN_NAMES = ("output", "denoised_output")
    FUNCTION = "sample"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "noise": ("NOISE",),
                "guider": ("GUIDER",),
                "sampler": ("SAMPLER",),
                "sigmas": ("SIGMAS",),
                "latent_image": ("LATENT",),
            }
        }

    def sample(self, noise, guider, sampler, sigmas, latent_image):
        CALLS.append({"node": "SamplerCustomAdvanced", "steps": int(len(sigmas)) - 1})
        return (latent_image, latent_image)


def _geometry(latent) -> tuple[int, int, int]:
    meta = latent.get("geometry", {})
    return meta.get("length", 5), meta.get("height", 256), meta.get("width", 448)


class VAEDecode:
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "decode"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"samples": ("LATENT",), "vae": ("VAE",)}}

    def decode(self, samples, vae):
        length, height, width = _geometry(samples)
        ramp = torch.linspace(0.0, 1.0, length).view(length, 1, 1, 1)
        return (ramp.expand(length, height, width, 3).contiguous(),)


class VAEDecodeAudio:
    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "decode"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"samples": ("LATENT",), "vae": ("VAE",)}}

    def decode(self, samples, vae):
        length, _, _ = _geometry(samples)
        count = int(SAMPLE_RATE * length / FPS)
        tone = torch.sin(torch.arange(count) * (2 * math.pi * 440 / SAMPLE_RATE)) * 0.1
        return ({"waveform": tone.view(1, 1, -1).repeat(1, CHANNELS, 1),
                 "sample_rate": SAMPLE_RATE},)


REPLACEMENTS: dict[str, type] = {
    "UNETLoader": UNETLoader,
    "CLIPLoader": CLIPLoader,
    "VAELoader": VAELoader,
    "MiniMaxH3ImageToVideo": MiniMaxH3ImageToVideo,
    "MiniMaxH3ReferenceToVideo": MiniMaxH3ReferenceToVideo,
    "RandomNoise": RandomNoise,
    "KSamplerSelect": KSamplerSelect,
    "BasicScheduler": BasicScheduler,
    "BasicGuider": BasicGuider,
    "SamplerCustomAdvanced": SamplerCustomAdvanced,
    "VAEDecode": VAEDecode,
    "VAEDecodeAudio": VAEDecodeAudio,
}
"""Core node names the harness swaps out. `CreateVideo` and `SaveVideo` are deliberately
absent -- those run for real, so the test ends with an actual file on disk."""
