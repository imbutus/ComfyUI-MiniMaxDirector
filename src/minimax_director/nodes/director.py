"""The nodes ComfyUI sees.

Every reference the director sends comes off its own timeline, so the node has no
reference sockets at all -- the four autogrow families it used to carry put four spare
sockets on the node for a path nobody took. A socket carries a tensor and nothing that
says what the tensor is, and a file with nothing said about it is a file the prompt
cannot name; the timeline is where a file is attached *and* described.
"""

from __future__ import annotations

from comfy_api.latest import ComfyExtension, io, ui

from .. import attachments, core, references
from ..cast import EMPTY as CAST_EMPTY
from ..cast import merge_json as cast_merge
from ..compile import compile_timeline
from ..lint import Issue, lint
from ..timeline import Timeline

CATEGORY = "MiniMaxDirector"
MAX_RESOLUTION = 16384

DEFAULT_TIMELINE = """{
  "version": 1,
  "fps": 24,
  "duration": 124,
  "global_prompt": "",
  "shots": [],
  "moves": [],
  "cues": [],
  "references": []
}"""
"""124 frames is the shortest length the model was trained on, and it is on the lattice.

Starting with an explicit duration rather than none is what makes the clip a fixed thing
you arrange segments inside, instead of a bag that silently grows to fit whatever the
last drag did."""


def _path(record: dict) -> str:
    """How ComfyUI's loaders name a file in the input folder."""
    subfolder = (record.get("subfolder") or "").strip("/")
    name = record.get("filename", "")
    return f"{subfolder}/{name}" if subfolder else name


def _load(record: dict):
    """Read a file the timeline points at, through ComfyUI's own loaders.

    Reusing the core nodes means EXIF orientation, alpha, sample rates and container
    quirks are somebody else's solved problem rather than ours.

    A reference video yields two things: its frames, and the soundtrack that travels with
    it -- the core H3 node expects exactly that pair.
    """
    kind = record.get("kind")
    path = _path(record)

    if kind == "image":
        return core.call("LoadImage", image=path)[0], None
    if kind == "audio":
        return core.call("LoadAudio", audio=path)[0], None
    if kind == "video":
        video = core.call("LoadVideo", file=path)[0]
        images, audio, *_ = core.call("GetVideoComponents", video=video)
        return images, audio

    raise ValueError(f"Unknown attachment kind {kind!r} on the timeline")


def _present(entries) -> bool:
    """Whether any slot is filled.

    `any()` cannot be used here: the entries are tensors, and asking a multi-element
    tensor for its truth value raises rather than answering.
    """
    return any(entry is not None for entry in entries)


def _skewed(image, width: int, height: int) -> bool:
    """Whether fitting this picture to the clip would change its proportions.

    The tolerance is 2% of the clip's ratio: a picture rounded onto the 32-pixel grid is
    a fraction off and nobody can see it, so nothing is cropped and nothing is said.
    """
    if image is None or not width or not height:
        return False
    tall, wide = int(image.shape[1]), int(image.shape[2])
    if not tall or not wide:
        return False
    theirs, ours = wide / tall, width / height
    return abs(theirs - ours) > 0.02 * ours


def _fit(image, width: int, height: int, how: str = "crop"):
    """A keyframe brought to the clip's shape without distorting it.

    `MiniMaxH3ImageToVideo` fits `first_frame` with `crop="disabled"`
    (`comfy_extras/nodes_minimax_h3.py`), a plain scale to `width` x `height`: a square
    photograph in a wide clip comes out squashed, and nothing says so before the render.
    Since the keyframe is handed over by this node, it can arrive already at the clip's
    size, which turns core's resize into a no-op. The crop is `center`, the same
    aspect-preserving cover-crop core itself uses for `last_frame`: a face stays a face,
    and what goes is the edge of the picture rather than its proportions.

    Only a picture that would actually be skewed is touched. When the shapes agree there
    is nothing to protect the image from, so it is passed on exactly as it was loaded and
    core scales it -- one resize instead of two, and no needless resampling. `stretch` is
    the author saying they want core's own behaviour, so the picture is left alone there
    too and arrives squashed on purpose.
    """
    if how == "stretch" or not _skewed(image, width, height):
        return image

    import comfy.utils

    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, width, height, "lanczos", "center")
    return samples.movedim(1, -1)


def _refitted(image, width: int, height: int, role: str, how: str) -> Issue | None:
    """What fitting this keyframe costs, said before the render rather than after.

    Only a keyframe whose shape is not the clip's is worth a word, and what the word says
    depends on what was asked for: `crop` keeps the picture's proportions and loses an
    edge, `stretch` keeps every pixel and loses the proportions. Both name the two ways to
    have neither happen.
    """
    if not _skewed(image, width, height):
        return None
    tall, wide = int(image.shape[1]), int(image.shape[2])
    theirs, ours = wide / tall, width / height
    cost = (f"cover-cropped to fit and its "
            f"{'sides' if theirs > ours else 'top and bottom'} are outside the frame"
            if how != "stretch" else
            "stretched to fit, so its proportions change")
    return Issue(
        "warning",
        f"the {role} is {wide}x{tall} but the clip is {width}x{height}, so it is {cost}. "
        f"Give the clip the picture's shape to keep all of it, or attach the file as a "
        f"reference instead -- that path scales without cropping and lets the model "
        f"compose the rest of the frame.",
    )


def _report(issues) -> str:
    return "\n".join(str(issue) for issue in issues)


class MiniMaxDirector(io.ComfyNode):
    """Lay out shots on a timeline; get back H3's conditioning and starting latent."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxDirector",
            display_name="MiniMax Director",
            category=CATEGORY,
            description=(
                "Timeline director for MiniMax H3. Shots and audio cues compile into the "
                "structured prompt H3 reads, and the clip snaps to a valid length."
            ),
            inputs=[
                io.Clip.Input("clip"),
                io.Vae.Input("vae"),
                io.String.Input("timeline", multiline=True, default=DEFAULT_TIMELINE),
                io.Int.Input("width", default=1344, min=32, max=MAX_RESOLUTION, step=32),
                io.Int.Input("height", default=768, min=32, max=MAX_RESOLUTION, step=32),
                io.Combo.Input(
                    "ref_image_size", options=["match", "max"], default="match",
                    tooltip="How reference images are sized; 'max' is slower but keeps identity.",
                ),
                io.String.Input("cast", multiline=True, default=CAST_EMPTY, optional=True,
                                tooltip="Everything the prompt names -- people, props, "
                                        "costumes, places -- and the one place a file is "
                                        "described. Edited in the director's WHO & WHAT "
                                        "tab."),
                io.Vae.Input("audio_vae", optional=True),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Latent.Output(display_name="latent"),
                io.String.Output(display_name="prompt"),
                # No `length` output. The frame count is already in the `latent` the
                # sampler consumes and on the timeline's own clock, so a socket for it
                # only offered a third place for the same number to be read from.
                io.String.Output(display_name="report"),
            ],
        )

    @classmethod
    def execute(cls, clip, vae, timeline, width, height, ref_image_size="match",
                cast=None, audio_vae=None) -> io.NodeOutput:
        document = Timeline.from_json(cast_merge(timeline, cast))

        # Every reference comes off the timeline. It is the only place a file can be
        # described -- a socket carries a tensor and nothing that says what it is -- so a
        # wired one could only ever be an unnamed reference the prompt never mentions.
        # A block whose `used as` says it is a frame of the video is exactly that: its
        # image goes to the model's keyframe input instead of into the reference list,
        # which is the only way H3 can be given one. Two slots, so the first block claiming
        # each role takes it; a `keyframe` in the middle has nowhere to go and stays a
        # reference, as it always was.
        first_frame = last_frame = None
        fits = {"first frame": "crop", "last frame": "crop"}
        pictures = []
        for item in attachments.of_kind(document, "image"):
            role = str(item.record.get("role", "")).strip()
            image = _load(item.record)[0]
            if role == "first frame" and first_frame is None:
                first_frame = image
                fits[role] = str(item.record.get("fit", "") or "crop")
            elif role == "last frame" and last_frame is None:
                last_frame = image
                fits[role] = str(item.record.get("fit", "") or "crop")
            else:
                pictures.append(image)
        videos, soundtracks = [], []
        for item in attachments.of_kind(document, "video"):
            frames, sound = _load(item.record)
            videos.append(frames)
            soundtracks.append(sound)
        # Standalone audio: the recordings on the AUDIO track, and any clip dropped there,
        # which contributes its soundtrack and none of its frames. A block video's own
        # soundtrack is not one of these -- it travels with the video, in `ref_video_audios`,
        # which is why the origin is asked for rather than the record's kind alone.
        audios = []
        for item in attachments.collect(document):
            if item.kind != "audio" or item.origin is None or item.origin[0] != "cues":
                continue
            frames, sound = _load(item.record)
            audios.append(sound if item.record.get("kind") == "video" else frames)

        document = document.with_references(
            references.assign(pictures, videos, soundtracks, audios)
        )
        compiled = compile_timeline(
            document, first_frame=first_frame is not None,
            last_frame=last_frame is not None)
        issues = lint(document)

        # The core reference node has no `first_frame`, so a timeline holding both would
        # silently drop the keyframe rather than fail.
        if first_frame is not None and (
            _present(pictures) or _present(videos) or _present(audios)):
            issues.insert(0, Issue(
                "error",
                "a block used as first frame is ignored while the timeline also carries "
                "references: MiniMax H3 has no reference-plus-keyframe path. Use one or "
                "the other.",
            ))

        # Both keyframes arrive at the clip's shape, cover-cropped rather than stretched:
        # core would scale `first_frame` with no crop at all, and a square photograph in a
        # wide clip would be squashed on the way in.
        for image, role in ((first_frame, "first frame"), (last_frame, "last frame")):
            refitted = _refitted(image, width, height, role, fits[role])
            if refitted is not None:
                issues.insert(0, refitted)
        if first_frame is not None:
            first_frame = _fit(first_frame, width, height, fits["first frame"])
        if last_frame is not None:
            last_frame = _fit(last_frame, width, height, fits["last frame"])

        report = _report(issues)

        shared = {
            "clip": clip,
            "vae": vae,
            "prompt": compiled.prompt,
            "width": width,
            "height": height,
            "length": compiled.length,
        }

        if _present(pictures) or _present(videos) or _present(audios):
            positive, latent = core.call(
                "MiniMaxH3ReferenceToVideo",
                **shared,
                audio_vae=audio_vae,
                ref_image_size=ref_image_size,
                ref_images=references.slots("ref_image_", pictures),
                ref_videos=references.slots("ref_video_", videos),
                ref_video_audios=references.slots("ref_video_audio_", soundtracks),
                ref_audios=references.slots("ref_audio_", audios),
            )
        else:
            positive, latent = core.call(
                "MiniMaxH3ImageToVideo",
                **shared,
                first_frame=first_frame,
                last_frame=last_frame,
            )

        return io.NodeOutput(positive, latent, compiled.prompt, report)


class MiniMaxDirectorPrompt(io.ComfyNode):
    """Show the compiled prompt, updating as the timeline is edited.

    `PreviewAny` would display the same string, but only after a run: it fills from
    execution results, so while you are writing the timeline the box sits empty -- which
    is exactly when you want to read what the model is being told.

    This node exists so the editor has somewhere to put its own answer. Wire the
    director's `prompt` output to `source` and the web extension paints it here on every
    edit pause, compiled by the same code the graph would run. Executing the graph fills
    it the ordinary way, so the node is honest with the extension missing.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxDirectorPrompt",
            display_name="MiniMax Director — Prompt",
            category=CATEGORY,
            description=cls.__doc__,
            inputs=[io.String.Input("source", force_input=True)],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, source) -> io.NodeOutput:
        return io.NodeOutput(ui=ui.PreviewText(source or ""))


class MiniMaxDirectorReport(io.ComfyNode):
    """Show the linter's findings, updating as the timeline is edited.

    The same argument as `MiniMaxDirectorPrompt`, one step further: a warning that only
    appears after a run appears after the cost. Every check the linter makes is free and
    needs no model, so there is no reason to learn about a gap in the shot list from a
    finished video rather than from the panel you are already looking at.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxDirectorReport",
            display_name="MiniMax Director — Report",
            category=CATEGORY,
            description=cls.__doc__,
            inputs=[io.String.Input("source", force_input=True)],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, source) -> io.NodeOutput:
        return io.NodeOutput(ui=ui.PreviewText(source or ""))


# The pack ships the timeline node and the two panels that read back from it, and
# nothing else. A `Compile` node (a run with no model) and a `Length` node (seconds to a
# legal frame count) both existed for wiring a graph by hand; the timeline already hands
# out `length` and `seconds`, and the editor already compiles and lints on every edit
# pause, so both only offered a second way to reach an answer that was already on screen.
NODES = [
    MiniMaxDirector,
    MiniMaxDirectorPrompt,
    MiniMaxDirectorReport,
]


class MiniMaxDirectorExtension(ComfyExtension):
    async def get_node_list(self):
        return list(NODES)
