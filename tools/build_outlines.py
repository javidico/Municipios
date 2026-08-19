#!/usr/bin/env python3
"""Build the province-border overlay for the Spain map as exact vector paths.

The runtime approach this replaces rasterised the whole 15 MB SVG to a 3538x2013
canvas and ran a per-pixel edge detector in JavaScript on every launch. Slow, and
the result was a bitmap with a hard resolution ceiling: zoom past ~2x and the
borders went soft. It also missed any border between two adjacent provinces that
happened to share one of the map's four fill colours.

A border is where the province on one side differs from the province on the
other. That sounds obvious and the naive readings of it are all wrong, so it is
worth spelling out how this arrives at the answer in two stages.

First, cheaply: every municipio polygon is split into undirected edges, quantised
so that vertices shared by neighbours compare equal. An edge used by two polygons
of the same province cannot be a border under any reading, and that removes
786,034 of the 1,003,950 edges outright. 86% of edges are used exactly twice,
which is what makes this work at all: the geometry is genuinely topologically
shared, not independently traced.

Everything else is only a *candidate*, and counting uses cannot settle it:

  * "Used once, so it must be the outer boundary" is wrong. It drew 49 spurious
    outlines around ordinary inland municipios -- Buñol, La Gineta, Alustante --
    whose polygons simply share no edges with their neighbours, so nothing
    cancelled them. They appeared as holes inside their own province.

  * "Two polygons declaring different provinces, so it must be a border" is also
    wrong. Where one polygon is overpainted by another, the declared province is
    not the province you can see, and the line lands in the middle of a
    single-coloured province.

So the second stage asks what is actually painted. The provinces are rasterised
once into an index map, and every candidate is sampled a couple of pixels to each
side of its midpoint; it survives only when the two sides disagree. Coastline
keeps (province vs. sea), a real province border keeps, a municipio surrounded by
its own province drops. After this, no closed loop on the map has the same
province on both sides, and the only enclaves left are the real ones -- Treviño,
Orduña, Petilla de Aragón.

The surviving edges are chained into polylines and simplified with
Douglas-Peucker. Simplification is not only about size: the source is a raster
trace of 0.1-unit staircase steps, and collapsing those is what makes the borders
look clean rather than pixelated.

Usage:  python tools/build_outlines.py
"""
import collections
import json
import os
import re
import sys
import time

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svgpath  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_JS = os.path.join(ROOT, 'quiz-municipios', 'map.js')
MUNICIPIOS_JS = os.path.join(ROOT, 'quiz-municipios', 'municipios.js')
OUT_DIR = os.path.join(ROOT, 'quiz-municipios', 'outlines')

REGION = 'spain'
VIEWBOX = (1769.1083, 1006.6781)

# Vertices are quantised to this many steps per unit so that a vertex shared by
# two polygons compares equal. The source sits on a 0.1 grid with a few 3-decimal
# values, so 1e-4 is comfortably below the noise. Coarsening this to 2e-2 changes
# the single-use count by under 3%, i.e. the vertices already match: the leftover
# single-use edges are real geometry, not a matching artefact.
QUANT = 10000

# Resolution of the province index map used to answer "what is on the other side
# of this edge", in pixels per viewBox unit.
PIX_PER_UNIT = 6

# How far to each side of an edge midpoint to sample, in pixels. Below ~1.5 both
# samples can land on the same pixel and every edge would look interior.
SAMPLE_PX = 2.0

# Douglas-Peucker tolerance in viewBox units. The map is 1769 units wide; at the
# app's 14x maximum zoom on a phone that is roughly 3pt per unit, so 0.15 units
# stays under half a point -- invisible, while still collapsing the staircases.
TOLERANCE = 0.15

# Decimals kept in the emitted path data.
PRECISION = 2

# Polylines whose bounding box is smaller than this, in viewBox units, are
# dropped. The map holds thousands of micro-polygons -- path3 is a 0.09 x 0.075
# square -- whose edges pass the border test legitimately but render as speckle.
# At 14x zoom one unit is about 3pt, so 0.5 units is a 1.5pt speck.
MIN_EXTENT = 0.5


def load_path_provinces():
    """Map every SVG path id to the province of the municipio that owns it.

    Parsed properly rather than scraped with a regex. A pattern keyed on
    "provincia" being followed by "population" silently missed 82 paths whose
    entries carry another field in between, and those 82 did real damage: each
    got a province of its own, so its edges against genuine neighbours counted as
    borders, and it was skipped when painting the index map, leaving a hole of
    fake "sea" inside provinces like Burgos and Guadalajara.
    """
    src = open(MUNICIPIOS_JS, encoding='utf-8').read()
    start = src.index('{', src.index(REGION + ': {'))
    depth = 0
    end = None
    for i in range(start, len(src)):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                end = i
                break
    if end is None:
        raise ValueError('no se pudo delimitar el bloque de ' + REGION)

    block = src[start:end + 1]
    # The block is JavaScript, not quite JSON: it has trailing commas, and one
    # entry has "population": 717. with a dangling decimal point.
    text = re.sub(r',(\s*[\]}])', r'\1', block)
    text = re.sub(r'(\d)\.(\s*[,\}\]])', r'\1\2', text)
    data = json.loads(text)

    pid2prov = {}
    for municipio in data.values():
        province = municipio.get('provincia')
        if not province:
            continue
        for pid in municipio.get('paths') or []:
            pid2prov[pid] = province
    return pid2prov


def province_ids(pid2prov):
    """Assign each province a small positive integer; 0 is reserved for sea."""
    names = sorted(set(pid2prov.values()))
    return {name: i + 1 for i, name in enumerate(names)}


def classify_edges(pid2prov):
    """Split edges into definite borders and the single-use ones needing a check."""
    uses = collections.Counter()
    provinces = collections.defaultdict(set)

    unmapped = set()
    for pid, fill, d in svgpath.iter_paths(MAP_JS, REGION):
        province = pid2prov.get(pid)
        if province is None:
            # One shared bucket, never a province per path: giving each its own
            # would turn every edge it shares with a neighbour into a "border".
            unmapped.add(pid)
            province = '\x00unmapped'
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

    # Edges shared by two polygons of the same province cannot be a border under
    # any reading, so they go now and cheaply -- that is the bulk of them. Every
    # other edge is only a candidate: what decides it is what is actually painted
    # either side, which resolve_candidates() settles.
    candidates = []
    interior = 0
    for key, count in uses.items():
        if count == 2 and len(provinces[key]) == 1:
            interior += 1
        else:
            candidates.append(key)
    print('  %d unique edges: %d interior dropped, %d candidates'
          % (len(uses), interior, len(candidates)))
    if unmapped:
        print('  note: %d svg paths belong to no municipio' % len(unmapped))
    return candidates


def rasterise_provinces(pid2prov, prov_id):
    """Paint a province id per pixel, 0 where there is no land.

    Anything left as 0 reads as sea, and sea next to land is a boundary, so a
    path skipped here would punch a fake hole into the middle of its province.
    Paths with no municipio therefore still get painted, with the province that
    dominates their surroundings.
    """
    width = int(round(VIEWBOX[0] * PIX_PER_UNIT))
    height = int(round(VIEWBOX[1] * PIX_PER_UNIT))
    img = Image.new('L', (width, height), 0)
    draw = ImageDraw.Draw(img)
    painted = 0
    leftovers = []
    for pid, fill, d in svgpath.iter_paths(MAP_JS, REGION):
        province = pid2prov.get(pid)
        subpaths = [sp for sp in svgpath.parse(d) if len(sp) >= 3]
        if province is None:
            leftovers.append(subpaths)
            continue
        value = prov_id[province]
        for subpath in subpaths:
            draw.polygon([(x * PIX_PER_UNIT, y * PIX_PER_UNIT)
                          for x, y in subpath], fill=value)
            painted += 1

    array = np.asarray(img)
    for subpaths in leftovers:
        for subpath in subpaths:
            xs = [p[0] for p in subpath]
            ys = [p[1] for p in subpath]
            # Sample a band just outside the bounding box and take the province
            # seen most often; that is the one this scrap of land sits inside.
            x0 = max(0, int(min(xs) * PIX_PER_UNIT) - 3)
            x1 = min(width, int(max(xs) * PIX_PER_UNIT) + 4)
            y0 = max(0, int(min(ys) * PIX_PER_UNIT) - 3)
            y1 = min(height, int(max(ys) * PIX_PER_UNIT) + 4)
            window = array[y0:y1, x0:x1]
            values = window[window != 0]
            if values.size == 0:
                continue
            counts = np.bincount(values.ravel())
            draw.polygon([(x * PIX_PER_UNIT, y * PIX_PER_UNIT)
                          for x, y in subpath], fill=int(counts.argmax()))
            painted += 1

    print('  %dx%d index map, %d polygons painted (%d had no municipio)'
          % (width, height, painted, len(leftovers)))
    return np.asarray(img)


def resolve_candidates(candidates, index_map):
    """Keep an edge only where the two sides sit in different provinces.

    Applied to every candidate, not just the single-use ones, because the two
    available authorities disagree in places. The edge classification goes by each
    polygon's declared province; the index map goes by what is actually painted.
    Where a polygon is overpainted by another, only the index map reflects what
    the player sees, and drawing a border there would put a line in the middle of
    a single-coloured province.
    """
    if not candidates:
        return set()
    height, width = index_map.shape

    edges = np.array(candidates, dtype=np.float64).reshape(len(candidates), 4)
    ax, ay, bx, by = (edges[:, 0] / QUANT, edges[:, 1] / QUANT,
                      edges[:, 2] / QUANT, edges[:, 3] / QUANT)
    mx, my = (ax + bx) / 2.0, (ay + by) / 2.0
    dx, dy = bx - ax, by - ay
    length = np.hypot(dx, dy)
    length[length == 0] = 1.0
    # Unit normal to the edge; which side is which does not matter, only that the
    # two samples straddle it.
    offset = SAMPLE_PX / PIX_PER_UNIT
    nx, ny = -dy / length * offset, dx / length * offset

    def sample(px, py):
        ix = np.clip((px * PIX_PER_UNIT).astype(np.int64), 0, width - 1)
        iy = np.clip((py * PIX_PER_UNIT).astype(np.int64), 0, height - 1)
        return index_map[iy, ix]

    left = sample(mx + nx, my + ny)
    right = sample(mx - nx, my - ny)
    differ = left != right

    kept = set()
    for i in np.nonzero(differ)[0]:
        a = (int(edges[i, 0]), int(edges[i, 1]))
        b = (int(edges[i, 2]), int(edges[i, 3]))
        kept.add((a, b) if a < b else (b, a))
    print('  %d of %d candidates separate two different provinces (%d dropped)'
          % (len(kept), len(candidates), len(candidates) - len(kept)))
    return kept


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
            # Keep going only while the continuation is unambiguous; at a junction
            # stop and let another walk pick up the remaining branches.
            options = [p for p in adjacency[nxt] if key(nxt, p) in unused]
            if len(options) != 1:
                break
            current, nxt = nxt, options[0]
        return line

    lines = []
    for vertex in [v for v, n in adjacency.items() if len(n) != 2]:
        for neighbour in list(adjacency[vertex]):
            if key(vertex, neighbour) in unused:
                lines.append(walk(vertex, neighbour))
    while unused:
        a, b = next(iter(unused))
        lines.append(walk(a, b))
    return lines


def simplify(points, tolerance):
    """Iterative Douglas-Peucker; iterative because some runs are very long."""
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
    """Emit one 'd' string, relative throughout to keep the text small."""
    out = []
    cx = cy = 0.0

    def num(v):
        s = ('%.*f' % (PRECISION, v)).rstrip('0').rstrip('.')
        return '0' if s in ('', '-0') else s

    for line in lines:
        first = True
        for x, y in line:
            out.append('%s%s,%s' % ('m' if first else 'l', num(x - cx), num(y - cy)))
            first = False
            cx, cy = x, y
    return ''.join(out)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    print('reading province assignments ...')
    pid2prov = load_path_provinces()
    prov_id = province_ids(pid2prov)
    print('  %d paths across %d provinces' % (len(pid2prov), len(prov_id)))

    print('classifying edges ...')
    t = time.time()
    candidates = classify_edges(pid2prov)
    print('  %.1fs' % (time.time() - t))

    print('rasterising a province index map ...')
    t = time.time()
    index_map = rasterise_provinces(pid2prov, prov_id)
    print('  %.1fs' % (time.time() - t))

    print('resolving candidates by what lies either side ...')
    t = time.time()
    keep = resolve_candidates(candidates, index_map)
    print('  %d edges to draw  %.1fs' % (len(keep), time.time() - t))
    del index_map

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
    print('  %d dropped, %d kept' % (len(lines) - len(kept_lines), len(kept_lines)))
    lines = kept_lines

    print('simplifying (tolerance %.2f units) ...' % TOLERANCE)
    t = time.time()
    simplified = []
    for line in lines:
        pts = simplify([(x / QUANT, y / QUANT) for x, y in line], TOLERANCE)
        if len(pts) >= 2:
            simplified.append(pts)
    raw_points = sum(len(l) for l in lines)
    kept_points = sum(len(l) for l in simplified)
    print('  %d points (%.1f%% of %d)  %.1fs'
          % (kept_points, 100.0 * kept_points / raw_points, raw_points, time.time() - t))

    payload = {
        'region': REGION,
        'tolerance': TOLERANCE,
        'polylines': len(simplified),
        'points': kept_points,
        'd': to_path_data(simplified)
    }
    path = os.path.join(OUT_DIR, 'outline-%s.json' % REGION)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, separators=(',', ':'))
    print('wrote %s (%.0f KB)' % (os.path.relpath(path, ROOT),
                                  os.path.getsize(path) / 1024.0))


if __name__ == '__main__':
    main()
