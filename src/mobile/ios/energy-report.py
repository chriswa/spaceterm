#!/usr/bin/env python3
"""Summarise Spaceterm's share of an Instruments "Activity Monitor" trace.

Reads the XML of the `activity-monitor-process-live` table (as
`xctrace export --xpath` writes it) on stdin and prints, for the app and the
WebKit processes working on its behalf, average CPU, idle wake-ups per second
and memory — the numbers that track battery drain. See energy.sh.
"""
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.stdin).getroot()

# xctrace writes each distinct value once with an id and refers back to it.
by_id = {}
for el in root.iter():
    if 'id' in el.attrib:
        by_id[el.attrib['id']] = el


def resolve(el):
    return by_id.get(el.attrib['ref'], el) if 'ref' in el.attrib else el


cols = [c.findtext('mnemonic') for c in root.iter('col')]
samples = {}  # process name -> list of (start ns, cpu-total ns, wakeups, memory bytes)
for row in root.iter('row'):
    cells = dict(zip(cols, (resolve(c) for c in row)))
    responsible = cells.get('responsible-process')
    process = cells.get('process')
    if responsible is None or process is None:
        continue
    name = process.attrib.get('fmt', '')
    if not (name.startswith('SpacetermMobile') or name.startswith('com.apple.WebKit.')):
        continue
    def num(name):
        el = cells.get(name)
        try:
            return int(el.text) if el is not None and el.text else 0
        except ValueError:
            return 0

    samples.setdefault(process.attrib.get('fmt', '?'), []).append(
        (num('start'), num('cpu-total'), num('idle-wakeups'), num('memory-physical-footprint')))

# The trace does not say which app a WebKit process works for (every one
# reports launchd as responsible). iOS starts an app's WebKit processes just
# after the app, so they are the ones whose pids follow its own.
def pid_of(name):
    try:
        return int(name.rsplit('(', 1)[1].rstrip(')'))
    except (IndexError, ValueError):
        return -1

apps = [pid_of(n) for n in samples if n.startswith('SpacetermMobile')]
if not apps:
    print('Spaceterm was not running during the trace. Was it open on screen?')
    sys.exit(1)
app_pid = max(apps)
samples = {n: r for n, r in samples.items()
           if n.startswith('SpacetermMobile') or 0 < pid_of(n) - app_pid <= 10}

print(f"{'process':40} {'avg CPU':>8} {'wakeups/s':>10} {'memory':>9}")
total_cpu = total_wakes = 0.0
span = 0.0
for name, rows in sorted(samples.items()):
    rows.sort()
    if len(rows) < 2:
        print(f"{name:40} (one sample only — record for longer)")
        continue
    seconds = (rows[-1][0] - rows[0][0]) / 1e9
    if seconds <= 0:
        continue
    span = max(span, seconds)
    cpu = (rows[-1][1] - rows[0][1]) / 1e9 / seconds * 100
    wakes = (rows[-1][2] - rows[0][2]) / seconds
    total_cpu += cpu
    total_wakes += wakes
    print(f"{name:40} {cpu:7.1f}% {wakes:10.0f} {rows[-1][3] / 2**20:7.0f}MB")
print(f"{'total':40} {total_cpu:7.1f}% {total_wakes:10.0f}   over {span:.0f}s")
print()
print('WebKit processes are matched to the app by pid order; see the comment above.')
print('Rough guide: a static screen should sit near 0-2% CPU and a few dozen wake-ups/s;')
print('steady double-digit CPU while nothing moves means something is redrawing every frame.')
