"""Shared asynchronous tool dispatch without desktop interaction."""
import asyncio
import inspect
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import ai_computer_control.server as server
from ai_computer_control.tools import browser

def check(condition, message):
    assert condition, message
    print('PASS', message)

async def check_async_tools(tools: dict) -> None:
    # The browser backend need not be installed for this dispatch check. The important contract is
    # that FastMCP sees and awaits an async callable instead of trying to serialize a coroutine.
    old_browser_available = browser._AVAILABLE
    old_system_open = browser._system_open
    browser._AVAILABLE = False
    opened = []
    browser._system_open = lambda url, new_tab: opened.append((url, new_tab))
    try:
        system_result = await tools["browser_open"].fn(url="https://example.invalid", mode="system")
        check(system_result.get("ok") is True and opened == [("https://example.invalid", True)],
              "system browser mode uses the user handler in a new tab without Playwright")
        result = await tools["browser_open"].fn(url="https://example.invalid", mode="managed")
        check(result.get("ok") is False and "playwright" in result.get("error", ""),
              "async wrapper awaits browser tools and normalizes their result")
        batch_result = await tools["batch_actions"].fn(actions=[{
            "tool": "browser_open", "args": {"url": "https://example.invalid", "mode": "managed"}
        }])
        check(batch_result.get("failed") == 1 and "playwright" in str(batch_result),
              "batch_actions awaits async tools and reports their normalized failure")
    finally:
        browser._AVAILABLE = old_browser_available
        browser._system_open = old_system_open

    class WorkbenchPage:
        url = "http://127.0.0.1:8765/"

        async def title(self):
            return "如意 Ruyi"

    check(await browser._is_workbench_page(WorkbenchPage()),
          "connected Workbench tabs are recognized and protected from browser navigation")

if __name__ == '__main__':
    tools = {tool.name: tool for tool in server.mcp._tool_manager.list_tools()}
    for name in ('batch_actions', 'macro_run', 'browser_open', 'browser_click', 'browser_type',
                 'browser_screenshot', 'browser_get_text', 'browser_execute_js', 'browser_navigate',
                 'browser_get_elements', 'browser_list_tabs', 'browser_switch_tab', 'browser_close'):
        check(inspect.iscoroutinefunction(tools[name].fn), name + ' retains async dispatch')
    asyncio.run(check_async_tools(tools))
