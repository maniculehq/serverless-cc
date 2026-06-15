#!/usr/bin/env python3
"""Extract the Claude Code JS bundle (cli.js) from a `bun build --compile`
standalone executable. Format-agnostic: works on macOS (Mach-O) and Linux (ELF).

Claude Code ships as a ~250 MB standalone binary = the Bun runtime + an embedded
payload. The payload's entry point is a single ~16 MB CommonJS file marked
`// @bun @bytecode @bun-cjs`, stored as readable source. This script locates that
file by content (the largest contiguous printable region starting with `// @bun`),
carves it out to <outdir>/cli.js, and prints an inventory.

The carved cli.js runs on a stock Bun — the embedded runtime is discarded — which
is exactly what `bin/cli.js` in this project is.

Usage:
    python3 scripts/extract.py <path-to-claude-binary> [outdir=bin]
"""
import re, sys, hashlib
from pathlib import Path


def analyze(path, outdir):
    data = Path(path).read_bytes()
    out = Path(outdir); out.mkdir(parents=True, exist_ok=True)
    rep = {}
    rep['file'] = str(path)
    rep['size'] = len(data)
    # bun version baked into the runtime
    m = re.search(rb'Bun v(\d+\.\d+\.\d+) \(([0-9a-f]+)\)', data)
    rep['bun'] = f"{m.group(1).decode()} ({m.group(2).decode()})" if m else "?"
    # claude code version banner
    cc = re.search(rb'(\d+\.\d+\.\d+) \(Claude Code\)', data)
    rep['cc_version'] = cc.group(1).decode() if cc else "?"
    # all $bunfs/root virtual-fs entries (embedded assets / .node addons)
    rep['bunfs'] = sorted(set(x.decode() for x in re.findall(rb'\$bunfs/root/[A-Za-z0-9_./\-]+', data)))
    # count separately-bundled CJS modules
    rep['cjs_headers'] = data.count(b'// @bun @bytecode @bun-cjs')
    rep['ripgrep_embedded'] = data.count(b'ripgrep 1') > 0 or data.count(b'BurntSushi') > 1

    # main cli.js = largest contiguous printable run that starts with "// @bun"
    def printable(b): return 32 <= b < 127 or b in (9, 10, 13)
    regions = []; start = None
    for i, b in enumerate(data):
        if printable(b):
            if start is None: start = i
        else:
            if start is not None and i - start >= 500_000: regions.append((start, i - start))
            start = None
    if start is not None and len(data) - start >= 500_000: regions.append((start, len(data) - start))

    entry = None
    for off, ln in sorted(regions, key=lambda r: -r[1]):
        head = data[off:off + 40]
        hp = head.find(b'// @bun')
        if hp != -1:
            entry = (off + hp, ln - hp); break

    if entry:
        o, ln = entry
        js = data[o:o + ln]
        (out / 'cli.js').write_bytes(js)
        rep['cli_out'] = str(out / 'cli.js')
        rep['cli_off'] = o; rep['cli_len'] = len(js)
        rep['cli_sha'] = hashlib.sha256(js).hexdigest()[:16]
        rep['cli_head'] = js[:50].decode('latin1')
        rep['cli_tail'] = js[-40:].decode('latin1')
    rep['printable_regions_ge_500k'] = [(o, l) for o, l in regions]
    return rep


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    r = analyze(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'bin')
    for k in ('file', 'size', 'bun', 'cc_version', 'cjs_headers', 'ripgrep_embedded',
              'cli_out', 'cli_off', 'cli_len', 'cli_sha', 'cli_head', 'cli_tail'):
        print(f"{k:20}: {r.get(k)}")
    print(f"{'bunfs':20}: {len(r['bunfs'])} entries")
    for b in r['bunfs']:
        print(f"{'':20}    {b}")
    print(f"{'printable>=500k':20}: {len(r['printable_regions_ge_500k'])} -> {r['printable_regions_ge_500k']}")
