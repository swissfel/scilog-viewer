"""The SciLog viewer as a web site of plain files: nothing to install, nothing running
on the user's side but the browser.

    python tools/build_web.py                   # -> dist/web, for https://scilog.psi.ch
    python tools/build_web.py --cname scilog-viewer.example.org     # its own domain (see below)
    python tools/build_web.py --api http://localhost:8790/api/v1 --out /tmp/web   # tools/fake_scilog.py

The site is the viewer's own page (scilog_viewer/static) plus scilog_viewer/web/browser.js,
which answers the page's /api/... requests in the page by calling SciLog directly, and
scilog_viewer/web/sw.js, the service worker that serves images and attachments with the
token. Any static host does (GitHub Pages: .github/workflows/pages.yml); a service worker
needs https, or localhost for a try (`python -m http.server` in the folder).

Give the site an origin of its own -- a domain or subdomain nothing else is served from.
The token is kept in the browser per origin, so every page on the same origin could read
it: on GitHub Pages without a custom domain that is every Pages site of the organisation
(https://<org>.github.io/...). --cname writes the CNAME file GitHub Pages uses for that.

The page gets a Content Security Policy: scripts only from the site and the editor's CDN,
connections only to the site and SciLog's API. Even if a post's HTML got something past the
viewer's cleaning, it could neither run a script nor send the token anywhere else.
"""

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "scilog_viewer" / "static"
WEB = ROOT / "scilog_viewer" / "web"
#: where the editor (CKEditor 5, editor.js) is loaded from
EDITOR_CDN = "https://cdn.jsdelivr.net"


def _origin(url):
    parts = urlsplit(url)
    if parts.scheme not in ("https", "http") or not parts.netloc:
        raise ValueError(f"not an http(s) address: {url}")
    return f"{parts.scheme}://{parts.netloc}"


def csp(api):
    """The page's policy. style-src needs 'unsafe-inline' for the editor and for the style
    attributes posts carry; images come from the site (the service worker) and from posts
    that point at images elsewhere (https:)."""
    return "; ".join([
        "default-src 'self'",
        f"script-src 'self' {EDITOR_CDN}",
        f"style-src 'self' 'unsafe-inline' {EDITOR_CDN}",
        f"font-src 'self' data: {EDITOR_CDN}",
        "img-src 'self' data: blob: https:",
        f"connect-src 'self' {_origin(api)} {EDITOR_CDN}",
        "frame-src 'self'",
        "worker-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ])


def _version(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()[:10]


def build(out, api="https://scilog.psi.ch/api/v1", web="https://scilog.psi.ch", cname=None):
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(STATIC, out / "static", ignore=shutil.ignore_patterns("index.html"))
    for name in ("browser.js", "sw.js"):
        shutil.copy2(WEB / name, out / name)
    (out / "config.js").write_text(  # not inline: the policy allows no inline script
        "// written by tools/build_web.py\n"
        f"window.SCILOG_BROWSER_CONFIG = {json.dumps({'api': api.rstrip('/'), 'web': web.rstrip('/')})};\n")

    page = (STATIC / "index.html").read_text()
    page = page.replace('"/static/', '"static/')  # relative: the site may live in a folder

    def versioned(m):  # a new build reaches the browser at once, not after its cache runs out
        attr, path = m.group(1), m.group(2)
        return f'{attr}="{path}?v={_version(out / path)}"'

    page, n = re.subn(r'(<script src="static/app\.js"></script>)',
                      '<script src="config.js"></script>\n<script src="browser.js"></script>\n\\1', page)
    if n != 1:
        raise RuntimeError("index.html: app.js not found")
    page = re.sub(r'(src|href)="((?:static/[\w.-]+|config\.js|browser\.js))"', versioned, page)
    head = (f'<meta http-equiv="Content-Security-Policy" content="{csp(api)}">\n'
            '<meta name="referrer" content="no-referrer">\n'
            '<meta name="description" content="Read and write SciLog in the browser">\n')
    page, n = re.subn(r'(<meta charset="utf-8">\n)', lambda m: m.group(1) + head, page)
    if n != 1:
        raise RuntimeError("index.html: no charset line to put the policy after")
    (out / "index.html").write_text(page)
    (out / ".nojekyll").write_text("")  # GitHub Pages: serve the files as they are
    if cname:
        (out / "CNAME").write_text(cname.strip() + "\n")
    return out


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", default=str(ROOT / "dist" / "web"))
    parser.add_argument("--api", default="https://scilog.psi.ch/api/v1", help="SciLog's REST API")
    parser.add_argument("--web", default="https://scilog.psi.ch", help="SciLog's own pages (links to a logbook)")
    parser.add_argument("--cname", help="the site's own domain (GitHub Pages: written to CNAME)")
    args = parser.parse_args()
    print(build(args.out, args.api, args.web, args.cname))
