"""Headless WebKitGTK (Safari engine) check of the computer page's phase 4 scripts (run under xvfb-run; no window on a real screen)."""
import gi, json, sys, threading, time, os, http.server, socketserver
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2

ROOT = sys.argv[1]


class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def translate_path(self, path):
        p = path.split('?')[0].split('#')[0]
        if p in ('/pc.html', '/doc.html'):
            p = '/work/remote_pc_webkit/harness.html'
        return os.path.join(ROOT, p.lstrip('/'))


srv = socketserver.TCPServer(('127.0.0.1', 0), H)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{PORT}'

views, results = [], []


def on_close(view):
    if view in views:
        views.remove(view)
    view.get_parent().destroy()


def make(related=None):
    v = WebKit2.WebView.new_with_related_view(related) if related else WebKit2.WebView()
    v.get_settings().set_javascript_can_open_windows_automatically(True)
    w = Gtk.OffscreenWindow()
    w.add(v)
    w.set_default_size(1000, 700)
    w.show_all()
    v.connect('create', lambda view, action: make(view))
    v.connect('close', on_close)
    views.append(v)
    return v


def spin(sec):
    end = time.time() + sec
    while time.time() < end:
        Gtk.main_iteration_do(False)
        time.sleep(0.01)


def js(v, expr):
    res = {}

    def cb(view, r, _):
        try:
            res['v'] = json.loads(view.evaluate_javascript_finish(r).to_json(0) or 'null')
        except Exception as e:  # noqa
            res['e'] = str(e)

    v.evaluate_javascript('(() => { try { return (' + expr + '); } catch (e) { return "ERR " + e; } })()', -1, None, None, None, cb, None)
    end = time.time() + 10
    while not res and time.time() < end:
        Gtk.main_iteration_do(False)
        time.sleep(0.005)
    return res.get('v', 'ERR ' + res.get('e', 'timeout'))


def wait(v, expr, sec, what):
    end = time.time() + sec
    while time.time() < end:
        if js(v, '!!(' + expr + ')') is True:
            return True
        spin(0.1)
    raise AssertionError('timed out: ' + what + ' | ' + str(js(v, 'location.href + " " + JSON.stringify(window.__errors)')))


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else ' -- ' + str(detail)), flush=True)


OPEN = "JSON.stringify(AIBRemoteWindows.handle({ op: 'open', from: AibWindow.id(), project: { key: 'p1', name: 'P', path: '/x' } }))"

main = make()
main.load_uri(BASE + '/pc.html')
wait(main, "window.AIBRemote && document.documentElement.dataset.seeding !== '1' && window.AibWindow", 20, 'main page')
spin(1)
check('scripts run in WebKit', js(main, 'window.__errors.length') == 0, js(main, 'JSON.stringify(window.__errors)'))
check('routing on (AibWindow.canRoute)', js(main, 'AibWindow.canRoute() && AibWindow.app()') is True)
me = js(main, 'AibWindow.id()')
check('tab id', isinstance(me, str) and me.startswith('t-'), me)
# ---- windows: one per project, the roster over BroadcastChannel, a window closes only itself ----
r = json.loads(js(main, OPEN))
check('open a project window (window.open)', r['status'] == 200 and r['body']['existed'] is False, r)
check('a second window exists', len(views) == 2, len(views))
child = views[-1] if len(views) > 1 else None
if child:
    wait(child, "window.AIBRemoteWindows && window.AibWindow && document.documentElement.dataset.seeding !== '1'", 20, 'child page')
    check('child is the project window', js(child, "AibWindow.context().kind + ':' + AibWindow.context().project") == 'project:p1',
          js(child, 'location.href'))
    check("child's copied sessionStorage cleaned", js(child, "sessionStorage.getItem('aib-chat-popouts')") is None)
    spin(4)  # heartbeats both ways
    check('roster filled over BroadcastChannel', js(main, 'AIBRemoteWindows._roster().some((e) => e.nonce)') is True,
          js(main, 'JSON.stringify(AIBRemoteWindows._roster())'))
    check('child sees the main window', js(child, "AibWindow.others().some((w) => w.kind === 'main')") is True)
r = json.loads(js(main, OPEN))
check('same project again: existed, no new window', r['body'].get('existed') is True and len(views) == 2, (r, len(views)))
r = json.loads(js(main, "JSON.stringify(AIBRemoteWindows.handle({ op: 'close', from: AibWindow.id(), w: AibWindow.others()[0].w }))"))
check('a window closes only itself', r['status'] == 403, r)
if child:
    js(child, "AIBRemoteWindows.handle({ op: 'close', from: AibWindow.id(), w: AibWindow.id() }).status")
    spin(2.5)
    check('closed window leaves the roster', js(main, 'AibWindow.others().length') == 0, js(main, 'JSON.stringify(AIBRemoteWindows._roster())'))
# ---- offline ----
js(main, "(window.__mode = 'unreachable', fetch('/api/live/state').catch(() => 0), 1)")
wait(main, "document.getElementById('remoteOffline')", 8, 'offline bar')
bar = js(main, "document.getElementById('remoteOffline').textContent")
check('offline bar text', bar == "Can't reach DESK. Trying again…Try now", bar)
check('offline mark', js(main, "document.documentElement.hasAttribute('data-remote-offline')") is True)
js(main, "(window.__r = null, fetch('/api/live/prompt', { method: 'POST', body: '{}' }).then(async (r) => window.__r = [r.status, (await r.json()).error]), 1)")
wait(main, 'window.__r', 5, 'refusal')
check('send refused offline, nothing sent',
      js(main, "window.__r[0] === 503 && window.__r[1].endsWith('Nothing was sent.') && window.__posts.indexOf('/api/live/prompt') < 0") is True,
      js(main, 'JSON.stringify(window.__r)'))
check('Send looks unavailable', js(main, "getComputedStyle(document.getElementById('send')).pointerEvents") == 'none')
js(main, "(window.__mode = 'down', document.querySelector('#remoteOffline .remote-offline-try').click(), 1)")
wait(main, "document.getElementById('remoteOffline').textContent.includes('is not answering')", 5, 'down wording')
check('AIB not answering wording (first 20 s of a 502)', True)
js(main, "(window.__mode = 'up', document.querySelector('#remoteOffline .remote-offline-try').click(), 1)")
wait(main, "!document.getElementById('remoteOffline') && !document.documentElement.hasAttribute('data-remote-offline')", 5, 'back online')
check('back online: bar gone', True)
check('no page errors', js(main, 'window.__errors.length') == 0, js(main, 'JSON.stringify(window.__errors)'))
print('WEBKIT', WebKit2.get_major_version(), WebKit2.get_minor_version(), WebKit2.get_micro_version(), 'UA', js(main, 'navigator.userAgent'))
srv.shutdown()
sys.exit(0 if all(ok for _, ok in results) else 1)
