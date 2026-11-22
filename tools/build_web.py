"""The SciLog viewer as a web site of plain files: nothing to install, nothing running
on the user's side but the browser.

    python tools/build_web.py                   # -> dist/web, for https://scilog.psi.ch
    python tools/build_web.py --api http://localhost:8790/api/v1 --out /tmp/web   # e.g. tools/fake_scilog.py

The site is the viewer's own page (scilog_viewer/static) plus scilog_viewer/web/browser.js,
which answers the page's /api/... requests in the page by calling SciLog directly, and
scilog_viewer/web/sw.js, the service worker that serves images and attachments with the
token. Any static host does: GitHub Pages (.github/workflows/pages.yml), a web server, or
`python -m http.server` in the folder for a try on localhost. A service worker needs https
or localhost.
"""

import argparse
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "scilog_viewer" / "static"
WEB = ROOT / "scilog_viewer" / "web"


def build(out, api="https://scilog.psi.ch/api/v1", web="https://scilog.psi.ch"):
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(STATIC, out / "static", ignore=shutil.ignore_patterns("index.html"))
    for name in ("browser.js", "sw.js"):
        shutil.copy2(WEB / name, out / name)
    page = (STATIC / "index.html").read_text()
    page = page.replace('"/static/', '"static/')  # relative: the site may live in a folder (GitHub Pages)
    config = json.dumps({"api": api, "web": web})
    page, n = re.subn(r'(<script src="static/app\.js"></script>)',
                      f'<script>window.SCILOG_BROWSER_CONFIG = {config};</script>\n'
                      '<script src="browser.js"></script>\n\\1', page)
    if n != 1:
        raise RuntimeError("index.html: app.js not found")
    page = page.replace("<title>SciLog viewer</title>",
                        '<title>SciLog viewer</title>\n<meta name="description" content="Read and write SciLog in the browser">')
    (out / "index.html").write_text(page)
    (out / ".nojekyll").write_text("")  # GitHub Pages: serve the files as they are
    return out


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", default=str(ROOT / "dist" / "web"))
    parser.add_argument("--api", default="https://scilog.psi.ch/api/v1", help="SciLog's REST API")
    parser.add_argument("--web", default="https://scilog.psi.ch", help="SciLog's own pages (links to a logbook)")
    args = parser.parse_args()
    print(build(args.out, args.api, args.web))
