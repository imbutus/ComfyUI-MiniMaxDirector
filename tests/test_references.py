"""Ordinals must match what the core H3 node presents to the text encoder.

A mistake here does not raise -- it points the prompt at the wrong clip and generates
the wrong video, so these cases are pinned deliberately tightly.
"""

from minimax_director.references import assign, slots

IMG = "image"
AUD = "audio"
VID = "video"


def tokens(*args):
    return [ref.token for ref in assign(*args)]


def test_images_number_in_order():
    assert tokens([IMG, IMG, IMG], [], [], []) == [
        "<Picture 1>",
        "<Picture 2>",
        "<Picture 3>",
    ]


def test_a_skipped_slot_does_not_skip_an_ordinal():
    assert tokens([None, IMG, None, IMG], [], [], []) == ["<Picture 1>", "<Picture 2>"]


def test_a_soundtrack_is_labelled_before_its_video():
    assert tokens([], [VID], [AUD], []) == ["<Audio 1>", "<Video 1>"]


def test_a_video_without_a_soundtrack_takes_no_audio_ordinal():
    assert tokens([], [VID], [None], [AUD]) == ["<Video 1>", "<Audio 1>"]


def test_standalone_audio_continues_the_soundtrack_counter():
    # The case that a per-slot numbering scheme gets wrong.
    assert tokens([], [VID], [AUD], [AUD]) == ["<Audio 1>", "<Video 1>", "<Audio 2>"]


def test_the_full_presentation_order_is_images_videos_then_audio():
    assert tokens([IMG], [VID, VID], [AUD, None], [AUD]) == [
        "<Picture 1>",
        "<Audio 1>",
        "<Video 1>",
        "<Video 2>",
        "<Audio 2>",
    ]


def test_nothing_wired_yields_nothing():
    assert assign([None], [None], [None], [None]) == []


def test_slots_preserve_the_original_index_for_pairing():
    packed = slots("ref_video_", [None, VID, None])
    assert packed == {"ref_video_1": VID}


def test_slots_drop_unconnected_inputs():
    assert slots("ref_image_", [IMG, None, IMG]) == {
        "ref_image_0": IMG,
        "ref_image_2": IMG,
    }


def test_a_video_and_its_soundtrack_share_a_suffix():
    videos = slots("ref_video_", [None, VID])
    soundtracks = slots("ref_video_audio_", [None, AUD])
    assert "ref_video_1" in videos
    assert "ref_video_audio_1" in soundtracks
