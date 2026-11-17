"""scilog_viewer.client -- SciLog's REST API with your own PSI account.

Personal accounts log in to SciLog through the browser (PSI single sign-on),
so this works with the token SciLog issues after that login:

  1. log in at https://scilog.psi.ch,
  2. in the browser's developer console (F12):  copy(localStorage.id_token)
  3. python -m scilog_viewer --token   (asks for it without echoing it and
     keeps it in ~/.config/scilog-viewer/token, mode 600), or set
     $SCILOG_TOKEN.

The token carries your PSI groups: everything here sees what you see in
SciLog's web page. It lasts about two weeks. Never keep a personal token on
an account several people use: they would all read and write SciLog as you
(list such accounts in $SCILOG_VIEWER_SHARED_ACCOUNTS, comma separated).
"""

import base64
import datetime
import html.parser
import json
import os
import re
import stat
import sys
import time
from pathlib import Path

URL = os.environ.get("SCILOG_URL", "https://scilog.psi.ch/api/v1")
CONFIG_DIR = Path(os.environ.get("SCILOG_VIEWER_HOME") or Path.home() / ".config" / "scilog-viewer")
TOKEN_PATH = CONFIG_DIR / "token"
#: also read: eco keeps the same token here
ECO_TOKEN_PATH = Path.home() / ".eco" / "scilog_token"
PAGE = 500  # snippets per request

TOKEN_STEPS = """\
  1. log in at https://scilog.psi.ch
  2. browser developer console (F12):  copy(localStorage.id_token)"""
TOKEN_HELP = f"""\
No personal SciLog token. To read SciLog as yourself:
{TOKEN_STEPS}
  3. here:  python -m scilog_viewer --token   (paste it at the hidden prompt)
It lasts about two weeks. Only on your own account, never on a shared one."""


def cache_dir():
    """Where images, files and view backups are kept."""
    path = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "scilog-viewer"
    path.mkdir(parents=True, exist_ok=True)
    return path


def token(path=None):
    """(token, where it came from) or (None, None): $SCILOG_TOKEN, then the
    token file, then eco's."""
    env = _clean(os.environ.get("SCILOG_TOKEN") or os.environ.get("ECO_SCILOG_TOKEN"))
    if env:
        return env, "$SCILOG_TOKEN"
    for p in ([Path(path)] if path else [TOKEN_PATH, ECO_TOKEN_PATH]):
        try:
            text = _clean(p.read_text())
        except OSError:
            continue
        if text:
            return text, str(p)
    return None, None


#: accounts several people use (no personal token is kept or used there); a plugin may add
#: to these, and so may $SCILOG_VIEWER_SHARED_ACCOUNTS (comma separated)
SHARED_ACCOUNTS = ()


def _shared_account():
    import getpass

    shared = [a.strip() for a in os.environ.get("SCILOG_VIEWER_SHARED_ACCOUNTS", "").split(",") if a.strip()]
    try:
        user = getpass.getuser()
    except Exception:
        return None
    return user if user in shared or user in SHARED_ACCOUNTS else None


# -- a beamline (functional) account, provided by a plugin ---------------------------
#
# Without a plugin there is none, and SciLog is always read with a personal token. A
# plugin (see scilog_viewer.load_plugin) sets FUNCTIONAL_USER and functional_login, a
# function (url, session, timeout) -> a SciLog token for that account, or None when its
# password is not readable here. The token is kept here until shortly before it expires
# or SciLog refuses it.

FUNCTIONAL_USER = ""
functional_login = None
_functional = {}  # url -> (token, exp)


def login(user, password, url=URL, session=None, timeout=30):
    """A SciLog token for a local (non-SSO) account, such as a beamline account."""
    if session is None:
        import requests

        session = requests.Session()
    r = session.post(url.rstrip("/") + "/users/login", json={"principal": user, "password": password}, timeout=timeout)
    r.raise_for_status()
    return r.json()["token"]


def functional_available():
    """Whether reader(personal=False) can log in as the beamline account here."""
    if not (FUNCTIONAL_USER and functional_login):
        return False
    available = getattr(functional_login, "available", None)
    return bool(available()) if available else True


def _functional_reader(url, session, timeout):
    cached = _functional.get(url)
    if not cached or cached[1] < time.time() + 600:
        value = functional_login(url=url, session=session, timeout=timeout) if functional_login else None
        if not value:
            raise TokenError(TOKEN_HELP + ("\n(The beamline account would work without a token, but it cannot "
                                           "log in here.)" if FUNCTIONAL_USER else ""))
        _functional[url] = cached = (value, claims(value).get("exp") or time.time() + 3600)
    r = Reader(cached[0], url=url, timeout=timeout, session=session)
    r.identity = f"the beamline account {FUNCTIONAL_USER}"
    return r


def reader(url=URL, session=None, timeout=30, personal=True):
    """A Reader as yourself (your personal token) or, with personal=False or on a shared
    account, as the beamline account if a plugin provides one. Its `identity` says which."""
    if personal and not _shared_account():
        value, where = token()
        if value:
            r = Reader(value, url=url, timeout=timeout, session=session)
            r.identity = f"{describe(value).split(',')[0]} (token from {where})"
            return r
    if functional_available():
        return _functional_reader(url, session, timeout)
    if _shared_account():
        raise TokenError("this is a shared account: no personal token here")
    raise TokenError(TOKEN_HELP)


def can_open_browser():
    """A browser can be started here: not over ssh, and on Linux a display."""
    if os.environ.get("SSH_CONNECTION") or os.environ.get("SSH_TTY"):
        return False
    if sys.platform in ("win32", "darwin"):
        return True
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def html_to_text(html_text):
    p = _TextOnly()
    p.feed(html_text or "")
    text = "".join(p.parts)
    return re.sub(r"\n[ \t]*\n\s*", "\n\n", text).strip()

class TokenError(RuntimeError):
    """No token, or SciLog refused it (expired)."""

def _clean(token):
    token = (token or "").strip().strip('"').strip("'")
    return token[len("Bearer "):].strip() if token.startswith("Bearer ") else token

def save_token(value, path=None):
    """Keep a token in the token file, readable only by you."""
    shared = _shared_account()
    if shared:
        raise ValueError(
            f"{shared} is a shared account: everyone using it would read SciLog as you. "
            "Use your own account."
        )
    value = _clean(value)
    if value.count(".") != 2:
        raise ValueError("that is not a SciLog token (expected three dot-separated parts)")
    path = Path(path or TOKEN_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(value + "\n")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    return path

def claims(value):
    """The token's payload (name, email, roles, exp) -- read, not verified;
    SciLog verifies it on every request."""
    try:
        part = _clean(value).split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except Exception:
        return {}

def describe(value):
    """'Name <email>, 12 groups, valid until 2026-11-14 10:00 (13.9 days)'."""
    c = claims(value)
    who = c.get("name") or "?"
    if c.get("email"):
        who += f" <{c['email']}>"
    out = f"{who}, {len(c.get('roles') or [])} groups"
    if c.get("exp"):
        left = (c["exp"] - time.time()) / 86400
        until = datetime.datetime.fromtimestamp(c["exp"]).strftime("%Y-%m-%d %H:%M")
        out += f", {'valid until' if left > 0 else 'EXPIRED since'} {until}" + (f" ({left:.1f} days)" if left > 0 else "")
    return out

class Reader:
    """Read-only SciLog access with one personal token."""

    def __init__(self, token_value=None, url=URL, timeout=30, session=None):
        if token_value is None:
            token_value, _where = token()
        if not token_value:
            raise TokenError(TOKEN_HELP)
        self.token = _clean(token_value)
        self.url = url.rstrip("/")
        self.timeout = timeout
        if session is None:
            import requests

            session = requests.Session()
        self.session = session
        self._locations = None
        self.identity = describe(self.token).split(",")[0]

    def get(self, path, filt=None):
        params = {"filter": json.dumps(filt)} if filt else None
        r = self.session.get(
            self.url + path, params=params, timeout=self.timeout,
            headers={"Authorization": "Bearer " + self.token, "Accept": "application/json"},
        )
        if r.status_code == 401:
            _functional.clear()  # a beamline-account token: log in again next time
            raise TokenError(
                f"SciLog refused the token ({describe(self.token)}) -- get a new one:\n{TOKEN_STEPS}\n"
                "  3. python -m scilog_viewer --token"
            )
        r.raise_for_status()
        return r.json()

    def me(self):
        return self.get("/users/me")

    def locations(self):
        """{location id: name}."""
        if self._locations is None:
            rows = self.get("/locations", {"fields": {"id": True, "name": True}})
            self._locations = {r["id"]: r.get("name") or "" for r in rows}
        return self._locations

    def logbooks(self, location=None, pgroup=None, name=None):
        """Logbooks you can read, newest activity first, as dicts {id, name,
        pgroup, location, private, touched}; each filter is a case-
        insensitive substring of that field (pgroup: of the owner group)."""
        rows = self.get("/logbooks", {"fields": {
            "id": True, "name": True, "ownerGroup": True, "location": True,
            "isPrivate": True, "touchedAt": True, "updatedAt": True, "deleted": True,
        }})
        locs = self.locations() if rows else {}
        out = []
        for r in rows:
            if r.get("deleted"):
                continue
            lb = {
                "id": r["id"],
                "name": r.get("name") or "",
                # many logbooks have no owner group but the pgroup in their name
                "pgroup": r.get("ownerGroup") or next(iter(re.findall(r"p\d{5}", r.get("name") or "")), ""),
                "location": locs.get(r.get("location"), "") if r.get("location") else "",
                "private": bool(r.get("isPrivate")),
                "touched": r.get("touchedAt") or r.get("updatedAt") or "",
            }
            out.append(lb)
        out.sort(key=lambda lb: lb["touched"], reverse=True)
        return select_logbooks(out, location=location, pgroup=pgroup, name=name)

    def paragraphs(self, logbook_id, after_iso=None, limit=100000):
        """Text posts of one logbook (or of a list of them) created after
        `after_iso`, oldest first, as dicts {id, t, created_at, author,
        tags, text, logbook}."""
        parent = {"inq": list(logbook_id)} if isinstance(logbook_id, (list, tuple, set)) else logbook_id
        where = {"snippetType": "paragraph", "parentId": parent}
        if after_iso:
            where["createdAt"] = {"gt": after_iso}
        out, skip = [], 0
        while len(out) < limit:
            rows = self.get("/basesnippets", {
                "where": where, "order": ["createdAt ASC"], "limit": PAGE, "skip": skip,
                "fields": {"id": True, "createdAt": True, "createdBy": True, "tags": True, "textcontent": True, "deleted": True, "parentId": True},
            })
            out += [p for p in (_record(r) for r in rows if not r.get("deleted")) if p]
            if len(rows) < PAGE:
                break
            skip += PAGE
        return out[:limit]

    #: what post()/around() read of a post: its HTML and attachments too
    POST_FIELDS = {
        "id": True, "createdAt": True, "createdBy": True, "tags": True, "textcontent": True,
        "files": True, "deleted": True, "parentId": True,
    }

    def post(self, post_id):
        """One post as SciLog stores it (HTML in "textcontent", images in
        "files"), for showing it rather than indexing it."""
        return self.get(f"/basesnippets/{_quote(post_id)}")

    def around(self, post, n=3):
        """`post` with the n posts before and after it in its logbook,
        oldest first (raw, as post())."""
        where = {"snippetType": "paragraph", "parentId": post.get("parentId")}

        def side(op, order):
            return self.get("/basesnippets", {
                "where": {**where, "createdAt": {op: post["createdAt"]}},
                "order": [f"createdAt {order}"], "limit": n, "fields": self.POST_FIELDS,
            })

        if not n or not post.get("parentId"):
            return [post]
        rows = side("lt", "DESC")[::-1] + [post] + side("gt", "ASC")
        return [r for r in rows if r is post or not r.get("deleted")]

    def image(self, file_id):
        """(bytes, content type) of an attachment."""
        r = self.session.get(
            f"{self.url}/images/{_quote(file_id)}", timeout=self.timeout,
            headers={"Authorization": "Bearer " + self.token},
        )
        r.raise_for_status()
        return r.content, r.headers.get("content-type", "application/octet-stream")

    # -- writing; SciLog checks every write against the token --

    def _send(self, method, path, **kwargs):
        r = self.session.request(
            method, self.url + path, timeout=self.timeout,
            headers={"Authorization": "Bearer " + self.token, "Accept": "application/json"}, **kwargs,
        )
        if r.status_code == 401:
            _functional.clear()
            raise TokenError(f"SciLog refused the token ({describe(self.token)}) -- get a new one:\n{TOKEN_STEPS}")
        if r.status_code >= 400:
            try:
                detail = r.json().get("error", {}).get("message") or r.text
            except ValueError:
                detail = r.text
            raise PermissionError(f"SciLog: {r.status_code} {detail[:300]}") if r.status_code == 403 else RuntimeError(
                f"SciLog: {r.status_code} {detail[:300]}")
        return r.json() if r.content else None

    def logbook(self, logbook_id):
        """One logbook as SciLog stores it (name, ownerGroup, accessGroups, ACLs)."""
        return self.get(f"/logbooks/{_quote(logbook_id)}")

    def upload_file(self, data, filename, content_type, fields):
        """A new file snippet, as SciLog's editor makes one (POST
        filesnippet/files: the file and its ACL fields); returns it (id,
        accessHash, fileExtension)."""
        # "fields" must be a plain form field: sent as a part with a content
        # type, SciLog ignores it and the file is readable by its uploader only
        return self._send("POST", "/filesnippet/files", files={"file": (filename, data, content_type)},
                          data={"fields": json.dumps(fields)})

    def create_post(self, payload):
        """POST basesnippets: a new post (snippetType/linkType "paragraph")."""
        return self._send("POST", "/basesnippets", json=payload)

    def delete_post(self, post_id):
        """DELETE basesnippets/<id>: SciLog marks the post deleted and moves it
        into the logbook's history (it can be restored there)."""
        return self._send("DELETE", f"/basesnippets/{_quote(post_id)}")

    def file_snippet(self, file_id):
        """GET filesnippet/<id>: an attachment's record (its ACLs among them)."""
        return self.get(f"/filesnippet/{_quote(file_id)}")

    def set_read_acl(self, kind, snippet_id, read_acl):
        """PATCH only readACL ("basesnippets" or "filesnippet"): SciLog treats
        that as sharing, allowed after a post's edit period too."""
        if kind not in ("basesnippets", "filesnippet"):
            raise ValueError(kind)
        return self._send("PATCH", f"/{kind}/{_quote(snippet_id)}", json={"readACL": list(read_acl)})

    # -- tasks (a logbook's to-do list; SciLog lets them be changed at any time) --

    TASK_FIELDS = {"id": True, "parentId": True, "content": True, "isDone": True, "defaultOrder": True,
                   "createdAt": True, "createdBy": True, "updatedAt": True, "updatedBy": True, "deleted": True,
                   "updateACL": True, "deleteACL": True}

    def tasks(self, logbook_id):
        """GET tasks: the logbook's tasks, not deleted ones."""
        rows = self.get("/tasks", {"where": {"parentId": logbook_id}, "fields": self.TASK_FIELDS, "limit": 5000})
        return [r for r in rows if not r.get("deleted")]

    def create_task(self, payload):
        """POST tasks: a new task (snippetType "task", content, isDone)."""
        return self._send("POST", "/tasks", json=payload)

    def update_task(self, task_id, payload):
        """PATCH tasks/<id>: content, isDone or defaultOrder; SciLog applies no edit period to tasks."""
        return self._send("PATCH", f"/tasks/{_quote(task_id)}", json=payload)

    def delete_task(self, task_id):
        """DELETE tasks/<id>: into the logbook's history, as a post."""
        return self._send("DELETE", f"/tasks/{_quote(task_id)}")

    def update_post(self, post_id, payload):
        """PATCH basesnippets/<id>: change a post's textcontent, files, tags."""
        return self._send("PATCH", f"/basesnippets/{_quote(post_id)}", json=payload)

    def views(self, parent_ids):
        """SciLog's views (dashboard layouts) hanging on these logbooks or
        locations, as stored."""
        return self.get("/views", {"where": {"parentId": {"inq": list(parent_ids)}}, "limit": 1000})

    def view(self, view_id):
        return self.get(f"/views/{_quote(view_id)}")

    def update_view(self, view_id, payload):
        """PATCH views/<id> (name, description, configuration)."""
        return self._send("PATCH", f"/views/{_quote(view_id)}", json=payload)

    def delete_view(self, view_id):
        return self._send("DELETE", f"/views/{_quote(view_id)}")

    def file(self, file_id):
        """(bytes, content type, file name) of any attachment."""
        r = self.session.get(
            f"{self.url}/filesnippet/{_quote(file_id)}/files", timeout=self.timeout,
            headers={"Authorization": "Bearer " + self.token},
        )
        r.raise_for_status()
        disposition = r.headers.get("content-disposition", "")
        name = re.search(r'filename="?([^";]+)', disposition)
        return r.content, r.headers.get("content-type", "application/octet-stream"), name.group(1) if name else None

    #: what a comment or a reply's quote (children of a post) is read with
    CHILD_FIELDS = {"id": True, "parentId": True, "linkType": True, "createdAt": True, "createdBy": True,
                    "updatedAt": True, "updatedBy": True, "textcontent": True, "files": True, "tags": True, "deleted": True,
                    "expiresAt": True, "readACL": True, "updateACL": True, "deleteACL": True}
    CHILD_WHERE = {"snippetType": "paragraph", "linkType": {"inq": ["comment", "quote"]}}

    def _post_query(self, children):
        """The fields a post is read with, and the comments and quotes with it."""
        fields = dict(self.POST_FIELDS, updatedAt=True, updatedBy=True, updateACL=True, ownerGroup=True,
                      accessGroups=True, isPrivate=True, defaultOrder=True, expiresAt=True, readACL=True, deleteACL=True)
        extra = {"include": [{"relation": "subsnippets", "scope": {"where": self.CHILD_WHERE, "fields": self.CHILD_FIELDS}}]} if children else {}
        return fields, extra

    def newest_posts(self, logbook_id, n, before=None, children=False):
        """The n newest posts of a logbook, oldest first in the result; with
        `before` (ISO) the n newest of those written no later than that. A long
        logbook is read from its end this way, a piece at a time, so that its
        last day is there while the rest is still coming."""
        where = {"snippetType": "paragraph", "parentId": logbook_id}
        if before:
            # no later than, not before: two posts can carry the same instant, and the piece
            # before ended on one of them. The caller drops the ones it has already.
            where["createdAt"] = {"lte": before}
        fields, extra = self._post_query(children)
        rows = self.get("/basesnippets", {"where": where, "order": ["createdAt DESC"], "limit": n,
                                          "fields": fields, **extra})
        return list(reversed(rows))

    def posts(self, logbook_id, updated_after=None, limit=100000, children=False):
        """Every post of a logbook as SciLog stores it (HTML, files, tags),
        oldest first; with updated_after (ISO) only those created or edited
        since, deleted ones included so they can be removed. With children,
        each post comes with its comments and, for a reply, the copy of what
        it quotes ("subsnippets", linkType "comment" / "quote")."""
        where = {"snippetType": "paragraph", "parentId": logbook_id}
        if updated_after:
            where["updatedAt"] = {"gt": updated_after}
        fields, extra = self._post_query(children)
        out, skip = [], 0
        while len(out) < limit:
            rows = self.get("/basesnippets", {
                "where": where, "order": ["createdAt ASC"], "limit": PAGE, "skip": skip, "fields": fields, **extra,
            })
            out += rows
            if len(rows) < PAGE:
                break
            skip += PAGE
        return out[:limit]

    def children_since(self, updated_after, limit=2000):
        """Comments and reply quotes anywhere (that this token reads)
        created or changed after updated_after (ISO), deleted ones included."""
        return self.get("/basesnippets", {"where": {**self.CHILD_WHERE, "updatedAt": {"gt": updated_after}},
                                          "order": ["updatedAt ASC"], "limit": limit, "fields": self.CHILD_FIELDS})

    def search(self, text, limit=20):
        """SciLog's own search over everything you can read, newest first.
        The server matches one case-insensitive regular expression, so
        word order counts there; several words are therefore searched for
        by the longest one, keeping the posts that contain all of them."""
        words = text.split()
        if len(words) <= 1:
            return self._search(text, limit)
        longest = max(words, key=len)
        found = self._search(re.escape(longest), max(limit * 25, 500))
        want = [w.lower() for w in words]
        return [p for p in found if all(w in p["text"].lower() for w in want)][:limit]

    def _search(self, pattern, limit):
        rows = self.get(f"/basesnippets/search={_quote(pattern)}", {
            "where": {"snippetType": "paragraph"}, "order": ["createdAt DESC"], "limit": limit,
        })
        return [p for p in (_record(r) for r in rows if not r.get("deleted")) if p]

def select_logbooks(logbooks, location=None, pgroup=None, name=None, **_ignored):
    """The ones matching every given filter (case-insensitive substrings)."""
    return [
        lb for lb in logbooks
        if all(
            not want or want.lower() in lb[field].lower()
            for field, want in (("location", location), ("pgroup", pgroup), ("name", name))
        )
    ]

def _quote(text):
    from urllib.parse import quote

    return quote(text, safe="")

def _record(r):
    created = r.get("createdAt")
    if not created:
        return None
    try:
        t = datetime.datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None
    return {
        "id": r.get("id"),
        "t": t,
        "created_at": created,
        "author": r.get("createdBy") or "",
        "tags": list(r.get("tags") or ()),
        "text": html_to_text(r.get("textcontent") or ""),
        "logbook": r.get("parentId") or "",
    }

class _TextOnly(html.parser.HTMLParser):
    # paragraph-level tags become a blank line (= a paragraph for
    # dated_chunks), line-level ones a newline
    _PARAGRAPH = {"p", "div", "h1", "h2", "h3", "h4", "pre", "table"}
    _LINE = {"br", "li", "tr"}
    _HIDDEN = {"style", "script"}

    def __init__(self):
        super().__init__()
        self.parts = []
        self._hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._HIDDEN:
            self._hidden += 1
        elif tag in self._PARAGRAPH:
            self.parts.append("\n\n")
        elif tag in self._LINE:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._HIDDEN:
            self._hidden = max(0, self._hidden - 1)

    def handle_data(self, data):
        if not self._hidden:
            self.parts.append(data)
