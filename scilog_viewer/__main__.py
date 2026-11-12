"""python -m scilog_viewer [--port N] [--no-browser]: the SciLog viewer's
server, in the foreground until Ctrl-C (or, with --parent, until that
process has ended)."""

import argparse
import os
import time

from scilog_viewer import DEFAULT_PORT, TOKEN_ENV

parser = argparse.ArgumentParser(prog="python -m scilog_viewer", description="The SciLog viewer's server.")
parser.add_argument("--port", type=int, default=DEFAULT_PORT)
parser.add_argument("--no-browser", action="store_true", help="only print the address")
parser.add_argument("--parent", type=int, help="end when this process has ended")
parser.add_argument("--quiet", action="store_true", help="no request log")
parser.add_argument("--token", action="store_true", help="keep your SciLog token (asked without echo), then exit")
parser.add_argument("--demo", nargs="?", const="", metavar="DIR",
                    help="read a made-up logbook instead of SciLog (generated once, in DIR or in the cache): "
                         "nothing is sent to SciLog and no token is needed")
args = parser.parse_args()

if args.token:
    import getpass

    from scilog_viewer import client

    print(client.TOKEN_STEPS)
    path = client.save_token(getpass.getpass("SciLog token: "), client.TOKEN_PATH)
    print(f"kept in {path}: {client.describe(client.token(path)[0])}")
    raise SystemExit(0)

if args.quiet:
    import logging

    logging.getLogger("tornado.access").setLevel(logging.WARNING)

from scilog_viewer.server import ScilogApp, Store  # noqa: E402

store = None
if args.demo is not None:
    from scilog_viewer.demo import open_demo

    store = Store(open_demo(args.demo or None))

try:
    app = ScilogApp(port=args.port, store=store, token=os.environ.pop(TOKEN_ENV, None)).start()
except OSError:  # the port is taken (another viewer?): any free one
    print(f"port {args.port} is in use, taking another", flush=True)
    app = ScilogApp(port=0, store=store, token=os.environ.pop(TOKEN_ENV, None)).start()
print(f"scilog viewer: {app.url}", flush=True)
if not args.no_browser:
    from scilog_viewer.client import can_open_browser

    if can_open_browser():
        import webbrowser

        webbrowser.open(app.url)


def parent_alive():
    if args.parent is None:
        return True
    try:
        os.kill(args.parent, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass  # exists, owned by someone else: cannot happen for our parent, keep going
    return True


try:
    while parent_alive():
        time.sleep(2)
except KeyboardInterrupt:
    pass
finally:
    app.stop()
