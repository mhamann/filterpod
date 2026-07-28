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
    (here / 'feature-graphic.svg').write_text(feature_graphic())
    print('icon SVGs written')


def feature_graphic():
    """Play's 1024x500 banner: the mark, the name, the tagline. Same glyph, same roast.

    Text is real SVG text, not paths — rsvg-convert resolves the family at raster time,
    so regenerating on another machine may shift metrics slightly. Acceptable: this is a
    one-off store asset, not a build artifact.
    """
    mark = asterisk(0, 0, 40, 17)  # drawn around origin, placed via transform
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500" viewBox="0 0 1024 500">
<defs><radialGradient id="bgv" cx="0.38" cy="0.42" r="0.9">
  <stop offset="0" stop-color="#1b120b"/><stop offset="1" stop-color="#0a0605"/>
</radialGradient></defs>
<rect width="1024" height="500" fill="url(#bgv)"/>
<g transform="translate(248 250) scale(2.1)">{''.join(mark)}</g>
<text x="428" y="272" font-family="Helvetica Neue, Helvetica, Arial, sans-serif"
  font-size="88" font-weight="700" fill="#f0e4d4" letter-spacing="-1">FilterPod</text>
<text x="432" y="330" font-family="Helvetica Neue, Helvetica, Arial, sans-serif"
  font-size="34" font-weight="400" fill="{CREMA}">Coarse language, filtered out.</text>
</svg>'''


if __name__ == '__main__':
    main()
