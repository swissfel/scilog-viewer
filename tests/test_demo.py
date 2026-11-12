"""The made-up logbook (scilog_viewer.demo): generated, nothing from SciLog in it,
and read through the same store as a real one -- pieces from its end included."""
import json

import pytest

pytest.importorskip("tornado")

from scilog_viewer import demo
from scilog_viewer.server import Store


@pytest.fixture(scope="module")
def made(tmp_path_factory):
    where = tmp_path_factory.mktemp("demo")
    demo.make(where, posts=80, figures=3, quiet=True)
    return where


def test_a_made_up_logbook_reads_like_a_real_one(made, tmp_path):
    store = Store(demo.DemoReader(made), cache_dir=tmp_path / "files")
    (book,) = store.list_logbooks()
    assert book["name"] == "26x_demo_p00000"

    whole = store.posts(book["id"])
    assert 60 <= len(whole["posts"]) <= 110 and whole["whole"] is True
    assert [p["t"] for p in whole["posts"]] == sorted(p["t"] for p in whole["posts"])
    assert all(p["author"].endswith("@example.org") for p in whole["posts"])  # nobody real
    assert any(p["title"] for p in whole["posts"]) and any(p["comments"] for p in whole["posts"])


def test_it_is_read_from_its_end_in_pieces(made, tmp_path):
    store = Store(demo.DemoReader(made), cache_dir=tmp_path / "files")
    (book,) = store.list_logbooks()
    end = store.posts(book["id"], newest=10)
    assert len(end["posts"]) == 10 and end["whole"] is False
    rest = store.posts(book["id"], newest=500, before=end["from"])
    assert rest["whole"] is True
    first, older = {p["id"] for p in end["posts"]}, {p["id"] for p in rest["posts"]}
    whole = {p["id"] for p in store.posts(book["id"])["posts"]}
    assert first | older == whole                 # the two pieces are the logbook
    # "before" means "no later than", so the post the first piece ended on comes again
    # (another post may carry that same instant); the page knows them and puts them in once
    again = {p["t"] for p in end["posts"] if p["id"] in first & older}
    assert len(again) <= 1


def test_its_figures_are_pngs_the_page_can_ask_for(made, tmp_path):
    store = Store(demo.DemoReader(made), cache_dir=tmp_path / "files")
    (book,) = store.list_logbooks()
    posts = store.posts(book["id"])["posts"]
    with_image = next(p for p in posts if "<img" in p["html"])
    file_id = with_image["html"].split('src="img/')[1][:24]
    data, ctype, _name = store.image(file_id)
    assert ctype == "image/png" and data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) > 1000

    with_file = next(p for p in posts if "fileLink" in p["html"] or "file/" in p["html"])
    attached = with_file["html"].split('href="file/')[1][:24]
    body, ctype, name = store.file(attached)
    assert name.endswith(".json") and json.loads(body)["made_up"] is True


def test_nothing_is_written_to_a_made_up_logbook(made):
    reader = demo.DemoReader(made)
    with pytest.raises(PermissionError):
        reader.create_post({})
