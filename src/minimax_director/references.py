"""Reference ordinals, assigned the way MiniMax H3 assigns them.

Getting this wrong does not crash anything -- it generates the wrong video, which is
worse. So the rule is stated once, here, read straight off
`comfy_extras/nodes_minimax_h3.py`:

References are presented to the text encoder in request order -- every image first,
then each reference video, then standalone audio. A video's soundtrack is emitted
*immediately before* its video, and it draws from the same `<Audio j>` counter that
standalone audio continues afterwards.

So wiring one video with a soundtrack plus one standalone audio yields::

    <Audio 1>   the soundtrack
    <Video 1>   the video
    <Audio 2>   the standalone clip

Numbering per slot index instead would call that standalone clip `<Audio 1>` and point
the prompt at the wrong sound.
"""

from __future__ import annotations

from typing import Any, Sequence

from .timeline import Reference


def assign(
    pictures: Sequence[Any],
    videos: Sequence[Any],
    video_audios: Sequence[Any],
    audios: Sequence[Any],
) -> list[Reference]:
    """Ordinals for the wired slots, in the order H3 presents them.

    Each sequence is positional: index 0 is slot 1, and `None` means "not connected".
    `video_audios[i]` is the soundtrack belonging to `videos[i]`.
    """
    assigned: list[Reference] = []
    picture_count = video_count = audio_count = 0

    for picture in pictures:
        if picture is None:
            continue
        picture_count += 1
        assigned.append(Reference("picture", picture_count))

    for index, video in enumerate(videos):
        if video is None:
            continue
        soundtrack = video_audios[index] if index < len(video_audios) else None
        if soundtrack is not None:
            audio_count += 1
            assigned.append(Reference("audio", audio_count))
        video_count += 1
        assigned.append(Reference("video", video_count))

    for audio in audios:
        if audio is None:
            continue
        audio_count += 1
        assigned.append(Reference("audio", audio_count))

    return assigned


def ordered(prefix: str, mapping: dict[str, Any] | None, count: int) -> list[Any]:
    """Unpack an autogrow dict back into a positional list.

    `{"ref_image_1": t}` with `count=3` becomes `[None, t, None]`, so slot numbers keep
    their meaning and `assign` can pair a video with its soundtrack by position.
    """
    mapping = mapping or {}
    return [mapping.get(f"{prefix}{index}") for index in range(count)]


def slots(prefix: str, values: Sequence[Any]) -> dict[str, Any]:
    """Pack wired slots into the autogrow dict the core node expects.

    The core node reads these as `{"ref_image_0": tensor, ...}` and pairs a video with
    its soundtrack by the numeric suffix, so the original slot number is preserved and
    unconnected slots are simply left out.
    """
    return {
        f"{prefix}{index}": value
        for index, value in enumerate(values)
        if value is not None
    }
