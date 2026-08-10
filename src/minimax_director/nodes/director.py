"""The nodes ComfyUI sees.

These use ComfyUI's V3 schema, for one reason that matters: `io.Autogrow`. Declaring
nine picture slots as plain optional inputs puts a wall of 27 sockets on the node and
pushes the timeline off the bottom of it. Autogrow shows only the slots in use plus one
spare, which is what the core H3 node does and what leaves room for the editor.
"""

from __future__ import annotations

from comfy_api.latest import ComfyExtension, io, ui

from .. import attachments, core, lattice, references
from ..compile import compile_timeline
from ..lint import Issue, lint
from ..timeline import Timeline

CATEGORY = "MiniMaxDirector"
MAX_RESOLUTION = 16384

MAX_PICTURES = 9
MAX_VIDEOS = 3
MAX_AUDIOS = 3
"""Mirrors the core node's autogrow templates exactly."""

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


def _grow(name: str, prefix: str, input_type, maximum: int):
    return io.Autogrow.Input(
        name,
        optional=True,
        template=io.Autogrow.TemplatePrefix(
            input=input_type, prefix=prefix, min=0, max=maximum
        ),
    )


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
                io.Vae.Input("audio_vae", optional=True),
                io.Image.Input("first_frame", optional=True),
                io.Image.Input("last_frame", optional=True),
                _grow("ref_images", "ref_image_", io.Image.Input("ref_image"), MAX_PICTURES),
                _grow("ref_videos", "ref_video_", io.Image.Input("ref_video"), MAX_VIDEOS),
                _grow("ref_video_audios", "ref_video_audio_",
                      io.Audio.Input("ref_video_audio"), MAX_VIDEOS),
                _grow("ref_audios", "ref_audio_", io.Audio.Input("ref_audio"), MAX_AUDIOS),
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
                audio_vae=None, first_frame=None, last_frame=None, ref_images=None,
                ref_videos=None, ref_video_audios=None, ref_audios=None) -> io.NodeOutput:
        document = Timeline.from_json(timeline)

        # Files on the timeline come first and files wired into sockets follow, so the
        # ordinals the compiler wrote into the prompt are the ones the model receives.
        # The timeline is where an author actually looks, so it owns the numbering.
        pictures = [_load(a.record)[0] for a in attachments.of_kind(document, "image")]
        videos, soundtracks = [], []
        for item in attachments.of_kind(document, "video"):
            frames, sound = _load(item.record)
            videos.append(frames)
            soundtracks.append(sound)
        audios = [_load(a.record)[0] for a in attachments.of_kind(document, "audio")]

        pictures += references.ordered("ref_image_", ref_images, MAX_PICTURES)
        videos += references.ordered("ref_video_", ref_videos, MAX_VIDEOS)
        soundtracks += references.ordered("ref_video_audio_", ref_video_audios, MAX_VIDEOS)
        audios += references.ordered("ref_audio_", ref_audios, MAX_AUDIOS)

        document = document.with_references(
            references.assign(pictures, videos, soundtracks, audios)
        )
        compiled = compile_timeline(
            document, first_frame=first_frame is not None,
            last_frame=last_frame is not None)
        issues = lint(document)

        # The core reference node has no `first_frame`, so wiring both would silently
        # drop the keyframe rather than fail.
        if first_frame is not None and (
            _present(pictures) or _present(videos) or _present(audios)):
            issues.insert(0, Issue(
                "error",
                "first_frame is ignored when references are wired: MiniMax H3 has no "
                "reference-plus-keyframe path. Use one or the other.",
            ))

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
            inputs=[io.String.Input("timeline", multiline=True, default=DEFAULT_TIMELINE)],
            outputs=[
                io.String.Output(display_name="prompt"),
                io.Int.Output(display_name="length"),
                io.Float.Output(display_name="seconds"),
                io.String.Output(display_name="report"),
            ],
        )

    @classmethod
    def execute(cls, timeline) -> io.NodeOutput:
        document = Timeline.from_json(timeline)
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
    MiniMaxDirectorLength,
]


class MiniMaxDirectorExtension(ComfyExtension):
    async def get_node_list(self):
        return list(NODES)
