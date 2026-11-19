"""Exclusive supervisor CPU benchmark, no desktop access or user data writes.

Run after all other Ruyi tests stop. Measures waited process-tree CPU with getrusage;
three identical idle commands follow one warm-up. RSS is wait4's maxrss, not summed RSS.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import socket
import statistics
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--helper', required=True)
parser.add_argument('--protocol', default='v2')
parser.add_argument('--seconds', type=int, default=10)
parser.add_argument('--output', required=True)
args = parser.parse_args()
helper = Path(args.helper).resolve()

def measure(seconds):
    child, owner = socket.socketpair()
    assert child.fileno() == 3, 'Private control descriptor must be fd 3'
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.monotonic()
    process = subprocess.Popen([str(helper), '--supervise-' + args.protocol, '/bin/sleep', str(seconds)],
                               pass_fds=(3,), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE)
    child.close()
    owner.settimeout(seconds + 10)
    frames = b''
    while True:
        data = owner.recv(4096)
        if not data:
            break
        frames += data
    owner.close()
    _, stderr = process.communicate(timeout=10)
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    events = [json.loads(line) for line in frames.splitlines()]
    assert process.returncode == 0, (process.returncode, stderr)
    assert all(e['detail'] == 1 for e in events if e['event'] in ('cleanup', 'guardian-cleanup')), events
    assert {'started', 'cleanup', 'guardian-cleanup', 'exit'} <= {e['event'] for e in events}, events
    return {'cpuSeconds': after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime,
            'wallSeconds': time.monotonic() - started, 'maxRssBytes': after.ru_maxrss,
            'voluntaryContextSwitches': after.ru_nvcsw - before.ru_nvcsw,
            'involuntaryContextSwitches': after.ru_nivcsw - before.ru_nivcsw}

measure(2)
runs = [measure(args.seconds) for _ in range(3)]
result = {'platform': platform.platform(), 'machine': platform.machine(), 'protocol': args.protocol,
          'helperSha256': hashlib.sha256(helper.read_bytes()).hexdigest(), 'seconds': args.seconds,
          'runs': runs, 'medianCpuSeconds': statistics.median(r['cpuSeconds'] for r in runs),
          'limits': 'Context switches are not hardware wakeups. maxrss is cumulative waited-child maximum. No power/battery claim.'}
Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
