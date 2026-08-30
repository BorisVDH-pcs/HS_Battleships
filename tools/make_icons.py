#!/usr/bin/env python
"""Turn a folder of source artwork into board-sized tile icons.

    pip install Pillow
    python tools/make_icons.py

Reads every image in tools/icon-src/ and writes a square, transparent-padded
64x64 PNG to web/public/icons/, named after the source file as a slug. Vite
copies web/public/ verbatim, so there is no build step to wire up — the file
is live as soon as it is committed.

Why 64px when a cell is 30-50px: two device pixels per CSS pixel on a phone.
Going bigger is wasted bytes. Going to the raw wiki art is *very* wasted bytes
— those are 100-1280px and average 92 KB, against roughly 4 KB here.

The slug is what goes in the admin paste box, after the pipe:

    Dragon warhammer | dragon_warhammer

so keep source filenames recognisable. `1024px-` prefixes and `_detail`
suffixes are stripped automatically, since that is how the OSRS wiki names
its downloads.
"""
import os
import re
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit('Pillow is missing. Run:  pip install Pillow')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', 'icon-src')
DST = os.path.join(ROOT, 'web', 'public', 'icons')
SIZE = 64
KEEP = re.compile(r'\.(png|webp|jpe?g|gif|bmp)$', re.I)


def slugify(filename):
    name = KEEP.sub('', filename)
    name = re.sub(r'^\d+px-', '', name)                      # 1024px-Foo -> Foo
    name = re.sub(r'[_ -]*(detail|animated)$', '', name, flags=re.I)
    name = re.sub(r'[^A-Za-z0-9]+', '_', name).strip('_').lower()
    return name or 'icon'


def convert(src_path, dst_path):
    with Image.open(src_path) as im:
        im.seek(0) if getattr(im, 'is_animated', False) else None
        im = im.convert('RGBA')
        im.thumbnail((SIZE, SIZE), Image.LANCZOS)
        # Square canvas so every icon sits the same in its cell regardless of
        # whether the source was portrait or landscape.
        canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
        canvas.paste(im, ((SIZE - im.width) // 2, (SIZE - im.height) // 2), im)
        canvas.save(dst_path, 'PNG', optimize=True)
    return os.path.getsize(dst_path)


def main():
    if not os.path.isdir(SRC):
        os.makedirs(SRC)
        sys.exit('Created %s — drop source images in there and run again.' % SRC)
    if not os.path.isdir(DST):
        os.makedirs(DST)

    files = sorted(f for f in os.listdir(SRC) if KEEP.search(f))
    if not files:
        sys.exit('No images in %s' % SRC)

    seen, before, after = {}, 0, 0
    for f in files:
        slug = slugify(f)
        if slug in seen:
            print('  SKIP %-40s slug %r already taken by %s' % (f, slug, seen[slug]))
            continue
        seen[slug] = f
        src = os.path.join(SRC, f)
        before += os.path.getsize(src)
        after += convert(src, os.path.join(DST, slug + '.png'))
        print('  %-44s -> %s.png' % (f[:44], slug))

    print('\n%d icons  |  %.1f KB in, %.1f KB out  (%.0f%% smaller)'
          % (len(seen), before / 1024.0, after / 1024.0,
             100 - (after * 100.0 / max(before, 1))))
    print('Slugs to use in the admin paste box: %s' % ', '.join(sorted(seen)))


if __name__ == '__main__':
    main()
