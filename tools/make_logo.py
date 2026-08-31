#!/usr/bin/env python
"""Derive the shipped logo and app icons from the source artwork.

    pip install Pillow
    python tools/make_logo.py

Reads the two files committed at the repo root and writes to web/public/:

    HSLogo_Larger.PNG  ->  logo.png             (header + sign-in wordmark)
    HS Logo.png        ->  icon.png             (favicon)
                       ->  apple-touch-icon.png (home-screen icon, 180x180)

Two things the sources need fixing for.

They are 3840x2160 and 2.6 MB. That is a fine master and a terrible thing to
send every player on a phone for something drawn 38px tall, so this crops away
the empty black and scales to LOGO_WIDTH.

They are opaque black, and the page is #07060a with a soft ember gradient
behind it. Pasted as-is the logo sits in a visible black box. Because the
artwork is glow-on-black, luminance *is* the alpha channel: taking the
brightest of R/G/B as alpha keeps the gold exactly as drawn and lets the glow
fall off into whatever is behind it. That only works for art on black, which
is why this is a script and not a general-purpose resizer.
"""
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is not installed:  pip install Pillow")

LOGO_WIDTH = 480   # ~2x the widest it is ever drawn (sign-in, ~210px)
TOUCH = 180        # what iOS asks for
BG = (7, 6, 10)    # --bg, for the one icon that cannot be transparent
CROP_MARGIN = 0.01  # trim until only this fraction of the glow is outside


def luminance_alpha(im):
    """Opaque art on black -> the same art, keyed to its own brightness."""
    im = im.convert("RGBA")
    r, g, b, _ = im.split()
    # Brightest channel, not a weighted luma: gold is red+green heavy, and a
    # luma curve would thin the blue-poor glow more than the eye expects.
    alpha = Image.new("L", im.size)
    alpha.paste(max((r, g, b), key=lambda c: c.getextrema()[1]))
    alpha = Image.merge("RGB", (r, g, b)).convert("L").point(lambda v: min(255, int(v * 1.25)))
    im.putalpha(alpha)
    return im


def trim(im):
    """Crop to where the light actually is.

    getbbox() is no use here: the master has embers scattered to all four
    edges, so any brightness threshold returns very nearly the whole 3840x2160
    frame and the wordmark ends up a small thing adrift in a large box. This
    instead walks the row and column luminance sums and drops the outermost
    CROP_MARGIN of the total at each edge, which keeps the wordmark and its
    glow and discards the sparse dust around them.
    """
    lum = Image.merge("RGB", im.convert("RGBA").split()[:3]).convert("L")
    w, h = lum.size
    px = lum.load()

    cols, rows = [0] * w, [0] * h
    for y in range(0, h, 4):          # every 4th pixel: same answer, 16x quicker
        for x in range(0, w, 4):
            v = px[x, y]
            cols[x] += v
            rows[y] += v

    def span(vals):
        total = sum(vals)
        if not total:
            return 0, len(vals) - 1
        lo_t, hi_t = total * CROP_MARGIN, total * (1 - CROP_MARGIN)
        lo = hi = 0
        run = 0
        for i, v in enumerate(vals):
            run += v
            if run >= lo_t:
                lo = i
                break
        run = 0
        for i, v in enumerate(vals):
            run += v
            if run >= hi_t:
                hi = i
                break
        return lo, hi

    left, right = span(cols)
    top, bottom = span(rows)
    return im.crop((left, top, right, bottom))


def main():
    src = Image.open("HSLogo_Larger.PNG")
    logo = trim(luminance_alpha(src))
    h = round(logo.height * LOGO_WIDTH / logo.width)
    logo = logo.resize((LOGO_WIDTH, h), Image.LANCZOS)
    logo.save("web/public/logo.png", optimize=True)
    print(f"web/public/logo.png          {logo.size}")

    icon = luminance_alpha(Image.open("HS Logo.png"))
    icon.save("web/public/icon.png", optimize=True)
    print(f"web/public/icon.png          {icon.size}")

    # The home-screen icon is composited onto the page background: iOS ignores
    # transparency and would otherwise fill it with white.
    touch = Image.new("RGBA", (TOUCH, TOUCH), BG + (255,))
    fitted = icon.copy()
    fitted.thumbnail((TOUCH - 32, TOUCH - 32), Image.LANCZOS)
    touch.alpha_composite(fitted, ((TOUCH - fitted.width) // 2, (TOUCH - fitted.height) // 2))
    touch.convert("RGB").save("web/public/apple-touch-icon.png", optimize=True)
    print(f"web/public/apple-touch-icon  {touch.size}")


if __name__ == "__main__":
    main()
