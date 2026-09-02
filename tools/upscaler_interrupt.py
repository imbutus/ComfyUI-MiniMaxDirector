#!/usr/bin/env python3
"""Let ComfyUI's Stop button land inside the latent upscaler's forward pass.

`Comfyui_Minimax_h3_latent_Upscaler` runs the whole latent through one pass with no interrupt
check anywhere in the file, so Stop does nothing until the pass returns -- minutes at
3584x2048, and the only way out was killing the pod. This inserts a check inside both block
loops, so the pass stops between blocks instead.

    python3 tools/upscaler_interrupt.py <path to minimax_h3_latent_upscaler_3d.py>

Idempotent: a second run is a no-op. Exit 0 = patched or already patched, 1 = the file did not
look the way this patch expects, so nothing was written. The caller treats 1 as a warning --
the render still works, Stop just stays slow.
"""
import sys

ANCHOR = "from typing import TypedDict\n"
HELPER = '''
def _mmd_interrupt():
    """Raise ComfyUI's own interrupt exception when the user has pressed Stop."""
    try:
        import comfy.model_management as _mm
        _mm.throw_exception_if_processing_interrupted()
    except ImportError:
        pass

'''


def patch(path):
    src = open(path).read()
    if "_mmd_interrupt" in src:
        print("[patch] already applied")
        return 0
    if src.count(ANCHOR) != 1:
        print("[patch] anchor not found -- not patching")
        return 1
    src = src.replace(ANCHOR, ANCHOR + HELPER)
    for blocks in ("in_blocks", "out_blocks"):
        old = "        for b in self.%s:\n            if isinstance(b, ResBlockEmb3D):" % blocks
        new = ("        for b in self.%s:\n            _mmd_interrupt()\n"
               "            if isinstance(b, ResBlockEmb3D):") % blocks
        if src.count(old) != 1:
            print("[patch] %s loop not found -- not patching" % blocks)
            return 1
        src = src.replace(old, new)
    compile(src, path, "exec")
    open(path, "w").write(src)
    print("[patch] upscaler answers Stop between blocks")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: upscaler_interrupt.py <minimax_h3_latent_upscaler_3d.py>")
    raise SystemExit(patch(sys.argv[1]))
