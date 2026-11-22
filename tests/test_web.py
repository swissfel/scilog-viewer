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

from scilog_viewer import content

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent


#: what a post's HTML could try: none of it may survive the cleaning, in Python or in the browser
HOSTILE = [
    '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">j</a>', '<a href=" jav&#x09;ascript:alert(1)">j</a>',
    '<a href="JaVaScRiPt:alert(1)">j</a>', '<svg><script>alert(1)</script><a xlink:href="javascript:alert(1)">s</a></svg>x',
    '<style>body{display:none}</style><p>v</p>', '<iframe src="https://evil"></iframe><object data=x></object><embed src=x>',
    '<div onclick="alert(1)" style="width:50%;position:fixed;background:url(x)">d</div>', '<form action=x><input value=y></form>t',
    '<math><mtext><img src=x onerror=alert(1)></mtext></math>', '<a href="data:text/html,<script>alert(1)</script>">d</a>',
    '<table><tr><td colspan=2 onmouseover=x>t</td></tr></table>', '<p><!-- c -->text</p>',
]
FILES = [{"fileHash": "H1", "fileId": "a" * 24, "style": {"width": "300px"}},
         {"fileHash": "H2", "fileId": "b" * 24, "fileExtension": "file/json"},
         {"fileHash": "H3", "fileId": "c" * 24, "fileExtension": "file/html"}]
POSTS = [
    '<figure class="image image_resized" style="width:50%"><img src="" title="H1" width="600" height="300" style="aspect-ratio:600/300"></figure>',
    '<figure class="image"><img src="" title="H1"></figure><p>an image SciLog sized in its file</p><img src="" title="nope">',
    '<p><a class="fileLink" href="file:H2">d.json</a>, <a href="file:H3">plot.html</a> and <a href="file:gone">gone</a></p>',
    '<h2>Head</h2><ul><li><b>b</b> <i>i</i> <u>u</u> <s>s</s> <sub>2</sub> <code>c</code></li></ul><blockquote>q</blockquote>',
    '<p style="text-align:center;color:#333">c</p><img src="https://example.org/x.png" alt="outside">',
]


def _cases(path):
    """What the Python side makes of each, for the page to compare its own with."""
    cases = [{"text": t, "files": FILES, "clean": content.clean_post(t, FILES), "editor": content.editor_html(t, FILES),
              "hostile": t in HOSTILE} for t in HOSTILE + POSTS]
    path.write_text(__import__("json").dumps(cases))
    return path


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
        run = subprocess.run(["node", str(HERE / "test_web.mjs"), f"http://localhost:{site_port}/", str(log),
                              str(_cases(tmp_path / "cases.json"))],
                             capture_output=True, text=True, cwd=HERE, env=dict(os.environ), timeout=180)
        print(run.stdout)
        assert run.returncode == 0, run.stdout + run.stderr
    finally:
        for p in procs:
            p.terminate()
            p.wait(timeout=10)
