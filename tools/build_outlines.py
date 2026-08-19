#!/usr/bin/env python3
"""Precompute the province-border overlay for the Spain map.

At runtime main.js builds this overlay by serialising the 15 MB inline SVG,
rasterising it to a 3538x2013 canvas and running a per-pixel edge detector in
JavaScript -- about 7.1 million pixels of work on every single launch. On an
iPhone that is the single most expensive thing the app does at startup, and the
result never changes: the serialised SVG carries only its presentation
attributes, so the external .selected rule does not apply and the overlay is
independent of how many municipios you have guessed.

So we build it once, here, and ship the PNG. main.js falls back to computing it
at runtime whenever the file is missing, which is also how the other three maps
keep working: murcia, madrid and cadiz wrap their paths in a <g> with a
transform and a clipPath that this script deliberately does not implement.

Usage:  python tools/build_outlines.py
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svgpath  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_JS = os.path.join(ROOT, 'quiz-municipios', 'map.js')
OUT_DIR = os.path.join(ROOT, 'quiz-municipios', 'outlines')

# Must match drawProvinceOutlines() in main.js.
REGION = 'spain'
VIEWBOX = (1769.1083, 1006.6781)
SCALE = 2
THRESHOLD_SQ = 30 * 30

# Rendered at twice the target and boxed down, so that shared polygon edges do
# not leave single-pixel transparent seams that the detector would report as
# borders between municipios of the same province.
SUPERSAMPLE = 2


def parse_fill(value):
    if not value or not value.startswith('#'):
        return None
    v = value[1:]
    if len(v) == 3:
        v = ''.join(c * 2 for c in v)
    if len(v) != 6:
        return None
    return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16), 255)


def rasterise(width, height):
    """Fill every path with its own colour, in document order."""
    k = width / VIEWBOX[0]
    img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    filled = skipped = 0
    for pid, fill, d in svgpath.iter_paths(MAP_JS, REGION):
        colour = parse_fill(fill)
        if colour is None:
            skipped += 1
            continue
        for sp in svgpath.parse(d):
            if len(sp) < 3:
                continue
            dr.polygon([(x * k, y * k) for x, y in sp], fill=colour)
            filled += 1
    print('  filled %d polygons (%d paths had no usable fill)' % (filled, skipped))
    return img


def detect_edges(img):
    """Port of the JS edge detector: mark pixels whose right or lower
    neighbour has a materially different colour."""
    arr = np.asarray(img)
    rgb = arr[:, :, :3].astype(np.int32)
    alpha = arr[:, :, 3]
    h, w = alpha.shape

    dx = np.zeros((h, w), dtype=bool)
    diff = rgb[:, 1:, :] - rgb[:, :-1, :]
    dx[:, :-1] = (diff * diff).sum(axis=2) > THRESHOLD_SQ

    dy = np.zeros((h, w), dtype=bool)
    diff = rgb[1:, :, :] - rgb[:-1, :, :]
    dy[:-1, :] = (diff * diff).sum(axis=2) > THRESHOLD_SQ

    # Transparent pixels are skipped, exactly as in the original loop.
    edge = (alpha != 0) & (dx | dy)

    out = np.zeros((h, w, 4), dtype=np.uint8)   # black, transparent everywhere
    out[:, :, 3] = np.where(edge, 255, 0)
    print('  %d edge pixels of %d (%.2f%%)' % (edge.sum(), edge.size,
                                               100.0 * edge.sum() / edge.size))
    return Image.fromarray(out, 'RGBA')


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    w = int(round(VIEWBOX[0] * SCALE))
    h = int(round(VIEWBOX[1] * SCALE))
    print('rasterising %s at %dx%d (supersampled x%d) ...' % (REGION, w, h, SUPERSAMPLE))

    big = rasterise(w * SUPERSAMPLE, h * SUPERSAMPLE)
    img = big.resize((w, h), Image.BOX)
    big.close()

    print('detecting province borders ...')
    outline = detect_edges(img)

    path = os.path.join(OUT_DIR, 'outline-%s.png' % REGION)
    outline.save(path, optimize=True)
    print('  wrote %s (%.0f KB)' % (os.path.relpath(path, ROOT),
                                    os.path.getsize(path) / 1024.0))


if __name__ == '__main__':
    main()
