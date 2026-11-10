"""The picture on its own is zoomable: the gestures live in app.js, so node runs them
(tests/test_lightbox.mjs, a fake DOM around the real lightbox function)."""
import pathlib
import shutil
import subprocess

import pytest

HERE = pathlib.Path(__file__).parent


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed to run app.js")
def test_lightbox_gestures():
    run = subprocess.run(["node", str(HERE / "test_lightbox.mjs")], capture_output=True, text=True)
    assert run.returncode == 0, run.stdout + run.stderr
