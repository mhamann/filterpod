#!/usr/bin/env python3
"""Generates every icon SVG from one drawing.

The mark: a podcast microphone with an asterisk for a grille — the mic that won't say
it. Mic means podcast at a glance; the asterisk is the universal glyph for a word you
were not shown. Coffee lives in the palette (crema capsule on dark roast), not in the
drawing — every attempt to draw actual coffee equipment died at launcher size.

Two variants on purpose. The launcher is the bare mark, because at a centimetre across
anything else is mud and Android prints the app name underneath anyway. The store mark
adds the grawlix bubble and the wordmark, which is where the icon stops being "a mic
app" and becomes this one.

Run from assets/:  python3 generate-icons.py
Then rasterise at each density with rsvg-convert (see README).
"""

import math
import pathlib

BG = '#0d0908'
CREAM = '#f0cea3'
CREMA = '#cf8842'

BG_DEFS = '''<defs>
  <radialGradient id="bgv" cx="0.5" cy="0.42" r="0.78">
    <stop offset="0" stop-color="#1b120b"/><stop offset="1" stop-color="#0a0605"/>
  </radialGradient>
</defs>'''


def asterisk(cx, cy, r, w, colour):
    """Six rounded arms. The censored word, reduced to one glyph."""
    out = []
    for a in range(6):
        ang = math.radians(90 + a * 60)
        out.append(f'<path d="M{cx} {cy} L{cx + r*math.cos(ang):.1f} '
                   f'{cy - r*math.sin(ang):.1f}" stroke="{colour}" '
                   f'stroke-width="{w}" stroke-linecap="round"/>')
    return out


def mic(cy_top, cap_h, cap_w, ast_r, ast_w, stroke):
    """The microphone: capsule with asterisk grille, cradle, stem, base.

    Proportions matter more than detail here: the capsule reads "mic" only when it is
    clearly taller than wide and the cradle arc swings visibly wider than the capsule.
    """
    cap_x = 54 - cap_w / 2
    cap_cy = cy_top + cap_h * 0.46
    cradle_top = cy_top + cap_h * 0.62
    cradle_r = cap_w / 2 + 12
    cradle_bot = cradle_top + cradle_r
    out = [f'<rect x="{cap_x:.1f}" y="{cy_top}" width="{cap_w}" height="{cap_h}" '
           f'rx="{cap_w/2:.1f}" fill="{CREMA}"/>']
    out += asterisk(54, cap_cy, ast_r, ast_w, BG)
    out.append(f'<path d="M{54-cradle_r:.1f} {cradle_top:.1f} v6 '
               f'a{cradle_r:.1f} {cradle_r:.1f} 0 0 0 {cradle_r*2:.1f} 0 v-6" '
               f'fill="none" stroke="{CREAM}" stroke-width="{stroke}" '
               f'stroke-linecap="round"/>')
    out.append(f'<path d="M54 {cradle_bot+4.5:.1f} v10 M{54-13} {cradle_bot+17:.1f} h26" '
               f'stroke="{CREAM}" stroke-width="{stroke}" stroke-linecap="round" '
               f'fill="none"/>')
    return out


def bubble(cx, cy, text):
    w = 6 + len(text.replace('&amp;', '&')) * 3.1
    return (f'<g><rect x="{cx-w/2:.1f}" y="{cy-5.4:.1f}" width="{w:.1f}" height="10.8" '
            f'rx="3.6" fill="#33230f" stroke="#7a5f3e" stroke-width="0.7"/>'
            f'<path d="M{cx-6:.1f} {cy+5:.1f} l1.2 4.4 l3.8 -4.4z" fill="#33230f"/>'
            f'<text x="{cx:.1f}" y="{cy+2.4:.1f}" text-anchor="middle" font-size="6.2" '
            f'font-weight="700" font-family="Helvetica, Arial, sans-serif" '
            f'fill="#ecd9b8">{text}</text></g>')


def wrap(parts, size, radius=24, bg='url(#bgv)', scale=1.0):
    body = [BG_DEFS]
    if bg:
        body.append(f'<rect width="108" height="108" rx="{radius}" fill="{bg}"/>')
    body.append(f'<g transform="translate(54 54) scale({scale}) translate(-54 -54)">')
    body += parts + ['</g>']
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 108 108">' + ''.join(body) + '</svg>')


def build_launcher():
    """Bare mark, sized for the adaptive safe zone (a circle of r33 around centre)."""
    return mic(cy_top=22, cap_h=38, cap_w=27, ast_r=9.5, ast_w=4.6, stroke=5)


def build_store():
    parts = mic(cy_top=12, cap_h=42, cap_w=30, ast_r=10.5, ast_w=5, stroke=5.5)
    parts.append(bubble(85, 18, '@#*!'))
    parts.append('<text x="54" y="99" text-anchor="middle" font-size="10.5" '
                 'font-weight="700" font-family="Helvetica, Arial, sans-serif" '
                 'fill="#f5eede">Filter<tspan fill="#e0a760">Pod</tspan></text>')
    return parts


def main():
    here = pathlib.Path(__file__).parent
    launch, store = build_launcher(), build_store()
    (here / 'icon-store.svg').write_text(wrap(store, 512))
    (here / 'icon-foreground.svg').write_text(wrap(launch, 108, bg=None))
    (here / 'icon-legacy.svg').write_text(wrap(launch, 512, scale=1.14))
    (here / 'icon-round.svg').write_text(
        wrap(launch, 512, scale=1.14).replace(
            '<rect width="108" height="108" rx="24" fill="url(#bgv)"/>',
            '<circle cx="54" cy="54" r="54" fill="url(#bgv)"/>'))
    (here / 'icon-maskable.svg').write_text(wrap(launch, 512, radius=0, scale=1.0))
    print('icon SVGs written')


if __name__ == '__main__':
    main()
