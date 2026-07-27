#!/usr/bin/env python3
"""Generates every icon SVG from one drawing.

The mark: coarse audio pouring into a coffee pod, a clean wave coming out under it.
Grawlix bubbles say "swearing" without printing any; the teal output is separated from
the brown input by hue, not just regularity, so the before/after reads in one glance.

Two variants on purpose. The store mark carries the wordmark, the bubbles and the
texture; the launcher drops all three, because at a centimetre across they are mud, and
Android prints the app name under the icon anyway.

Run from assets/:  python3 generate-icons.py
Then rasterise with scripts in the README (rsvg-convert at each density).
"""

import math
import pathlib
import random

BG_DEFS = '''<defs>
  <radialGradient id="bgv" cx="0.5" cy="0.42" r="0.75">
    <stop offset="0" stop-color="#1b120b"/><stop offset="1" stop-color="#0a0605"/>
  </radialGradient>
  <linearGradient id="bodyg" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#6e4c2c"/><stop offset="0.44" stop-color="#4a3119"/>
    <stop offset="0.56" stop-color="#3a2513"/><stop offset="1" stop-color="#5a3c20"/>
  </linearGradient>
  <linearGradient id="rimg" x1="0" y1="0" x2="1" y2="0.25">
    <stop offset="0" stop-color="#d9c096"/><stop offset="0.35" stop-color="#f7ecd2"/>
    <stop offset="0.7" stop-color="#e2cba2"/><stop offset="1" stop-color="#b3946a"/>
  </linearGradient>
  <radialGradient id="paperg" cx="0.5" cy="0.4" r="0.72">
    <stop offset="0" stop-color="#ecdfc4"/><stop offset="1" stop-color="#c2ab86"/>
  </radialGradient>
  <linearGradient id="tealg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#63e9ca"/><stop offset="1" stop-color="#2c9c86"/>
  </linearGradient>
  <radialGradient id="tglow" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="#3fd6b6" stop-opacity="0.4"/>
    <stop offset="1" stop-color="#3fd6b6" stop-opacity="0"/>
  </radialGradient>
  <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2"/>
    <feColorMatrix type="saturate" values="0"/>
    <feComposite operator="in" in2="SourceGraphic"/></filter>
</defs>'''

BAR_COLS = ['#c98f4e', '#9c6f3f', '#e3c795', '#7a5a38', '#8d6b46']


def basket(cy, rx, ry, bottom, half_bot):
    """The pod. Returns (under, over): `under` is drawn beneath the bars' clipped
    copies, `over` (front-lip shadow, rim) above them, which is what makes the bars
    read as going *into* the opening."""
    rx_in, ry_in = rx - 3.2, ry - 1.0
    under, over = [], []
    lw, rw = 54 - rx + 1.2, 54 + rx - 1.2
    under.append(f'<rect x="{54-half_bot+3.5:.1f}" y="{bottom-0.5:.1f}" '
                 f'width="{(half_bot-3.5)*2:.1f}" height="5.6" rx="2.6" fill="#d3b88c"/>')
    under.append(
        f'<path d="M{lw:.1f} {cy:.1f} '
        f'C {lw+1.5:.1f} {cy+14:.1f}, {54-half_bot-3:.1f} {bottom-8:.1f}, {54-half_bot:.1f} {bottom:.1f} '
        f'Q 54 {bottom+3.6:.1f}, {54+half_bot:.1f} {bottom:.1f} '
        f'C {54+half_bot+3:.1f} {bottom-8:.1f}, {rw-1.5:.1f} {cy+14:.1f}, {rw:.1f} {cy:.1f} '
        f'A {rx-1.2:.1f} {ry:.1f} 0 0 1 {lw:.1f} {cy:.1f} z" fill="url(#bodyg)"/>')
    # Centre crease and its catch light: the fold that makes the body two-fold.
    under.append(f'<path d="M54 {cy+ry+1.5:.1f} L54 {bottom+1.5:.1f}" stroke="#170d05" '
                 f'stroke-width="0.9" opacity="0.35" fill="none"/>')
    under.append(f'<path d="M52.6 {cy+ry+2:.1f} L52.6 {bottom:.1f}" stroke="#ffe9c2" '
                 f'stroke-width="1.6" opacity="0.10" fill="none"/>')
    under.append(f'<path d="M{lw+0.6:.1f} {cy+2:.1f} C {lw+2:.1f} {cy+13:.1f}, '
                 f'{54-half_bot-2:.1f} {bottom-9:.1f}, {54-half_bot+1:.1f} {bottom-1:.1f}" '
                 f'stroke="#ffdfae" stroke-width="1.4" opacity="0.22" fill="none"/>')
    under.append(f'<ellipse cx="54" cy="{cy}" rx="{rx_in}" ry="{ry_in}" fill="url(#paperg)"/>')
    under.append(f'<ellipse cx="54" cy="{cy}" rx="{rx_in}" ry="{ry_in}" fill="#7a6242" '
                 f'opacity="0.3" filter="url(#grain)"/>')
    under.append(f'<path d="M{54-rx_in:.1f} {cy:.1f} A {rx_in} {ry_in} 0 0 1 {54+rx_in:.1f} {cy:.1f}" '
                 f'fill="none" stroke="#5f4930" stroke-width="2.4" opacity="0.45"/>')
    over.append(f'<path d="M{54-rx_in:.1f} {cy:.1f} A {rx_in} {ry_in} 0 0 0 {54+rx_in:.1f} {cy:.1f} '
                f'L {54+rx_in-4:.1f} {cy+ry_in+2:.1f} A {rx_in-4:.1f} {ry_in-1:.1f} 0 0 0 '
                f'{54-rx_in+4:.1f} {cy+ry_in+2:.1f} z" fill="#241407" opacity="0.35"/>')
    over.append(f'<ellipse cx="54" cy="{cy}" rx="{rx}" ry="{ry}" fill="none" '
                f'stroke="url(#rimg)" stroke-width="4"/>')
    over.append(f'<path d="M{54-rx:.1f} {cy-0.8:.1f} A {rx} {ry} 0 0 1 {54+rx:.1f} {cy-0.8:.1f}" '
                f'fill="none" stroke="#fff7e6" stroke-width="1" opacity="0.5"/>')
    return under, over


def streams(rnd, n, x_spread, y_top, y_rim, y_deep):
    """Falling audio, as dashed vertical streams.

    x is drawn from a triangular distribution (sum of two uniforms) so the streams
    bunch into a pouring column; sampled uniformly they scatter into a cloud that
    hovers over the pod instead of falling into it.
    """
    out = []
    for _ in range(n):
        x = 54 + (rnd.random() + rnd.random() - 1) * x_spread
        centre = 1 - abs(x - 54) / (x_spread + 1)
        col = BAR_COLS[rnd.randrange(len(BAR_COLS))]
        y = y_top + rnd.random() * 8 * (1 - centre)
        end = y_rim + centre * (y_deep - y_rim) * rnd.random()
        w = 2.0 + centre * 0.9
        while y < end:
            seg = min(3 + rnd.random() * 9, end - y)
            if seg > 1.6:
                out.append(f'<rect x="{x-w/2:.2f}" y="{y:.2f}" width="{w:.2f}" '
                           f'height="{seg:.2f}" rx="{w/2:.2f}" fill="{col}" '
                           f'opacity="{0.5+0.5*centre:.2f}"/>')
            y += seg + 2 + rnd.random() * 3
    return out


def bubble(cx, cy, text):
    w = 6 + len(text.replace('&amp;', '&')) * 3.1
    return (f'<g><rect x="{cx-w/2:.1f}" y="{cy-5.4:.1f}" width="{w:.1f}" height="10.8" rx="3.6" '
            f'fill="#33230f" stroke="#7a5f3e" stroke-width="0.7"/>'
            f'<path d="M{cx-3:.1f} {cy+5:.1f} l2.6 3.8 l2.6 -3.8z" fill="#33230f"/>'
            f'<text x="{cx:.1f}" y="{cy+2.4:.1f}" text-anchor="middle" font-size="6.2" '
            f'font-weight="700" font-family="Helvetica, Arial, sans-serif" '
            f'fill="#ecd9b8">{text}</text></g>')


def wave(y, max_h, n, bar_w, gap, glow):
    out = []
    if glow:
        out.append(f'<ellipse cx="54" cy="{y}" rx="{(n*(bar_w+gap))/2+6:.1f}" '
                   f'ry="{max_h/2+7:.1f}" fill="url(#tglow)"/>')
    for i in range(n):
        t = i / (n - 1)
        h = max(2.6, max_h * (math.sin(t * math.pi) ** 1.4))
        x = 54 + (i - (n - 1) / 2) * (bar_w + gap)
        out.append(f'<rect x="{x-bar_w/2:.2f}" y="{y-h/2:.2f}" width="{bar_w}" '
                   f'height="{h:.2f}" rx="{bar_w/2}" fill="url(#tealg)"/>')
    return out


def wrap(parts, size, radius=24, bg='url(#bgv)', scale=1.0):
    body = []
    if bg:
        body.append(f'<rect width="108" height="108" rx="{radius}" fill="{bg}"/>')
    body.append(f'<g transform="translate(54 54) scale({scale}) translate(-54 -54)">')
    body += parts + ['</g>']
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 108 108">' + ''.join(body) + '</svg>')


def build_store():
    rnd = random.Random(41)
    cy, rx, ry, bot, hb = 48, 29, 7.4, 78, 17
    under, over = basket(cy, rx, ry, bot, hb)
    bars = streams(rnd, 15, rx - 9, 12, cy, cy + 5)
    clip = f'<clipPath id="cin"><ellipse cx="54" cy="{cy}" rx="{rx-3.2}" ry="{ry-1.0}"/></clipPath>'
    parts = [BG_DEFS, clip] + bars + under
    parts += ['<g clip-path="url(#cin)" opacity="0.8">'] + bars + ['</g>'] + over
    parts.append('<text x="54" y="67.5" text-anchor="middle" font-size="10" font-weight="700" '
                 'font-family="Helvetica, Arial, sans-serif" fill="#f5eede">Filter'
                 '<tspan fill="#e0a760">Pod</tspan></text>')
    parts += [bubble(22, 16, '@#*!'), bubble(84, 12, '%$#'), bubble(89, 27, '&amp;%!')]
    parts += wave(93, 22, 15, 2.7, 1.5, glow=True)
    return parts


def build_launcher():
    rnd = random.Random(9)
    cy, rx, ry, bot, hb = 45, 25, 6.3, 70, 14.5
    under, over = basket(cy, rx, ry, bot, hb)
    bars = streams(rnd, 9, rx - 8, 22, cy, cy + 4)
    clip = f'<clipPath id="cin2"><ellipse cx="54" cy="{cy}" rx="{rx-3.2}" ry="{ry-1.0}"/></clipPath>'
    parts = [BG_DEFS, clip] + bars + under
    parts += ['<g clip-path="url(#cin2)" opacity="0.8">'] + bars + ['</g>'] + over
    parts += wave(81.5, 12, 11, 3.1, 1.7, glow=True)
    return parts


def main():
    here = pathlib.Path(__file__).parent
    store, launch = build_store(), build_launcher()
    (here / 'icon-store.svg').write_text(wrap(store, 512))
    (here / 'icon-foreground.svg').write_text(wrap(launch, 108, bg=None))
    (here / 'icon-legacy.svg').write_text(wrap(launch, 512, scale=1.16))
    (here / 'icon-round.svg').write_text(
        wrap(launch, 512, scale=1.16).replace(
            '<rect width="108" height="108" rx="24" fill="url(#bgv)"/>',
            '<circle cx="54" cy="54" r="54" fill="url(#bgv)"/>'))
    (here / 'icon-maskable.svg').write_text(wrap(launch, 512, radius=0, scale=1.05))
    print('icon SVGs written')


if __name__ == '__main__':
    main()
