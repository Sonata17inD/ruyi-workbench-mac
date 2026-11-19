"""Shared batch image routing; native desktop actions live in smoke_macos_* contracts."""
import asyncio
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from ai_computer_control.tools import batch

def check(condition, message):
    assert condition, message
    print('PASS', message)

def test_batch_images():
    print("F14 batch_actions lifts step images to the top-level channel")
    big = lambda c: c * 5000
    out = {"success": True, "results": [
        {"step": 0, "tool": "screenshot", "ok": True,
         "result": {"ok": True, "image": big("A"), "width": 10, "height": 5, "scale": 0.5, "format": "png"}},
        {"step": 1, "tool": "mouse_click", "ok": True, "result": {"ok": True}},
        {"step": 2, "tool": "screenshot", "ok": True,
         "result": {"ok": True, "image": big("B"), "width": 20, "height": 9, "scale": 1.0, "format": "png"}},
        {"step": 3, "tool": "screenshot", "ok": True,
         "result": {"ok": True, "image_base64": big("C"), "width": 30, "height": 9, "scale": 1.0, "format": "png"}},
    ]}
    batch.lift_batch_images(out)
    check(out.get("image") == big("C") and out.get("width") == 30 and out.get("image_base64") == big("B"),
          "newest image -> top-level `image` (+ its width/height/scale/format), previous -> `image_base64`")
    check([e["step"] for e in out["lifted_images"]] == [3, 2], "lifted_images records the source steps")
    r0 = out["results"][0]["result"]
    check("image" not in r0 and r0.get("image_omitted") is True, "images beyond the cap are dropped and marked image_omitted")
    check("image_base64" not in out["results"][3]["result"] and out["results"][3]["result"].get("image_lifted") is True,
          "lifted images are removed from the nested result (no double payload)")
    check(len(repr(out["results"])) < 2000, "the nested results no longer carry base64")

    # same shape the workbench's extractToolImages reads (top-level image / image_base64 / screenshot.image)
    nested = {"results": [{"step": 0, "tool": "observe", "ok": True,
                           "result": {"ok": True, "screenshot": {"image": big("Z"), "width": 1}}}]}
    batch.lift_batch_images(nested)
    check(nested.get("image") == big("Z") and "image" not in nested["results"][0]["result"]["screenshot"],
          "screenshot.image inside a step result is lifted too")
    small = {"results": [{"step": 0, "tool": "x", "ok": True, "result": {"image": "tiny"}}]}
    batch.lift_batch_images(small)
    check("image" not in small, "short strings named 'image' are not mistaken for pictures")

    # end to end through the real dispatcher with a fake tool
    class FakeTool:
        is_async = False

        def __init__(self, res):
            self.fn = lambda **kw: res

    old_map = batch._tool_map
    batch._tool_map = lambda: {"shot": FakeTool({"ok": True, "image": big("Q"), "width": 4, "height": 4,
                                                 "scale": 1.0, "format": "png"})}
    try:
        res = asyncio.run(batch._run_batch([{"tool": "shot", "args": {}}], "stop", 0))
        check(res.get("image") == big("Q") and res["success"] is True, "batch_actions output carries the lifted image")
    finally:
        batch._tool_map = old_map

if __name__ == '__main__':
    test_batch_images()
