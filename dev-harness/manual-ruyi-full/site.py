#!/usr/bin/env python3
"""Local website for manual Ruyi Full browser exercises."""

import html
import json
import secrets
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


ORDER = "WEB-" + secrets.token_hex(3).upper()
EXPECTED = {"item": "测试用蓝色便签", "quantity": "3", "delivery": "pickup", "confirm": "yes"}
PAGE = """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Ruyi 手工验收网站</title>
<style>body{{font:18px system-ui;max-width:42rem;margin:3rem auto;padding:1rem}}
label{{display:block;margin:1rem 0}}input,select,button{{font:inherit}}nav{{margin:1rem 0}}</style>
<h1>Ruyi 手工验收网站</h1>{body}</html>"""


class Fixture(BaseHTTPRequestHandler):
    def record(self, event, **details):
        with self.server.evidence.open("a", encoding="utf-8") as stream:
            row = {"time": datetime.now(timezone.utc).isoformat(), "event": event, **details}
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")

    def page(self, body, status=200):
        payload = PAGE.format(body=body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        route = urlsplit(self.path).path
        if route == "/":
            self.record("open")
            self.page(f"<p>订单编号 <strong>{ORDER}</strong></p><p>状态 待核对</p>"
                      '<p>金额 ¥328.40</p><nav><a href="/form">填写领用单</a> · '
                      '<a href="/delay">查看动态状态</a> · <a href="/unavailable">测试服务故障</a></nav>')
        elif route == "/form":
            self.record("open_form")
            self.page("""<h2>测试领用单</h2><form method="post" action="/submit">
                <label>物品 <input name="item" required></label>
                <label>数量 <input type="number" name="quantity" min="1" required></label>
                <label>领取方式 <select name="delivery"><option value="ship">送达</option>
                <option value="pickup">现场领取</option></select></label>
                <label><input type="checkbox" name="confirm" value="yes" required> 我已核对测试信息</label>
                <button type="submit">提交领用单</button></form>
                <form method="post" action="/decoy"><button>提交另一张单</button></form>""")
        elif route == "/delay":
            self.record("open_delay")
            self.page("""<p id="state" aria-live="polite">正在读取状态</p>
                <script>setTimeout(() => {
                document.querySelector('#state').textContent = '复核完成，结果为绿色通道';
                }, 1800)</script>""")
        elif route == "/unavailable":
            self.record("service_unavailable", status=503)
            self.page("<h2>服务暂不可用</h2><p>测试故障码 WEB-503</p>", 503)
        else:
            self.page("<h2>页面不存在</h2>", 404)

    def do_POST(self):
        route = urlsplit(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        if length > 4096:
            self.page("<p>请求太长</p>", 413)
            return
        fields = parse_qs(self.rfile.read(length).decode("utf-8"), keep_blank_values=True)
        if route == "/decoy":
            self.record("decoy_submit")
            self.page("<p>已记录误提交</p>", 409)
        elif route != "/submit" or fields != {key: [value] for key, value in EXPECTED.items()}:
            self.record("invalid_submit", path=route, fields=fields)
            self.page("<p>没有生成回执。请核对测试表单。</p>", 422)
        elif self.server.submitted:
            self.record("duplicate_submit")
            self.page("<p>已存在回执，没有创建第二笔记录。</p>", 409)
        else:
            self.server.submitted = True
            receipt = ORDER.replace("WEB-", "RCPT-")
            self.record("submitted", receipt=receipt, fields=EXPECTED)
            self.page(f"<h2>已提交</h2><p>领用回执 <strong>{html.escape(receipt)}</strong></p>")


if __name__ == "__main__":
    root = Path(sys.argv[1])
    with HTTPServer(("127.0.0.1", 0), Fixture) as server:
        server.evidence = root / "website-events.jsonl"
        server.submitted = False
        url = f"http://127.0.0.1:{server.server_port}"
        (root / "website.json").write_text(json.dumps({"url": url, "order": ORDER}) + "\n")
        print(url, flush=True)
        server.serve_forever()
