#!/usr/bin/env python3
"""Generate placeholder app/toolbar icons (no third-party deps).

Draws a rounded green square with a white "export/download" glyph and writes
PNGs at the sizes the manifest references. Pure stdlib (zlib + struct), with
3x supersampling for antialiased edges.

    python3 tools/make-icons.py
"""
import os
import struct
import zlib

SIZES = [16, 32, 48, 96, 128, 256, 512]
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "extension", "images")

GREEN = (16, 163, 127)   # #10a37f
WHITE = (255, 255, 255)
RADIUS = 0.22            # corner radius as a fraction of the side
SS = 3                   # supersampling factor


def in_rounded_square(nx, ny, r):
    cx = min(max(nx, r), 1 - r)
    cy = min(max(ny, r), 1 - r)
    dx, dy = nx - cx, ny - cy
    return dx * dx + dy * dy <= r * r


def in_glyph(nx, ny):
    # Vertical stem of the arrow.
    if 0.44 <= nx <= 0.56 and 0.24 <= ny <= 0.52:
        return True
    # Downward arrowhead: half-width tapers to a point at ny = 0.66.
    if 0.46 <= ny <= 0.66:
        hw = 0.20 * (1 - (ny - 0.46) / 0.20)
        if hw > 0 and abs(nx - 0.5) <= hw:
            return True
    # Baseline tray ("save to").
    if 0.28 <= nx <= 0.72 and 0.70 <= ny <= 0.78:
        return True
    return False


def render(size):
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            sr = sg = sb = 0
            covered = 0
            for sy in range(SS):
                for sx in range(SS):
                    nx = (x + (sx + 0.5) / SS) / size
                    ny = (y + (sy + 0.5) / SS) / size
                    if not in_rounded_square(nx, ny, RADIUS):
                        continue  # transparent outside the rounded square
                    col = WHITE if in_glyph(nx, ny) else GREEN
                    sr += col[0]
                    sg += col[1]
                    sb += col[2]
                    covered += 1
            total = SS * SS
            if covered == 0:
                row += bytes((0, 0, 0, 0))
            else:
                # Straight-alpha: color averaged over opaque samples only,
                # alpha = coverage. Avoids dark fringing at the edges.
                row += bytes((
                    round(sr / covered),
                    round(sg / covered),
                    round(sb / covered),
                    round(255 * covered / total),
                ))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0 (None)
        raw.extend(row)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(chunk(b"IEND", b""))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon-{size}.png")
        write_png(path, size, render(size))
        print(f"wrote {os.path.normpath(path)} ({size}x{size})")


if __name__ == "__main__":
    main()
