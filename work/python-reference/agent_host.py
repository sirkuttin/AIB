#!/usr/bin/env python3
"""Agent Studio agent host: the long-lived process that owns every ACP adapter, so the web server can be restarted.

Normally started for you by studio.py (detached); run it by hand only to debug. It listens on a random
127.0.0.1 port and publishes the port and a random token in <state-dir>/agent-host.json (readable by your user only).
Stop it with: python studio.py --stop-host. See docs/agent-host.md.
"""
import argparse
import http.server
import json
import logging
import os
import pathlib
import secrets
import signal
import socketserver
import sys
import threading
import time

from app_paths import APP_ROOT
import host_client
import log_setup
import security
import state_paths
import studio
from ownership import OwnershipConflict, SessionLease

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())   # a library logger: quiet until main() configures logging (log_setup.py)

HERE = APP_ROOT


def migrate_in_process_recovery(store):
    """One-time carry-over when switching from the single-process server to the host.

    The single-process server kept "Was open in Studio before restart" records and prompt receipts in
    studio-recovery-<port>.json; the host uses studio-recovery-host.json. Without this, the first switch
    would silently drop the conversations the user still needs to reconnect. Each old file is merged once
    (receipts still marked working load as unknown, as after any restart) and renamed *.migrated.
    """
    if store is None:
        return
    from state_store import StateStore
    for legacy in sorted(store.directory.glob('studio-recovery-*.json')):
        name = legacy.stem[len('studio-'):]
        if name == 'recovery-host':
            continue
        old = StateStore(store.directory, name)
        for key, record in old.conversations.items():
            store.conversations.setdefault(key, record)
        for key, receipts in old.receipts.items():
            merged = store.receipts.setdefault(key, {})
            for message_id, receipt in receipts.items():
                merged.setdefault(message_id, receipt)
        store.save()
        if not store.warning:  # only retire the old file once the merge is safely on disk
            try:
                legacy.replace(legacy.with_name(legacy.name + '.migrated'))
            except OSError:
                pass


class AgentHost:
    ATTACH_FRESH_SECONDS = 45  # a web server that has not called in this long is not "attached"

    def __init__(self, options, idle_exit_minutes=30, host_port=0):
        self.options = options
        self.studio = studio.Studio(options, port='host')
        migrate_in_process_recovery(self.studio.store)
        self.token = secrets.token_urlsafe(32)
        self.started_at = time.time()
        self.idle_exit_seconds = max(0.0, float(idle_exit_minutes)) * 60
        self.web = {}            # web server instance id -> {pid, port, seen}
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.idle_since = None
        self.lease = None
        self.httpd = None
        self.host_port = host_port
        self.studio.artifact_url_provider = self.web_url   # artifact tool (agent C)
        self.ops = {'info': self.op_info, 'attach': self.op_attach, 'detach': self.op_detach, 'list': lambda a: self.studio.live_list(),
                    'state': lambda a: self.studio.live_state(a['id'], a.get('after', 0)),
                    'live': lambda a: list(self.studio.live_call(a['name'], a.get('body'))),
                    'ownership': lambda a: self.studio.ownership_query(a.get('provider') or '', a.get('id') or '', a.get('cwd') or ''),
                    'artifact': lambda a: self.studio.emit_artifact(a['conversationId'], a['data']),
                    'writes': lambda a: self.studio.live_writes(),
                    'install': lambda a: list(self.studio.install_call(a['action'], a.get('agent'))),   # protocol 3: the agent install job runs here
                    'signin': lambda a: list(self.studio.signin_call(a['action'], a.get('agent') or '', a.get('force'))),   # protocol 4: the sign-in check and Sign in job run here
                    'busy': lambda a: {'busy': self.studio.busy_connections()},
                    'stop': self.op_stop}

    # ---- operations ---------------------------------------------------------------------------
    def web_attached(self):
        now = time.time()
        with self.lock:
            for key in [k for k, v in self.web.items() if now - v['seen'] > self.ATTACH_FRESH_SECONDS]:
                del self.web[key]
            return len(self.web)

    def web_url(self):
        """Artifact tool (agent C): base URL of the most recently attached web server, or '' (the tool then reads artifact-web.json)."""
        with self.lock:
            fresh = [v for v in self.web.values() if isinstance(v.get('port'), int) and v['port'] and time.time() - v['seen'] <= self.ATTACH_FRESH_SECONDS]
        fresh.sort(key=lambda v: v['seen'], reverse=True)
        return f'http://127.0.0.1:{fresh[0]["port"]}' if fresh else ''

    def op_info(self, args):
        info = self.studio.live_info()
        busy = self.studio.busy_connections()
        options = self.options
        return dict(info, format=host_client.HOST_FORMAT, protocol=host_client.PROTOCOL_VERSION, hostId=info['instanceId'], startedAt=self.started_at,
                    stateDir=str(self.studio.state_dir), codeRoot=host_client.CODE_ROOT, sourceHash=host_client.SOURCE_HASH, appId=host_client.APP_ID, version=host_client.APP_VERSION, open=len(info['connections']), active=busy, webAttached=self.web_attached(),
                    idleExitMinutes=self.idle_exit_seconds / 60,
                    startedWith={'ompCommand': getattr(options, 'omp_command', None), 'nodeCommand': getattr(options, 'node_command', None),
                                 'claudeLauncher': getattr(options, 'claude_launcher', None), 'ownersDir': str(options.owners_dir) if getattr(options, 'owners_dir', None) else None,
                                 'autoReconnect': bool(self.studio.auto_reconnect), 'enableClientTerminal': bool(getattr(options, 'enable_client_terminal', False)), 'enableClientFs': getattr(options, 'enable_client_fs', None),
                                 'mcpServers': len(getattr(options, 'mcp_servers', None) or [])})

    def op_attach(self, args):
        with self.lock:
            self.web[str(args.get('webInstanceId') or args.get('pid'))] = {'pid': args.get('pid'), 'port': args.get('port'), 'seen': time.time()}
        return {'attached': True, 'webServers': self.web_attached()}

    def op_detach(self, args):
        with self.lock:
            self.web.pop(str(args.get('webInstanceId') or args.get('pid')), None)
        return {'detached': True}

    def op_stop(self, args):
        busy = self.studio.busy_connections()
        if busy and not args.get('force'):
            names = '; '.join(f'{b["provider"]} in {b["cwd"]} ({b["state"]})' for b in busy)
            return {'stopping': False, 'active': busy, 'message': f'Refusing to stop the agent host: {len(busy)} conversation(s) are working, opening or waiting for you: {names}. Use --force to stop anyway.'}
        self.stop_event.set()
        return {'stopping': True, 'forced': bool(busy), 'active': busy}

    # ---- serving ------------------------------------------------------------------------------
    def make_handler(self):
        host = self

        class Handler(security.BodyDrainMixin, http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, status, payload):
                data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(data)

            def allowed(self):
                port = self.server.server_port
                return (self.client_address[0] in ('127.0.0.1', '::1', '::ffff:127.0.0.1')
                        and self.headers.get('Host') in (f'127.0.0.1:{port}', f'localhost:{port}')
                        and self.headers.get('Origin') is None and self.headers.get('Sec-Fetch-Site') is None
                        and security.token_matches(self.headers.get(host_client.TOKEN_HEADER, ''), host.token))

            def do_GET(self):
                self.reply(405, {'error': 'POST /rpc only'})

            def do_POST(self):
                if not self.allowed():
                    return self.reply(403, {'error': 'Forbidden'})
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= host_client.MAX_RPC_BYTES or self.path != '/rpc':
                        return self.reply(400, {'error': 'Invalid request', 'errorType': 'ValueError'})
                    request = json.loads(self.rfile.read(length))
                    operation = host.ops.get(request.get('op')) if isinstance(request, dict) else None
                    if operation is None:
                        return self.reply(404, {'error': 'Unknown operation'})
                    args = request.get('args')
                    self.reply(200, {'result': operation(args if isinstance(args, dict) else {})})
                except (KeyError, ValueError, TypeError, OSError, RuntimeError, TimeoutError) as error:
                    self.reply(400, {'error': str(error), 'errorType': type(error).__name__})
                except Exception as error:  # a bug here must not kill the host
                    log.exception('Host RPC failed')
                    self.reply(500, {'error': f'{type(error).__name__}: {error}', 'errorType': 'RuntimeError'})

        return Handler

    def start(self):
        state_dir = self.studio.state_dir
        state_dir.mkdir(parents=True, exist_ok=True)
        self.lease = SessionLease(state_dir, 'agent-host', 'singleton').acquire()  # one host per state dir; released if we die
        class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True
            allow_reuse_address = False
        self.httpd = Server(('127.0.0.1', self.host_port), self.make_handler())
        threading.Thread(target=self.httpd.serve_forever, daemon=True, name='agent-host-rpc').start()
        host_client.write_info(state_dir, {'format': host_client.HOST_FORMAT, 'protocol': host_client.PROTOCOL_VERSION, 'pid': os.getpid(), 'port': self.httpd.server_port,
                                           'token': self.token, 'hostId': self.studio.instance_id, 'startedAt': self.started_at,
                                           'codeRoot': host_client.CODE_ROOT, 'sourceHash': host_client.SOURCE_HASH,
                                           'appId': host_client.APP_ID, 'version': host_client.APP_VERSION})
        self.studio.start_auto_reconnect()  # chats that were open before the restart; nothing is sent
        return self.httpd.server_port

    def idle_check(self):
        """True when the host should exit: no open conversations and no web server for the whole idle period."""
        if not self.idle_exit_seconds:
            return False
        if self.studio.live_info()['connections'] or self.web_attached():
            self.idle_since = None
            return False
        self.idle_since = self.idle_since or time.time()
        return time.time() - self.idle_since >= self.idle_exit_seconds

    def run(self):
        log, checked = host_client.log_path(self.studio.state_dir), 0.0
        while not self.stop_event.wait(2.0):
            if time.time() - checked > 60:   # the log is held open by this process, so rotate it by copy-and-truncate
                checked = time.time()
                host_client.rotate_log(log, copy_truncate=True)
            if self.idle_check():
                print('Agent host: idle with no conversations and no web server; exiting.', flush=True)
                break
        self.shutdown()

    def shutdown(self):
        host_client.remove_info(self.studio.state_dir, os.getpid())  # first, so web servers see a stop and not a crash
        time.sleep(0.2)  # let the reply to a stop request leave
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
        self.studio.close()
        if self.lease:
            self.lease.release()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    studio.add_agent_arguments(parser)
    log_setup.add_arguments(parser)
    parser.add_argument('--host-port', type=int, default=0, help='Loopback port for the host RPC (default: a random free port, published in the host file)')
    parser.add_argument('--idle-exit-minutes', type=float, default=30, help='Exit after this long with no open conversations and no web server attached (default 30; 0 = never)')
    options = parser.parse_args(argv)
    studio.finish_agent_options(options, parser)
    state_paths.apply(options, parser, HERE, attempt_migration=False)   # normally --state-dir is given by the web server
    # stderr only: the web server starts the host with stderr going to <state>/agent-host.log, which host_client rotates, so a
    # second handle on that file would fight the rotation.
    log_setup.setup('agent-host', level=options.log_level)
    host = AgentHost(options, options.idle_exit_minutes, options.host_port)
    log_setup.register_secret(host.token)
    try:
        port = host.start()
    except OwnershipConflict:
        print('Agent host: another host already runs for this state dir; exiting.', flush=True)
        return 0
    except OSError as error:
        print(f'Agent host: could not start: {error}', file=sys.stderr, flush=True)
        return 1
    for name in ('SIGINT', 'SIGTERM', 'SIGBREAK'):
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), lambda *_: host.stop_event.set())
            except (ValueError, OSError):
                pass
    print(f'Agent host {os.getpid()} protocol {host_client.PROTOCOL_VERSION} on 127.0.0.1:{port}, state {host.studio.state_dir}', flush=True)
    host.run()
    print('Agent host stopped.', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
