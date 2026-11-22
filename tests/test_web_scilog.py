"""The browser-only viewer where SciLog sends no CORS permission (as at PSI): the web site tells that
apart from no network and offers the bookmark; started from it inside SciLog's own page (inject.js) the
viewer reads and writes there with SciLog's login (tests/test_web_scilog.mjs). A stand-in for SciLog
without CORS (tools/fake_scilog.py --no-cors), its page with a strict script policy (--page-csp,
as a production site may have), and the built site on another port; node and its
playwright are needed, without them it is skipped."""
import json
import shutil
import subprocess
import sys
import urllib.request

import pytest

from test_web import HERE, ROOT, _free_port, _wait


def _api(base, token, method, path, body=None, form=None):
    headers = {"Authorization": f"Bearer {token}"}
    data = None
    if body is not None:
        data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
    if form is not None:  # (filename, content type, bytes)
        boundary = "----scilogtest"
        name, ctype, payload = form
        data = (f'--{boundary}\r\nContent-Disposition: form-data; name="fields"\r\n\r\n{{}}\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
                f"Content-Type: {ctype}\r\n\r\n").encode() + payload + f"\r\n--{boundary}--\r\n".encode()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    with urllib.request.urlopen(urllib.request.Request(base + path, data=data, method=method, headers=headers)) as r:
        text = r.read()
        return json.loads(text) if text else None


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed to run the page")
def test_the_viewer_runs_inside_scilogs_page_where_the_site_may_not_call_it(tmp_path):
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
                                           "--demo", str(tmp_path / "demo"), "--no-cors", "--page-csp"], stdout=out, stderr=subprocess.STDOUT))
        procs.append(subprocess.Popen([sys.executable, "-m", "http.server", str(site_port), "--bind", "127.0.0.1"],
                                      cwd=site, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        _wait(api_port, procs[0], timeout=60)
        _wait(site_port, procs[1])
        token = log.read_text().split("token: ")[1].split()[0]
        base = f"http://localhost:{api_port}/api/v1"
        # a post with an image, an interactive plot and an attachment, as SciLog stores one
        book = _api(base, token, "GET", "/logbooks")[0]["id"]
        png = (ROOT / "android/app/src/main/res/mipmap-hdpi/ic_launcher.png").read_bytes()
        img = _api(base, token, "POST", "/filesnippet/files", form=("i.png", "image/png", png))["id"]
        plot = _api(base, token, "POST", "/filesnippet/files",
                    form=("scan_4217.html", "text/html", b"<details open><summary>scan_4217</summary>x</details>"))["id"]
        data = _api(base, token, "POST", "/filesnippet/files", form=("d.json", "application/json", b'{"a": 1}'))["id"]
        files = [{"fileHash": "hi", "fileId": img, "fileExtension": "image/png"},
                 {"fileHash": "hp", "fileId": plot, "fileExtension": "file/html"},
                 {"fileHash": "hd", "fileId": data, "fileExtension": "file/json"}]
        html = ('<p>with files</p><figure class="image"><img src="" title="hi"></figure>'
                '<p><a class="fileLink" href="file:hp">scan_4217.html</a> <a class="fileLink" href="file:hd">d.json</a></p>')
        post = _api(base, token, "POST", "/basesnippets", body={"snippetType": "paragraph", "linkType": "paragraph",
                                                                "parentId": book, "textcontent": html, "files": files})["id"]
        run = subprocess.run(["node", str(HERE / "test_web_scilog.mjs"), f"http://localhost:{site_port}/",
                              f"http://localhost:{api_port}/", str(log), post, str(procs[0].pid)],
                             capture_output=True, text=True, cwd=HERE, timeout=180)
        print(run.stdout)
        assert run.returncode == 0, run.stdout + run.stderr
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
            p.wait(timeout=10)
