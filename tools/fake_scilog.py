"""A stand-in for SciLog's REST API, serving a made-up logbook (scilog_viewer.demo), to try
and test the browser-only viewer (tools/build_web.py) without SciLog.

    python tools/fake_scilog.py [--port 8790] [--demo DIR] [--no-cors]

It answers the requests the viewer makes, as far as the viewer needs them (LoopBack's
filter: where with inq/gt/lt/lte, order, skip, limit, include subsnippets), keeps what is
written in memory, and sends CORS headers as SciLog's own API does (cors() with its
defaults: any origin, no exposed headers) -- or, with --no-cors, none, as the SciLog at
PSI does when another web site asks. Like SciLog it takes the token from an id_token
cookie as well, and "/" is a stand-in for SciLog's own page, logged in (its login in
localStorage.id_token), for the viewer started there from its bookmark (inject.js). It
prints the one token it accepts.
"""

import argparse
import base64
import datetime
import json
import secrets
import sys
import time
from pathlib import Path

import tornado.ioloop
import tornado.web

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scilog_viewer import demo  # noqa: E402

EMAIL = "demo@example.org"
ROLES = ["p00000", "any-authenticated-user"]


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id():
    return f"{int(time.time()):08x}" + secrets.token_hex(8)


def make_token():
    body = json.dumps({"name": "Demo User", "email": EMAIL, "roles": ROLES, "exp": int(time.time()) + 14 * 86400}).encode()
    return "x." + base64.urlsafe_b64encode(body).decode().rstrip("=") + ".y"


class Data:
    def __init__(self, where):
        made = json.loads((Path(where) / "logbook.json").read_text())
        self.where = Path(where)
        self.book = made["logbook"]
        self.snippets = {}
        for post in made["posts"]:
            kids = post.pop("subsnippets", None) or []
            post.setdefault("deleteACL", [self.book.get("ownerGroup", "p00000")])
            self.snippets[post["id"]] = post
            for k in kids:
                self.snippets[k["id"]] = dict(k, parentId=post["id"])
        self.tasks = {t["id"]: t for t in made.get("tasks") or []}
        self.files = {}
        for fid, f in (made.get("files") or {}).items():
            self.files[fid] = {"id": fid, "name": f.get("name"), "type": f.get("type") or "image/png",
                               "path": f.get("path"), "data": None, "readACL": list(self.book.get("readACL") or [])}
        self.views = {}
        vid = new_id()
        self.views[vid] = {"id": vid, "name": "Beamtime overview", "description": "made up", "parentId": self.book["id"],
                           "ownerGroup": "p00000", "configuration": {"widgetConfig": [
                               {"x": 0, "y": 0, "cols": 6, "rows": 4, "config": {"general": {"type": "logbook", "title": "Logbook"},
                                                                                "filter": {"targetId": self.book["id"], "tags": []}}}]}}

    def file_bytes(self, fid):
        f = self.files.get(fid)
        if not f:
            return None
        if f["data"] is not None:
            return f["data"]
        if f["path"]:
            return (self.where / f["path"]).read_bytes()
        if "json" in (f["type"] or ""):
            return json.dumps({"made_up": True, "file": f["name"]}).encode()
        return b""


def matches(doc, where):
    for key, want in (where or {}).items():
        have = doc.get(key)
        if isinstance(want, dict):
            for op, v in want.items():
                if op == "inq" and have not in v:
                    return False
                if op == "gt" and not (have is not None and have > v):
                    return False
                if op == "lt" and not (have is not None and have < v):
                    return False
                if op == "lte" and not (have is not None and have <= v):
                    return False
                if op == "gte" and not (have is not None and have >= v):
                    return False
        elif have != want:
            return False
    return True


def query(docs, filt, data=None):
    rows = [d for d in docs if matches(d, filt.get("where"))]
    for spec in reversed(filt.get("order") or []):
        field, _, direction = spec.partition(" ")
        rows.sort(key=lambda d: d.get(field) or "", reverse=direction.upper() == "DESC")
    skip, limit = int(filt.get("skip") or 0), filt.get("limit")
    rows = rows[skip:skip + int(limit)] if limit else rows[skip:]
    out = [dict(r) for r in rows]
    for inc in filt.get("include") or []:
        if inc.get("relation") == "subsnippets" and data is not None:
            scope = (inc.get("scope") or {}).get("where")
            for r in out:
                r["subsnippets"] = [dict(k) for k in data.snippets.values() if k.get("parentId") == r["id"] and matches(k, scope)]
    return out


class Base(tornado.web.RequestHandler):
    def set_default_headers(self):
        if self.settings.get("cors", True):
            self.set_header("Access-Control-Allow-Origin", "*")

    def options(self, *args):
        if not self.settings.get("cors", True):
            self.set_status(204)
            return self.finish()
        self.set_header("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE")
        self.set_header("Access-Control-Allow-Headers", self.request.headers.get("Access-Control-Request-Headers", ""))
        self.set_status(204)
        self.finish()

    def prepare(self):
        if self.request.method == "OPTIONS":
            return
        given = self.request.headers.get("Authorization") or (f"Bearer {self.get_cookie('id_token')}" if self.get_cookie("id_token") else "")
        if given != f"Bearer {self.settings['token']}":  # as SciLog's cookieToToken: the cookie stands for the header
            self.set_status(401)
            self.finish({"error": {"statusCode": 401, "message": "Authorization header not found or invalid"}})

    @property
    def data(self):
        return self.settings["data"]

    def filt(self):
        return json.loads(self.get_query_argument("filter", "{}") or "{}")

    def body(self):
        return json.loads(self.request.body or b"{}")

    def send(self, value):
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(value))


class Me(Base):
    def get(self):
        self.send({"email": EMAIL, "roles": ROLES})


class Locations(Base):
    def get(self):
        self.send([])


class Logbooks(Base):
    def get(self, lid=None):
        if lid:
            return self.send(self.data.book) if lid == self.data.book["id"] else self.send_error(404)
        self.send(query([self.data.book], self.filt()))


class Snippets(Base):
    def get(self, sid=None):
        if sid:
            doc = self.data.snippets.get(sid)
            return self.send(doc) if doc else self.send_error(404)
        self.send(query(self.data.snippets.values(), self.filt(), self.data))

    def post(self, sid=None):
        b = self.body()
        doc = {"id": new_id(), "createdAt": now(), "updatedAt": now(), "createdBy": EMAIL, "updatedBy": EMAIL, "deleted": False,
               "ownerGroup": self.data.book.get("ownerGroup"), "readACL": list(self.data.book.get("readACL") or []),
               "updateACL": [], "deleteACL": [self.data.book.get("ownerGroup")], "tags": [], "files": [], **b}
        if doc.get("linkType") == "paragraph" and "defaultOrder" not in doc:
            doc["defaultOrder"] = int(time.time() * 1e6)
        self.data.snippets[doc["id"]] = doc
        self.send(doc)

    def patch(self, sid):
        doc = self.data.snippets.get(sid)
        if not doc:
            return self.send_error(404)
        doc.update(self.body(), updatedAt=now(), updatedBy=EMAIL)
        self.set_status(204)
        self.finish()

    def delete(self, sid):
        doc = self.data.snippets.get(sid)
        if not doc:
            return self.send_error(404)
        doc.update(deleted=True, updatedAt=now(), updatedBy=EMAIL)
        self.set_status(204)
        self.finish()


class Images(Base):
    def get(self, fid):
        data = self.data.file_bytes(fid)
        if data is None:
            return self.send_error(404)
        self.set_header("Content-Type", self.data.files[fid]["type"] if self.data.files[fid]["type"].startswith("image/") else "image/png")
        self.finish(data)


class FileSnippet(Base):
    def get(self, fid, files=None):
        f = self.data.files.get(fid)
        if not f:
            return self.send_error(404)
        if files:
            ctype = f["type"]
            ctype = {"file/json": "application/json", "file/html": "text/html"}.get(ctype, ctype if "/" in ctype and not ctype.startswith("file/") else "application/octet-stream")
            self.set_header("Content-Type", ctype)
            self.set_header("Content-Disposition", f'attachment; filename="{f["name"] or fid}"')
            return self.finish(self.data.file_bytes(fid))
        self.send({"id": fid, "readACL": f["readACL"], "fileExtension": f["type"]})

    def patch(self, fid, files=None):
        f = self.data.files.get(fid)
        if not f:
            return self.send_error(404)
        if "readACL" in self.body():
            f["readACL"] = self.body()["readACL"]
        self.set_status(204)
        self.finish()


class Upload(Base):
    def post(self):
        up = (self.request.files.get("file") or [None])[0]
        if not up:
            return self.send_error(400)
        fields = json.loads(self.get_body_argument("fields", "{}"))
        fid = new_id()
        ext = fields.get("fileExtension") or ""
        self.data.files[fid] = {"id": fid, "name": up["filename"], "type": up.get("content_type") or f"file/{ext}",
                                "path": None, "data": up["body"], "readACL": list(self.data.book.get("readACL") or [])}
        self.send({"id": fid, "accessHash": secrets.token_hex(8), "fileExtension": ext})


class Tasks(Base):
    def get(self, tid=None):
        self.send(query(self.data.tasks.values(), self.filt()))

    def post(self, tid=None):
        doc = {"id": new_id(), "createdAt": now(), "updatedAt": now(), "createdBy": EMAIL, "updatedBy": EMAIL, "deleted": False,
               "deleteACL": [self.data.book.get("ownerGroup")], **self.body()}
        self.data.tasks[doc["id"]] = doc
        self.send(doc)

    def patch(self, tid):
        self.data.tasks[tid].update(self.body(), updatedAt=now(), updatedBy=EMAIL)
        self.set_status(204)
        self.finish()

    def delete(self, tid):
        self.data.tasks[tid].update(deleted=True, updatedAt=now())
        self.set_status(204)
        self.finish()


class Views(Base):
    def get(self, vid=None):
        if vid:
            return self.send(self.data.views[vid])
        self.send(query(self.data.views.values(), self.filt()))

    def patch(self, vid):
        self.data.views[vid].update(self.body())
        self.set_status(204)
        self.finish()

    def delete(self, vid):
        self.data.views.pop(vid, None)
        self.set_status(204)
        self.finish()


class Page(tornado.web.RequestHandler):
    """A stand-in for SciLog's own page, logged in: its login where SciLog keeps it."""

    def get(self):
        token = json.dumps(self.settings["token"])
        nonce = ""
        if self.settings.get("page_csp"):
            # as a site may protect its page: only its own scripts, and what they add -- not what is written in
            nonce = secrets.token_hex(8)
            self.set_header("Content-Security-Policy", f"script-src 'nonce-{nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none'")
        self.finish(f"""<!doctype html><html><head><meta charset="utf-8"><title>SciLog</title></head>
<body><h1>SciLog (stand-in)</h1><p id="app">An app of its own runs here.</p>
<script nonce="{nonce}">localStorage.setItem("id_token", {token}); setInterval(() => {{ window.ticks = (window.ticks || 0) + 1; }}, 500);</script>
</body></html>""")


def app(where=None, token=None, cors=True, page_csp=False):
    reader = demo.open_demo(where, quiet=True)  # makes the made-up logbook the first time
    data = Data(reader.where)
    token = token or make_token()
    id_ = r"([0-9a-f]{24})"
    return tornado.web.Application([
        (r"/", Page),
        (r"/api/v1/users/me", Me),
        (r"/api/v1/locations", Locations),
        (r"/api/v1/logbooks/?" + f"{id_}?", Logbooks),
        (r"/api/v1/basesnippets/?" + f"{id_}?", Snippets),
        (rf"/api/v1/images/{id_}", Images),
        (r"/api/v1/filesnippet/files", Upload),
        (rf"/api/v1/filesnippet/{id_}(/files)?", FileSnippet),
        (r"/api/v1/tasks/?" + f"{id_}?", Tasks),
        (r"/api/v1/views/?" + f"{id_}?", Views),
    ], data=data, token=token, cors=cors, page_csp=page_csp), token


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--demo", default=None, metavar="DIR", help="the made-up logbook's folder (made if missing)")
    parser.add_argument("--no-cors", action="store_true", help="no CORS headers: another web site may not read the answers")
    parser.add_argument("--page-csp", action="store_true", help="the page at / with a strict script policy (nonce, strict-dynamic)")
    args = parser.parse_args()
    application, token = app(args.demo, cors=not args.no_cors, page_csp=args.page_csp)
    application.listen(args.port, "127.0.0.1")
    print(f"fake SciLog API: http://localhost:{args.port}/api/v1", flush=True)
    print(f"token: {token}", flush=True)
    tornado.ioloop.IOLoop.current().start()
