"""Structured workbook reads for the Mac Office helper."""
import datetime
import json
import os
import signal
import sys

_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_OOXML_EXTS = (".docx", ".docm", ".xlsx", ".xlsm", ".xltx", ".xltm", ".pptx", ".pptm")


def ole_password_hint(path: str) -> str | None:
    """OOXML 扩展名却是 OLE 复合文档头(D0 CF 11 E0): 设了「打开密码」的 Office 文件就是这种封装
    (旧版 .xls/.doc/.ppt 改扩展名也是)。给人话,而不是「File is not a zip file」。"""
    if not str(path).lower().endswith(_OOXML_EXTS):
        return None
    try:
        with open(path, "rb") as f:
            head = f.read(8)
    except Exception:
        return None
    if head == _OLE_MAGIC:
        return ("文件是 OLE 复合文档而非 OOXML 压缩包:多半设置了【打开密码】(加密的 Office 文件会变成这种封装),"
                "也可能是旧版 .xls/.doc/.ppt 直接改了扩展名。请让用户解除密码保护,或另存为未加密的新版格式后重试。")
    return None


def _exc_chain_names(e: BaseException) -> list[str]:
    names, seen, cur = [], set(), e
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        names.append(type(cur).__name__)
        for a in getattr(cur, "args", ()):
            if isinstance(a, BaseException):
                names.append(type(a).__name__)
        cur = cur.__cause__ or cur.__context__
    return names


def describe_read_error(e: BaseException, path: str = "") -> str:
    """把读文档时的异常翻成人话(非空!)。加密 PDF / 加密 Office / 损坏或改名的文件都给明确原因;
    空消息异常回落到类型名 —— 空 error 会被 server 归一化成 ok:true(F9)。"""
    names = _exc_chain_names(e)
    msg = str(e).strip()
    low = msg.lower()
    if any(n in ("PDFPasswordIncorrect", "PDFEncryptionError") for n in names) or ("password" in low and "pdf" in low):
        return "PDF 已加密(password-protected),需要密码才能读取。请让用户先解除密码保护,或另存为未加密的副本。"
    hint = ole_password_hint(path) if path else None
    if hint:
        return hint
    ext = os.path.splitext(str(path))[1].lower()
    if any(n in ("BadZipFile", "PackageNotFoundError") for n in names) or "not a zip file" in low:
        return f"不是有效的 {ext or 'Office'} 文件(已损坏,或是改了扩展名的其他格式如旧版 .doc/.xls)。"
    if not msg:
        return type(e).__name__
    return f"{type(e).__name__}: {msg}"


def _col_letter(idx: int) -> str:
    """1-based 列号 → Excel 列字母 (1→A, 27→AA)。"""
    s = ""
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        s = chr(65 + rem) + s
    return s


def _parse_a1_range(rng: str):
    """把 'B2:D10' 拆成 (min_row, min_col, max_row, max_col)，1-based。坏 range 抛 ValueError (人话)。"""
    from openpyxl.utils import range_boundaries  # (min_col, min_row, max_col, max_row)

    try:
        min_col, min_row, max_col, max_row = range_boundaries(str(rng).strip())
    except Exception:
        raise ValueError(
            f"看不懂的单元格区域 range={rng!r} —— 请用 A1 记法，例如 'A1:D20' 或单格 'B2'。"
        )
    if None in (min_col, min_row, max_col, max_row):
        raise ValueError(
            f"不完整的单元格区域 range={rng!r} —— 需要形如 'A1:D20' 的闭区间 (不支持整列 'A:A')。"
        )
    return min_row, min_col, max_row, max_col


def excel_read(
    path: str,
    sheet: str | None = None,
    range: str | None = None,
    include_formulas: bool = False,
    max_rows: int = 200,
) -> dict:
    if not str(path).lower().endswith((".xlsx", ".xlsm", ".xltx", ".xltm")):
        return {"error": f"excel_read 只读 .xlsx 系列，收到 {path!r}。CSV/老 .xls 不支持。"}
    if not os.path.exists(path):
        return {"error": f"文件不存在: {path}"}

    try:
        from openpyxl import load_workbook
    except Exception:
        return {"error": "结构化读表需要 openpyxl。离线包已含，可运行 installer 重装；或 pip install openpyxl"}

    try:
        mr = max(1, int(max_rows))
    except Exception:
        mr = 200

    ole = ole_password_hint(path)
    if ole:
        return {"error": ole}

    try:
        wb = load_workbook(path, read_only=True, data_only=True)
    except Exception as e:
        return {"error": f"打不开工作簿 (可能损坏或非 xlsx): {describe_read_error(e, path)}"}

    try:
        # 全表概要 (维度) —— 多 sheet 时让 AI 一眼看清有哪些表、各多大。
        # 没写 <dimension> 的工作表(部分生成器)read_only 下 max_row/max_column 是 None: 报 None(未知),
        # 不要报 0 —— 0 会让模型以为是空表。
        sheets_summary = []
        for nm in wb.sheetnames:
            w = wb[nm]
            sheets_summary.append({
                "name": nm,
                "rows": int(w.max_row) if w.max_row else None,
                "cols": int(w.max_column) if w.max_column else None,
            })

        # 选表: 显式 sheet= 优先，否则活动表。
        if sheet is not None:
            if sheet not in wb.sheetnames:
                return {"error": f"没有名为 {sheet!r} 的工作表。可选: {wb.sheetnames}"}
            ws = wb[sheet]
            active_name = sheet
        else:
            ws = wb.active
            active_name = ws.title

        # 区域: 显式 range= 优先，否则整表 (A1 起)。
        explicit = range is not None
        if explicit:
            try:
                min_row, min_col, max_row, max_col = _parse_a1_range(range)
            except ValueError as ve:
                return {"error": str(ve)}
        else:
            min_row, min_col = 1, 1
            max_row = int(ws.max_row) if ws.max_row else None
            max_col = int(ws.max_column) if ws.max_column else None
            # 声明的维度不可信(缺失,或只有 A1 却有数据): 不按维度截,改成逐行迭代到 max_rows。
            if not max_row or not max_col or (max_row <= 1 and max_col <= 1):
                max_row = max_col = None

        # 读值: 一遍 read_only 迭代同时取 值 + 数字格式(read_only 的 ReadOnlyCell 自带 number_format,
        # 不必再整本非只读重开 —— 那一遍在 5 万行表上就是 3 秒)。
        bounded = max_row is not None and max_col is not None
        if bounded:
            rows_total = max_row - min_row + 1
            row_cap = min(rows_total, mr)
            it = ws.iter_rows(min_row=min_row, max_row=min_row + row_cap - 1,
                              min_col=min_col, max_col=max_col, values_only=False)
        else:
            rows_total = None
            row_cap = mr
            it = ws.iter_rows(min_row=min_row, min_col=min_col,
                              max_col=max_col, values_only=False)

        data = []
        col_formats: dict[int, str] = {}   # 绝对列号 -> 首个非 General 格式(跳过表头行)
        more = False
        width = 0
        for ridx, row in enumerate(it):
            if ridx >= row_cap:
                more = True    # 多看到第 row_cap+1 行 = 确有更多(未声明维度时用它判截断)
                break
            vals = []
            for cidx, cell in enumerate(row):
                vals.append(getattr(cell, "value", None))
                if ridx >= 1 or row_cap == 1:
                    nf = getattr(cell, "number_format", None)
                    col = (getattr(cell, "column", None) or (min_col + cidx))
                    if nf and nf != "General" and col not in col_formats:
                        col_formats[col] = nf
            width = max(width, len(vals))
            data.append(vals)
        if not bounded:
            max_col = min_col + max(width, 1) - 1
        for r_ in data:            # 未声明维度时各行长短不一: 补齐成矩形
            if len(r_) < width:
                r_.extend([None] * (width - len(r_)))
        n_read = len(data)
        hard_max_row = min_row + max(n_read, 1) - 1
        if not bounded and not more:
            rows_total = n_read

        headers = [("" if v is None else v) for v in data[0]] if data else []
        body = data[1:] if len(data) > 1 else []
        number_formats = {_col_letter(c): f for c, f in sorted(col_formats.items())}

        truncated = None
        if more or (rows_total is not None and rows_total > n_read):
            truncated = {
                "rows_returned": n_read,
                "rows_total": rows_total,      # None = 工作表未声明维度,总行数未知
                "next_start_row": min_row + n_read,
                "note": (f"数据超 max_rows={mr}，只返回前 {n_read} 行"
                         + (f" (共 {rows_total} 行)" if rows_total is not None else " (工作表未声明维度,总行数未知)")
                         + "。缩小 range= (如续读用 next_range) 或调大 max_rows= 读更多。"),
            }
            if rows_total is not None:
                truncated["next_range"] = (f"{_col_letter(min_col)}{min_row + n_read}:"
                                           f"{_col_letter(max_col)}{max_row}")
            else:
                truncated["next_range"] = f"{_col_letter(min_col)}{min_row + n_read}:{_col_letter(max_col)}{min_row + n_read + mr - 1}"

        out = {
            "ok": True,
            "path": os.path.abspath(path),
            "sheet": active_name,
            "sheets": sheets_summary,
            "headers": headers,
            "data": body,
            "range": f"{_col_letter(min_col)}{min_row}:{_col_letter(max_col)}{hard_max_row}",
            "truncated": truncated,
            "number_formats": number_formats or None,
            "formulas": None,
        }

        # include_formulas: 单独开一次 data_only=False (values 变成公式串)，只挑真有公式的格。
        if include_formulas:
            out["formulas"] = _read_formulas(path, active_name, min_row, min_col,
                                             max_row if max_row is not None else hard_max_row, max_col, mr)

        return out
    except Exception as e:
        return {"error": f"读表失败: {describe_read_error(e, path)}"}
    finally:
        wb.close()


def _read_formulas(path, sheet_name, min_row, min_col, max_row, max_col, mr) -> dict:
    """回读区域内的公式 (data_only=False → cell.value 是 '=...' 串)。仅收真以 '=' 开头的格。"""
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=False)
    try:
        end = min(max_row, min_row + mr - 1)
        rows = wb[sheet_name].iter_rows(min_row=min_row, max_row=end, min_col=min_col, max_col=max_col)
        return {cell.coordinate: cell.value for row in rows for cell in row
                if isinstance(cell.value, str) and cell.value.startswith("=")}
    finally:
        wb.close()


def _encode_cell(value):
    if isinstance(value, datetime.timedelta):
        return {"$duration": [value.days, value.seconds, value.microseconds]}
    if isinstance(value, (datetime.date, datetime.time)):
        return {"$" + type(value).__name__: value.isoformat()}
    raise TypeError(f"Unsupported cell type: {type(value).__name__}")


def decode_cell(value):
    if "$duration" in value:
        return datetime.timedelta(*value["$duration"])
    for kind in (datetime.date, datetime.datetime, datetime.time):
        key = "$" + kind.__name__
        if key in value:
            return kind.fromisoformat(value[key])
    return value


def serve():
    # Only this parser process owns the timer. The kernel terminates even a blocked read.
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    for line in sys.stdin.buffer:
        timeout, args = json.loads(line)
        signal.setitimer(signal.ITIMER_REAL, timeout)
        try:
            reply = json.dumps(excel_read(**args), default=_encode_cell)
        except Exception as error:
            reply = json.dumps({"error": str(error) or type(error).__name__})
        signal.setitimer(signal.ITIMER_REAL, 0)
        print(reply, flush=True)
        del reply


if __name__ == "__main__":
    serve()
