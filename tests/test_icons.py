"""The icon the packages and the Windows program carry (packaging/make_icons.py): drawn
here out of nothing but Python, so what it writes has to be a real PNG and a real ICO."""
import importlib.util
import pathlib
import struct

import pytest

ICONS = pathlib.Path(__file__).resolve().parent.parent / "packaging" / "make_icons.py"


@pytest.fixture(scope="module")
def icons(tmp_path_factory):
    spec = importlib.util.spec_from_file_location("make_icons", ICONS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.MASTER = 256          # smaller than the real one: the same drawing, drawn quicker
    module.SIZES = (16, 32, 48)
    module.ICO_SIZES = (16, 32, 48)
    where = tmp_path_factory.mktemp("icons")
    module.main(where)
    return where


def test_every_size_is_a_png_of_that_size(icons):
    for size in (16, 32, 48):
        data = (icons / f"scilog-viewer-{size}.png").read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n"
        width, height, depth, colour = struct.unpack(">IIBB", data[16:26])
        assert (width, height, depth, colour) == (size, size, 8, 6)   # 8-bit RGBA


def test_the_ico_holds_each_size_where_it_says(icons):
    data = (icons / "scilog-viewer.ico").read_bytes()
    nought, kind, count = struct.unpack("<HHH", data[:6])
    assert (nought, kind) == (0, 1) and count == 3
    seen = []
    for i in range(count):
        width, _h, _colours, _r, _planes, bits, size, offset = struct.unpack("<BBBBHHII", data[6 + 16 * i:22 + 16 * i])
        seen.append(width or 256)
        assert bits == 32 and offset + size <= len(data)
        assert data[offset:offset + 8] == b"\x89PNG\r\n\x1a\n" or len(data[offset:offset + size]) == size
    assert seen == [16, 32, 48]


def test_the_icon_is_the_blue_square_with_white_pages(icons):
    """Not what it looks like -- that is for eyes -- but that something was drawn at all."""
    spec = importlib.util.spec_from_file_location("make_icons2", ICONS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.MASTER = 128
    sheet = module.draw()
    middle = sheet.px[(64 * 128 + 64) * 4:(64 * 128 + 64) * 4 + 4]
    corner = sheet.px[0:4]
    edge = sheet.px[(64 * 128 + 4) * 4:(64 * 128 + 4) * 4 + 4]
    assert corner[3] == 0                      # the rounded corner is see-through
    assert tuple(edge) == (0x1F, 0x5F, 0xBF, 255)   # blue at the side
    assert tuple(middle[:3]) in {(0xFF, 0xFF, 0xFF), (0x1F, 0x5F, 0xBF)}  # a page, or the fold


def test_the_scalable_icon_comes_along(icons):
    svg = (icons / "scilog-viewer.svg").read_text()
    assert svg.startswith("<?xml") and "#1F5FBF" in svg and "</svg>" in svg
