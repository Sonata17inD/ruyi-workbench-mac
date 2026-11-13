"""Behavioral smoke test for v1.8.3 —— 评审挖出的四 bug 修复 + 审计值脱敏 + 写护栏补齐.

修复清单 (对应如意工作台 v1.7 评审 B 表 ACC 侧):
  B1 read_file        —— max_bytes 从「字符数」修正为真字节预算 (二进制读 +1 探测截断再解码)。
  B2 list_directory   —— 递归分支 1000 条封顶原本只 break 内层循环, 条目可超限; 现硬停并如实报 capped。
  B3 ocr_click        —— nth 越界原返回 ok:true + error 的自矛盾包络 (_normalize 信任显式 ok 键,
                        调用方会把失败的消歧当成成功); 现 ok:false (执行拒绝) + found:true (查询有果)。
  B4 launch_application —— wait=True 原本复用 2 秒 ready_timeout 当进程等待上限; 新增独立
                        wait_timeout (默认 120s, 钳 [1,600])。
  S1 audit            —— 值级脱敏: command/content 等良性键名的值里出现 password=/Bearer/sk-/JWT/ghp_
                        也会被擦除 (原先只按【键名】脱敏, 命令行口令原文落审计)。
  S2 window_screenshot / get_clipboard_image —— 输出路径补 protected 护栏 (与 write_file 族同一闸)。
  S3 installer/update.bat —— 双布局探测 (新 runtime\\python 优先, 旧 venv 兜底), 静态断言防回退。

Run with UTF-8:  python -X utf8 tests/smoke_v183.py
"""

import asyncio
import os
import sys
import tempfile
import time

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SRC = os.path.join(_ROOT, "src")
sys.path.insert(0, _SRC)

_DATA = os.path.join(tempfile.gettempdir(), "acc_smoke_v183_data")
os.makedirs(_DATA, exist_ok=True)
os.environ["WCW_DATA_DIR"] = _DATA
# Off Windows there is no %SystemRoot%: the "writing into SystemRoot is refused" checks would otherwise resolve
# "C:\Windows/x" against the cwd, find it unprotected and leave a `C:\Windows/` directory in the repo.
os.environ.setdefault("SystemRoot", os.path.join(_DATA, "FakeWindows"))

import ai_computer_control.server as server  # noqa: E402

_FNS = {t.name: t.fn for t in server.mcp._tool_manager.list_tools()}
_FAILURES: list[str] = []


def check(cond: bool, msg: str):
    print(f"  [{'ok  ' if cond else 'FAIL'}] {msg}")
    if not cond:
        _FAILURES.append(msg)


def main() -> int:
    # ============================================================ ① read_file 字节语义
    print("== ① read_file: max_bytes 是真字节预算, truncated 不再误报 ==")
    cn = os.path.join(_DATA, "中文.txt")
    with open(cn, "w", encoding="utf-8") as f:
        f.write("汉" * 60)  # 60 字 = 180 字节 (UTF-8)

    r = _FNS["read_file"](path=cn, max_bytes=150)
    check(r.get("truncated") is True and len(r.get("content", "")) == 50,
          f"CJK 150 字节预算 → 50 字 + truncated (got {len(r.get('content', ''))} chars, trunc={r.get('truncated')})")

    r2 = _FNS["read_file"](path=cn, max_bytes=1_000_000)
    check(r2.get("truncated") is False and len(r2.get("content", "")) == 60,
          f"小 CJK 文件不再误报截断 (got trunc={r2.get('truncated')})")

    asc = os.path.join(_DATA, "ascii.txt")
    with open(asc, "w") as f:
        f.write("x" * 500)
    r3 = _FNS["read_file"](path=asc, max_bytes=100)
    check(r3.get("truncated") is True and len(r3.get("content", "")) == 100, "ASCII 语义不变 (截断)")
    r4 = _FNS["read_file"](path=asc, max_bytes=500)
    check(r4.get("truncated") is False and len(r4.get("content", "")) == 500, "恰好装满不误报截断")

    # ============================================================ ② list_directory 封顶
    print("\n== ② list_directory: 递归 1000 条硬封顶 + capped 如实标注 ==")
    big = os.path.join(_DATA, "big_tree")
    for d in range(5):
        os.makedirs(os.path.join(big, f"d{d}"), exist_ok=True)
        for i in range(300):
            with open(os.path.join(big, f"d{d}", f"f{i}.txt"), "w") as f:
                f.write("x")

    lr = _FNS["list_directory"](path=big, recursive=True)
    check(len(lr.get("entries", [])) == 1000 and lr.get("total") == 1000,
          f"递归封顶硬停于 1000 (got total={lr.get('total')})")
    check(lr.get("capped") is True, "递归封顶如实报 capped=true")

    lg = _FNS["list_directory"](path=big, pattern="*.txt", recursive=True)
    check(len(lg.get("entries", [])) == 1000 and lg.get("capped") is True,
          f"glob 分支封顶 + capped (got total={lg.get('total')})")

    small = _FNS["list_directory"](path=os.path.join(big, "d0"))
    check(small.get("capped") is None and small.get("total") == 300, "未封顶不带 capped 键")

    # An exactly-full tree is complete, not partial: root contributes one directory entry and its
    # child contributes 999 files. The recursive loop must only set capped after seeing item 1001.
    exact = os.path.join(_DATA, "exactly_1000")
    leaf = os.path.join(exact, "leaf")
    os.makedirs(leaf, exist_ok=True)
    for i in range(999):
        with open(os.path.join(leaf, f"f{i}.txt"), "w") as f:
            f.write("x")
    le = _FNS["list_directory"](path=exact, recursive=True)
    check(le.get("total") == 1000 and le.get("capped") is None,
          f"exactly 1000 entries are not falsely marked capped (got total={le.get('total')}, capped={le.get('capped')})")

    # Native OCR selection and GUI launch contracts: smoke_macos_visual/input.

    # ============================================================ ⑤ audit 值脱敏
    print("\n== ⑤ audit: 值级脱敏 (命令行里的口令不进日志), 良性值不动 ==")
    from ai_computer_control.tools.audit import _summarize_args, _scrub_value

    cmd = ('net use \\\\srv\\c$ /user:admin password=Sup3rSecret! && '
           'curl -H "Authorization: Bearer abcdef1234567890" -d key=sk-livekey123456789')
    s = _summarize_args({"command": cmd})
    check("Sup3rSecret!" not in s, "password= 的值被擦除")
    check("abcdef1234567890" not in s, "Bearer 令牌被擦除 (generic key=value 不得先吃掉 Bearer 字样)")
    check("sk-livekey123456789" not in s, "sk- 密钥被擦除")
    check("password=***" in s and "Authorization=***" in s, f"键形状保留可读 (got {s})")

    jwt = _scrub_value("t=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5cE")
    check("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in jwt, "JWT 被擦除")
    gh = _scrub_value("git clone https://ghp_AbCdEfGh0123456789@github.com/x/y")
    check("ghp_AbCdEfGh0123456789" not in gh, "ghp_ 被擦除")

    s2 = _summarize_args({"path": "normal.txt", "content": "hello world"})
    check("hello world" in s2 and "normal.txt" in s2, "良性值原样保留")
    s3 = _summarize_args({"api_key": "whatever"})
    check("whatever" not in s3 and "***" in s3, "键名脱敏仍整值 ***")

    # Native capture path guards: smoke_macos_capture; installer retired.

    print()
    if _FAILURES:
        print(f"FAILED: {len(_FAILURES)} assertion(s)")
        for f in _FAILURES:
            print("  -", f)
        print("ACC-V183 SMOKE: FAIL")
        return 1
    print("ACC-V183 SMOKE: ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
