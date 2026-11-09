# SciLog viewer

Read and write [SciLog](https://scilog.psi.ch), PSI's electronic logbook, in the browser:

- one logbook as a continuous flow of days, newest at the bottom, new posts appearing by themselves;
- a left pane with either the **outline** (months, days, posts, headings) or the **map**: the flow drawn
  small, with figures, tables, lists and code recognisable by their look; a click jumps there;
- fuzzy search (typos allowed) with previews;
- interactive HTML plots inline, images in a lightbox;
- writing and editing posts with the editor SciLog itself uses (CKEditor 5), images uploaded as they are pasted,
  drafts kept in the browser; a composer at the bottom, double-click your own post to edit it;
- views of the flow (all, mine, by tag) and **SciLog's own views** (dashboard layouts) listed side by side,
  with what tells same-named ones apart, and renamed, changed or deleted (a local copy is kept first);
- links to a single post, in context or alone.

## Run it

**As a program** (no Python needed): download the one for your system from the
[releases](../../releases) (or the latest [build](../../actions/workflows/build.yml) run's artifacts) and start it:

| system | file |
|---|---|
| Linux (x86-64) | `scilog-viewer-linux-x86_64` (make it executable: `chmod +x`) |
| Windows | `scilog-viewer-windows-x86_64.exe` |
| macOS (Apple silicon / Intel) | `scilog-viewer-macos-arm64` / `-x86_64` (unsigned: right-click, Open, the first time) |

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
account several people use.

### From a phone

The viewer is a small local server plus a web page; SciLog's API does not accept calls from pages served elsewhere
(no CORS), so a page alone (e.g. on GitHub Pages) cannot do it. Ways that work:

- **through a computer that runs it:** `ssh -L 8798:localhost:8798 that-computer` from the phone (e.g. Termux or
  any SSH app with port forwarding), then open the printed address on the phone;
- **on the phone itself** (Android, untested so far): in [Termux](https://termux.dev),
  `pkg install python rust && pip install git+https://github.com/swissfel/scilog-dev && scilog-viewer --no-browser`,
  then open the printed address in the phone's browser;
- an Android app wrapping the same server and page (a WebView) is possible; see "Where this could go".

## What it may do

The server binds 127.0.0.1 only and checks a random token (a cookie after the first visit). Writes need a header
only the page itself sends, from the page's own origin. Everything is done with your token, so SciLog decides
what you can read and change, as in its own page.

Writing is off until you switch it on per logbook (the page's "Allow writing here", or
`~/.config/scilog-viewer/config.json`: `{"write_logbooks": [ids] or "all"}`); until then only the test logbook
`0123456789abcdef01234567` (p10002) is writable.

## Development

```bash
pip install -e ".[dev]"
pytest
```

The viewer was written inside eco (gitea.psi.ch: Bernina/eco) (`eco/scilog_app`, started
there with `eco.start_scilog()`). `tools/sync_from_eco.py /path/to/eco` rebuilds `scilog_viewer/` and the tests
from an eco checkout, leaving out what is eco-specific, until eco uses this package instead of its own copy.

## Where this could go

- **An Android app:** the same server and page packed with Python (BeeWare Briefcase / Chaquopy) and shown in a
  WebView; built by the same workflow as the desktop programs, installed from the APK (not the Play Store).
- **A purely static version** (e.g. on GitHub Pages, no local server) needs two things from SciLog: its API
  answering requests from another site (CORS for that site), and its login sending the browser back to that site
  with a token. Both are SciLog configuration, not code here.

## Building the programs

`pip install ".[build]" && sh packaging/build.sh` makes `dist/scilog-viewer` for the system it runs on;
`packaging/smoke_test.py dist/scilog-viewer` starts it and checks that it serves the page. The `build` workflow does
both on Linux, Windows and macOS (on demand, and for tags `v*`, which also publish a release).
