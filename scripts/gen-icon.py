#!/usr/bin/env python3
"""Generate a placeholder brand icon (256x256) for Aike-FBclaw.
Draws a rounded-square gradient background with a white "claw/paw" mark,
then writes assets/icon.png and assets/icon.ico (PNG-in-ICO).
Pure stdlib only (zlib + struct), no PIL required.
"""
import struct, zlib, math, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
os.makedirs(ASSETS, exist_ok=True)

S = 256
R = 52  # rounded corner radius

# top / bottom gradient colors (indigo -> blue)
TOP = (24, 32, 74)
BOT = (27, 60, 138)

def lerp(a, b, t):
    return int(a + (b - a) * t)

def in_rounded_rect(x, y, w, h, r):
    # returns alpha mask boost for rounded square with margin
    if x < r and y < r:
        if (r - x) ** 2 + (r - y) ** 2 > r * r:
            return False
    if x >= w - r and y < r:
        if (x - (w - r)) ** 2 + (r - y) ** 2 > r * r:
            return False
    if x < r and y >= h - r:
        if (r - x) ** 2 + (y - (h - r)) ** 2 > r * r:
            return False
    if x >= w - r and y >= h - r:
        if (x - (w - r)) ** 2 + (y - (h - r)) ** 2 > r * r:
            return False
    return True

# paw geometry (centered)
cx, cy = 128, 150
pad_rx, pad_ry = 50, 42
toes = [(92, 96, 22), (120, 80, 24), (150, 82, 23), (176, 100, 20)]

def paw_alpha(x, y):
    best = 0.0
    # big pad (ellipse)
    dx = (x - cx) / pad_rx
    dy = (y - cy) / pad_ry
    d = math.hypot(dx, dy)
    best = max(best, 1.0 - abs(d - 1.0) * 6.0)
    for tx, ty, tr in toes:
        d = math.hypot(x - tx, y - ty) / tr
        best = max(best, 1.0 - abs(d - 1.0) * 5.0)
    return max(0.0, min(1.0, best))

# build RGBA pixels
raw = bytearray()
for y in range(S):
    raw.append(0)  # filter type 0
    t = y / (S - 1)
    bg = (lerp(TOP[0], BOT[0], t), lerp(TOP[1], BOT[1], t), lerp(TOP[2], BOT[2], t))
    for x in range(S):
        if not in_rounded_rect(x, y, S, S, R):
            raw += bytes((0, 0, 0, 0))
            continue
        pa = paw_alpha(x, y)
        if pa > 0:
            # white paw with slight cool tint
            r = int(lerp(bg[0], 245, pa))
            g = int(lerp(bg[1], 247, pa))
            b = int(lerp(bg[2], 255, pa))
            a = 255
        else:
            r, g, b, a = bg[0], bg[1], bg[2], 255
        raw += bytes((r, g, b, a))

def png_chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

png = b"\x89PNG\r\n\x1a\n"
png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
png += png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
png += png_chunk(b"IEND", b"")

png_path = os.path.join(ASSETS, "icon.png")
with open(png_path, "wb") as f:
    f.write(png)

# ICO wrapping a PNG (supported for <=256px)
ico = struct.pack("<HHH", 0, 1, 1)
ico += struct.pack("<BBBBHHII",
                    S & 0xFF, S & 0xFF, 0, 0, 1, 32,
                    len(png), 22)
ico += png
ico_path = os.path.join(ASSETS, "icon.ico")
with open(ico_path, "wb") as f:
    f.write(ico)

print("wrote", png_path, len(png), "bytes")
print("wrote", ico_path, len(ico), "bytes")
