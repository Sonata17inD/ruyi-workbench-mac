"""Build-time probes for the non-editable offline Python payload; no downloads."""
import argparse
import csv
import importlib.metadata
import io
import json
import os
import shlex
from pathlib import Path
from zipfile import ZipFile


def relocate_entrypoints(runtime):
    directory = Path(runtime) / 'bin'
    if not (directory / 'python').exists():
        (directory / 'python').symlink_to('python3')
    for distribution in importlib.metadata.distributions():
        for entry in distribution.entry_points:
            if entry.group != 'console_scripts':
                continue
            if Path(entry.name).name != entry.name or entry.name in ('python', 'python3', 'python3.12'):
                raise RuntimeError('Unsafe console entrypoint: ' + entry.name)
            code = ('import sys; from importlib.metadata import distribution; '
                    f'sys.argv[0]={entry.name!r}; '
                    f'entry=next(e for e in distribution({distribution.metadata["Name"]!r}).entry_points '
                    f'if e.group=="console_scripts" and e.name=={entry.name!r}); sys.exit(entry.load()())')
            target = directory / entry.name
            target.write_text('#!/bin/sh\nexec "${0%/*}/python3" -c ' + shlex.quote(code) + ' "$@"\n')
            target.chmod(0o755)


def prune_bootstrap_wheel(wheel, suffixes):
    with ZipFile(wheel) as source:
        removed = {name for name in source.namelist() if Path(name).suffix.lower() in suffixes}
        if not removed:
            return
        updated = wheel.with_suffix('.tmp')
        with ZipFile(updated, 'x') as target:
            for member in source.infolist():
                if member.filename in removed:
                    continue
                data = source.read(member)
                if member.filename.endswith('.dist-info/RECORD'):
                    rows = csv.reader(io.StringIO(data.decode('utf-8')))
                    output = io.StringIO(newline='')
                    csv.writer(output, lineterminator='\n').writerows(row for row in rows if row[0] not in removed)
                    data = output.getvalue().encode('utf-8')
                target.writestr(member, data)
    updated.replace(wheel)


def prune_windows_launchers(runtime, suffixes):
    root = Path(runtime).resolve()
    removed = set()
    for file in root.rglob('*'):
        if file.suffix.lower() in suffixes and (file.is_file() or file.is_symlink()):
            file.unlink()
            removed.add(str(file))
    for record in root.rglob('*.dist-info/RECORD'):
        with record.open(encoding='utf-8', newline='') as stream:
            rows = list(csv.reader(stream))
        kept = [row for row in rows if os.path.abspath(record.parent.parent / row[0]) not in removed]
        if len(kept) != len(rows):
            with record.open('w', encoding='utf-8', newline='') as stream:
                csv.writer(stream, lineterminator='\n').writerows(kept)
    # Keep Mac venv/ensurepip working. Normalize the runtime's bootstrap wheel
    # separately from the installed copy of pip and the build-only wheelhouse.
    for wheel in root.rglob('*.whl'):
        prune_bootstrap_wheel(wheel, suffixes)


def licenses(runtime, output):
    records = []
    for distribution in sorted(importlib.metadata.distributions(), key=lambda item: item.metadata['Name'].lower()):
        files = list(distribution.files or [])
        notices = [str(file) for file in files if any(
            token in str(file).upper() for token in ('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'COPYRIGHT'))]
        metadata = distribution.metadata
        record = {'name': metadata['Name'], 'version': distribution.version,
                  'license': metadata.get('License-Expression') or metadata.get('License'),
                  'notices': notices}
        if not notices:
            raise RuntimeError('No shipped license text for ' + record['name'])
        for file in files:
            resolved = Path(distribution.locate_file(file)).resolve()
            if not resolved.is_relative_to(Path(runtime).resolve()):
                raise RuntimeError('Distribution escapes bundled Python: ' + str(file))
        records.append(record)
    Path(output).write_text(json.dumps(records, indent=2) + '\n')


async def browser_notices(output):
    from playwright.async_api import async_playwright
    directory = Path(output)
    directory.mkdir()
    async with async_playwright() as playwright:
        # Use full Chromium in headless mode, matching production's explicit executable path.
        browser = await playwright.chromium.launch(executable_path=playwright.chromium.executable_path, headless=True)
        try:
            page = await browser.new_page()
            for name in ('credits', 'terms'):
                await page.goto('chrome://' + name, wait_until='load')
                text = await page.locator('body').inner_text()
                if len(text) < 100:
                    raise RuntimeError('Browser notices missing: ' + name)
                (directory / (name + '.html')).write_text(await page.content())
        finally:
            await browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime')
    parser.add_argument('--licenses')
    parser.add_argument('--browser-notices')
    parser.add_argument('--entrypoints', action='store_true')
    parser.add_argument('--prune-windows-launchers', nargs='+')
    arguments = parser.parse_args()
    if arguments.prune_windows_launchers:
        prune_windows_launchers(arguments.runtime, set(arguments.prune_windows_launchers))
    elif arguments.entrypoints:
        relocate_entrypoints(arguments.runtime)
    elif arguments.browser_notices:
        import asyncio
        asyncio.run(browser_notices(arguments.browser_notices))
    else:
        licenses(arguments.runtime, arguments.licenses)
