The files in here are generated. Do not edit them by hand.

    logo.png              header + sign-in wordmark
    icon.png              favicon
    apple-touch-icon.png  home-screen icon
    favicon.svg           hand-written fallback favicon (not generated)

The masters are the two PNGs at the repo root. Re-derive after changing one:

    python tools/make_logo.py

That crops the empty black margin, keys the black to transparency so the glow
sits on the page rather than in a box, and scales the 3840x2160 master down to
something a phone should be asked to download.
