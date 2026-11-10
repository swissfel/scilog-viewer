"""scilog_viewer -- read and write SciLog in the browser.

One logbook as a flow of days with an outline and a map of it, fuzzy search
(typos allowed), inline interactive plots, writing and editing posts with
the editor SciLog itself uses, and SciLog's views listed and fixed.

    python -m scilog_viewer            # serves http://localhost:8798/?token=...

The server binds 127.0.0.1 only and checks a random token (a cookie after
the first visit); from another machine forward the port over SSH. SciLog is
read and written with your own token (scilog_viewer.client), so you see
and may change exactly what you see in SciLog's own page.
"""

import os
import secrets
import socket
import collections
import subprocess
import sys
import threading
import time

DEFAULT_PORT = 8798
#: the server's token travels in the environment: a command line is
#: readable by every account on the host (ps)
TOKEN_ENV = "ECO_SCILOG_APP_TOKEN"

_process = None
_url = None
#: the server's last output lines (log()), read off its pipe so it never fills up
_output = collections.deque(maxlen=200)


def start(port=DEFAULT_PORT, open_browser=None, timeout=60, logbook=None):
    """Start the server as a separate process (once per session) and print
    its address; opens a browser where one can be started (a display, not
    over ssh). The process ends when this session does. `logbook` (an id)
    makes the address open that logbook."""
    global _process, _url
    if _process is None or _process.poll() is not None:
        token = secrets.token_urlsafe(24)
        env = dict(os.environ, **{TOKEN_ENV: token})
        env["PYTHONPATH"] = os.pathsep.join(p for p in [os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
                                                         env.get("PYTHONPATH", "")] if p)
        _process = subprocess.Popen(
            [sys.executable, "-m", "scilog_viewer", "--port", str(port), "--no-browser",
             "--parent", str(os.getpid()), "--quiet"],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            start_new_session=True,  # Ctrl-C in the session does not reach it
        )
        line, t0 = "", time.time()
        while time.time() - t0 < timeout:
            line = _process.stdout.readline()
            if line.startswith("scilog viewer: http") or not line:
                break
        if not line.startswith("scilog viewer: http"):
            rest = line + (_process.stdout.read() if _process.poll() is not None else "")
            _process.kill()
            _process = None
            raise RuntimeError(f"scilog viewer server did not start: {rest.strip()[-500:]}")
        _url = line.split(": ", 1)[1].strip()
        threading.Thread(target=_drain, args=(_process,), name="scilog-viewer-output", daemon=True).start()
    url = f"{_url.split('#', 1)[0]}#lb={logbook}" if logbook else _url
    print(f"scilog viewer: {url}")
    if os.environ.get("SSH_CONNECTION"):
        print(f"  from your machine: ssh -L {port}:localhost:{port} {socket.gethostname()}, then open the address")
    from scilog_viewer.client import can_open_browser

    if open_browser or (open_browser is None and can_open_browser()):
        import webbrowser

        webbrowser.open(url)
    return url


def _drain(process):
    for line in process.stdout:
        _output.append(line.rstrip("\n"))


def log():
    """The server's last output lines (warnings, errors)."""
    return "\n".join(_output)


def stop():
    global _process, _url
    if _process is not None and _process.poll() is None:
        _process.terminate()
        try:
            _process.wait(5)
        except subprocess.TimeoutExpired:
            _process.kill()
    _process = _url = None
