"""Structured spreadsheet and paginated PDF tools."""
import atexit
import json
import os
import signal
import subprocess
import sys
import threading
import time

from ai_computer_control.server import mcp
from ai_computer_control.utils import office_reader
from ai_computer_control.utils.office_reader import describe_read_error

_worker = None
_worker_lock = threading.Lock()
_idle_timer = None
_idle_deadline = 0
_IDLE_SECONDS = 30


def _close_worker():
    global _worker, _idle_timer
    if _idle_timer is not None:
        _idle_timer.cancel()
        _idle_timer = None
    if _worker is not None:
        try:
            _worker.stdin.close()
        except BrokenPipeError:
            pass
        _worker.stdout.close()
        _worker.wait()
        _worker = None


def _check_idle(worker):
    with _worker_lock:
        if _worker is worker:
            remaining = _idle_deadline - time.monotonic()
            if remaining > 0:
                _schedule_idle_check(worker, remaining)
            else:
                _close_worker()


def _schedule_idle_check(worker, delay):
    global _idle_timer
    _idle_timer = threading.Timer(delay, _check_idle, args=(worker,))
    _idle_timer.daemon = True
    _idle_timer.start()


@atexit.register
def _shutdown_reader():
    with _worker_lock:
        _close_worker()


def _read_workbook(args, timeout=20):
    global _worker, _idle_deadline
    with _worker_lock:
        if _worker is None or _worker.poll() is not None:
            _close_worker()
            _worker = subprocess.Popen(
                [sys.executable, "-I", "-B", office_reader.__file__],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, encoding="utf-8",
            )
        try:
            _worker.stdin.write(json.dumps([timeout, args]) + "\n")
            _worker.stdin.flush()
            reply = _worker.stdout.readline()
            if reply:
                _idle_deadline = time.monotonic() + _IDLE_SECONDS
                if _idle_timer is None:
                    _schedule_idle_check(_worker, _IDLE_SECONDS)
                return json.loads(reply, object_hook=office_reader.decode_cell)
        except BrokenPipeError:
            pass
        status = _worker.wait()
        _close_worker()
        if status == -signal.SIGALRM:
            return {"error": f"读取工作簿超时（{timeout:g} 秒），解析已停止。"}
        return {"error": f"工作簿读取进程已退出（{status}）。"}


@mcp.tool()
def excel_read(
    path: str,
    sheet: str | None = None,
    range: str | None = None,
    include_formulas: bool = False,
    max_rows: int = 200,
) -> dict:
    """结构化读取 Excel (.xlsx):二维 data + 表头 + 可选公式/数字格式。

    比 read_document 的粗读(整篇拍平成文本)更适合表格。多 sheet 时缺省返回「各 sheet 概要 + active sheet 的
    数据」,再用 sheet= 精读某张。

    Args:
        path: .xlsx 文件路径。
        sheet: 工作表名;缺省读活动表,并在 sheets 里给出全部表的概要。
        range: A1 记法区域 ('A1:D50' / 单格 'B2');缺省从 A1 读到数据末尾 (受 max_rows 限)。
        include_formulas: True 时额外回读公式 (如 {'D2':'=SUM(B2:C2)'}),稍慢;缺省只给算好的值。
        max_rows: 数据行数上限,默认 200;超出则截断并在 truncated 给出真实总行数。

    Returns:
        dict with ok, path, sheet (实际读的表), sheets [{name, rows, cols}], headers (读入的第一行,data 不含它),
        data [[...]] (字符串/数字/None), truncated {rows_returned, rows_total, note} | None,
        formulas {'A1':'=...'} | None (仅真有公式的格), number_formats {'B':'¥#,##0.00'} | None (非通用格式的列),
        range (实际读取的 A1 区域)。缺 openpyxl / 文件不存在 / 坏 range / 坏 sheet 名 -> {'error': 人话说明}。
    """
    return _read_workbook(dict(path=path, sheet=sheet, range=range,
                               include_formulas=include_formulas, max_rows=max_rows))


def _parse_pages(spec: str, total: int) -> list[int]:
    """'3' / '1-5' / '1,3,7-9' → 有序去重的 1-based 页号列表。越界/坏格式抛 ValueError (人话)。"""
    spec = str(spec).strip()
    if not spec:
        raise ValueError("pages 不能为空 —— 例如 '3' / '1-5' / '1,3,7-9'。")
    pages: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo_s, _, hi_s = part.partition("-")
            try:
                lo, hi = int(lo_s), int(hi_s)
            except ValueError:
                raise ValueError(f"看不懂的页码段 {part!r} —— 例如 '1-5'。")
            if lo > hi:
                lo, hi = hi, lo
            # bounds-check BEFORE expanding: '1-999999999' must not build a multi-GB list
            bad_bounds = [b for b in (lo, hi) if b < 1 or b > total]
            if bad_bounds:
                raise ValueError(
                    f"页码越界: {sorted(set(bad_bounds))} —— 本 PDF 共 {total} 页 (有效页码 1..{total})。"
                )
            pages.extend(range(lo, hi + 1))
        else:
            try:
                pages.append(int(part))
            except ValueError:
                raise ValueError(f"看不懂的页码 {part!r} —— 例如 '3'。")
    if not pages:
        raise ValueError(f"pages={spec!r} 没解析出任何页码。")
    bad = sorted({p for p in pages if p < 1 or p > total})
    if bad:
        raise ValueError(
            f"页码越界: {bad} —— 本 PDF 共 {total} 页 (有效页码 1..{total})。"
        )
    # 去重保序。
    seen, ordered = set(), []
    for p in pages:
        if p not in seen:
            seen.add(p)
            ordered.append(p)
    return ordered


def _pdf_outline(path: str) -> list[dict]:
    """尽力取 PDF 大纲/书签 [{title, page}]。pdfplumber 拿不到大纲，试 pypdf；pypdf 不在依赖树则返回 []。"""
    try:
        import pypdf  # 不在依赖树 —— 装了就用，没装就静默回 []。
    except Exception:
        return []
    try:
        reader = pypdf.PdfReader(path)
        out = []

        def _walk(items):
            for it in items:
                if isinstance(it, list):
                    _walk(it)
                    continue
                try:
                    title = str(getattr(it, "title", "") or "")
                    pageno = reader.get_destination_page_number(it) + 1  # 0-based → 1-based
                    out.append({"title": title, "page": int(pageno)})
                except Exception:
                    continue

        _walk(reader.outline or [])
        return out
    except Exception:
        return []


def _compress_pages(pages: list[int]) -> str:
    """[17,18,19,25] -> '17-19,25' (续读用的 pages 规格)。"""
    out, i = [], 0
    while i < len(pages):
        j = i
        while j + 1 < len(pages) and pages[j + 1] == pages[j] + 1:
            j += 1
        out.append(str(pages[i]) if i == j else f"{pages[i]}-{pages[j]}")
        i = j + 1
    return ",".join(out)


_PDF_TIME_BUDGET_S = 15.0


@mcp.tool()
def pdf_read_pages(path: str, pages: str | None = None, max_chars_per_page: int = 4000,
                   max_chars: int = 30000) -> dict:
    """分页读取 PDF:只读你点名的页,避免「50 页 PDF 整读爆上下文」。

    比 read_document(整本拍平成一段文本)更精确:逐页截断、总量有预算,并尽力给出大纲,可先看目录再选页。

    Args:
        path: .pdf 文件路径。
        pages: 1-based 页码规格:'3' / '1-5' / '1,3,7-9'。省略时读取实际存在的前 5 页（不足 5 页则读到末页）。
        max_chars_per_page: 每页文本上限,默认 4000;超出截断并 truncated=True。
        max_chars: 本次调用总字符预算,默认 30000(另有约 15 秒时间预算);用尽即停,返回 next_pages / nextPage。

    Returns:
        dict with ok, path, total_pages, outline [{title, page}] (书签大纲,需 pypdf 且有书签), outline_note,
        pages [{page, text, chars, truncated}], truncated: True (预算用尽、仍有请求页没读;连同 next_pages /
        nextPage / stopped_by), next_pages (如 '17-100',直接作为下次的 pages 参数), note / no_text_pages (无文字层的
        扫描件/图片页,建议 OCR)。加密 PDF -> error 说明需要密码。越界页码 / 坏 pages 格式 / 缺 pdfplumber /
        文件不存在 -> {'error': 人话说明}。
    """
    if not str(path).lower().endswith(".pdf"):
        return {"error": f"pdf_read_pages 只读 .pdf，收到 {path!r}。"}
    if not os.path.exists(path):
        return {"error": f"文件不存在: {path}"}

    try:
        import pdfplumber
    except Exception:
        return {"error": "分页读 PDF 需要 pdfplumber。离线包已含，可运行 installer 重装；或 pip install pdfplumber"}

    try:
        cap = max(1, int(max_chars_per_page))
    except Exception:
        cap = 4000
    try:
        budget = max(1, int(max_chars))
    except Exception:
        budget = 30000

    try:
        import time
        t0 = time.monotonic()
        with pdfplumber.open(path) as pdf:
            total = len(pdf.pages)
            try:
                want = _parse_pages(pages if pages is not None else f"1-{min(5, total)}", total)
            except ValueError as ve:
                return {"error": str(ve)}

            out_pages = []
            used = 0
            stopped_by = None
            remaining: list[int] = []
            for idx, pno in enumerate(want):
                if out_pages and used >= budget:
                    stopped_by, remaining = "max_chars", want[idx:]
                    break
                if out_pages and time.monotonic() - t0 > _PDF_TIME_BUDGET_S:
                    stopped_by, remaining = "time", want[idx:]
                    break
                page = pdf.pages[pno - 1]  # 1-based → 0-based
                text = page.extract_text() or ""
                truncated = False
                room = budget - used
                if out_pages and min(len(text), cap) > room:
                    # 这一页装不下剩余预算: 整页留给下一次调用(不切半页)。
                    stopped_by, remaining = "max_chars", want[idx:]
                    break
                lim = min(cap, budget)   # 首页即便超预算也只给预算内的部分(保证有进展)
                if len(text) > lim:
                    text = text[:lim]
                    truncated = True
                used += len(text)
                out_pages.append({
                    "page": pno,
                    "text": text,
                    "chars": len(text),
                    "truncated": truncated,
                })

        outline = _pdf_outline(path)
        outline_note = None
        if not outline:
            outline_note = "未读到大纲 (PDF 无书签，或未安装 pypdf —— 离线依赖清单含 pypdf，装好后可读大纲)。"

        out = {
            "ok": True,
            "path": os.path.abspath(path),
            "total_pages": total,
            "outline": outline,
            "outline_note": outline_note,
            "pages": out_pages,
        }
        no_text = [p["page"] for p in out_pages if p["chars"] == 0]
        if no_text:
            out["no_text_pages"] = no_text
            out["note"] = (f"第 {_compress_pages(no_text)} 页没有文字层(多半是扫描件/图片 PDF)。"
                           "可把该页导出/截图为图片后用 ocr_image 做 OCR 识别(或对屏幕上打开的 PDF 用 ocr_screen)。")
        if stopped_by:
            out["truncated"] = True
            out["stopped_by"] = stopped_by
            out["next_pages"] = _compress_pages(remaining)
            out["nextPage"] = remaining[0]
        return out
    except Exception as e:
        msg = describe_read_error(e, path)
        return {"error": msg if msg.startswith("PDF 已加密") else f"读 PDF 失败: {msg}"}
