"""A stand-in for the model, so the graph can be exercised without a GPU.

MiniMax H3 is roughly 50 GB of weights and needs a large card. Almost none of that is
needed to answer the questions this project actually has to get right: does the graph
wire up, do the types line up, does the timeline snap to a legal length, and -- above
all -- what exact string reaches the text encoder.

Set `MINIMAX_DIRECTOR_MOCK=1` and these classes take over the names of the real loaders
and samplers, so the *unmodified* production workflow runs end to end on CPU and writes
a real (meaningless) mp4. Set `MINIMAX_DIRECTOR_MOCK_LOG=/path/to/log.jsonl` and every
prompt handed to H3 is appended there, which is what the test suite asserts against.

Nothing in this file is imported unless mocking is on.
"""

from __future__ import annotations

import json
import os
from typing import Any

SAMPLE_RATE = 44100
CHANNELS = 2

MOCK_FLAG = "MINIMAX_DIRECTOR_MOCK"
MOCK_LOG = "MINIMAX_DIRECTOR_MOCK_LOG"

CATEGORY = "MiniMaxDirector/mock"


def enabled() -> bool:
    return os.environ.get(MOCK_FLAG, "") == "1"


def record(event: dict[str, Any]) -> None:
    """Append one observation to the log, if a log was asked for."""
    path = os.environ.get(MOCK_LOG)
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def _torch():
    import torch  # imported late: the pure compiler tests must not need it

    return torch


class _Stub:
    """A named placeholder that stands in for a loaded weight file."""

    def __init__(self, name: str):
        self.name = name

    def __repr__(self) -> str:
        return f"<mock {self.name}>"


# -- loaders ---------------------------------------------------------------


class _Loader:
    """Shared shape for the three loaders: take a filename, hand back a stub."""

    ARGUMENT = "name"
    RETURN_TYPES = ()
    FUNCTION = "load"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {cls.ARGUMENT: ("STRING", {"default": "mock"})}}

    def load(self, **kwargs):
        return (_Stub(str(next(iter(kwargs.values()), "mock"))),)


class MockUNETLoader(_Loader):
    ARGUMENT = "unet_name"
    RETURN_TYPES = ("MODEL",)


class MockCLIPLoader(_Loader):
    ARGUMENT = "clip_name"
    RETURN_TYPES = ("CLIP",)


class MockVAELoader(_Loader):
    ARGUMENT = "vae_name"
    RETURN_TYPES = ("VAE",)


# -- H3 ---------------------------------------------------------------------


class _H3:
    """Records the prompt, then returns a latent carrying the requested geometry."""

    NAME = "MiniMaxH3"
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
            "optional": {name: (kind,) for name, kind in cls.SLOTS},
        }

    SLOTS: tuple[tuple[str, str], ...] = ()

    def encode(self, clip, vae, prompt, width, height, length, **slots):
        wired = sorted(name for name, value in slots.items() if value is not None)
        record(
            {
                "node": self.NAME,
                "prompt": prompt,
                "width": width,
                "height": height,
                "length": length,
                "slots": wired,
            }
        )
        torch = _torch()
        latent = {
            "samples": torch.zeros(1, 4, max(1, length // 17), height // 32, width // 32),
            "mock": {"width": width, "height": height, "length": length},
        }
        return ([[torch.zeros(1, 8, 4096), {}]], latent)


class MockMiniMaxH3ImageToVideo(_H3):
    NAME = "MiniMaxH3ImageToVideo"
    SLOTS = (("first_frame", "IMAGE"), ("last_frame", "IMAGE"))


class MockMiniMaxH3ReferenceToVideo(_H3):
    NAME = "MiniMaxH3ReferenceToVideo"
    SLOTS = (
        ("audio_vae", "VAE"),
        ("ref_image_0", "IMAGE"),
        ("ref_image_1", "IMAGE"),
        ("ref_image_2", "IMAGE"),
        ("ref_video_0", "IMAGE"),
        ("ref_audio_0", "AUDIO"),
    )


# -- sampling ---------------------------------------------------------------


class MockRandomNoise:
    RETURN_TYPES = ("NOISE",)
    FUNCTION = "get"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"noise_seed": ("INT", {"default": 0})}}

    def get(self, noise_seed):
        return (_Stub(f"noise:{noise_seed}"),)


class MockKSamplerSelect:
    RETURN_TYPES = ("SAMPLER",)
    FUNCTION = "get"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"sampler_name": ("STRING", {"default": "res_multistep"})}}

    def get(self, sampler_name):
        return (_Stub(f"sampler:{sampler_name}"),)


class MockBasicScheduler:
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
        return (_torch().linspace(1.0, 0.0, steps + 1),)


class MockBasicGuider:
    RETURN_TYPES = ("GUIDER",)
    FUNCTION = "get"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "conditioning": ("CONDITIONING",)}}

    def get(self, model, conditioning):
        return (_Stub("guider"),)


class MockSamplerCustomAdvanced:
    """Passes the latent through untouched, which is exactly the useful behaviour:
    every shape assertion downstream still runs, and nothing takes a minute."""

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
        record({"node": "SamplerCustomAdvanced", "steps": int(len(sigmas)) - 1})
        return (latent_image, latent_image)


# -- decoding ---------------------------------------------------------------


def _geometry(latent) -> tuple[int, int, int]:
    meta = latent.get("mock", {})
    return meta.get("length", 5), meta.get("height", 256), meta.get("width", 448)


class MockVAEDecode:
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "decode"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"samples": ("LATENT",), "vae": ("VAE",)}}

    def decode(self, samples, vae):
        torch = _torch()
        length, height, width = _geometry(samples)
        ramp = torch.linspace(0.0, 1.0, length).view(length, 1, 1, 1)
        return (ramp.expand(length, height, width, 3).contiguous(),)


class MockVAEDecodeAudio:
    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "decode"
    CATEGORY = CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"samples": ("LATENT",), "vae": ("VAE",)}}

    def decode(self, samples, vae):
        torch = _torch()
        length, _, _ = _geometry(samples)
        count = int(SAMPLE_RATE * length / 24)
        tone = torch.sin(torch.arange(count) * (2 * 3.141592653589793 * 440 / SAMPLE_RATE))
        return ({"waveform": tone.view(1, 1, -1).repeat(1, CHANNELS, 1) * 0.1,
                 "sample_rate": SAMPLE_RATE},)


REPLACEMENTS: dict[str, type] = {
    "UNETLoader": MockUNETLoader,
    "CLIPLoader": MockCLIPLoader,
    "VAELoader": MockVAELoader,
    "MiniMaxH3ImageToVideo": MockMiniMaxH3ImageToVideo,
    "MiniMaxH3ReferenceToVideo": MockMiniMaxH3ReferenceToVideo,
    "RandomNoise": MockRandomNoise,
    "KSamplerSelect": MockKSamplerSelect,
    "BasicScheduler": MockBasicScheduler,
    "BasicGuider": MockBasicGuider,
    "SamplerCustomAdvanced": MockSamplerCustomAdvanced,
    "VAEDecode": MockVAEDecode,
    "VAEDecodeAudio": MockVAEDecodeAudio,
}
"""Core node names this file takes over. The names are deliberately the real ones so
the production workflow JSON needs no edit to run under mocks."""
