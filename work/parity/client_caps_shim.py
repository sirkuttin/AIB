"""Plain-data wrapper around client_caps.ClientCaps.call for the Deno parity tests (work/deno/client_caps_test.ts).

call(workspace, terminal, fs, method, params) builds a fresh ClientCaps, makes one call, shuts it down (killing anything it started)
and returns {"ok": result} or {"error": "CapError", "code": n, "message": text}."""
import client_caps


def call(workspace, terminal, fs, method, params):
    caps = client_caps.ClientCaps(workspace, terminal, fs)
    try:
        return {'ok': caps.call(method, params)}
    except client_caps.CapError as error:
        return {'error': 'CapError', 'code': error.code, 'message': str(error)}
    finally:
        caps.shutdown()
