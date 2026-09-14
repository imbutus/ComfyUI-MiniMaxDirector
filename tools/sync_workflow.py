#!/usr/bin/env python3
"""Regenerate `example_workflows/minimax-director.json` from the copy the-project ships.

One graph, two homes. It is edited in the-project, where it is rendered on a real pod, and
copied here for everyone else — two hand-maintained copies of one workflow drift, and the
drift gets found by a user rather than by us.

The public copy is not quite a byte copy. It carries two things a pod does not need, because
a pod already has the pack cloned and the weights on disk:

  * `cnr_id` on our own nodes, so ComfyUI Manager can offer "install missing nodes"
  * `properties.models` on the loaders, so the weights can be fetched from the graph

Run it after any change to the shared graph:

    tools/sync_workflow.py            # writes example_workflows/minimax-director.json
    tools/sync_workflow.py --check    # exit 1 if it is out of date, changes nothing
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path.home() / (
    "Projects/experiments/the-project/comfyui/examples/video-minimaxh3/minimaxh3-director.json")
DST = HERE / "example_workflows/minimax-director.json"

CNR = "minimax-director"
OURS = ("MiniMaxDirector", "MiniMaxDirectorPrompt", "MiniMaxDirectorReport", "MiniMaxDirectorRefit")

HF = "https://huggingface.co/{repo}/resolve/main/{path}"
WEIGHTS = {
    "minimax_h3_ref2va_pruned_int8_convrot.safetensors": (
        "Comfy-Org/MiniMax-H3", "diffusion_models", "diffusion_models"),
    "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors": (
        "Comfy-Org/MiniMax-H3", "text_encoders", "text_encoders"),
    "minimax_h3_video_vae_fp16.safetensors": ("Comfy-Org/MiniMax-H3", "vae", "vae"),
    "minimax_h3_audio_vae_fp32.safetensors": ("Comfy-Org/MiniMax-H3", "vae", "vae"),
    "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors": (
        "lightx2v/Minimax-h3-Turbo", "", "loras"),
}


# The bundle's copy loads a fine-tune the pod fetches at boot; the public graph stays on the
# stock base, which is what the pack documents and what a ComfyUI Manager install can fetch.
BUNDLE_ONLY = {
    "Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors":
        "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
}


def version() -> str:
    for line in (HERE / "pyproject.toml").read_text().splitlines():
        if line.startswith("version = "):
            return line.split('"')[1]
    raise SystemExit("sync_workflow: no version in pyproject.toml")


def build() -> str:
    if not SRC.exists():
        raise SystemExit("sync_workflow: source not found: %s" % SRC)
    d = json.loads(SRC.read_text())
    ver = version()
    seen = set()

    for n in d["nodes"]:
        props = n.setdefault("properties", {})
        if n["type"] in OURS:
            props["cnr_id"] = CNR
            props["ver"] = ver
        if n["type"] == "MiniMaxH3Base":
            # The bundle's own loader: the same file through core's Load Diffusion Model,
            # plus a fetch-on-first-use of the Singularity fine-tune. The public pack does
            # not ship it, so the public graph loads the stock base through core directly.
            n["type"] = "UNETLoader"
            n.pop("title", None)
            props["Node name for S&R"] = "UNETLoader"
            values = n.get("widgets_values") or []
            n["widgets_values"] = ["minimax_h3_ref2va_pruned_int8_convrot.safetensors",
                                   values[1] if len(values) > 1 else "default"]
        values = n.get("widgets_values") or []
        for i, w in enumerate(values):
            if isinstance(w, str) and w in BUNDLE_ONLY:
                values[i] = w = BUNDLE_ONLY[w]
            if isinstance(w, str) and w in WEIGHTS:
                repo, sub, directory = WEIGHTS[w]
                props["models"] = [{
                    "name": w,
                    "url": HF.format(repo=repo, path="%s/%s" % (sub, w) if sub else w),
                    "directory": directory,
                }]
                seen.add(w)

    missing = set(WEIGHTS) - seen
    if missing:
        raise SystemExit("sync_workflow: no loader names %s — the graph changed" % sorted(missing))

    d["id"] = "minimax-director-example"
    return json.dumps(d, indent=2, ensure_ascii=False)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="report drift instead of writing")
    args = ap.parse_args()

    out = build()
    if args.check:
        if not DST.exists() or DST.read_text() != out:
            print("sync_workflow: %s is out of date — run tools/sync_workflow.py" % DST.name,
                  file=sys.stderr)
            return 1
        print("sync_workflow: up to date")
        return 0

    DST.write_text(out)
    print("sync_workflow: wrote %s" % DST)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
