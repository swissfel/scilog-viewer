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

**As a program** (no Python needed): download the one for your system from the
[releases](../../releases) (or the latest [build](../../actions/workflows/build.yml) run's artifacts) and start it:

| system | file |
|---|---|
| Linux (x86-64) | `scilog-viewer-linux-x86_64` (make it executable: `chmod +x`) |
| Windows | `scilog-viewer-windows-x86_64.exe` |
| Android | `scilog-viewer-android.apk` (see [From a phone](#from-a-phone)) |

No macOS program for now (GitHub runs no macOS builds for this repository); on a Mac use `pip install` below.

It opens the viewer in your browser and runs until its window is closed.

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
`~/.config/scilog-viewer/config.json`: `{"write_logbooks": [ids] or "all"}`); until then only the test logbook
`0123456789abcdef01234567` (p10002) is writable.

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

The viewer was written inside eco (gitea.psi.ch: Bernina/eco) (`eco/scilog_app`, started
there with `eco.start_scilog()`). `tools/sync_from_eco.py /path/to/eco` rebuilds `scilog_viewer/` and the tests
from an eco checkout, leaving out what is eco-specific, until eco uses this package instead of its own copy.

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
