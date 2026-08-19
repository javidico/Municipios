"""Minimal SVG path parser for the quiz-municipios maps.

The maps were vector-traced from a raster, so the only commands present are
m/M (moveto), h/H, v/V, l/L -- no curves, no arcs, no closepath. Every path is
therefore a plain polyline, which makes parsing and simplifying trivial.
"""
import re

NUM = re.compile(r'[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?')
TOKEN = re.compile(r'([MmLlHhVvZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)')


def parse(d):
    """Parse a path 'd' string into a list of subpaths (lists of (x, y))."""
    toks = [(m.group(1), m.group(2)) for m in TOKEN.finditer(d)]
    subpaths, cur = [], []
    x = y = 0.0
    cmd = None
    i = 0
    n = len(toks)
    while i < n:
        letter, num = toks[i]
        if letter:
            cmd = letter
            i += 1
            if cmd in 'Zz':
                if len(cur) > 1:
                    subpaths.append(cur)
                cur = []
                cmd = None
            continue
        if cmd is None:
            i += 1
            continue

        def take(k):
            """Consume k numeric tokens starting at i."""
            vals = []
            j = i
            while j < n and len(vals) < k:
                if toks[j][0]:
                    break
                vals.append(float(toks[j][1]))
                j += 1
            return vals, j

        if cmd in 'Mm':
            vals, j = take(2)
            if len(vals) < 2:
                break
            if cmd == 'm':
                x, y = x + vals[0], y + vals[1]
            else:
                x, y = vals[0], vals[1]
            if len(cur) > 1:
                subpaths.append(cur)
            cur = [(x, y)]
            i = j
            # Subsequent coordinate pairs after a moveto are implicit linetos.
            cmd = 'l' if cmd == 'm' else 'L'
        elif cmd in 'Ll':
            vals, j = take(2)
            if len(vals) < 2:
                break
            if cmd == 'l':
                x, y = x + vals[0], y + vals[1]
            else:
                x, y = vals[0], vals[1]
            cur.append((x, y))
            i = j
        elif cmd in 'Hh':
            vals, j = take(1)
            if not vals:
                break
            x = x + vals[0] if cmd == 'h' else vals[0]
            cur.append((x, y))
            i = j
        elif cmd in 'Vv':
            vals, j = take(1)
            if not vals:
                break
            y = y + vals[0] if cmd == 'v' else vals[0]
            cur.append((x, y))
            i = j
        else:
            i += 1
    if len(cur) > 1:
        subpaths.append(cur)
    return subpaths


def iter_paths(map_js_path, region):
    """Yield (id, fill, d) for every <path> in the given region's SVG."""
    src = open(map_js_path, encoding='utf-8').read()
    start = src.index(region + ':`') if (region + ':`') in src else src.index(region + ': `')
    tail = src[start:]
    # Region blocks are template literals; stop at the closing backtick.
    end = tail.index('`', tail.index('`') + 1)
    block = tail[:end]
    for m in re.finditer(r'<path\b([^>]*?)/?>', block):
        attrs = m.group(1)
        pid = re.search(r'id="([^"]*)"', attrs)
        fill = re.search(r'fill="([^"]*)"', attrs)
        d = re.search(r'\sd="([^"]*)"', attrs)
        if d:
            yield (pid.group(1) if pid else None,
                   fill.group(1) if fill else None,
                   d.group(1))
