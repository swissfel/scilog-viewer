"""The browser-only viewer: built (tools/build_web.py), served as plain files, and run in
Chromium against a stand-in for SciLog's API on another port (tools/fake_scilog.py), so
that the calls really cross origins as they do to scilog.psi.ch (tests/test_web.mjs).
node and its playwright are needed; without them it is skipped."""
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time

import pytest

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait(port, proc, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        if proc.poll() is not None:
            raise RuntimeError(f"a server ended: {proc.args}")
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            return
        except OSError:
            time.sleep(0.2)
    raise TimeoutError(port)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed to run the page")
def test_the_viewer_runs_in_the_browser_alone(tmp_path):
    found = subprocess.run(["node", "-e", "require.resolve('playwright')"], capture_output=True, cwd=HERE)
    if found.returncode:
        pytest.skip("playwright for node is needed for this one")
    api_port, site_port = _free_port(), _free_port()
    site = tmp_path / "web"
    subprocess.run([sys.executable, str(ROOT / "tools" / "build_web.py"), "--out", str(site),
                    "--api", f"http://localhost:{api_port}/api/v1"], check=True, capture_output=True)
    log = tmp_path / "api.log"
    procs = []
    try:
        with open(log, "w") as out:
            procs.append(subprocess.Popen([sys.executable, str(ROOT / "tools" / "fake_scilog.py"), "--port", str(api_port),
                                           "--demo", str(tmp_path / "demo")], stdout=out, stderr=subprocess.STDOUT))
        procs.append(subprocess.Popen([sys.executable, "-m", "http.server", str(site_port), "--bind", "127.0.0.1"],
                                      cwd=site, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        _wait(api_port, procs[0], timeout=60)
        _wait(site_port, procs[1])
        run = subprocess.run(["node", str(HERE / "test_web.mjs"), f"http://localhost:{site_port}/", str(log)],
                             capture_output=True, text=True, cwd=HERE, env=dict(os.environ), timeout=180)
        assert run.returncode == 0, run.stdout + run.stderr
    finally:
        for p in procs:
            p.terminate()
            p.wait(timeout=10)
