#!/bin/sh
# Build the SciLog viewer as one program for this system: dist/scilog-viewer(.exe)
#   pip install ".[build]" && sh packaging/build.sh
set -e
cd "$(dirname "$0")/.."
pyinstaller --noconfirm --clean --onefile --name scilog-viewer \
  --add-data "scilog_viewer/static:scilog_viewer/static" \
  --collect-submodules scilog_viewer --collect-submodules tornado \
  packaging/scilog_viewer_app.py
