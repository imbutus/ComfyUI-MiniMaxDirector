"""The refit: keyframes re-encoded at the size of the latent the refine pass samples.

Issue #4: a picture used as a first or last frame is encoded at the timeline's size, and
the Upscale branch sampled a bigger latent with that same conditioning -- the model lays
keyframe rows out on the grid of the latent it is given, so the two disagreed and the
refine pass failed with a shape mismatch. These check that the refit re-encodes each
keyframe at the latent's size, keeps everything else, and leaves keyframe-less
conditioning alone.
"""

from __future__ import annotations

import pytest

from .harness import boot, comfy_path

pytestmark = pytest.mark.skipif(comfy_path() is None, reason="COMFYUI_PATH is not set")


class FakeVAE:
    """Sixteen pixels a cell each way, like H3's; the picture's mean rides along in the
    latent so a decode gives back something of the right size."""

    def encode(self, image):
        import torch

        _, height, width, _ = image.shape
        return torch.full((1, 24, 1, height // 16, width // 16), float(image.mean()))

    def decode(self, latent):
        import torch

        _, _, _, cells_tall, cells_wide = latent.shape
        return torch.full((1, cells_tall * 16, cells_wide * 16, 3), float(latent.mean()))


@pytest.fixture(scope="module")
def refit():
    boot()
    from minimax_director.nodes.director import MiniMaxDirectorRefit

    def run(positive, latent):
        return MiniMaxDirectorRefit.execute(positive, latent, FakeVAE()).args[0]

    return run


def conditioning(width: int, height: int, first: bool = True, last: bool = True):
    import torch

    vae = FakeVAE()
    keyframes = []
    if first:
        keyframes.append({"resolved_frame_index": 0,
                          "latent": vae.encode(torch.full((1, height, width, 3), 0.25))})
    if last:
        keyframes.append({"resolved_frame_index": 123,
                          "latent": vae.encode(torch.full((1, height, width, 3), 0.75))})
    extra = {"minimax_frame_count": 124, "ref_images": ["kept"]}
    if keyframes:
        extra["minimax_keyframes"] = keyframes
    return [[torch.zeros(1, 8, 16), extra]]


def latent(width: int, height: int):
    import torch

    return {"samples": torch.zeros(1, 24, 8, height // 16, width // 16)}


def test_every_keyframe_comes_out_at_the_latents_size(refit):
    out = refit(conditioning(448, 256), latent(640, 384))
    shapes = [tuple(k["latent"].shape[-2:]) for k in out[0][1]["minimax_keyframes"]]
    assert shapes == [(384 // 16, 640 // 16)] * 2


def test_the_frame_index_and_the_rest_of_the_conditioning_are_kept(refit):
    given = conditioning(448, 256)
    out = refit(given, latent(640, 384))
    assert [k["resolved_frame_index"] for k in out[0][1]["minimax_keyframes"]] == [0, 123]
    assert out[0][1]["minimax_frame_count"] == 124
    assert out[0][1]["ref_images"] == ["kept"]
    assert out[0][0] is given[0][0]


def test_the_picture_survives_the_round_trip(refit):
    out = refit(conditioning(448, 256), latent(640, 384))
    means = [float(k["latent"].mean()) for k in out[0][1]["minimax_keyframes"]]
    # lanczos in core goes through 8-bit, so a code value of give is expected
    assert means == pytest.approx([0.25, 0.75], abs=1 / 255)


def test_conditioning_without_keyframes_passes_through_as_it_is(refit):
    given = conditioning(448, 256, first=False, last=False)
    out = refit(given, latent(640, 384))
    assert out[0][1] is given[0][1]


def test_the_given_conditioning_is_not_changed_in_place(refit):
    given = conditioning(448, 256)
    before = tuple(given[0][1]["minimax_keyframes"][0]["latent"].shape)
    refit(given, latent(640, 384))
    assert tuple(given[0][1]["minimax_keyframes"][0]["latent"].shape) == before
