# SciLog viewer

Read and write [SciLog](https://scilog.psi.ch), PSI's electronic logbook, in the browser:

- one logbook as a continuous flow of days, newest at the bottom, new posts appearing by themselves;
- a long logbook is read from its end: the newest posts are on the screen at once and the older days
  fill in above them while you read, each piece larger than the last; a quick flick upwards offers the
  way back to the top, and goes away again by itself (Home does the same);
- the day header stays at the top while its day is read and says which part of the day is on the screen
  (night, morning, noon, afternoon, evening, late);
- a **scroll rail** down the right: a handle wide enough for a thumb, a mark for every day on the track,
  and, while it is held (or pointed at), a sign saying where it would take you -- the day, the part of
  that day and the heading above that place;
- a left pane with either the **outline** (headings across all posts), the **stream** (months, days, posts)
  or the **map**: the flow drawn small, with figures, tables, lists and code recognisable by their look;
  a click jumps there. The pane grows with the logbook the same way the flow does -- the older days are
  put in above what it shows, so it stays where you are reading -- and only the pane on show is drawn;
- fuzzy search (typos allowed) with previews;
- interactive HTML plots inline, images on their own on a tap or a click, there pinch- (or wheel-) zoomable,
  dragged about and zoomed in and out again by a double tap: on a phone a figure can be read, not only seen;
- writing and editing posts with the editor SciLog itself uses (CKEditor 5), images uploaded as they are pasted,
  drafts kept in the browser; a composer at the bottom, double-click your own post to edit it;
- views of the flow (all, mine, by tag) and **SciLog's own views** (dashboard layouts) listed side by side,
  with what tells same-named ones apart, and renamed, changed or deleted (a local copy is kept first);
- links to a single post, in context or alone;
- comments and replies as in SciLog, and a post's info;
- the logbook's **tasks** in a pane: changed at any time and dragged into order, which is stored in SciLog (its own
  page lists tasks by when they were added, until it sorts them too).

## Run it

**Installed** (no Python needed): take the one for your system from the
[releases](../../releases) (or the latest [build](../../actions/workflows/build.yml) run's artifacts).
These put the viewer in the menu, with its icon, and can be removed again as any other program:

| system | file |
|---|---|
| Debian, Ubuntu | `scilog-viewer_<version>_amd64.deb` -- `sudo apt install ./scilog-viewer_*.deb` |
| Red Hat, Alma, Fedora, openSUSE | `scilog-viewer-<version>-1.x86_64.rpm` -- `sudo dnf install ./scilog-viewer-*.rpm` |
| Windows | `scilog-viewer-setup-windows-x86_64.exe` -- for you alone, so it asks for no administrator |
| Android | `scilog-viewer-android.apk` (see [From a phone](#from-a-phone)) |

**As one file**, to carry about or to run where nothing may be installed:

| system | file |
|---|---|
| Linux (x86-64) | `scilog-viewer-linux-x86_64` (make it executable: `chmod +x`) |
| Windows | `scilog-viewer-windows-x86_64.exe` |
| macOS (Apple silicon, Intel) | `scilog-viewer-macos-arm64`, `scilog-viewer-macos-x86_64` -- unsigned: start the first one through right-click → Open |

Either way it opens the viewer in your browser and runs until its window is closed. The icon and the
packages are made by `packaging/make_icons.py`, `packaging/linux_package.sh` and
`packaging/windows_setup.iss` -- all of it from `packaging/icon.svg`, the drawing the Android app uses too.
The app's launcher icons live in `android/app/src/main/res`: the adaptive one a phone draws
(`mipmap-anydpi-v26/`, with a monochrome layer for Android 13's themed icons) and a plain picture at
every density for launchers that ask for one. `python packaging/make_icons.py --android` draws those
again if the icon changes.

**In the browser alone**: the same page as a web site of plain files, with nothing installed and nothing running on
your side but the browser. `scilog_viewer/web/browser.js` does in the page what the local server does, calling SciLog's
API directly (SciLog's API allows that from any site), and the service worker `scilog_viewer/web/sw.js` serves the
images and attachments with your token:

```bash
python tools/build_web.py --cname scilog-viewer.example.org   # -> dist/web, for https://scilog.psi.ch
cd dist/web && python -m http.server 8000                     # a try on http://localhost:8000
```

`.github/workflows/pages.yml` tests it in Chromium and puts it on GitHub Pages (setup in the file). Before it goes
live:

- **its own domain** (`--cname`; the workflow takes the repository variable `SCILOG_VIEWER_DOMAIN`). The token is kept
  in the browser per origin, and `https://<org>.github.io/...` is one origin for every Pages site of the organisation;
- **https** (GitHub Pages has it): the service worker, and so images, plots and attachments, need it;
- the page carries a strict Content Security Policy: scripts only from the site and the editor's CDN, connections
  only to SciLog. Plots, images and downloads opened from it run sandboxed, in no origin of the site's.

**Inside SciLog's own page**, for where SciLog does not let the site call it (no CORS permission for it, as
the site then says): a bookmark loads the viewer from the site into the SciLog page you are logged in to. It reads
SciLog there on SciLog's own origin with SciLog's own login, so there is no token to copy and CORS does not apply.
The token window has the bookmark ("Or: the viewer inside SciLog's own page"): drag it to the bookmarks bar, open
SciLog, log in, click it. Offline copies need the site itself and are not there. (`inject.js`, written by
`tools/build_web.py`; `tests/test_web_scilog.py` runs it against a stand-in SciLog without CORS.)

**Offline copies** (📴 in the bar): check logbooks in a list (or all of them) to keep them in the browser, to read
later without a network and without a token: posts, comments, tasks and, if wanted, their images, attachments and
interactive plots. The viewer itself is kept too, so it opens offline and shows the kept logbooks read-only.
Before a large copy (over 500 MB, or more than half of what the browser has left) it says how large and asks: keep it
anyway, keep it in a folder of your choice (Chrome and Edge on a computer), keep only the text, or not at all. With a
token and a network the copies are brought up to date by themselves every few hours; unchecking one removes it.
Anyone using that browser can read the copies, so keep none on a computer others use.

The token is entered in the page as above and kept in that browser (or only in the tab, for at most 8 hours);
"🔑 → Forget the token in this browser" removes it, which is what to do on a computer others use. The logbooks you
allow writing to are remembered in the browser too. Not here: the beamline account (its password cannot be given to
a web page) and eco's plugin. To try it without SciLog, `python tools/fake_scilog.py` serves the made-up logbook
through a stand-in for SciLog's API (with its CORS behaviour) and prints the token it accepts; build with
`--api http://localhost:8790/api/v1` for it, as `tests/test_web.py` does.

**With Python:**

```bash
pip install -e .                  # tornado, requests, nh3
python -m scilog_viewer           # or: scilog-viewer
```

### The token

The viewer reads and writes SciLog with your own token. The first time (and whenever the token has run out) the page
asks for it and says how to get it:

1. log in at https://scilog.psi.ch;
2. copy the token: on a computer press F12, Console, `copy(localStorage.id_token)`; on a phone, or without the
   developer tools, once make a bookmark with the address
   `javascript:void(prompt('SciLog token (select all, copy):',localStorage.id_token))` and open it while SciLog is
   shown (Android Chrome: type the bookmark's name in the address bar);
3. paste it into the viewer's window.

The viewer checks it with SciLog and keeps it in `~/.config/scilog-viewer/token` (mode 600). **A token lasts 14 days
from the login and cannot be renewed**; three days before, a badge in the bar says so. `python -m scilog_viewer --token`
and `$SCILOG_TOKEN` work too, and eco's `~/.eco/scilog_token` is used if present. Never keep a personal token on an
account several people use: there (listed in `$SCILOG_VIEWER_SHARED_ACCOUNTS`) the viewer only *borrows* a
token, held in memory for at most 8 hours and never written to disk. Anywhere, the token window's "Keep it" box
decides between keeping a token and borrowing it.

### From a phone

The viewer is a small local server plus a web page; SciLog's API does not accept calls from pages served elsewhere
(no CORS), so a page alone (e.g. on GitHub Pages) cannot do it. Ways that work:

- **through a computer that runs it:** `ssh -L 8798:localhost:8798 that-computer` from the phone (e.g. Termux or
  any SSH app with port forwarding), then open the printed address on the phone;
- **on the phone itself** (Android, untested so far): in [Termux](https://termux.dev),
  `pkg install python rust && pip install git+https://github.com/swissfel/scilog-dev && scilog-viewer --no-browser`,
  then open the printed address in the phone's browser;
- **the Android app**: on the phone, sign in to github.com in the browser (the repository is private), open this
  repository's **Releases**, tap `scilog-viewer-android.apk` and open the download. The same server and page
  inside the app; newer releases install over it. Install the APK (Android asks once to allow installs from your browser or file manager),
  open *SciLog viewer*, tap **Log in to SciLog here**: SciLog's own login (PSI account, MFA) opens in the app and
  the token is taken over by itself. Links to other sites open in your browser; attachments go to Downloads.
  A picture opened from a post zooms with a pinch; Back closes it.

## What it may do

The server binds 127.0.0.1 only and checks a random token (a cookie after the first visit). Writes need a header
only the page itself sends, from the page's own origin. Everything is done with your token, so SciLog decides
what you can read and change, as in its own page.

Writing is off until you switch it on per logbook (the page's "Allow writing here", or
`~/.config/scilog-viewer/config.json`: `{"write_logbooks": [ids] or "all"}`); until then nothing is written.

## A logbook to try it on, without SciLog

```bash
python -m scilog_viewer --demo            # makes one the first time (a few seconds), then reads it
```

A made-up logbook: 1729 posts over three months, 43 days with posts, bursts of 212 in a day, a figure in
every fifth post, a third of them a scan report with a table and a data file -- the shape of a real beamtime
logbook, so the viewer is slow in the same places. Everything in it is generated by `scilog_viewer/demo.py`:
the words come from a word list and ten sentence patterns, the figures (scans, detector frames, spectra,
camera pictures) are drawn pixel by pixel and written out as PNGs by hand, the names are invented. Nothing
is taken from SciLog or anywhere else, nothing is sent anywhere, and no token is needed, so the logbook can
be passed on freely. It is read-only.

`python tools/make_test_logbook.py DIR --posts 6000` makes a bigger one somewhere else
(`--demo DIR` then reads it); the same `--seed` always gives the same logbook.

## Development

```bash
pip install -e ".[dev]"
pytest
```

Two of the tests run the page itself in node: the gestures of the picture window, and a logbook of
600 posts read from its end with all three panes (`tests/test_panes.mjs`, which needs jsdom --
`npm install jsdom` here, or `NODE_PATH` to one; without it that test is skipped).

Releasing: `git config core.hooksPath .githooks` once per clone. Then every push of `main` is a release:
the pre-push hook tags the next patch version (`v0.2.9` after `v0.2.8`), `publish.yml` puts it on PyPI and
`build.yml` attaches the programs and the Android app to a GitHub release. The version comes from that tag
(setuptools-scm). `SKIP_AUTOTAG=1 git push` pushes without releasing; a bigger step is tagged by hand before
the push (`git tag v0.3.0`).

## A site's own parts (plugins)

`python -m scilog_viewer --plugin MODULE` (or `$SCILOG_VIEWER_PLUGIN`, or `scilog_viewer.start(plugin=...)`)
imports `MODULE` and calls its `setup(client, server)` before the server starts. It may set:

- `client.FUNCTIONAL_USER` and `client.functional_login(url, session, timeout)` -- a beamline account whose
  token the function returns (`client.login(user, password)` does SciLog's local login), or `None` when its
  password is not readable; give the function an `available()` attribute to say so without logging in;
- `client.SHARED_ACCOUNTS` -- accounts several people use: no personal token is kept or used there;
- `server.CONFIG_PATH`, `server.DEFAULT_WRITE_LOGBOOKS` -- where the settings live, and which logbooks are
  writable until a user says otherwise.

eco (gitea.psi.ch: Bernina/eco), where the viewer was first written, uses this for the Bernina beamline
account (`eco.scilog_viewer_plugin`); `scilog.viewer()` in an eco session starts this package.

## Where this could go

- **A purely static version** (e.g. on GitHub Pages, no local server) needs two things from SciLog: its API
  answering requests from another site (CORS for that site), and its login sending the browser back to that site
  with a token. Both are SciLog configuration, not code here.

## Building the programs

**Android** (`android/`): a Kotlin app with [Chaquopy](https://chaquo.com/chaquopy/), which packs Python 3.12,
tornado, requests and bleach with this repository's `scilog_viewer/`; `MainActivity` starts the server on
127.0.0.1 and shows the page, `LoginActivity` is SciLog's login whose token it hands over. `cd android &&
./gradlew :app:assembleRelease` (Android SDK 35, Java 17, Python 3.12 on the PATH). The build workflow signs it with
the key in the repository secrets `SCILOG_KEYSTORE_B64` / `SCILOG_KEYSTORE_PASSWORD` (alias `scilog-viewer`), so that
new versions install over old ones; without them it is debug-signed.

**Desktop:**

`pip install ".[build]" && sh packaging/build.sh` makes `dist/scilog-viewer` for the system it runs on;
`packaging/smoke_test.py dist/scilog-viewer` starts it and checks that it serves the page. The `build` workflow does
both on Linux and Windows (macOS when GitHub provides runners again) (on demand, and for tags `v*`, which also publish a release).
