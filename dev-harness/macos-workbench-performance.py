"""Exclusive paired source benchmark. Uses isolated homes; never touches installed Ruyi.

Extract only the baseline app/resources for measurement, then remove the temporary
copy. Report process-tree RSS snapshots (not wait4 maxrss), health startup latency,
and authenticated session-list P95. Run with no other Ruyi tests in flight.
"""
import argparse
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import socket
import statistics
import subprocess
import tarfile
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('--baseline', default='931f9fa21972d8722ad027ca631877f2623ba462')
parser.add_argument('--output', required=True)
parser.add_argument('--runs', type=int, default=3)
args = parser.parse_args()
if args.runs < 3:
    parser.error('--runs must be at least 3')
root = Path(__file__).resolve().parents[1]
node = shutil.which('node')


def measure(app, home):
    home.mkdir()
    data = home / 'data'
    data.mkdir()
    (data / 'config.json').write_text(json.dumps({
        'configSchema': 7, 'stewardEnabledV1': False, 'schedulerEnabledV1': False,
        'includeWorkbenchMcp': False, 'stewardThreadBriefV1': False,
        'sessionSearchIndexV1': False, 'providers': [], 'recentWorkspaces': [],
        'defaultWorkspace': str(home),
    }))
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'HOME': str(home), 'USERPROFILE': str(home),
           'RUYI_HOME': str(data), 'WIN_CLAUDE_WORKBENCH_HOME': str(data)}
    started = time.perf_counter()
    with (home / 'server.log').open('w') as log:
        child = subprocess.Popen([node, str(app / 'app/server.js'), 'serve', '--port', str(port)],
                                 cwd=app, env=env, stdout=log, stderr=log, start_new_session=True)
        try:
            while True:
                try:
                    c = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                    c.request('GET', '/health')
                    r = c.getresponse(); r.read(); c.close()
                    if r.status == 200:
                        break
                except OSError:
                    pass
                if child.poll() is not None or time.perf_counter() - started > 25:
                    raise RuntimeError((home / 'server.log').read_text()[-3000:])
                time.sleep(.01)
            startup = (time.perf_counter() - started) * 1000
            while not (data / 'runtime.json').exists():
                if time.perf_counter() - started > 30:
                    raise RuntimeError('runtime metadata unavailable')
                time.sleep(.01)
            token = json.loads((data / 'runtime.json').read_text())['token']
            c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
            def request():
                at = time.perf_counter()
                c.request('GET', '/api/sessions', headers={'x-wcw-token': token})
                r = c.getresponse(); r.read()
                assert r.status == 200, r.status
                return (time.perf_counter() - at) * 1000
            for _ in range(20):
                request()
            time.sleep(1)
            latencies = [request() for _ in range(200)]
            c.close()
            rss = []
            counts = []
            for _ in range(5):
                lines = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss=']).decode().splitlines()
                rows = [tuple(map(int, line.split())) for line in lines]
                owned = {child.pid}
                while True:
                    more = {pid for pid, parent, _ in rows if parent in owned}
                    if more <= owned:
                        break
                    owned |= more
                rss.append(sum(kb for pid, _, kb in rows if pid in owned))
                counts.append(len(owned))
                time.sleep(.2)
            return {'startupMs': startup, 'requestP95Ms': sorted(latencies)[189],
                    'rssKiB': statistics.median(rss), 'processCount': max(counts)}
        finally:
            # Only this benchmark's fresh session/process group is addressed.
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()


with tempfile.TemporaryDirectory(prefix='ruyi-paired-performance-') as directory:
    temp = Path(directory)
    archive = subprocess.check_output(['git', 'archive', args.baseline,
        'ruyi-workbench/app', 'ruyi-workbench/package.json', 'ruyi-workbench/resources'], cwd=root)
    baseline_root = temp / 'baseline'
    baseline_root.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(baseline_root, filter='data')
    # Both Node versions must discover the same optional Python/MCP installation.
    (baseline_root / 'mcp').symlink_to(root / 'mcp', target_is_directory=True)
    baseline = baseline_root / 'ruyi-workbench'
    runtime = baseline / 'runtime/macos'
    runtime.mkdir(parents=True)
    for item in (root / 'ruyi-workbench/runtime/macos').iterdir():
        if item.name != 'ruyi-process-helper':
            (runtime / item.name).symlink_to(item, target_is_directory=item.is_dir())
    subprocess.run(['/usr/bin/xcrun', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
        '-mmacosx-version-min=14.0', '-arch', platform.machine(),
        str(baseline / 'resources/macos-process-helper.c'), '-o', str(runtime / 'ruyi-process-helper')], check=True)
    current = root / 'ruyi-workbench'
    samples = {'baseline': [], 'candidate': []}
    warmups = {}
    for label, app in [('baseline', baseline), ('candidate', current)]:
        warmups[label] = measure(app, temp / (label + '-warmup'))
    for i in range(args.runs):
        for label, app in ([('baseline', baseline), ('candidate', current)] if i % 2 == 0 else
                           [('candidate', current), ('baseline', baseline)]):
            value = measure(app, temp / (label + '-' + str(i)))
            samples[label].append(value)
            print(label, i + 1, json.dumps(value), flush=True)
    medians = {label: {key: statistics.median(row[key] for row in rows) for key in rows[0]}
               for label, rows in samples.items()}
    ratios = {key: medians['candidate'][key] / medians['baseline'][key]
              for key in ['startupMs', 'rssKiB', 'requestP95Ms']}
    report = {'baselineCommit': args.baseline, 'candidateCommit': subprocess.check_output(
        ['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip(),
        'candidateServerSha256': hashlib.sha256((current / 'app/server.js').read_bytes()).hexdigest(),
        'candidateRuntimeSha256': hashlib.sha256((current / 'app/workbench-runtime.cjs').read_bytes()).hexdigest(),
        'candidateBackendSha256': {str(file.relative_to(current)): hashlib.sha256(file.read_bytes()).hexdigest()
            for file in sorted((current / 'app/backend').glob('*.cjs'))},
        'platform': platform.platform(), 'node': subprocess.check_output([node, '--version']).decode().strip(),
        'workload': 'isolated empty session list; 20 warmups, 200 authenticated keepalive requests; 5 process-tree RSS samples',
        'limitations': ['No model or tool execution; not a full workload performance claim.',
                         'Baseline supervisor compiled from baseline source with identical flags; native leaf helpers and optional Python/MCP installation shared.',
                         'RSS is summed ps snapshots; no physical power or hardware wakeup measurement.'],
        'warmups': warmups, 'samples': samples, 'medians': medians, 'ratios': ratios,
        'withinTenPercent': all(value <= 1.10 for value in ratios.values())}
    Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'medians': medians, 'ratios': ratios, 'withinTenPercent': report['withinTenPercent']}), flush=True)
