"""The nodes ComfyUI sees.

These use ComfyUI's V3 schema, for one reason that matters: `io.Autogrow`. Declaring
nine picture slots as plain optional inputs puts a wall of 27 sockets on the node and
pushes the timeline off the bottom of it. Autogrow shows only the slots in use plus one
spare, which is what the core H3 node does and what leaves room for the editor.
"""

from __future__ import annotations

from comfy_api.latest import ComfyExtension, io

from .. import core, lattice, references
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
  "dialect": "timeline",
  "global_prompt": "",
  "shots": [],
  "cues": [],
  "references": []
}"""


def _grow(name: str, prefix: str, input_type, maximum: int):
    return io.Autogrow.Input(
        name,
        optional=True,
        template=io.Autogrow.TemplatePrefix(
            input=input_type, prefix=prefix, min=0, max=maximum
        ),
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
        pictures = references.ordered("ref_image_", ref_images, MAX_PICTURES)
        videos = references.ordered("ref_video_", ref_videos, MAX_VIDEOS)
        soundtracks = references.ordered("ref_video_audio_", ref_video_audios, MAX_VIDEOS)
        audios = references.ordered("ref_audio_", ref_audios, MAX_AUDIOS)

        document = Timeline.from_json(timeline).with_references(
            references.assign(pictures, videos, soundtracks, audios)
        )
        compiled = compile_timeline(document)
        issues = lint(document)

        # The core reference node has no `first_frame`, so wiring both silently drops the
        # guide -- which is exactly how a chained window loses its continuity.
        if first_frame is not None and (ref_images or ref_videos or ref_audios):
            issues.insert(0, Issue(
                "error",
                "first_frame is ignored when references are wired: MiniMax H3 has no "
                "reference-plus-keyframe path. Chain windows without references, or drop "
                "the first_frame.",
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

        if ref_images or ref_videos or ref_audios:
            positive, latent = core.call(
                "MiniMaxH3ReferenceToVideo",
                **shared,
                audio_vae=audio_vae,
                ref_image_size=ref_image_size,
                ref_images=ref_images,
                ref_videos=ref_videos,
                ref_video_audios=ref_video_audios,
                ref_audios=ref_audios,
            )
        else:
            positive, latent = core.call(
                "MiniMaxH3ImageToVideo",
                **shared,
                first_frame=first_frame,
                last_frame=last_frame,
            )

        return io.NodeOutput(positive, latent, compiled.prompt, compiled.length, report)


class MiniMaxDirectorChain(io.ComfyNode):
    """Continue a timeline into its next window, starting from the frame just rendered.

    H3's trained range is roughly 5-15 seconds, so a longer piece has to be generated in
    windows. Rendering them independently produces jump cuts: nothing tells window two
    what window one ended on.

    This closes that loop. Feed it the decoded frames of the window just rendered and it
    hands back two things -- that window's last frame, to wire into the next Director's
    `first_frame`, and the same timeline with its window advanced. One document, one
    shot list, rendered in legal-length pieces that actually join.

    `overlap` re-renders the tail of the previous window. A frame or two hides the seam
    where the model's first frame is a slightly imperfect reconstruction of the guide.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxDirectorChain",
            display_name="MiniMax Director — Chain",
            category=CATEGORY,
            description=cls.__doc__,
            inputs=[
                io.Image.Input("frames", tooltip="Decoded frames of the window just rendered"),
                io.String.Input("timeline", multiline=True, default=DEFAULT_TIMELINE),
                io.Int.Input("overlap", default=0, min=0, max=120,
                             tooltip="Frames of the previous window to render again, hiding the seam"),
            ],
            outputs=[
                io.Image.Output(display_name="last_frame"),
                io.String.Output(display_name="timeline"),
                io.Int.Output(display_name="start"),
                io.Boolean.Output(display_name="more"),
            ],
        )

    @classmethod
    def execute(cls, frames, timeline, overlap=0) -> io.NodeOutput:
        advanced = Timeline.from_json(timeline).advanced(overlap)
        return io.NodeOutput(
            frames[-1:], advanced.to_json(indent=2), advanced.start, not advanced.exhausted
        )


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


NODES = [MiniMaxDirector, MiniMaxDirectorChain, MiniMaxDirectorCompile,
         MiniMaxDirectorLength]


class MiniMaxDirectorExtension(ComfyExtension):
    async def get_node_list(self):
        return list(NODES)
