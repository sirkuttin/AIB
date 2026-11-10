"""Plain-data wrappers around Python server functions whose real arguments are objects (a request handler, a Gate), so
work/deno parity tests can call them through py_call.py. Each returns JSON-friendly values only."""
import types

import security


class _Headers(dict):
    """Case-insensitive get(), like http.client's message headers."""
    def get(self, name, default=None):
        for key, value in self.items():
            if key.lower() == str(name).lower():
                return value
        return default


def authorize(method, path, headers, scope, port, token, names=None, origins=(), artifact_ports=(), conversation_id=None):
    """security.authorize for a request described as plain data. Returns {'ok': kind} or {'refused': reason, 'status', 'message'}."""
    gate = security.Gate(port, lambda: token, names=names, origins=list(origins), artifact_ports=list(artifact_ports))
    handler = types.SimpleNamespace(server=types.SimpleNamespace(gate=gate), headers=_Headers(headers), command=method, path=path)
    result = security.authorize(handler, scope, conversation_id)
    if result:
        return {'ok': result.kind}
    return {'refused': result.reason, 'status': result.status, 'message': result.message(path)}


def gate_sets(port, names=None, origins=(), artifact_ports=()):
    gate = security.Gate(port, lambda: 't', names=names, origins=list(origins), artifact_ports=list(artifact_ports))
    return {'names': list(gate.names), 'hosts': sorted(gate.hosts()), 'origins': sorted(gate.origins())}


def scope_for(entries, method, path):
    table = security.RouteTable()
    for m, p, s in entries:
        table.add(m, p, s)
    return table.scope_for(method, path)


def studio_routes():
    """Every (method, path, scope) of the Python web server's route table (studio.ROUTES), sorted."""
    import studio
    return sorted([m, p, s] for (m, p), s in studio.ROUTES.scopes.items())


def studio_route_kinds():
    """(method, path, kind) of Studio's own routes: 'get', 'body', 'bare' or 'own-gate' (web_handler.route_specs)."""
    import studio
    return sorted([r.method, r.path, r.kind] for r in studio.ROUTE_SET.entries.values())


def live_post_ops():
    """Studio.LIVE_POST_OPS, sorted."""
    import studio
    return sorted(studio.Studio.LIVE_POST_OPS)
