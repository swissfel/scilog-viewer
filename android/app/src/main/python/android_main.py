"""The viewer's server inside the Android app: started once per app process,
on 127.0.0.1 and a free port, with its files in the app's own storage."""

import os

_app = None


def start(files_dir):
    """Start the server (once) and return the address that opens the page."""
    global _app
    if _app is None:
        os.environ.setdefault("HOME", files_dir)
        os.environ["SCILOG_VIEWER_HOME"] = os.path.join(files_dir, "config")
        os.environ["XDG_CACHE_HOME"] = os.path.join(files_dir, "cache")
        from scilog_viewer.server import ScilogApp

        _app = ScilogApp(port=0).start()
    return _app.url


def set_token(value):
    """A token taken from SciLog's own login in the app: checked and kept as
    when pasted into the page. Returns "" or what was wrong."""
    try:
        _app.store.set_token(value)
        return ""
    except Exception as exc:  # shown to the user
        return str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
