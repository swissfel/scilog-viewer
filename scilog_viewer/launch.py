"""The `scilog-viewer` command and the built programs: start the viewer,
open it in the browser, run until the window (or Ctrl-C) ends it."""

import runpy
import sys


def main():
    if getattr(sys, "frozen", False) and len(sys.argv) == 1:
        print("SciLog viewer -- close this window to stop it.", flush=True)
    runpy.run_module("scilog_viewer", run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
