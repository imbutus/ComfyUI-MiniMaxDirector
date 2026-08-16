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
    """The string the encoder receives is the whole product, so it is asserted whole."""
    prompt = h3_call(run)["prompt"]
    assert prompt.startswith(
        "integrated_multimodal_description: [Shot 1] Neon-lit alley after rain")
    assert "Wide shot of the alley. The camera pushes in with small amplitude" in prompt
    assert "[Shot 2] At 00:01.000, the camera cuts to Close on the collar" in prompt
    assert "\n\noverall_soundscape: Distant siren, then rain on metal." in prompt
    assert "\n\nnon_diegetic_music: N/A" in prompt


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


# --- a keyframe whose shape is not the clip's --------------------------------


class _Picture:
    """Just the shape: `_cropped` reads nothing else off an image."""

    def __init__(self, tall: int, wide: int):
        self.shape = (1, tall, wide, 3)


def cropped(*args):
    harness.boot()
    from minimax_director.nodes.director import _cropped

    return _cropped(*args)


def test_a_square_first_frame_in_a_wide_clip_is_reported():
    issue = cropped(_Picture(1024, 1024), 1280, 832, "first frame")
    assert issue is not None
    assert "1024x1024" in issue.message and "1280x832" in issue.message
    assert "cover-cropped" in issue.message
    assert "top and bottom" in issue.message  # a square in a wide clip loses height
    assert "reference" in issue.message  # the way out is named


def test_a_tall_picture_in_a_wide_clip_loses_its_top_and_bottom():
    assert "top and bottom" in cropped(_Picture(1600, 900), 1280, 832, "first frame").message


def test_a_wider_picture_than_the_clip_loses_its_sides():
    assert "sides" in cropped(_Picture(600, 1600), 1280, 832, "first frame").message


def test_a_keyframe_of_the_clip_s_own_shape_says_nothing():
    assert cropped(_Picture(832, 1280), 1280, 832, "first frame") is None


def test_no_keyframe_is_not_a_finding():
    assert cropped(None, 1280, 832, "first frame") is None


def test_the_keyframe_reaches_the_model_at_the_clip_s_size():
    harness.boot()
    import torch

    from minimax_director.nodes.director import _fit

    fitted = _fit(torch.zeros(1, 1024, 1024, 3), 1280, 832)
    assert tuple(fitted.shape) == (1, 832, 1280, 3)
