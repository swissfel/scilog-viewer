"""The panes of a long logbook: the page itself, in a DOM, reading a logbook of 600 posts
from its end (tests/test_panes.mjs). node and jsdom run it; without them it is skipped."""
import os
import pathlib
import shutil
import subprocess

import pytest

HERE = pathlib.Path(__file__).parent


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed to run the page")
def test_the_panes_grow_with_the_logbook():
    env = dict(os.environ)
    here = subprocess.run(["node", "-e", "require.resolve('jsdom')"], capture_output=True, text=True, cwd=HERE, env=env)
    if here.returncode:
        pytest.skip("jsdom is needed for this one: npm install jsdom (or NODE_PATH to one)")
    run = subprocess.run(["node", str(HERE / "test_panes.mjs")], capture_output=True, text=True, cwd=HERE, env=env)
    assert run.returncode == 0, run.stdout + run.stderr
