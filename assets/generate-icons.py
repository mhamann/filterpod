#!/usr/bin/env python3
"""Generates every icon SVG from one drawing.

The mark is the asterisk: the universal glyph for a censored word, in crema on dark
roast. Nothing else — earlier icons (a filter funnel, a rendered pour-over, a microphone
with an asterisk grille) were pictograms assembled from parts, and next to the
one-circle-one-gesture marks of the apps people actually use they read as kludge. The
asterisk is already the app's glyph on the cut pills and the splash; the launcher now
says the same single thing.

Run from assets/:  python3 generate-icons.py
"""

import math
import pathlib

BG_DEFS = """<defs><radialGradient id="bgv" cx="0.5" cy="0.42" r="0.78">
  <stop offset="0" stop-color="#1b120b"/><stop offset="1" stop-color="#0a0605"/>
</radialGradient></defs>"""
CREMA = '#cf8842'


def asterisk(cx, cy, r, w):
    out = []
    for a in range(6):
        ang = math.radians(90 + a * 60)
        out.append(f'<path d="M{cx} {cy} L{cx + r*math.cos(ang):.2f} '
                   f'{cy - r*math.sin(ang):.2f}" stroke="{CREMA}" '
                   f'stroke-width="{w}" stroke-linecap="round"/>')
    return out


def wrap(parts, size, radius=24, bg=True):
    body = [BG_DEFS]
    if bg:
        body.append(f'<rect width="108" height="108" rx="{radius}" fill="url(#bgv)"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 108 108">' + ''.join(body + parts) + '</svg>')


def main():
    here = pathlib.Path(__file__).parent
    # Adaptive foreground: the mask crops to ~r33 of the 108 canvas; r22 + half the
    # 10-wide stroke reaches 27, safely inside. Verified against a circle clip once
    # already this project — see the launcher-mask commit.
    mark = asterisk(54, 54, 22, 10)
    (here / 'icon-foreground.svg').write_text(wrap(mark, 108, bg=False))
    (here / 'icon-legacy.svg').write_text(wrap(asterisk(54, 54, 25, 11), 512))
    (here / 'icon-round.svg').write_text(
        wrap(asterisk(54, 54, 25, 11), 512).replace(
            '<rect width="108" height="108" rx="24" fill="url(#bgv)"/>',
            '<circle cx="54" cy="54" r="54" fill="url(#bgv)"/>'))
    (here / 'icon-maskable.svg').write_text(wrap(mark, 512, radius=0))
    # The store icon is the launcher icon. One mark, everywhere — that is the point.
    (here / 'icon-store.svg').write_text(wrap(asterisk(54, 54, 25, 11), 512))
    print('icon SVGs written')


if __name__ == '__main__':
    main()
