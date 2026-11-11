"""Scripted ACP agent for the README screenshots (work/demo-studio/readme_shots.py). No model calls; standard library only.

    python showcase_agent.py <claude|codex|opencode> [acp]

Each turn is picked by a phrase in the person's message (see SCENES): the agent streams realistic tool calls, plans, diffs and
subagents for that task, writes real files in the chat's folder, and may ask for approval or a question. A turn that is meant
to stay "Working" for a screenshot holds until the file <SHOWCASE_GATES>/<scene>.go exists (or the person presses Stop).
Anything else gets a short plain answer.
"""
import json
import os
import pathlib
import sys
import threading
import time

ROLE = (sys.argv[1] if len(sys.argv) > 1 else 'claude').lower()
GATES = pathlib.Path(os.environ.get('SHOWCASE_GATES') or '.')
PACE = float(os.environ.get('SHOWCASE_PACE') or 0.35)   # seconds between streamed steps

# ---- what each agent says about itself (shapes the real adapters use) -----------------------------------------------------
if ROLE == 'codex':
    MODES = {'currentModeId': 'auto', 'availableModes': [
        {'id': 'read-only', 'name': 'Read Only', 'description': 'Reads files; asks before any edit or command'},
        {'id': 'auto', 'name': 'Auto', 'description': 'Edits and runs commands in the workspace; asks for anything outside it'},
        {'id': 'full-access', 'name': 'Full Access', 'description': 'Edits and runs anything without asking'}]}
    CONFIG = [
        {'id': 'model', 'name': 'Model', 'category': 'model', 'type': 'select', 'currentValue': 'gpt-5-codex', 'options': [
            {'value': 'gpt-5-codex', 'name': 'gpt-5-codex', 'description': 'Tuned for coding'},
            {'value': 'gpt-5', 'name': 'gpt-5', 'description': 'General reasoning'}]},
        {'id': 'reasoning_effort', 'name': 'Effort', 'category': 'thought_level', 'type': 'select', 'currentValue': 'medium', 'options': [
            {'value': 'low', 'name': 'Low'}, {'value': 'medium', 'name': 'Medium'}, {'value': 'high', 'name': 'High'}]}]
    COMMANDS = [{'name': 'review', 'description': 'Review the current changes'}, {'name': 'init', 'description': 'Create an AGENTS.md'},
                {'name': 'compact', 'description': 'Summarise the conversation to save context'}]
elif ROLE == 'opencode':
    MODES = {'currentModeId': 'build', 'availableModes': [
        {'id': 'build', 'name': 'Build', 'description': 'Full tool access'},
        {'id': 'plan', 'name': 'Plan', 'description': 'Read-only: analyses and plans'}]}
    CONFIG = [{'id': 'model', 'name': 'Model', 'category': 'model', 'type': 'select', 'currentValue': 'sonnet', 'options': [
        {'value': 'sonnet', 'name': 'anthropic/claude-sonnet-4-5'}, {'value': 'gpt5', 'name': 'openai/gpt-5'}]}]
    COMMANDS = [{'name': 'init', 'description': 'Create AGENTS.md'}, {'name': 'compact', 'description': 'Compact the session'}]
else:
    MODES = {'currentModeId': 'default', 'availableModes': [
        {'id': 'default', 'name': 'Default', 'description': 'Asks before edits and commands'},
        {'id': 'acceptEdits', 'name': 'Accept Edits', 'description': 'Edits files without asking'},
        {'id': 'plan', 'name': 'Plan Mode', 'description': 'Plans without making changes'},
        {'id': 'bypassPermissions', 'name': 'Bypass Permissions', 'description': 'Runs everything without asking'}]}
    CONFIG = [{'id': 'model', 'name': 'Model', 'category': 'model', 'type': 'select', 'currentValue': 'default', 'options': [
        {'value': 'default', 'name': 'Default (recommended)', 'description': 'Sonnet for everyday work'},
        {'value': 'opus', 'name': 'Opus', 'description': 'For the hardest tasks'},
        {'value': 'haiku', 'name': 'Haiku', 'description': 'Fastest'}]}]
    COMMANDS = [{'name': 'review', 'description': 'Review a pull request'}, {'name': 'compact', 'description': 'Clear history but keep a summary'},
                {'name': 'init', 'description': 'Write a CLAUDE.md for this codebase'}]

lock = threading.Lock()
session = {'id': 'session', 'cwd': os.getcwd()}
turn = {'key': None}
answers = {}        # our request id -> threading.Event, with the reply stored in replies
replies = {}
counter = [0]


def emit(value):
    with lock:
        print(json.dumps(dict(jsonrpc='2.0', **value)), flush=True)


def update(body):
    emit({'method': 'session/update', 'params': {'sessionId': session['id'], 'update': body}})


def say(text):
    update({'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': text}})


def think(text):
    update({'sessionUpdate': 'agent_thought_chunk', 'content': {'type': 'text', 'text': text}})


def stream(text, pieces=6):
    """Say text in a few chunks, like a model streaming."""
    step = max(1, len(text) // pieces)
    for start in range(0, len(text), step):
        say(text[start:start + step])
        time.sleep(PACE / 3)


def pause(factor=1.0):
    time.sleep(PACE * factor)


def tool_id(name):
    counter[0] += 1
    return f'{name}-{counter[0]}'


def path_in(rel):
    return str(pathlib.Path(session['cwd']) / rel)


def read(rel, title=None, text=''):
    call = tool_id('read')
    update({'sessionUpdate': 'tool_call', 'toolCallId': call, 'title': title or f'Read {rel}', 'kind': 'read', 'status': 'pending',
            'locations': [{'path': path_in(rel)}], 'rawInput': {'file_path': path_in(rel)}})
    pause(0.5)
    if not text:
        try:
            text = pathlib.Path(path_in(rel)).read_text(encoding='utf-8')
        except OSError:
            text = ''
    update({'sessionUpdate': 'tool_call_update', 'toolCallId': call, 'status': 'completed',
            'content': [{'type': 'content', 'content': {'type': 'text', 'text': text}}]})


def search(pattern, found):
    call = tool_id('grep')
    update({'sessionUpdate': 'tool_call', 'toolCallId': call, 'title': f'grep "{pattern}"', 'kind': 'search', 'status': 'in_progress',
            'rawInput': {'pattern': pattern, 'path': session['cwd']}})
    pause(0.5)
    update({'sessionUpdate': 'tool_call_update', 'toolCallId': call, 'status': 'completed',
            'content': [{'type': 'content', 'content': {'type': 'text', 'text': found}}]})


def write(rel, new, old=None):
    """Write a real file in the chat's folder and report it as an edit with its diff."""
    target = pathlib.Path(path_in(rel))
    if old is None and target.exists():
        old = target.read_text(encoding='utf-8')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(new, encoding='utf-8', newline='\n')
    call = tool_id('edit')
    update({'sessionUpdate': 'tool_call', 'toolCallId': call, 'title': ('Edit ' if old else 'Write ') + rel, 'kind': 'edit', 'status': 'completed',
            'locations': [{'path': str(target)}], 'content': [{'type': 'diff', 'path': str(target), 'oldText': old, 'newText': new}]})


def replace(rel, old_part, new_part):
    target = pathlib.Path(path_in(rel))
    text = target.read_text(encoding='utf-8')
    target.write_text(text.replace(old_part, new_part, 1), encoding='utf-8', newline='\n')
    call = tool_id('edit')
    update({'sessionUpdate': 'tool_call', 'toolCallId': call, 'title': 'Edit ' + rel, 'kind': 'edit', 'status': 'completed',
            'locations': [{'path': str(target)}], 'content': [{'type': 'diff', 'path': str(target), 'oldText': old_part, 'newText': new_part}]})


def run(command, description, output, status='completed', call=None):
    call = call or tool_id('bash')
    update({'sessionUpdate': 'tool_call', 'toolCallId': call, 'title': command, 'kind': 'execute', 'status': 'in_progress',
            'rawInput': {'command': command, 'description': description}})
    if status == 'in_progress':
        return call
    pause(1.2)
    update({'sessionUpdate': 'tool_call_update', 'toolCallId': call, 'status': status, 'rawOutput': output,
            'content': [{'type': 'content', 'content': {'type': 'text', 'text': output}}]})
    return call


def plan(entries):
    update({'sessionUpdate': 'plan', 'entries': [{'content': c, 'priority': 'medium', 'status': s} for c, s in entries]})


def subagent(child, title, description, state):
    update({'sessionUpdate': 'subagent_update', 'sessionId': child, 'title': title, 'description': description,
            'capabilities': {'cancel': {}}, 'state': {'state': state}})


def ask(method, params):
    """Send a request to Studio and wait for the reply (or the turn being stopped)."""
    counter[0] += 1
    key = f'ask-{counter[0]}'
    done = threading.Event()
    answers[key] = done
    emit({'id': key, 'method': method, 'params': params})
    while not done.wait(0.5):
        if turn['key'] is None:
            return None
    return replies.pop(key, None)


def hold(scene):
    """Stay working until the gate file exists or the turn is stopped. Returns True when released."""
    gate = GATES / f'{scene}.go'
    while turn['key'] is not None:
        if gate.exists():
            return True
        time.sleep(0.3)
    return False


def title(text):
    update({'sessionUpdate': 'session_info_update', 'title': text})


# ---- the scenes ---------------------------------------------------------------------------------------------------------------
def scene_rounding():
    think('The totals are rounded once at the end, after tax. Per-line rounding plus tax rounding is what the receipts show, '
          'so the two can differ by a cent. I should compare against the receipt code before changing anything.')
    stream("Picking up where the review left off: the subtotal is rounded per line on the receipt but only once here, "
           "so a cart with three $19.99 items at 8.25% tax comes out a cent apart.\n\n")
    plan([('Reproduce the off-by-one-cent total', 'completed'), ('Round per line in cents, then apply tax', 'completed'),
          ('Check the other money formatters', 'in_progress'), ('Run the checkout test suite', 'in_progress'), ('Summarise the fix', 'pending')])
    pause()
    read('src/lib/money.ts')
    pause()
    subagent('sub-formatters', 'Audit currency formatting', 'Finds every place money is formatted or rounded outside lib/money.ts', 'running')
    pause()
    subagent('sub-receipts', 'Compare receipt totals', 'Checks 200 recorded orders against the new totals', 'running')
    pause()
    replace('src/checkout/totals.ts', '  const total = subtotal * (1 + taxRate);\n  return Number(total.toFixed(2));',
            '  const subtotalCents = items.reduce((sum, item) => sum + toCents(item.price) * item.quantity, 0);\n'
            '  const taxCents = Math.round(subtotalCents * taxRate);\n  return fromCents(subtotalCents + taxCents);')
    pause()
    run('npm test -- src/checkout', 'Run the checkout tests', '', status='in_progress')
    stream('Running the checkout tests now; the receipt comparison is still going in the background.')
    released = hold('rounding')
    if released:
        subagent('sub-formatters', 'Audit currency formatting', 'Finds every place money is formatted or rounded outside lib/money.ts', 'idle')
        subagent('sub-receipts', 'Compare receipt totals', 'Checks 200 recorded orders against the new totals', 'idle')
        say('\n\nAll 38 checkout tests pass and the 200 recorded receipts now match to the cent.')
    return released


CSV_EXPORT = '''import type { Order } from "./api";

const HEADER = ["Order", "Date", "Customer", "Items", "Total", "Status"];

function cell(value: string | number): string {
  const text = String(value);
  return /[",\\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Orders as CSV text: one header row, one row per order, totals in the shop currency. */
export function ordersToCsv(orders: Order[]): string {
  const rows = orders.map((o) => [o.id, o.placedAt.slice(0, 10), o.customer.name, o.items.length, o.total.toFixed(2), o.status]);
  return [HEADER, ...rows].map((row) => row.map(cell).join(",")).join("\\r\\n") + "\\r\\n";
}

export function downloadCsv(orders: Order[], filename = "orders.csv"): void {
  const blob = new Blob([ordersToCsv(orders)], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
'''

CSV_TEST = '''import { describe, expect, it } from "vitest";
import { ordersToCsv } from "./exportCsv";

const order = (id: string, name: string, total: number) => ({
  id, placedAt: "2026-10-02T09:14:00Z", customer: { name }, items: [{}, {}], total, status: "paid",
});

describe("ordersToCsv", () => {
  it("writes a header and one row per order", () => {
    const csv = ordersToCsv([order("A-1001", "Ana Ruiz", 59.97)] as never);
    expect(csv.split("\\r\\n")[1]).toBe("A-1001,2026-10-02,Ana Ruiz,2,59.97,paid");
  });

  it("quotes names with commas and quotes", () => {
    const csv = ordersToCsv([order("A-1002", 'Lee, "Sam"', 12)] as never);
    expect(csv).toContain('"Lee, ""Sam"""');
  });
});
'''


def scene_csv():
    title('Add CSV export')
    stream("I'll add an **Export CSV** button to the orders page. First a look at how orders are loaded and shown.\n\n")
    plan([('Find where orders are listed', 'in_progress'), ('Write the CSV formatter', 'pending'), ('Add the Export button', 'pending'),
          ('Test quoting and totals', 'pending')])
    read('src/orders/api.ts')
    read('src/orders/OrdersPage.tsx')
    search('toFixed', 'src/checkout/totals.ts:14\nsrc/orders/OrdersPage.tsx:31')
    plan([('Find where orders are listed', 'completed'), ('Write the CSV formatter', 'in_progress'), ('Add the Export button', 'pending'),
          ('Test quoting and totals', 'pending')])
    stream('Orders already arrive fully loaded, so the export can run in the browser without a new endpoint. '
           'Names can contain commas and quotes, so every cell is escaped the RFC 4180 way.\n\n')
    write('src/orders/exportCsv.ts', CSV_EXPORT, old=None)
    pause()
    replace('src/orders/OrdersPage.tsx', 'import { useOrders } from "./api";',
            'import { useOrders } from "./api";\nimport { downloadCsv } from "./exportCsv";')
    replace('src/orders/OrdersPage.tsx', '      <h1>Orders</h1>',
            '      <header className="orders-header">\n        <h1>Orders</h1>\n'
            '        <button onClick={() => downloadCsv(orders)} disabled={!orders.length}>Export CSV</button>\n      </header>')
    plan([('Find where orders are listed', 'completed'), ('Write the CSV formatter', 'completed'), ('Add the Export button', 'completed'),
          ('Test quoting and totals', 'in_progress')])
    write('src/orders/exportCsv.test.ts', CSV_TEST, old=None)
    pause()
    run('npx vitest run src/orders', 'Run the orders tests', '', status='in_progress', call='csv-tests')
    released = hold('csv')
    if released:
        update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'csv-tests', 'status': 'completed',
                'rawOutput': ' ✓ src/orders/exportCsv.test.ts (2 tests) 6ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)\n',
                'content': [{'type': 'content', 'content': {'type': 'text', 'text': ' ✓ src/orders/exportCsv.test.ts (2 tests) 6ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)\n'}}]})
        plan([('Find where orders are listed', 'completed'), ('Write the CSV formatter', 'completed'), ('Add the Export button', 'completed'),
              ('Test quoting and totals', 'completed')])
        stream('Done. The orders page has an **Export CSV** button:\n\n'
               '- `src/orders/exportCsv.ts`: `ordersToCsv` (header plus one row per order, cells quoted when they need it) and `downloadCsv`\n'
               '- `src/orders/OrdersPage.tsx`: the button, disabled while there are no orders\n'
               '- `src/orders/exportCsv.test.ts`: two tests, both passing\n\n'
               'It exports what is on screen, so a filtered list exports filtered.')
    return released


def scene_stripe():
    title('Bump Stripe SDK to v18')
    stream("Stripe's v18 SDK drops the `2023-10-16` API version we pin, so this is two steps: upgrade the package, then move the "
           "webhook handler to the new event types.\n\n")
    read('package.json')
    search('apiVersion', 'src/checkout/stripe.ts:4:  apiVersion: "2023-10-16",')
    plan([('Upgrade the stripe package', 'in_progress'), ('Update the pinned API version', 'pending'), ('Fix the webhook event types', 'pending'),
          ('Run the checkout tests', 'pending')])
    pause()
    reply = ask('session/request_permission', {'sessionId': session['id'], 'toolCall': {
        'toolCallId': 'stripe-install', 'title': 'npm install stripe@18.0.0', 'kind': 'execute', 'status': 'pending',
        'rawInput': {'command': 'npm install stripe@18.0.0', 'description': 'Upgrade the Stripe SDK to v18'}},
        'options': [{'optionId': 'allow', 'name': 'Allow', 'kind': 'allow_once'},
                    {'optionId': 'always', 'name': 'Always allow npm install', 'kind': 'allow_always'},
                    {'optionId': 'deny', 'name': 'Deny', 'kind': 'reject_once'}]})
    outcome = ((reply or {}).get('outcome') or {}).get('optionId')
    if outcome in ('allow', 'always'):
        run('npm install stripe@18.0.0', 'Upgrade the Stripe SDK to v18', 'changed 1 package, audited 412 packages in 4s\nfound 0 vulnerabilities')
        say('Upgraded. Next I will move the webhook handler over.')
    elif reply is not None:
        say('OK, I will leave the package as it is.')
    return True


def scene_copy():
    title('Update product page copy')
    stream("I'll tighten the product page copy: shorter headline, the shipping promise up front, and no more \"click here\".\n\n")
    read('src/products/copy.ts')
    replace('src/products/copy.ts', 'export const headline = "The best everyday backpack you will ever own";',
            'export const headline = "An everyday backpack, built to last";')
    replace('src/products/copy.ts', 'export const shippingNote = "Click here to read about our shipping options.";',
            'export const shippingNote = "Free shipping over $50. Free returns for 30 days.";')
    stream('Updated `src/products/copy.ts`:\n\n| Before | After |\n| --- | --- |\n'
           '| The best everyday backpack you will ever own | An everyday backpack, built to last |\n'
           '| Click here to read about our shipping options. | Free shipping over $50. Free returns for 30 days. |\n\n'
           'Want me to do the same pass on the cart and checkout pages?')
    return True


def scene_refunds():
    title('Write tests for refunds')
    stream("I'll cover `billing/refunds.py` with tests: full and partial refunds, refunds over the charged amount, and refunds on a "
           "disputed charge.\n\n")
    read('billing/refunds.py')
    plan([('Read the refund rules', 'completed'), ('Write tests for full and partial refunds', 'in_progress'), ('Cover the error cases', 'pending'),
          ('Run the suite', 'pending')])
    reply = ask('elicitation/create', {'sessionId': session['id'], 'mode': 'form',
                'message': 'Disputed charges: should a refund be refused, or allowed once the dispute is closed?',
                'requestedSchema': {'type': 'object', 'properties': {
                    'disputed': {'type': 'string', 'title': 'Refund on a disputed charge', 'oneOf': [
                        {'const': 'refuse', 'title': 'Refuse while disputed'}, {'const': 'after', 'title': 'Allow after the dispute closes'}]},
                    'note': {'type': 'string', 'title': 'Anything else the tests should assume'}}, 'required': ['disputed']}})
    if reply is not None:
        say('Thanks, writing the tests that way.')
    return True


SCENES = [('rounding', scene_rounding), ('csv export', scene_csv), ('stripe', scene_stripe), ('product page', scene_copy),
          ('refund', scene_refunds)]


def run_turn(key, text):
    turn['key'] = key
    low = text.lower()
    scene = next((fn for phrase, fn in SCENES if phrase in low), None)
    try:
        if scene:
            finished = scene()
        else:
            stream('Sure. I had a look and that is a small change; I will keep it to the files that need it and run the tests after.')
            finished = True
    except Exception as error:   # a scene must never kill the agent
        say(f'\n\n(Something went wrong: {error})')
        finished = True
    if turn['key'] == key:
        turn['key'] = None
        emit({'id': key, 'result': {'stopReason': 'end_turn' if finished else 'cancelled'}})


KINDS = {'Read': 'read', 'Grep': 'search', 'Glob': 'search', 'Bash': 'execute', 'Edit': 'edit', 'Write': 'edit', 'Agent': 'think'}


def tool_title(name, args):
    if name == 'Bash':
        return args.get('command', 'Bash')
    if name in ('Read', 'Edit', 'Write'):
        return f'{name} {args.get("file_path", "")}'
    if name == 'Grep':
        return f'grep "{args.get("pattern", "")}"'
    if name == 'Agent':
        return args.get('description', 'Agent')
    return name


def replay(sid):
    """session/load: send the saved conversation back first, as the real adapters do (Claude Code keeps it in its transcript)."""
    root = os.environ.get('SHOWCASE_TRANSCRIPTS')
    found = next(pathlib.Path(root).rglob(f'{sid}.jsonl'), None) if root else None
    if not found:
        return
    for line in found.read_text(encoding='utf-8').splitlines():
        row = json.loads(line)
        message = row.get('message') or {}
        content = message.get('content')
        if row.get('type') == 'user':
            if isinstance(content, str):
                update({'sessionUpdate': 'user_message_chunk', 'content': {'type': 'text', 'text': content}})
                continue
            for block in content or []:
                if block.get('type') == 'text':
                    update({'sessionUpdate': 'user_message_chunk', 'content': {'type': 'text', 'text': block['text']}})
                elif block.get('type') == 'tool_result':
                    out = block.get('content')
                    out = out if isinstance(out, str) else ''.join(b.get('text', '') for b in out or [] if isinstance(b, dict))
                    update({'sessionUpdate': 'tool_call_update', 'toolCallId': block['tool_use_id'], 'status': 'failed' if block.get('is_error') else 'completed',
                            'rawOutput': out, 'content': [{'type': 'content', 'content': {'type': 'text', 'text': out}}]})
        elif row.get('type') == 'assistant':
            for block in content or []:
                if block.get('type') == 'text':
                    say(block['text'])
                elif block.get('type') == 'thinking':
                    think(block['thinking'])
                elif block.get('type') == 'tool_use':
                    args = block.get('input') or {}
                    body = {'sessionUpdate': 'tool_call', 'toolCallId': block['id'], 'title': tool_title(block['name'], args),
                            'kind': KINDS.get(block['name'], 'other'), 'status': 'in_progress', 'rawInput': args}
                    if args.get('file_path'):
                        body['locations'] = [{'path': args['file_path']}]
                    update(body)


def session_result(sid):
    return {'sessionId': sid, 'modes': MODES, 'configOptions': CONFIG}


def announce():
    update({'sessionUpdate': 'available_commands_update', 'availableCommands': COMMANDS})
    update({'sessionUpdate': 'usage_update', 'size': 200000, 'used': 41800})


def main():
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except ValueError:
            continue
        method, key, params = message.get('method'), message.get('id'), message.get('params') or {}
        if method is None and key in answers:      # a reply to our own request
            replies[key] = message.get('result')
            answers.pop(key).set()
        elif method == 'initialize':
            emit({'id': key, 'result': {'protocolVersion': 1, 'agentCapabilities': {
                'loadSession': True, 'promptCapabilities': {'image': True, 'embeddedContext': True, 'audio': False},
                'sessionCapabilities': {'close': {}}}, 'authMethods': []}})
        elif method in ('session/new', 'session/load', 'session/resume'):
            session['id'] = params.get('sessionId') or f'{ROLE}-{int(time.time() * 1000)}'
            session['cwd'] = params.get('cwd') or session['cwd']
            if method == 'session/load':
                replay(session['id'])
            emit({'id': key, 'result': session_result(session['id'])})
            announce()
        elif method == 'session/prompt':
            blocks = params.get('prompt') or []
            text = next((b.get('text', '') for b in blocks if b.get('type') == 'text' and not b.get('text', '').startswith('<studio-context>')), '')
            threading.Thread(target=run_turn, args=(key, text), daemon=True).start()
        elif method == 'session/cancel':
            active = turn['key']
            if active is not None:
                turn['key'] = None
                emit({'id': active, 'result': {'stopReason': 'cancelled'}})
        elif method == 'session/set_mode':
            MODES['currentModeId'] = params.get('modeId') or MODES['currentModeId']
            emit({'id': key, 'result': {}})
        elif method == 'session/set_config_option':
            for option in CONFIG:
                if option['id'] == params.get('configId'):
                    option['currentValue'] = params.get('value')
            emit({'id': key, 'result': {'configOptions': CONFIG}})
        elif key is not None and method is not None:
            emit({'id': key, 'result': {}})


if __name__ == '__main__':
    main()
