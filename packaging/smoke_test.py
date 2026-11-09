"""Start a built program, check that it serves the viewer's page, stop it.
Without a token the page must still load (it then asks for one)."""

import os
import re
import subprocess
import sys
import time
import http.cookiejar
import urllib.request

exe = os.path.abspath(sys.argv[1])
env = dict(os.environ, SCILOG_VIEWER_HOME=os.path.abspath("smoke-home"), HOME=os.path.abspath("smoke-home"))
p = subprocess.Popen([exe, "--no-browser", "--port", "8799"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
url, out = None, []
t0 = time.time()
while time.time() - t0 < 90 and url is None:
    line = p.stdout.readline()
    if not line:
        time.sleep(0.2)
        continue
    out.append(line)
    m = re.search(r"(http://localhost:\d+/\?token=\S+)", line)
    if m:
        url = m.group(1)
try:
    if url is None:
        sys.exit("no address printed:\n" + "".join(out))
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    page = opener.open(url, timeout=20).read().decode()
    assert "SciLog viewer" in page and "app.js" in page, page[:300]
    status = opener.open(url.split("?")[0] + "api/token", timeout=20).read().decode()
    assert '"ok": false' in status or '"ok":false' in status, status
    print("ok:", url.split("?")[0], status)
finally:
    p.terminate()
    try:
        p.wait(10)
    except subprocess.TimeoutExpired:
        p.kill()
