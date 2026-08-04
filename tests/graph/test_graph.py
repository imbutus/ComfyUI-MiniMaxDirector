"""End-to-end: a real ComfyUI graph, a real mp4, no weights.

Skipped unless `COMFYUI_PATH` points at a ComfyUI checkout.
"""

from __future__ import annotations

import json
import time

import pytest

from . import harness

pytestmark = pytest.mark.skipif(
    harness.comfy_path() is None,
    reason="set COMFYUI_PATH to a ComfyUI checkout to run the graph tests",
)

TIMELINE = {
    "global_prompt": "Neon-lit alley after rain, cyan and magenta signage, 35mm grain.",
    "dialect": "timeline",
    "shots": [
        {"start": 0, "length": 24, "prompt": "Wide shot of the alley.", "camera": "dolly_in"},
        {"start": 24, "length": 36, "prompt": "Close on the collar, rain beading."},
    ],
    "cues": [{"start": 0, "length": 48, "prompt": "Distant siren, then rain on metal."}],
}


def base_graph(prefix: str) -> dict:
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "stub-unet"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "stub-clip"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "stub-video-vae"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "stub-audio-vae"}},
        "5": {
            "class_type": "MiniMaxDirector",
            "inputs": {
                "clip": ["2", 0],
                "vae": ["3", 0],
                "audio_vae": ["4", 0],
                "timeline": json.dumps(TIMELINE),
                "width": 448,
                "height": 256,
                "ref_image_size": "match",
            },
        },
        "6": {"class_type": "RandomNoise", "inputs": {"noise_seed": 7}},
        "7": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "8": {
            "class_type": "BasicScheduler",
            "inputs": {"model": ["1", 0], "scheduler": "simple", "steps": 4, "denoise": 1.0},
        },
        "9": {"class_type": "BasicGuider", "inputs": {"model": ["1", 0], "conditioning": ["5", 0]}},
        "10": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["6", 0],
                "guider": ["9", 0],
                "sampler": ["7", 0],
                "sigmas": ["8", 0],
                "latent_image": ["5", 1],
            },
        },
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 0], "vae": ["3", 0]}},
        "12": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["10", 0], "vae": ["4", 0]}},
        "13": {
            "class_type": "CreateVideo",
            "inputs": {"images": ["11", 0], "fps": 24.0, "audio": ["12", 0]},
        },
        "14": {
            "class_type": "SaveVideo",
            "inputs": {
                "video": ["13", 0],
                "filename_prefix": prefix,
                "format": "auto",
                "codec": "auto",
            },
        },
    }


@pytest.fixture(scope="module")
def run():
    prefix = f"minimax-director-test-{int(time.time())}"
    result = harness.run(base_graph(prefix), outputs=["14"])
    result["prefix"] = prefix
    return result


def h3_call(result):
    return next(call for call in result["calls"] if call["node"].startswith("MiniMaxH3"))


def test_the_graph_executes(run):
    assert run["calls"], "no stub was reached"


def test_an_mp4_is_written(run):
    written = list(harness.output_dir().rglob(f"{run['prefix']}*"))
    assert written, "SaveVideo produced no file"
    assert written[0].stat().st_size > 0


def test_text_to_video_is_chosen_when_no_reference_is_wired(run):
    assert h3_call(run)["node"] == "MiniMaxH3ImageToVideo"
    assert h3_call(run)["slots"] == []


def test_the_compiled_prompt_reaches_the_encoder(run):
    prompt = h3_call(run)["prompt"]
    assert prompt.startswith("Neon-lit alley after rain")
    assert "Timeline:\n[0s-1s] Wide shot of the alley. The camera dollies slowly in." in prompt
    assert "Audio:\n[0s-2s] Distant siren, then rain on metal." in prompt


def test_the_length_is_on_the_lattice(run):
    call = h3_call(run)
    assert call["length"] == 73
    assert call["length"] % 17 == 5


def test_the_geometry_survives_the_round_trip(run):
    call = h3_call(run)
    assert (call["width"], call["height"]) == (448, 256)


# --- media attached on the timeline, with nothing wired ----------------------

MEDIA_TIMELINE = {
    "global_prompt": "Neon-lit alley after rain.",
    "dialect": "timeline",
    "shots": [
        {"start": 0, "length": 48, "prompt": "The alley",
         "media": {"kind": "image", "filename": "example.png", "subfolder": ""}},
    ],
}


def media_graph(prefix):
    graph = base_graph(prefix)
    graph["5"]["inputs"]["timeline"] = json.dumps(MEDIA_TIMELINE)
    return graph


@pytest.fixture(scope="module")
def media_run():
    prefix = f"minimax-director-media-{int(time.time())}"
    result = harness.run(media_graph(prefix), outputs=["14"])
    result["prefix"] = prefix
    return result


def test_an_attached_image_reaches_the_model(media_run):
    call = h3_call(media_run)
    assert call["node"] == "MiniMaxH3ReferenceToVideo"
    assert "ref_image_0" in call["slots"]


def test_the_prompt_names_the_attached_image(media_run):
    assert "The alley <Picture 1>" in h3_call(media_run)["prompt"]


def test_no_loader_node_is_needed(media_run):
    wired = [c for c in media_run["calls"] if c["node"].startswith("MiniMaxH3")]
    assert len(wired) == 1  # one H3 call, fed entirely from the timeline
