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


INJECT = """// The SciLog viewer inside SciLog's own page: loaded by the bookmark
//   javascript:(()=>{const s=document.createElement('script');s.src='<this site>/inject.js';document.body.appendChild(s)})()
// on scilog.psi.ch. It writes the viewer (its files from this site) into that page, where it reads SciLog's
// API on SciLog's own origin with SciLog's own login: no token to copy, and no CORS. Written by tools/build_web.py.
(() => {
  "use strict";
  if (window.ScilogBrowser) return;  // already here
  if (!localStorage.getItem("id_token")) {
    alert("SciLog viewer: log in to SciLog in this tab first, then click the bookmark again.");
    return;
  }
  const BASE = new URL(".", document.currentScript.src).href;
  const at = (path) => new URL(path, BASE).href;
  const config = { api: location.origin + "/api/v1", web: location.origin, files: "api", tokenFrom: "scilog", worker: false };
  const styles = STYLES.map((p) => `<link rel="stylesheet" href="${at(p)}">`).join("");
  document.open();
  document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><title>SciLog viewer</title>${styles}</head>`
    + `<body>${BODY}</body></html>`);
  document.close();
  // The scripts are added, not written in: a page with a strict script policy ('strict-dynamic', as a
  // production site may have) runs scripts a script adds, but none written into the page. One after
  // another, in their order; the viewer starts when the last is there.
  window.SCILOG_BROWSER_CONFIG = config;
  window.SCILOG_DEFER_MAIN = true;
  const add = (path) => new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = at(path);
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${path} could not be loaded`));
    document.body.appendChild(s);
  });
  SCRIPTS.reduce((before, path) => before.then(() => add(path)), Promise.resolve())
    .then(() => window.scilogStart())
    .catch((e) => {
      const flow = document.getElementById("flow");
      if (flow) flow.textContent = `The viewer could not start in this page: ${e.message}. (F12, Console says more.)`;
    });
})();
"""


def _inject(page):
    """inject.js from the built index.html: its body, and its styles and scripts but the config, the
    offline panel (it needs the site's own service worker) and the policy (SciLog's page has its own)."""
    body = re.search(r"<body>(.*?)<script", page, re.S).group(1).strip()
    styles = re.findall(r'<link rel="stylesheet" href="([^"]+)">', page)
    scripts = [s for s in re.findall(r'<script src="([^"]+)"></script>', page) if not s.startswith(("config.js", "offline.js"))]
    return (INJECT.replace("STYLES", json.dumps(styles)).replace("SCRIPTS", json.dumps(scripts))
            .replace("BODY", json.dumps(body)))


def build(out, api="https://scilog.psi.ch/api/v1", web="https://scilog.psi.ch", cname=None):
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(STATIC, out / "static", ignore=shutil.ignore_patterns("index.html"))
    for name in ("browser.js", "offline.js"):
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
    page, n = re.subn(r'(<script src="static/rail\.js"></script>)', '\\1\n<script src="offline.js"></script>', page)
    if n != 1:
        raise RuntimeError("index.html: rail.js not found")
    page = re.sub(r'(src|href)="((?:static/[\w.-]+|config\.js|browser\.js|offline\.js))"', versioned, page)
    head = (f'<meta http-equiv="Content-Security-Policy" content="{csp(api)}">\n'
            '<meta name="referrer" content="no-referrer">\n'
            '<meta name="description" content="Read and write SciLog in the browser">\n')
    page, n = re.subn(r'(<meta charset="utf-8">\n)', lambda m: m.group(1) + head, page)
    if n != 1:
        raise RuntimeError("index.html: no charset line to put the policy after")
    (out / "index.html").write_text(page)

    # inject.js: the same page written into SciLog's own page, started from a bookmark there
    (out / "inject.js").write_text(_inject(page))

    # the service worker keeps the site's files, to start without a network (offline copies)
    shell = ["", "index.html", "config.js", "browser.js", "offline.js"] + sorted(
        p.relative_to(out).as_posix() for p in (out / "static").rglob("*") if p.is_file())
    version = hashlib.sha256("".join(f"{name}:{_version(out / name)}" for name in shell[1:]).encode()).hexdigest()[:12]
    worker = (WEB / "sw.js").read_text()
    worker, n1 = re.subn(r"^const SHELL = \[\];", f"const SHELL = {json.dumps(shell)};", worker, flags=re.M)
    worker, n2 = re.subn(r'^const VERSION = "dev";', f'const VERSION = "{version}";', worker, flags=re.M)
    if (n1, n2) != (1, 1):
        raise RuntimeError("sw.js: SHELL or VERSION not found")
    (out / "sw.js").write_text(worker)
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
