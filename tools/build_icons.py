#!/usr/bin/env python3
"""Generate the PWA / apple-touch icons from the real Spain map geometry.

Rasterises the peninsula + Balearics + Ceuta/Melilla silhouette straight out of
map.js, so the icon is the actual map rather than a hand-drawn approximation.
The Canaries composition is left out: at 60 px it reads as noise.

Usage:  python tools/build_icons.py
"""
import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svgpath  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_JS = os.path.join(ROOT, 'quiz-municipios', 'map.js')
OUT_DIR = os.path.join(ROOT, 'quiz-municipios', 'icons')

BG = (14, 42, 71)        # deep navy
FG = (76, 187, 23)       # #4CBB17, the same green a guessed municipio turns

# Content bbox in viewBox units, excluding the Canaries composition.
BBOX = (252.2, 0.5, 1768.6, 959.8)
MASTER_W = 3072          # master mask width before downscaling


def render_master():
    """Render a high-resolution grayscale mask of the silhouette."""
    x0, y0, x1, y1 = BBOX
    bw, bh = x1 - x0, y1 - y0
    w = MASTER_W
    h = int(round(w * bh / bw))
    k = w / bw
    img = Image.new('L', (w, h), 0)
    dr = ImageDraw.Draw(img)
    kept = 0
    for pid, fill, d in svgpath.iter_paths(MAP_JS, 'spain'):
        for sp in svgpath.parse(d):
            if len(sp) < 3:
                continue
            ys = [p[1] for p in sp]
            xs = [p[0] for p in sp]
            if min(ys) > 760 and max(xs) < 560:   # Canaries -> skip
                continue
            dr.polygon([((x - x0) * k, (y - y0) * k) for x, y in sp], fill=255)
            kept += 1
    print('  silhouette polygons: %d  master %dx%d' % (kept, w, h))
    return img


def compose(master, size, fill_ratio, bg=BG, fg=FG):
    """Scale the mask to fill_ratio of `size` and centre it on a bg square."""
    cw = max(1, int(round(size * fill_ratio)))
    ch = max(1, int(round(cw * master.height / master.width)))
    mask = master.resize((cw, ch), Image.LANCZOS)
    out = Image.new('RGB', (size, size), bg)
    layer = Image.new('RGB', (cw, ch), fg)
    out.paste(layer, ((size - cw) // 2, (size - ch) // 2), mask)
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print('rendering master mask from map.js ...')
    master = render_master()

    # (filename, size, fill ratio).  Maskable icons must keep their content
    # inside the centre 80%, so they get a smaller ratio.
    targets = [
        ('apple-touch-icon.png', 180, 0.86),
        ('icon-192.png',         192, 0.86),
        ('icon-512.png',         512, 0.86),
        ('icon-512-maskable.png',512, 0.60),
        ('favicon-32.png',        32, 0.92),
    ]
    for name, size, ratio in targets:
        img = compose(master, size, ratio)
        path = os.path.join(OUT_DIR, name)
        img.save(path, optimize=True)
        print('  %-24s %4dpx  %6d bytes' % (name, size, os.path.getsize(path)))

    # A 16+32 px .ico keeps the desktop browser tab tidy too.
    ico = os.path.join(OUT_DIR, 'favicon.ico')
    compose(master, 64, 0.92).save(ico, sizes=[(16, 16), (32, 32), (48, 48)])
    print('  %-24s        %6d bytes' % ('favicon.ico', os.path.getsize(ico)))


if __name__ == '__main__':
    main()
