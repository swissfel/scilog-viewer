#!/bin/sh
# The built program as something a Linux desktop installs: a .deb and an .rpm that put
# scilog-viewer in the menu with its icon.
#
#   pip install ".[build]" && sh packaging/build.sh && sh packaging/linux_package.sh [version]
#
# dpkg-deb comes with Debian and Ubuntu; the .rpm wants rpmbuild (apt install rpm, or build
# it on a Red Hat machine) and is left out where that is missing. Without a version it takes
# the one from the tag being built (GITHUB_REF_NAME), or 0.0.0.
#
# What is installed:
#   /usr/bin/scilog-viewer                                  the program itself (one file)
#   /usr/share/applications/scilog-viewer.desktop           the menu entry
#   /usr/share/icons/hicolor/*/apps/scilog-viewer.{png,svg} its icon, every size
set -e
cd "$(dirname "$0")/.."

version=${1:-}
[ -n "$version" ] || version=${GITHUB_REF_NAME#v}
case "$version" in "" | *[!0-9.]*) version=0.0.0 ;; esac   # a build off a tag has no number
machine=$(uname -m)
case "$machine" in x86_64) deb_arch=amd64 ;; aarch64) deb_arch=arm64 ;; *) deb_arch=$machine ;; esac
maintainer="SciLog viewer <scilog-viewer@users.noreply.github.com>"
summary="Read and write SciLog, PSI's electronic logbook, in the browser"

[ -f dist/scilog-viewer ] || { echo "dist/scilog-viewer is not there: run packaging/build.sh first" >&2; exit 1; }
python3 packaging/make_icons.py build/icons

root=build/linux/root
rm -rf build/linux
mkdir -p "$root/usr/bin" "$root/usr/share/applications" "$root/usr/share/icons/hicolor/scalable/apps" dist
install -m 0755 dist/scilog-viewer "$root/usr/bin/scilog-viewer"
install -m 0644 build/icons/scilog-viewer.svg "$root/usr/share/icons/hicolor/scalable/apps/scilog-viewer.svg"
for size in 16 24 32 48 64 128 256 512; do
  mkdir -p "$root/usr/share/icons/hicolor/${size}x${size}/apps"
  install -m 0644 "build/icons/scilog-viewer-${size}.png" "$root/usr/share/icons/hicolor/${size}x${size}/apps/scilog-viewer.png"
done

# Terminal=true on purpose: the viewer runs until it is stopped, and the terminal window it
# opens is what the reader closes to stop it -- as the Windows and macOS programs do.
cat > "$root/usr/share/applications/scilog-viewer.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=SciLog viewer
GenericName=Electronic logbook
Comment=$summary
Exec=scilog-viewer
Icon=scilog-viewer
Terminal=true
Categories=Science;Physics;
Keywords=SciLog;logbook;PSI;beamtime;
StartupNotify=true
DESKTOP

chmod 0644 "$root/usr/share/applications/scilog-viewer.desktop"
find "$root" -type d -exec chmod 0755 {} +     # whatever the umask here says

refresh='update-desktop-database -q /usr/share/applications 2>/dev/null || true
gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true'

# -- the .deb ---------------------------------------------------------------------------------
mkdir -p "$root/DEBIAN"
cat > "$root/DEBIAN/control" <<CONTROL
Package: scilog-viewer
Version: $version
Section: science
Priority: optional
Architecture: $deb_arch
Maintainer: $maintainer
Homepage: https://github.com/swissfel/scilog-viewer
Description: $summary
 One logbook as a flow of days with an outline, a map and fuzzy search, figures that
 pinch-zoom, and writing with SciLog's own editor. Everything runs on this machine: the
 program serves the page to 127.0.0.1 and talks to SciLog with your own token.
 .
 It needs nothing else installed: Python and the libraries are inside the program.
CONTROL
printf '#!/bin/sh\nset -e\n%s\n' "$refresh" > "$root/DEBIAN/postinst"
printf '#!/bin/sh\nset -e\n%s\n' "$refresh" > "$root/DEBIAN/postrm"
chmod 0755 "$root/DEBIAN/postinst" "$root/DEBIAN/postrm"
deb="dist/scilog-viewer_${version}_${deb_arch}.deb"
dpkg-deb --root-owner-group --build "$root" "$deb" >/dev/null
echo "$deb"

# -- the .rpm ---------------------------------------------------------------------------------
if ! command -v rpmbuild >/dev/null 2>&1; then
  echo "rpmbuild is not here: no .rpm (apt install rpm)" >&2
  exit 0
fi
rm -rf "$root/DEBIAN"
top=$(cd build/linux && pwd)/rpm
mkdir -p "$top"
cat > build/linux/scilog-viewer.spec <<SPEC
Name:           scilog-viewer
Version:        $version
Release:        1
Summary:        $summary
License:        Unspecified
URL:            https://github.com/swissfel/scilog-viewer
BuildArch:      $machine
AutoReqProv:    no

%description
One logbook as a flow of days with an outline, a map and fuzzy search, figures that
pinch-zoom, and writing with SciLog's own editor. Everything runs on this machine: the
program serves the page to 127.0.0.1 and talks to SciLog with your own token. It needs
nothing else installed: Python and the libraries are inside the program.

%install
cp -a $(cd "$root" && pwd)/. %{buildroot}/

%post
$refresh

%postun
$refresh

%files
/usr/bin/scilog-viewer
/usr/share/applications/scilog-viewer.desktop
/usr/share/icons/hicolor/*/apps/scilog-viewer.*
SPEC
rpmbuild -bb build/linux/scilog-viewer.spec \
  --define "_topdir $top" --define "_rpmdir $(pwd)/dist" --define "_build_id_links none" \
  --quiet
mv "dist/$machine/scilog-viewer-${version}-1.${machine}.rpm" dist/ 2>/dev/null || true
rmdir "dist/$machine" 2>/dev/null || true
echo "dist/scilog-viewer-${version}-1.${machine}.rpm"
