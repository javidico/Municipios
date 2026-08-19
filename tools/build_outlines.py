#!/usr/bin/env python3
"""Build the province-border overlay for the Spain map as exact vector paths.

The original runtime approach rasterised the whole 15 MB SVG to a 3538x2013
canvas and ran a per-pixel edge detector in JavaScript on every launch. That was
slow, and it left the borders as a raster with a hard resolution ceiling: zoom
past ~2x and they go soft. It also missed any border between two adjacent
provinces that happened to share one of the map's four fill colours.

This computes the same borders topologically instead, and exactly:

  * Every municipio polygon is split into its edges (undirected, quantised so
    shared vertices match).
  * An edge used by two polygons of the same province is interior -> dropped.
  * An edge used by two polygons of different provinces is a province border.
  * An edge used only once is the outer boundary: coastline or national border.

86% of the edges are shared by exactly two polygons, which is what makes this
work: the geometry is genuinely topologically shared, not independently traced.

The surviving edges are chained into polylines and simplified with
Douglas-Peucker. Simplification is not just for size: the source is a raster
trace made of 0.1-unit staircase steps, and collapsing those into straight runs
is what makes the borders look clean rather than pixelated.

Usage:  python tools/build_outlines.py
"""
import collections
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svgpath  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_JS = os.path.join(ROOT, 'quiz-municipios', 'map.js')
MUNICIPIOS_JS = os.path.join(ROOT, 'quiz-municipios', 'municipios.js')
OUT_DIR = os.path.join(ROOT, 'quiz-municipios', 'outlines')

REGION = 'spain'

# Coordinates are quantised to this many units per 1.0 so that vertices shared
# between neighbouring polygons compare equal. The source data is on a 0.1 grid,
# with a few values carrying 3 decimals, so 1e-4 is comfortably below the noise.
QUANT = 10000

# Douglas-Peucker tolerance, in viewBox units. The map is 1769 units wide; at the
# app's maximum 14x zoom on a phone that is roughly 3pt per unit, so 0.15 units
# stays under half a point -- invisible, while still collapsing the staircases.
TOLERANCE = 0.15

# Decimals kept in the emitted path data. 0.01 units is far below one device
# pixel at maximum zoom.
PRECISION = 2

# Polylines whose bounding box is smaller than this, in viewBox units, are
# dropped. The source map contains thousands of micro-polygons -- path3 is a
# 0.09 x 0.075 square -- and each one contributes four single-use edges that
# survive the border test legitimately but render as speckle scattered across the
# provinces. This is not a vertex-matching artefact: coarsening QUANT from 1e-4
# to 2e-2 changes the single-use edge count by under 3%, so the geometry really
# is that small. At the app's 14x maximum zoom one unit is roughly 3pt, so 0.5
# units is a 1.5pt speck; genuine enclaves are an order of magnitude larger.
MIN_EXTENT = 0.5


def load_path_provinces():
    """Map every SVG path id to the province of the municipio that owns it."""
    src = open(MUNICIPIOS_JS, encoding='utf-8').read()
    block = src[src.index(REGION + ': {'):]
    pid2prov = {}
    pattern = re.compile(
        r'"provincia":\s*"([^"]*)"\s*,\s*"population".*?"paths":\s*\[(.*?)\]',
        re.S)
    for match in pattern.finditer(block):
        province = match.group(1)
        for pid in re.findall(r'"([^"]+)"', match.group(2)):
            pid2prov[pid] = province
    return pid2prov


def collect_border_edges(pid2prov):
    """Return the set of edges that lie on a province border or the outer edge."""
    uses = collections.Counter()
    provinces = collections.defaultdict(set)

    for pid, fill, d in svgpath.iter_paths(MAP_JS, REGION):
        # Paths with no municipio still contribute their outline; they simply
        # never cancel against a same-province neighbour.
        province = pid2prov.get(pid, '\x00unmapped:' + str(pid))
        for subpath in svgpath.parse(d):
            if len(subpath) < 3:
                continue
            pts = [(int(round(x * QUANT)), int(round(y * QUANT)))
                   for x, y in subpath]
            if pts[0] != pts[-1]:
                pts.append(pts[0])
            for i in range(len(pts) - 1):
                a, b = pts[i], pts[i + 1]
                if a == b:
                    continue
                key = (a, b) if a < b else (b, a)
                uses[key] += 1
                provinces[key].add(province)

    keep = set()
    stats = collections.Counter()
    for key, count in uses.items():
        if count == 1:
            keep.add(key)
            stats['outer'] += 1
        elif count == 2 and len(provinces[key]) == 1:
            stats['interior'] += 1
        else:
            # Two polygons from different provinces, or a degenerate edge used
            # more than twice. Either way it is not interior to one province.
            keep.add(key)
            stats['border'] += 1
    print('  edges: %d unique -> %d kept (%d interior dropped, %d border, %d outer)'
          % (len(uses), len(keep), stats['interior'], stats['border'], stats['outer']))
    return keep


def chain(edges):
    """Chain undirected edges into the longest polylines they allow."""
    adjacency = collections.defaultdict(list)
    for a, b in edges:
        adjacency[a].append(b)
        adjacency[b].append(a)

    unused = set(edges)

    def key(a, b):
        return (a, b) if a < b else (b, a)

    def walk(start, first):
        line = [start]
        current, nxt = start, first
        while True:
            k = key(current, nxt)
            if k not in unused:
                break
            unused.discard(k)
            line.append(nxt)
            # Keep going only while the path is unambiguous: at a junction, stop
            # and let another walk pick up the remaining branches.
            options = [p for p in adjacency[nxt] if key(nxt, p) in unused]
            if len(options) != 1:
                break
            current, nxt = nxt, options[0]
        return line

    lines = []
    # Start at junctions and endpoints first, so open runs are not cut in half.
    for vertex in [v for v, n in adjacency.items() if len(n) != 2]:
        for neighbour in list(adjacency[vertex]):
            if key(vertex, neighbour) in unused:
                lines.append(walk(vertex, neighbour))
    # Whatever is left is a closed loop of degree-2 vertices.
    while unused:
        a, b = next(iter(unused))
        lines.append(walk(a, b))
    return lines


def simplify(points, tolerance):
    """Iterative Douglas-Peucker. Iterative because some runs are very long."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    t2 = tolerance * tolerance
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        x1, y1 = points[first]
        x2, y2 = points[last]
        dx, dy = x2 - x1, y2 - y1
        norm = dx * dx + dy * dy
        worst, worst_i = -1.0, -1
        for i in range(first + 1, last):
            px, py = points[i]
            if norm == 0:
                d2 = (px - x1) ** 2 + (py - y1) ** 2
            else:
                # Squared perpendicular distance to the segment's line.
                cross = dx * (py - y1) - dy * (px - x1)
                d2 = cross * cross / norm
            if d2 > worst:
                worst, worst_i = d2, i
        if worst > t2:
            keep[worst_i] = True
            stack.append((first, worst_i))
            stack.append((worst_i, last))
    return [p for p, k in zip(points, keep) if k]


def to_path_data(lines):
    """Emit one 'd' string, using relative moves to keep the text small."""
    fmt = '%.*f' % (PRECISION, 0)  # placeholder, real formatting below
    out = []
    cx = cy = 0.0

    def num(v):
        s = ('%.*f' % (PRECISION, v)).rstrip('0').rstrip('.')
        return '0' if s in ('', '-0') else s

    for line in lines:
        first = True
        for x, y in line:
            if first:
                out.append('m%s,%s' % (num(x - cx), num(y - cy)))
                first = False
            else:
                out.append('l%s,%s' % (num(x - cx), num(y - cy)))
            cx, cy = x, y
    return ''.join(out)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print('reading province assignments ...')
    pid2prov = load_path_provinces()
    print('  %d paths across %d provinces' % (len(pid2prov), len(set(pid2prov.values()))))

    print('classifying edges ...')
    t = time.time()
    keep = collect_border_edges(pid2prov)
    print('  %.1fs' % (time.time() - t))

    print('chaining into polylines ...')
    t = time.time()
    lines = chain(keep)
    print('  %d polylines, %d points  %.1fs'
          % (len(lines), sum(len(l) for l in lines), time.time() - t))

    print('dropping speckle (extent < %.2f units) ...' % MIN_EXTENT)
    threshold = MIN_EXTENT * QUANT
    kept_lines = []
    for line in lines:
        xs = [p[0] for p in line]
        ys = [p[1] for p in line]
        if max(max(xs) - min(xs), max(ys) - min(ys)) >= threshold:
            kept_lines.append(line)
    print('  %d polylines dropped, %d kept' % (len(lines) - len(kept_lines), len(kept_lines)))
    lines = kept_lines

    print('simplifying (tolerance %.2f units) ...' % TOLERANCE)
    t = time.time()
    simplified = []
    for line in lines:
        pts = [(x / QUANT, y / QUANT) for x, y in line]
        pts = simplify(pts, TOLERANCE)
        if len(pts) >= 2:
            simplified.append(pts)
    raw_points = sum(len(l) for l in lines)
    kept_points = sum(len(l) for l in simplified)
    print('  %d points (%.1f%% of %d)  %.1fs'
          % (kept_points, 100.0 * kept_points / raw_points, raw_points, time.time() - t))

    data = to_path_data(simplified)
    payload = {
        'region': REGION,
        'tolerance': TOLERANCE,
        'polylines': len(simplified),
        'points': kept_points,
        'd': data
    }
    path = os.path.join(OUT_DIR, 'outline-%s.json' % REGION)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, separators=(',', ':'))
    print('wrote %s (%.0f KB)' % (os.path.relpath(path, ROOT),
                                  os.path.getsize(path) / 1024.0))


if __name__ == '__main__':
    main()
