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


def test_the_android_launcher_icons_are_written_at_each_density(tmp_path):
    spec = importlib.util.spec_from_file_location("make_icons3", ICONS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.MASTER = 128
    module.DENSITIES = {"mdpi": 48, "xhdpi": 96}
    module.android(tmp_path)
    for density, size in (("mdpi", 48), ("xhdpi", 96)):
        for name in ("ic_launcher", "ic_launcher_round"):
            data = (tmp_path / f"mipmap-{density}" / f"{name}.png").read_bytes()
            assert data[:8] == b"\x89PNG\r\n\x1a\n"
            assert struct.unpack(">II", data[16:24]) == (size, size)


# -- what the app itself carries, which is checked in rather than built ------------------------
RES = pathlib.Path(__file__).resolve().parent.parent / "android/app/src/main/res"
MANIFEST = RES.parent / "AndroidManifest.xml"


def _resources():
    """Every res/ name the app has: ("drawable", "ic_launcher_foreground") and so on."""
    import xml.etree.ElementTree as ET

    have = {(f.parent.name.split("-")[0], f.stem) for f in RES.rglob("*") if f.is_file()}
    for colours in RES.glob("values*/*.xml"):
        for item in ET.parse(colours).getroot():
            have.add((item.tag, item.get("name")))
    return have


def test_every_icon_resource_points_at_something_that_is_there():
    """The launcher icon is drawn from pieces: a reference going nowhere is a blank icon."""
    import xml.etree.ElementTree as ET

    have = _resources()
    looked = 0
    for xml in list(RES.rglob("*.xml")) + [MANIFEST]:
        tree = ET.parse(xml)                       # also: the file is well-formed at all
        for node in tree.iter():
            for value in node.attrib.values():
                if value.startswith("@") and "/" in value and not value.startswith("@android:"):
                    kind, name = value.lstrip("@").split("/")
                    assert (kind, name) in have, f"{xml.name}: {value} is not there"
                    looked += 1
    assert looked > 5


def test_the_app_icon_is_there_for_old_launchers_too():
    """Android 8 and later draw mipmap-anydpi-v26; anything else wants a plain picture."""
    for density in ("mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"):
        for name in ("ic_launcher", "ic_launcher_round"):
            assert (RES / f"mipmap-{density}" / f"{name}.png").exists()
    icon = (RES / "mipmap-anydpi-v26" / "ic_launcher.xml").read_text()
    assert "<monochrome" in icon                         # Android 13's themed icons
    assert "@drawable/ic_launcher_background" in icon    # not a bare colour: some launchers skip it
