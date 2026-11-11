"""Errors and sign-in descriptions from the agent's JSON-RPC replies."""
import json
import re



class RpcError(RuntimeError):
    """A JSON-RPC error response from the agent, keeping its code and data."""
    def __init__(self, error):
        error = error if isinstance(error, dict) else {'message': str(error)}
        super().__init__(str(error.get('message') or error))
        self.code, self.data = error.get('code'), error.get('data')


_AUTH_WORDS = re.compile(r'auth|log.?in|sign.?in|credential', re.I)


def is_auth_required(error):
    """ACP reports missing authentication as code -32000 (auth_required)."""
    if not isinstance(error, RpcError):
        return False
    text = f'{error} {json.dumps(error.data, default=str) if error.data is not None else ""}'
    return (error.code == -32000 and bool(_AUTH_WORDS.search(text))) or 'auth_required' in text


def describe_auth_methods(methods, provider=''):
    """Normalize initialize.authMethods. kind 'agent' = the client can call authenticate;
    anything else is shown as instructions and never executed by Studio."""
    out = []
    clip = lambda v, n=500: v[:n] if isinstance(v, str) else ''
    for item in methods[:20] if isinstance(methods, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id'] or len(item['id']) > 256:
            continue
        meta = item.get('_meta') if isinstance(item.get('_meta'), dict) else {}
        term = meta.get('terminal-auth') if isinstance(meta.get('terminal-auth'), dict) else None
        kind, instructions, mtype = 'agent', '', item.get('type')
        if term is not None or mtype == 'terminal':
            kind = 'terminal'
            src = term if term is not None else item
            args = src.get('args') if isinstance(src.get('args'), list) else []
            parts = ([src['command']] if isinstance(src.get('command'), str) else []) + [a for a in args if isinstance(a, str)]
            command = clip(' '.join(parts[:20]), 300)
            if command:
                instructions = f'Run `{command}` in a terminal, complete the sign-in, then choose Retry.'
            elif provider == 'claude':
                instructions = 'Run `claude /login` in a terminal, complete the sign-in, then choose Retry.'
            else:
                instructions = "Complete this sign-in in the agent's own command-line tool, then choose Retry."
        elif mtype == 'env_var':
            kind = 'env_var'
            raw = item.get('vars') if isinstance(item.get('vars'), list) else []
            names = [v.get('name') for v in raw if isinstance(v, dict) and isinstance(v.get('name'), str)]
            instructions = ('Set ' + ', '.join(f'`{clip(n, 80)}`' for n in names[:10]) + ' in the environment that starts the agent, restart AIB, then retry. AIB never asks for secrets.') if names else 'Configure the credentials this agent documents, restart AIB, then retry.'
        elif isinstance(mtype, str) and mtype != 'agent':
            kind, instructions = 'other', "This sign-in type is not supported inside AIB. Complete it with the agent's own tools, then choose Retry."
        out.append({'id': item['id'], 'name': clip(item.get('name')) or item['id'], 'description': clip(item.get('description'), 1000), 'kind': kind, 'instructions': instructions})
    return out

class PromptStateUnknown(ValueError):
    """A retried prompt whose delivery could not be confirmed after a Studio restart."""
