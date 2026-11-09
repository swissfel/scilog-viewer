"""Build scilog_viewer/ from an eco checkout (eco/scilog_app and the SciLog
client parts of eco/logs_scilog.py and eco/logs_sources.py).

    python tools/sync_from_eco.py /path/to/eco

The viewer was written inside eco; until eco depends on this package, this
script is how changes made there come here. Everything eco-specific (the
beamline account's login, %ei's index) is left out.
"""

import ast
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
PKG = HERE / "scilog_viewer"

CLIENT_HEAD = '''"""scilog_viewer.client -- SciLog's REST API with your own PSI account.

Personal accounts log in to SciLog through the browser (PSI single sign-on),
so this works with the token SciLog issues after that login:

  1. log in at https://scilog.psi.ch,
  2. in the browser's developer console (F12):  copy(localStorage.id_token)
  3. python -m scilog_viewer --token   (asks for it without echoing it and
     keeps it in ~/.config/scilog-viewer/token, mode 600), or set
     $SCILOG_TOKEN.

The token carries your PSI groups: everything here sees what you see in
SciLog's web page. It lasts about two weeks. Never keep a personal token on
an account several people use: they would all read and write SciLog as you
(list such accounts in $SCILOG_VIEWER_SHARED_ACCOUNTS, comma separated).
"""

import base64
import datetime
import html.parser
import json
import os
import re
import stat
import sys
import time
from pathlib import Path

URL = os.environ.get("SCILOG_URL", "https://scilog.psi.ch/api/v1")
CONFIG_DIR = Path(os.environ.get("SCILOG_VIEWER_HOME") or Path.home() / ".config" / "scilog-viewer")
TOKEN_PATH = CONFIG_DIR / "token"
#: also read: eco keeps the same token here
ECO_TOKEN_PATH = Path.home() / ".eco" / "scilog_token"
PAGE = 500  # snippets per request

TOKEN_STEPS = """\\
  1. log in at https://scilog.psi.ch
  2. browser developer console (F12):  copy(localStorage.id_token)"""
TOKEN_HELP = f"""\\
No personal SciLog token. To read SciLog as yourself:
{TOKEN_STEPS}
  3. here:  python -m scilog_viewer --token   (paste it at the hidden prompt)
It lasts about two weeks. Only on your own account, never on a shared one."""


def cache_dir():
    """Where images, files and view backups are kept."""
    path = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "scilog-viewer"
    path.mkdir(parents=True, exist_ok=True)
    return path


def token(path=None):
    """(token, where it came from) or (None, None): $SCILOG_TOKEN, then the
    token file, then eco's."""
    env = _clean(os.environ.get("SCILOG_TOKEN") or os.environ.get("ECO_SCILOG_TOKEN"))
    if env:
        return env, "$SCILOG_TOKEN"
    for p in ([Path(path)] if path else [TOKEN_PATH, ECO_TOKEN_PATH]):
        try:
            text = _clean(p.read_text())
        except OSError:
            continue
        if text:
            return text, str(p)
    return None, None


def _shared_account():
    import getpass

    shared = [a.strip() for a in os.environ.get("SCILOG_VIEWER_SHARED_ACCOUNTS", "").split(",") if a.strip()]
    try:
        user = getpass.getuser()
    except Exception:
        return None
    return user if user in shared else None


def reader(url=URL, session=None, timeout=30):
    """A Reader with your personal token."""
    if _shared_account():
        raise TokenError("this is a shared account: no personal token here")
    value, where = token()
    if not value:
        raise TokenError(TOKEN_HELP)
    r = Reader(value, url=url, timeout=timeout, session=session)
    r.identity = f"{describe(value).split(',')[0]} (token from {where})"
    return r


def can_open_browser():
    """A browser can be started here: not over ssh, and on Linux a display."""
    if os.environ.get("SSH_CONNECTION") or os.environ.get("SSH_TTY"):
        return False
    if sys.platform in ("win32", "darwin"):
        return True
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def html_to_text(html_text):
    p = _TextOnly()
    p.feed(html_text or "")
    text = "".join(p.parts)
    return re.sub(r"\\n[ \\t]*\\n\\s*", "\\n\\n", text).strip()

'''

CLIENT_TAKE = ["TokenError", "_clean", "save_token", "claims", "describe", "Reader", "select_logbooks", "_quote", "_record"]
SOURCES_TAKE = ["_TextOnly"]


def segments(path, names):
    src = path.read_text()
    tree = ast.parse(src)
    found = {}
    for node in tree.body:
        name = getattr(node, "name", None)
        if name in names:
            start = node.lineno - 1 - len(getattr(node, "decorator_list", []))
            found[name] = "\n".join(src.splitlines()[start:node.end_lineno])
    missing = set(names) - set(found)
    if missing:
        raise SystemExit(f"not found in {path}: {sorted(missing)}")
    return [found[n] for n in names]


def client(eco):
    parts = segments(eco / "eco" / "logs_scilog.py", CLIENT_TAKE) + segments(eco / "eco" / "logs_sources.py", SOURCES_TAKE)
    text = CLIENT_HEAD + "\n\n".join(parts) + "\n"
    text = text.replace("logs_sources.html_to_text", "html_to_text")
    text = re.sub(r"\n\s*_functional\.clear\(\)[^\n]*", "", text)
    text = text.replace("Keep a token in ~/.eco/scilog_token", "Keep a token in the token file")
    text = text.replace("# -- writing (eco.scilog_app);", "# -- writing;")
    text = text.replace('"It reads SciLog through the beamline account instead, without a token."', '"Use your own account."')
    text = text.replace('"  3. %ei --scilog-token new"', '"  3. python -m scilog_viewer --token"')
    if re.search(r"\beco\b", re.sub(r"ECO_\w+|eco keeps|eco's|\.eco\b", "", text)):
        raise SystemExit("client.py still mentions eco: extend the rewrites")
    return text


REWRITES = [
    ("from eco import logs_ask, logs_scilog, logs_sources", "from scilog_viewer import client as logs_scilog"),
    ("from eco.scilog_app import", "from scilog_viewer import"),
    ("from eco.scilog_app.server import", "from scilog_viewer.server import"),
    ("from eco import logs_sources", "from scilog_viewer import client"),
    ("logs_sources.html_to_text", "logs_scilog.html_to_text"),
    ("logs_ask.index_dir()", "logs_scilog.cache_dir()"),
    ('"-m", "eco.scilog_app"', '"-m", "scilog_viewer"'),
    ("python -m eco.scilog_app", "python -m scilog_viewer"),
    ('Path.home() / ".eco" / "scilog_app.json"', 'logs_scilog.CONFIG_DIR / "config.json"'),
    ("~/.eco/scilog_app.json", "~/.config/scilog-viewer/config.json"),
    ("from eco.ei_page import can_open_browser", "from scilog_viewer.client import can_open_browser"),
    ("eco.start_scilog() printed", "python -m scilog_viewer printed"),
    ('"eco scilog: ', '"scilog viewer: '),
    ("eco scilog server", "scilog viewer server"),
    ('"eco-scilog', '"scilog-viewer'),
    ('COOKIE = "eco_scilog_token"', 'COOKIE = "scilog_viewer_token"'),
]


def rewrite(text, name):
    for a, b in REWRITES:
        text = text.replace(a, b)
    if name == "__main__.py":
        text = text.replace('''args = parser.parse_args()''', '''parser.add_argument("--token", action="store_true", help="keep your SciLog token (asked without echo), then exit")
args = parser.parse_args()

if args.token:
    import getpass

    from scilog_viewer import client

    print(client.TOKEN_STEPS)
    path = client.save_token(getpass.getpass("SciLog token: "), client.TOKEN_PATH)
    print(f"kept in {path}: {client.describe(client.token(path)[0])}")
    raise SystemExit(0)''', 1)
        text = text.replace("updated eco reaches", "updated viewer reaches")
    if name in ("__init__.py", "server.py"):  # module docstrings describe eco: replaced
        head = {"__init__.py": INIT_DOC, "server.py": SERVER_DOC}[name]
        text = head + text[text.index('"""', 3) + 3:]
    return text


INIT_DOC = '''"""scilog_viewer -- read and write SciLog in the browser.

One logbook as a flow of days with an outline and a map of it, fuzzy search
(typos allowed), inline interactive plots, writing and editing posts with
the editor SciLog itself uses, and SciLog's views listed and fixed.

    python -m scilog_viewer            # serves http://localhost:8798/?token=...

The server binds 127.0.0.1 only and checks a random token (a cookie after
the first visit); from another machine forward the port over SSH. SciLog is
read and written with your own token (scilog_viewer.client), so you see
and may change exactly what you see in SciLog's own page.
"""'''

SERVER_DOC = '''"""scilog_viewer.server -- the local server: SciLog's posts, files and views
seen through your own token, and the page in scilog_viewer/static.

It binds 127.0.0.1 and checks a random token (cookie after the first visit);
writes need a header only the page itself sends and the page's own origin.
"""'''


LAUNCH = '''"""The `scilog-viewer` command and the built programs: start the viewer,
open it in the browser, run until the window (or Ctrl-C) ends it."""

import runpy
import sys


def main():
    if getattr(sys, "frozen", False) and len(sys.argv) == 1:
        print("SciLog viewer -- close this window to stop it.", flush=True)
    runpy.run_module("scilog_viewer", run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
'''


def main(eco):
    eco = Path(eco).resolve()
    src = eco / "eco" / "scilog_app"
    if PKG.exists():
        shutil.rmtree(PKG)
    shutil.copytree(src, PKG, ignore=shutil.ignore_patterns("__pycache__"))
    for py in PKG.glob("*.py"):
        py.write_text(rewrite(py.read_text(), py.name))
    for js in (PKG / "static").glob("*"):
        if js.suffix in (".js", ".html", ".css"):
            js.write_text(js.read_text().replace("eco SciLog viewer", "SciLog viewer").replace("~/.eco/scilog_app.json", "~/.config/scilog-viewer/config.json"))
    (PKG / "client.py").write_text(client(eco))
    (PKG / "launch.py").write_text(LAUNCH)
    tests = HERE / "tests"
    tests.mkdir(exist_ok=True)
    t = (eco / "tests" / "test_scilog_app.py").read_text()
    t = re.sub(r"from _light_eco import ensure_eco_importable\n+ensure_eco_importable\(\)\n", "", t)
    t = t.replace('"eco.logs_scilog.', '"scilog_viewer.client.').replace('"""eco.scilog_app:', '"""scilog_viewer:')
    t = t.replace("from eco import logs_scilog\n", "from scilog_viewer import client as logs_scilog\n")
    t = t.replace("from eco.scilog_app import content", "from scilog_viewer import content")
    t = t.replace("from eco.scilog_app.server import", "from scilog_viewer.server import")
    (tests / "test_viewer.py").write_text(t)
    left = [p.name for p in list(PKG.rglob("*.py")) + [tests / "test_viewer.py"] if re.search(r"\beco\.|from eco\b|import eco\b", p.read_text())]
    if left:
        raise SystemExit(f"still importing eco: {left}")
    print(f"scilog_viewer/ and tests/ built from {eco}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "../eco")
