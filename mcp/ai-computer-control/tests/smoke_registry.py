"""Registration smoke test: import the server and assert the FastMCP tool registry looks right.

Run with UTF-8 to avoid Windows GBK console failures:
    python -X utf8 tests/smoke_registry.py
or  set PYTHONIOENCODING=utf-8 && python tests/smoke_registry.py

Exits non-zero on any failed assertion.
"""

import os
import sys

# Make `src/` importable when run from the repo root without installing.
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "src"))

import ai_computer_control.server as server  # noqa: E402

# Tools that MUST be present (baseline + v1.3 additions).
_EXPECTED = {
    "screenshot", "mouse_click", "type_text", "press_key", "hotkey", "get_clipboard",
    "set_clipboard", "list_windows", "focus_window", "launch_application", "read_file",
    "write_file", "delete_file", "move_file", "copy_file", "run_command", "list_monitors",
    "get_dpi_info", "batch_actions", "macro_run", "ui_inspect", "ui_find", "ui_invoke",
    "ocr_screen", "ocr_click", "ocr_image", "find_template", "mouse_drag", "mouse_scroll",
    "diagnostics", "version_info", "safety_info", "audit_tail", "window_screenshot",
    "ocr_find_text", "vision_click", "scroll_at", "observe", "act_and_verify",
    "record_start", "record_stop", "macro_list", "write_pdf", "excel_beautify", "excel_chart",
    "write_pptx", "chart_image", "excel_read", "pdf_read_pages", "image_info", "image_resize",
    "edit_file", "fetch", "memory_save", "memory_read", "memory_list", "memory_delete",
    "ocr_available_languages", "sequential_thinking", "input_sequence", "execution_receipt",
}


def main() -> int:
    tools = server.mcp._tool_manager.list_tools()
    names = {t.name for t in tools}

    print(f"server VERSION = {server.VERSION}")
    print(f"registered tool count = {len(names)}")

    failures = []

    # 1) version bumped
    if server.VERSION != "1.9.1":
        failures.append(f"VERSION expected 1.9.1, got {server.VERSION}")

    # 1b) the package's own __version__ and pyproject.toml say the same thing (__version__ once lagged at 1.8.3)
    import re
    import ai_computer_control
    if ai_computer_control.__version__ != server.VERSION:
        failures.append(f"__version__ {ai_computer_control.__version__!r} != server.VERSION {server.VERSION!r}")
    try:
        with open(os.path.join(_ROOT, "pyproject.toml"), encoding="utf-8") as fh:
            pyproject_version = (re.search(r'(?m)^version = "([^"]+)"', fh.read()) or [None, None])[1]
    except OSError:
        pyproject_version = None  # standalone copy without pyproject: nothing to compare
    if pyproject_version is not None and pyproject_version != server.VERSION:
        failures.append(f"pyproject version {pyproject_version!r} != server.VERSION {server.VERSION!r}")

    if len(names) != 93:
        failures.append(f"tool count {len(names)} != expected 93 Mac/shared tools")
    retired = {"kill_process", "get_system_info", "get_pixel_color", "wait_for_pixel",
               "wait_for_window_idle"}
    if names & retired:
        failures.append(f"retired tools registered: {sorted(names & retired)}")

    # 3) all expected tools present
    missing = sorted(_EXPECTED - names)
    if missing:
        failures.append(f"missing expected tools: {missing}")

    # 4) every tool has a non-empty description (F9)
    no_desc = sorted(t.name for t in tools if not (t.description or "").strip())
    if no_desc:
        failures.append(f"tools missing description: {no_desc}")

    # 5) no duplicate names
    if len(names) != len(tools):
        failures.append("duplicate tool names detected")

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print("  -", f)
        return 1

    print("\nOK: all registry assertions passed.")
    print("v1.4 new tools present:", sorted(n for n in names if n in {
        "observe", "act_and_verify", "record_start", "record_stop", "macro_list"}))
    print("v1.5 new tools present:", sorted(n for n in names if n in {"write_pdf"}))
    print("v1.6 new tools present:", sorted(n for n in names if n in {
        "excel_beautify", "excel_chart", "write_pptx", "chart_image"}))
    print("v1.8 new tools present:", sorted(n for n in names if n in {
        "excel_read", "pdf_read_pages", "image_info", "image_resize"}))
    print("v1.9 new tools present:", sorted(n for n in names if n in {
        "edit_file", "fetch", "memory_save", "memory_read", "memory_list", "memory_delete",
        "sequential_thinking"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
