"""The icon of packaging/icon.svg as the files a desktop package and a Windows program need:

    python packaging/make_icons.py build/icons      # PNGs 16..512, scilog-viewer.ico
    python packaging/make_icons.py --android        # the Android launcher's own PNGs

An open logbook, the same drawing as the Android launcher. It is drawn here rather than
read from the SVG so that building needs nothing but Python: the shapes are filled at
1024 and averaged down to each size, which is where the smooth edges come from.

--android writes the raster launcher icons into android/app/src/main/res: a phone on
Android 8 or later draws the adaptive icon (mipmap-anydpi-v26/) instead, but a launcher
that asks for a plain picture -- and anything showing the app outside the home screen --
then has one at its own density rather than nothing at all. They are checked in, so
building the app needs no Python; run this again if the drawing changes.
"""

import struct
import sys
import zlib
from pathlib import Path

MASTER = 1024                      # everything is drawn this large, then averaged down
SIZES = (16, 24, 32, 48, 64, 128, 256, 512)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
BLUE = (0x1F, 0x5F, 0xBF, 255)
WHITE = (0xFF, 0xFF, 0xFF, 255)
#: the drawing, in the 108 units the Android icon uses
PAGES = [[(30, 36), (52, 40), (52, 74), (30, 70)], [(56, 40), (78, 36), (78, 70), (56, 74)]]
LINES = [((35, 46), (47, 48)), ((35, 52), (47, 54)), ((35, 58), (47, 60)),
         ((61, 48), (73, 46)), ((61, 54), (73, 52)), ((61, 60), (73, 58))]
GROW = 1.3                         # a desktop icon has no safe zone to keep clear of
RADIUS = 19 / 108                  # the rounded corner, as a part of the width
#: the five densities an Android launcher looks for, in pixels
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


class Sheet:
    """A square RGBA picture, drawn into at MASTER and averaged down from there."""

    def __init__(self, size):
        self.size = size
        self.px = bytearray(size * size * 4)          # transparent to begin with

    def row_fill(self, y, x0, x1, colour):
        if y < 0 or y >= self.size:
            return
        x0, x1 = max(0, int(x0)), min(self.size, int(x1))
        if x1 > x0:
            self.px[(y * self.size + x0) * 4:(y * self.size + x1) * 4] = bytes(colour) * (x1 - x0)

    def rounded_square(self, radius, colour):
        r = radius
        for y in range(self.size):
            dy = r - y - 0.5 if y < r else (y + 0.5) - (self.size - r) if y > self.size - r else 0
            dx = (r * r - dy * dy) ** 0.5 if dy > 0 else r
            self.row_fill(y, r - dx, self.size - r + dx, colour)

    def polygon(self, points, colour):
        ys = [p[1] for p in points]
        for y in range(max(0, int(min(ys))), min(self.size, int(max(ys)) + 1)):
            mid = y + 0.5
            crossings = []
            for (ax, ay), (bx, by) in zip(points, points[1:] + points[:1]):
                if (ay <= mid < by) or (by <= mid < ay):
                    crossings.append(ax + (mid - ay) * (bx - ax) / (by - ay))
            crossings.sort()
            for a, b in zip(crossings[::2], crossings[1::2]):
                self.row_fill(y, a, b, colour)

    def thick_line(self, a, b, width, colour):
        (ax, ay), (bx, by) = a, b
        dx, dy = bx - ax, by - ay
        length = (dx * dx + dy * dy) ** 0.5 or 1
        nx, ny = -dy / length * width / 2, dx / length * width / 2
        ex, ey = dx / length * width / 2, dy / length * width / 2    # round ends, squared off
        self.polygon([(ax + nx - ex, ay + ny - ey), (bx + nx + ex, by + ny + ey),
                      (bx - nx + ex, by - ny + ey), (ax - nx - ex, ay - ny - ey)], colour)

    def shrink_to(self, size):
        """This picture averaged down to a smaller one: the edges become smooth."""
        out = Sheet(size)
        step = self.size / size
        for y in range(size):
            y0, y1 = int(y * step), max(int(y * step) + 1, int((y + 1) * step))
            for x in range(size):
                x0, x1 = int(x * step), max(int(x * step) + 1, int((x + 1) * step))
                r = g = b = a = n = 0
                for sy in range(y0, y1):
                    row = sy * self.size * 4
                    for sx in range(x0, x1):
                        i = row + sx * 4
                        alpha = self.px[i + 3]
                        r += self.px[i] * alpha
                        g += self.px[i + 1] * alpha
                        b += self.px[i + 2] * alpha
                        a += alpha
                        n += 1
                i = (y * size + x) * 4
                if a:                                  # colours weighted by their own alpha
                    out.px[i:i + 4] = bytes((r // a, g // a, b // a, a // n))
        return out

    def png(self):
        raw = bytearray()
        for y in range(self.size):
            raw.append(0)
            raw += self.px[y * self.size * 4:(y + 1) * self.size * 4]

        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

        return (b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", struct.pack(">IIBBBBB", self.size, self.size, 8, 6, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
                + chunk(b"IEND", b""))

    def bmp_for_ico(self):
        """The picture as an icon directory entry's DIB: BGRA, bottom-up, with the mask."""
        head = struct.pack("<IiiHHIIiiII", 40, self.size, self.size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
        pixels = bytearray()
        for y in range(self.size - 1, -1, -1):
            for x in range(self.size):
                i = (y * self.size + x) * 4
                pixels += bytes((self.px[i + 2], self.px[i + 1], self.px[i], self.px[i + 3]))
        mask_row = (self.size + 31) // 32 * 4           # the AND mask, every row 4-byte aligned
        return head + bytes(pixels) + bytes(mask_row * self.size)


def draw(round=False):
    """The icon at MASTER; round for the circle some Android launchers ask for."""
    sheet = Sheet(MASTER)
    unit = MASTER / 108
    sheet.rounded_square(MASTER / 2 if round else RADIUS * MASTER, BLUE)
    place = lambda p: ((54 + (p[0] - 54) * GROW) * unit, (54 + (p[1] - 54) * GROW) * unit)
    for page in PAGES:
        sheet.polygon([place(p) for p in page], WHITE)
    for a, b in LINES:
        sheet.thick_line(place(a), place(b), 2 * GROW * unit, BLUE)
    return sheet


def ico(sheets):
    """The .ico Windows wants: the small sizes as plain DIBs, the big ones as PNGs."""
    entries, blobs, offset = [], [], 6 + 16 * len(sheets)
    for sheet in sheets:
        data = sheet.png() if sheet.size >= 128 else sheet.bmp_for_ico()   # the big ones compressed
        entries.append(struct.pack("<BBBBHHII", sheet.size % 256, sheet.size % 256, 0, 0, 1, 32, len(data), offset))
        blobs.append(data)
        offset += len(data)
    return struct.pack("<HHH", 0, 1, len(sheets)) + b"".join(entries) + b"".join(blobs)


def android(res):
    """The launcher's raster icons: mipmap-<density>/ic_launcher{,_round}.png."""
    res = Path(res)
    for name, round in (("ic_launcher", False), ("ic_launcher_round", True)):
        master = draw(round)
        for density, size in DENSITIES.items():
            folder = res / f"mipmap-{density}"
            folder.mkdir(parents=True, exist_ok=True)
            sheet = master if size == MASTER else master.shrink_to(size)
            (folder / f"{name}.png").write_bytes(sheet.png())
    print(f"{2 * len(DENSITIES)} launcher PNGs in {res}")


def main(where):
    where = Path(where)
    where.mkdir(parents=True, exist_ok=True)
    master = draw()
    made = {}
    for size in SIZES:
        made[size] = master if size == MASTER else master.shrink_to(size)
        (where / f"scilog-viewer-{size}.png").write_bytes(made[size].png())
    (where / "scilog-viewer.ico").write_bytes(ico([made[s] for s in ICO_SIZES]))
    (where / "scilog-viewer.svg").write_bytes((Path(__file__).parent / "icon.svg").read_bytes())
    print(f"{len(SIZES)} PNGs, scilog-viewer.ico and scilog-viewer.svg in {where}")


if __name__ == "__main__":
    argv = sys.argv[1:]
    if argv and argv[0] == "--android":
        here = Path(__file__).resolve().parent.parent
        android(argv[1] if len(argv) > 1 else here / "android/app/src/main/res")
    else:
        main(argv[0] if argv else "build/icons")
