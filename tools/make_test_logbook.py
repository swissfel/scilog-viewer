#!/usr/bin/env python3
"""Make a logbook to try the viewer on: the size and shape of a real beamtime
logbook, with made-up words and figures drawn by scilog_viewer.demo. Nothing in
it comes from SciLog, so it can be passed around freely.

    python tools/make_test_logbook.py                  # into the cache, 1729 posts
    python tools/make_test_logbook.py /tmp/lb --posts 6000
    python -m scilog_viewer --demo /tmp/lb             # read it
"""
import argparse
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from scilog_viewer import demo  # noqa: E402

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("where", nargs="?", help=f"the folder to write it into (default: {demo.DEFAULT_DIR})")
parser.add_argument("--posts", type=int, default=1729, help="how many posts (default: as the real one)")
parser.add_argument("--figures", type=int, default=80, help="how many different figures to draw")
parser.add_argument("--seed", type=int, default=7, help="the same seed gives the same logbook")
args = parser.parse_args()

where = demo.make(args.where, posts=args.posts, seed=args.seed, figures=args.figures)
print(f"read it with: python -m scilog_viewer --demo {where}")
