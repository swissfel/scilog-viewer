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

```bash
pip install -e .            # tornado and requests; or use any environment that has them
python -m scilog_viewer --token   # once: paste your SciLog token (see below)
python -m scilog_viewer           # prints http://localhost:8798/?token=... and opens it
```

The token is SciLog's own login token: log in at https://scilog.psi.ch, open the browser's developer console
(F12) and run `copy(localStorage.id_token)`. It is kept in `~/.config/scilog-viewer/token` (mode 600) and lasts
about two weeks. `$SCILOG_TOKEN` works too, and eco's `~/.eco/scilog_token` is used if present. Never keep a
personal token on an account several people use.

From another machine, forward the port: `ssh -L 8798:localhost:8798 host`, then open the printed address.

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

A purely static version (e.g. on GitHub Pages, no local server) needs two things from SciLog: its API answering
requests from another site (CORS for that site), and its login sending the browser back to that site with a
token. Both are SciLog configuration, not code here.
