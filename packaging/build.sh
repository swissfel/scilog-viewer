#!/bin/sh
# Build the SciLog viewer as one program for this system: dist/scilog-viewer(.exe)
#   pip install ".[build]" && sh packaging/build.sh
# packaging/linux_package.sh turns it into a .deb and an .rpm with a menu entry;
# packaging/windows_setup.iss (Inno Setup) turns it into a Windows installer.
set -e
cd "$(dirname "$0")/.."
python3 packaging/make_icons.py build/icons 2>/dev/null || python packaging/make_icons.py build/icons
# only Windows programs carry their icon in the file; elsewhere it belongs to the package
icon=""
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN* | Windows*) icon="--icon=build/icons/scilog-viewer.ico" ;; esac
pyinstaller --noconfirm --clean --onefile --name scilog-viewer $icon \
  --add-data "scilog_viewer/static:scilog_viewer/static" \
  --collect-submodules scilog_viewer --collect-submodules tornado \
  packaging/scilog_viewer_app.py
