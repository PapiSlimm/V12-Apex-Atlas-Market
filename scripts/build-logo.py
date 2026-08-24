#!/usr/bin/env python3
"""
Derive every logo asset the app needs from the one supplied master.

    python3 scripts/build-logo.py

Input   assets/urban-visions-logo.png            (the master, as supplied)
Output  assets/urban-visions-logo-reverse.png    (for dark backgrounds)
        public/media/logo-{128,256,512}.png
        public/media/logo-reverse-{128,256,512}.png
        public/favicon.png, public/apple-touch-icon.png
        public/media/og-card.png                 (social preview)

WHY A REVERSE VARIANT EXISTS
----------------------------
The supplied mark is chrome-on-white: a vertical gradient whose lower half is
near-black. On this application's #09090b surface the bottom of the V, the
"Multimedia" wordmark and most of the chrome simply disappear — you are left
with a red outline floating in space.

The reverse variant lifts the *neutral* pixels into the light half of the range
and leaves the saturated ones alone. That distinction matters: lifting the red
glow too turns crimson into pink, which is a different brand. So saturation is
used as a mask, and the glow passes through untouched.

Nothing here alters the artwork's shapes, proportions or colours-of-record. It
is the same logo, exposed for the surface it is being placed on.
"""

from __future__ import annotations

import os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, 'assets', 'urban-visions-logo.png')
SURFACE = (9, 9, 11)  # --surface-0

SIZES = (128, 256, 512)


def load_master() -> Image.Image:
    img = Image.open(MASTER).convert('RGBA')
    # The supplied file carries transparent margins; trimming makes every
    # downstream size behave predictably instead of inheriting arbitrary padding.
    return img.crop(img.getbbox())


def reverse(img: Image.Image) -> Image.Image:
    a = np.array(img).astype(np.float32)
    rgb, alpha = a[..., :3], a[..., 3:]

    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    mx, mn = rgb.max(axis=-1), rgb.min(axis=-1)
    saturation = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)

    # Neutral chrome, lifted into a range that reads on a dark surface.
    lifted = 55 + (lum / 255.0) * 200
    neutral = np.stack([lifted, lifted, lifted], axis=-1)

    # 1 where the crimson glow lives, 0 on neutral chrome; a soft edge between,
    # so there is no visible seam where the mask switches.
    glow = np.clip((saturation - 0.12) / 0.25, 0, 1)[..., None]

    out = np.clip(neutral * (1 - glow) + rgb * glow, 0, 255)
    return Image.fromarray(np.concatenate([out, alpha], axis=-1).astype(np.uint8), 'RGBA')


def square(img: Image.Image, size: int, background: tuple[int, int, int] | None) -> Image.Image:
    """Fit into a square canvas without distorting the mark's proportions."""
    canvas = Image.new('RGBA', (size, size), (*background, 255) if background else (0, 0, 0, 0))
    scale = min(size / img.width, size / img.height) * 0.86  # breathing room
    resized = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    canvas.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return canvas


def main() -> None:
    master = load_master()
    rev = reverse(master)
    rev.save(os.path.join(ROOT, 'assets', 'urban-visions-logo-reverse.png'))

    media = os.path.join(ROOT, 'public', 'media')
    os.makedirs(media, exist_ok=True)

    for name, img in (('logo', master), ('logo-reverse', rev)):
        for width in SIZES:
            height = round(img.height * width / img.width)
            img.resize((width, height), Image.LANCZOS).save(os.path.join(media, f'{name}-{width}.png'))

    # Favicons sit on browser chrome that may be light or dark, so they get the
    # app surface baked in rather than transparency — a transparent dark-chrome
    # logo on a dark tab bar is an empty square.
    square(rev, 64, SURFACE).save(os.path.join(ROOT, 'public', 'favicon.png'))
    square(rev, 180, SURFACE).save(os.path.join(ROOT, 'public', 'apple-touch-icon.png'))

    # Social preview, 1200x630 — the size every platform crops toward.
    card = Image.new('RGBA', (1200, 630), (*SURFACE, 255))
    scale = 430 / rev.height
    mark = rev.resize((round(rev.width * scale), 430), Image.LANCZOS)
    card.alpha_composite(mark, ((1200 - mark.width) // 2, (630 - mark.height) // 2 - 20))
    card.convert('RGB').save(os.path.join(media, 'og-card.png'))

    print(f'[logo] master {master.size} -> reverse, {len(SIZES)} sizes each, favicons, og-card')


if __name__ == '__main__':
    main()
