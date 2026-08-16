"""The nodes ComfyUI sees.

Every reference the director sends comes off its own timeline, so the node has no
reference sockets at all -- the four autogrow families it used to carry put four spare
sockets on the node for a path nobody took. A socket carries a tensor and nothing that
says what the tensor is, and a file with nothing said about it is a file the prompt
cannot name; the timeline is where a file is attached *and* described.
"""

from __future__ import annotations

from comfy_api.latest import ComfyExtension, io, ui

from .. import attachments, core, lattice, references
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


def _fit(image, width: int, height: int):
    """A keyframe brought to the clip's shape without distorting it.

    `MiniMaxH3ImageToVideo` fits `first_frame` with `crop="disabled"`
    (`comfy_extras/nodes_minimax_h3.py`), a plain scale to `width` x `height`: a square
    photograph in a wide clip comes out squashed, and nothing says so before the render.
    Since the keyframe is handed over by this node, it can arrive already at the clip's
    size, which turns core's resize into a no-op. The crop is `center`, the same
    aspect-preserving cover-crop core itself uses for `last_frame`: a face stays a face,
    and what goes is the edge of the picture rather than its proportions.
    """
    import comfy.utils

    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, width, height, "lanczos", "center")
    return samples.movedim(1, -1)


def _cropped(image, width: int, height: int, role: str) -> Issue | None:
    """What the fit above had to take off, said out loud.

    Losing the edges of a picture is a smaller surprise than losing its proportions, but
    it is still a surprise: the author framed that photograph, and part of it is not in
    the clip. The message names both shapes and the two ways to keep the whole frame.
    """
    if image is None:
        return None
    tall, wide = int(image.shape[1]), int(image.shape[2])
    if not tall or not wide or not width or not height:
        return None
    theirs, ours = wide / tall, width / height
    # A frame's worth of rounding on a 32-pixel grid is not worth a warning.
    if abs(theirs - ours) <= 0.02 * ours:
        return None
    return Issue(
        "warning",
        f"the {role} is {wide}x{tall} but the clip is {width}x{height}, so it is "
        f"cover-cropped to fit and its {'sides' if theirs > ours else 'top and bottom'} "
        f"are outside the frame. Give the clip the picture's shape to keep all of it, or "
        f"attach the file as a reference instead -- that path scales without cropping and "
        f"lets the model compose the rest of the frame.",
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
                io.Int.Output(display_name="length"),
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
        pictures = []
        for item in attachments.of_kind(document, "image"):
            role = str(item.record.get("role", "")).strip()
            image = _load(item.record)[0]
            if role == "first frame" and first_frame is None:
                first_frame = image
            elif role == "last frame" and last_frame is None:
                last_frame = image
            else:
                pictures.append(image)
        videos, soundtracks = [], []
        for item in attachments.of_kind(document, "video"):
            frames, sound = _load(item.record)
            videos.append(frames)
            soundtracks.append(sound)
        audios = [_load(a.record)[0] for a in attachments.of_kind(document, "audio")]

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
            cropped = _cropped(image, width, height, role)
            if cropped is not None:
                issues.insert(0, cropped)
        if first_frame is not None:
            first_frame = _fit(first_frame, width, height)
        if last_frame is not None:
            last_frame = _fit(last_frame, width, height)

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

        return io.NodeOutput(positive, latent, compiled.prompt, compiled.length, report)


class MiniMaxDirectorCompile(io.ComfyNode):
    """Compile a timeline to text without touching the model.

    The same code path the director takes, so a prompt can be reviewed or hand-edited
    before it costs a generation.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxDirectorCompile",
            display_name="MiniMax Director — Compile",
            category=CATEGORY,
            description=cls.__doc__,
            inputs=[
                io.String.Input("timeline", multiline=True, default=DEFAULT_TIMELINE),
                io.String.Input("cast", multiline=True, default=CAST_EMPTY, optional=True),
            ],
            outputs=[
                io.String.Output(display_name="prompt"),
                io.Int.Output(display_name="length"),
                io.Float.Output(display_name="seconds"),
                io.String.Output(display_name="report"),
            ],
        )

    @classmethod
    def execute(cls, timeline, cast=None) -> io.NodeOutput:
        document = Timeline.from_json(cast_merge(timeline, cast))
        compiled = compile_timeline(document)
        return io.NodeOutput(
            compiled.prompt, compiled.length, compiled.duration, _report(lint(document))
        )


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


class MiniMaxDirectorLength(io.ComfyNode):
    """Snap a duration in seconds to a length H3 accepts."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxDirectorLength",
            display_name="MiniMax Director — Length",
            category=CATEGORY,
            description=cls.__doc__,
            inputs=[
                io.Float.Input("seconds", default=5.0, min=0.2, max=120.0, step=0.1)
            ],
            outputs=[
                io.Int.Output(display_name="length"),
                io.Float.Output(display_name="seconds"),
            ],
        )

    @classmethod
    def execute(cls, seconds) -> io.NodeOutput:
        length = lattice.from_seconds(seconds)
        return io.NodeOutput(length, lattice.to_seconds(length))


NODES = [
    MiniMaxDirector,
    MiniMaxDirectorCompile,
    MiniMaxDirectorPrompt,
    MiniMaxDirectorReport,
    MiniMaxDirectorLength,
]


class MiniMaxDirectorExtension(ComfyExtension):
    async def get_node_list(self):
        return list(NODES)
