"""Demo Studio with realistic projects and chats, for the README screenshots. Standard library only.

  python work/demo-studio/readme_shots.py --port 8951            build the data, start Studio, stage the live chats; prints URL and PID
  python work/demo-studio/readme_shots.py --port 8951 --release rounding    let a held turn finish (rounding | csv)
  python work/demo-studio/readme_shots.py --port 8951 --stop     stop it and delete its folder

Like start.py (whose helpers it uses), everything lives in one temp folder, aib-readme-<port>; the owner's state and ~/.claude are
never read. The agents are work/demo-studio/showcase_agent.py: it plays Claude Code and Codex (through the launcher flags) and
OpenCode, a Beta agent (through an opencode.cmd on the server's PATH). Two git projects, storefront and billing-api; saved Claude
Code transcripts for the older chats; live chats started through Studio's own API:

  storefront   Fix checkout rounding bug    Claude Code  saved, then resumed: Working (subagents, a dev server still running)
  storefront   Add CSV export               Codex        its own worktree, Working until released, then Your turn
  storefront   Bump Stripe SDK to v18       Claude Code  Needs you (asks to run npm install)
  storefront   Update product page copy     OpenCode     Your turn
  storefront   Migrate product images to WebP  Claude Code  saved, idle
  billing-api  Write tests for refunds      Codex        Needs you (asks a question)
  billing-api  October revenue report       Claude Code  saved, with an HTML artifact in two versions
  billing-api  Add idempotency keys to /charges  Claude Code  saved, idle
"""
import argparse
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import uuid

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import start as demo  # noqa: E402  (the demo Studio's helpers: git, transcripts, http, processes)

AGENT = HERE / 'showcase_agent.py'
PREFIX = 'aib-readme-'
MARKER = '.demo-studio'
HOUR = 3600

STOREFRONT = {
    '.gitignore': 'node_modules/\ndist/\n.env\n',
    'README.md': '# storefront\n\nThe shop front end: product pages, cart, checkout and the orders admin.\n\n```\nnpm install\nnpm run dev\n```\n',
    'package.json': json.dumps({'name': 'storefront', 'version': '2.4.1', 'private': True, 'type': 'module',
                                'scripts': {'dev': 'vite', 'build': 'vite build', 'test': 'vitest run'},
                                'dependencies': {'react': '^18.3.1', 'react-dom': '^18.3.1', 'stripe': '^17.7.0'},
                                'devDependencies': {'typescript': '^5.6.3', 'vite': '^5.4.10', 'vitest': '^2.1.4'}}, indent=2) + '\n',
    'src/lib/money.ts': 'export const toCents = (amount: number): number => Math.round(amount * 100);\n'
                        'export const fromCents = (cents: number): number => cents / 100;\n\n'
                        'export function formatMoney(amount: number, currency = "USD"): string {\n'
                        '  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);\n}\n',
    'src/checkout/totals.ts': 'import { fromCents, toCents } from "../lib/money";\n\nexport interface LineItem {\n  sku: string;\n  price: number;\n  quantity: number;\n}\n\n'
                              '/** The order total the customer pays, tax included. */\n'
                              'export function orderTotal(items: LineItem[], taxRate: number): number {\n'
                              '  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n'
                              '  const total = subtotal * (1 + taxRate);\n  return Number(total.toFixed(2));\n}\n',
    'src/checkout/totals.test.ts': 'import { describe, expect, it } from "vitest";\nimport { orderTotal } from "./totals";\n\n'
                                   'describe("orderTotal", () => {\n  it("adds tax", () => {\n'
                                   '    expect(orderTotal([{ sku: "BAG-01", price: 20, quantity: 1 }], 0.1)).toBe(22);\n  });\n});\n',
    'src/checkout/stripe.ts': 'import Stripe from "stripe";\n\nexport const stripe = new Stripe(process.env.STRIPE_KEY ?? "", {\n  apiVersion: "2023-10-16",\n});\n',
    'src/orders/api.ts': 'export interface Order {\n  id: string;\n  placedAt: string;\n  customer: { name: string };\n  items: unknown[];\n  total: number;\n  status: "paid" | "refunded" | "pending";\n}\n\n'
                         'export function useOrders(): Order[] {\n  return [];\n}\n',
    'src/orders/OrdersPage.tsx': 'import { useOrders } from "./api";\nimport { formatMoney } from "../lib/money";\n\n'
                                 'export function OrdersPage() {\n  const orders = useOrders();\n  return (\n    <main>\n      <h1>Orders</h1>\n'
                                 '      <table>\n        <tbody>\n          {orders.map((o) => (\n            <tr key={o.id}>\n'
                                 '              <td>{o.id}</td>\n              <td>{o.customer.name}</td>\n              <td>{formatMoney(o.total)}</td>\n'
                                 '            </tr>\n          ))}\n        </tbody>\n      </table>\n    </main>\n  );\n}\n',
    'src/products/copy.ts': 'export const headline = "The best everyday backpack you will ever own";\n'
                            'export const shippingNote = "Click here to read about our shipping options.";\n',
    'src/products/ProductPage.tsx': 'import { headline, shippingNote } from "./copy";\n\nexport function ProductPage() {\n'
                                    '  return (\n    <article>\n      <h1>{headline}</h1>\n      <p>{shippingNote}</p>\n    </article>\n  );\n}\n',
}

BILLING = {
    '.gitignore': '__pycache__/\n.venv/\n*.pyc\n',
    'README.md': '# billing-api\n\nCharges, invoices and refunds for the shop.\n\n```\npython -m unittest -v\n```\n',
    'pyproject.toml': '[project]\nname = "billing-api"\nversion = "1.8.0"\nrequires-python = ">=3.11"\n',
    'billing/__init__.py': '',
    'billing/charges.py': 'from dataclasses import dataclass\n\n\n@dataclass\nclass Charge:\n    id: str\n    amount_cents: int\n'
                          '    refunded_cents: int = 0\n    disputed: bool = False\n',
    'billing/refunds.py': 'from .charges import Charge\n\n\nclass RefundError(ValueError):\n    pass\n\n\n'
                          'def refund(charge: Charge, amount_cents: int | None = None) -> int:\n'
                          '    """Refund all or part of a charge. Returns the amount refunded, in cents."""\n'
                          '    if charge.disputed:\n        raise RefundError("charge is disputed")\n'
                          '    left = charge.amount_cents - charge.refunded_cents\n    amount = left if amount_cents is None else amount_cents\n'
                          '    if amount <= 0 or amount > left:\n        raise RefundError("amount must be between 1 and %d cents" % left)\n'
                          '    charge.refunded_cents += amount\n    return amount\n',
    'billing/invoices.py': 'def invoice_total(lines: list[tuple[int, int]], tax_rate: float) -> int:\n'
                           '    """Total in cents for (unit_cents, quantity) lines, tax rounded once."""\n'
                           '    subtotal = sum(unit * qty for unit, qty in lines)\n    return subtotal + round(subtotal * tax_rate)\n',
    'tests/__init__.py': '',
    'tests/test_invoices.py': 'import unittest\n\nfrom billing.invoices import invoice_total\n\n\nclass InvoiceTotalTest(unittest.TestCase):\n'
                              '    def test_no_tax(self):\n        self.assertEqual(invoice_total([(1999, 3)], 0), 5997)\n\n'
                              '    def test_tax_is_rounded_once(self):\n        self.assertEqual(invoice_total([(1999, 3)], 0.0825), 6492)\n\n'
                              '    def test_empty_invoice(self):\n        self.assertEqual(invoice_total([], 0.2), 0)\n',
    'tests/test_charges.py': 'import unittest\n\nfrom billing.charges import Charge\nfrom billing.refunds import RefundError, refund\n\n\n'
                             'class RefundTest(unittest.TestCase):\n    def test_full_refund(self):\n        charge = Charge("ch_1", 5000)\n'
                             '        self.assertEqual(refund(charge), 5000)\n\n    def test_partial_refund(self):\n        charge = Charge("ch_2", 5000)\n'
                             '        self.assertEqual(refund(charge, 1250), 1250)\n        self.assertEqual(charge.refunded_cents, 1250)\n\n'
                             '    def test_refund_over_amount(self):\n        with self.assertRaises(RefundError):\n            refund(Charge("ch_3", 500), 900)\n\n'
                             '    def test_disputed_charge(self):\n        with self.assertRaises(RefundError):\n            refund(Charge("ch_4", 500, disputed=True))\n',
}

STOREFRONT_HISTORY = [
    ('Add product page and cart', ['src/products/ProductPage.tsx', 'src/products/copy.ts']),
    ('Checkout: order totals with tax', ['src/checkout/totals.ts', 'src/checkout/totals.test.ts', 'src/lib/money.ts']),
    ('Stripe client for checkout', ['src/checkout/stripe.ts']),
    ('Orders admin page', ['src/orders/api.ts', 'src/orders/OrdersPage.tsx']),
]
BILLING_HISTORY = [
    ('Charges and refunds', ['billing/__init__.py', 'billing/charges.py', 'billing/refunds.py']),
    ('Invoice totals', ['billing/invoices.py']),
    ('Tests for invoices and refunds', ['tests/__init__.py', 'tests/test_invoices.py', 'tests/test_charges.py']),
]


def git(cwd, *args, when=None):
    env = dict(os.environ)
    if when:
        stamp = time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(when))
        env.update(GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)
    subprocess.run(['git', '-c', 'user.name=Sam Rivera', '-c', 'user.email=sam@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', *args],
                   cwd=str(cwd), check=True, capture_output=True, text=True, env=env, creationflags=demo_flags())


def demo_flags():
    return getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def make_project(path, files, history, now):
    path.mkdir(parents=True, exist_ok=True)
    for name, text in files.items():
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8', newline='\n')
    git(path, 'init', '-q', '-b', 'main')
    first = [n for n in files if not any(n in f for _, f in history)]
    git(path, 'add', *first)
    when = now - 30 * 24 * HOUR
    git(path, 'commit', '-q', '-m', 'Initial commit', when=when)
    for index, (message, names) in enumerate(history):
        git(path, 'add', *names)
        git(path, 'commit', '-q', '-m', message, when=when + (index + 1) * 5 * 24 * HOUR)


def save(t):
    """Write a transcript with a real-looking model id in place of start.py's placeholder."""
    path = t.write()
    stamp = path.stat().st_mtime
    path.write_text(path.read_text(encoding='utf-8').replace('"demo-model"', '"claude-sonnet-4-5"'), encoding='utf-8')
    os.utime(path, (stamp, stamp))
    return path


def transcripts(demo_root, store, billing, now):
    claude = demo_root / 'claude'
    chats = {}

    t = demo.Transcript(claude, store, '5b1f3c2e-8a4d-4f6b-9c1e-2d7a6e0b4f91', 'Fix checkout rounding bug', now - 2 * HOUR, step=40)
    t.user('Customers say the checkout total is sometimes a cent off from their emailed receipt. Find out why and fix it.')
    t.think('Receipts and checkout probably round at different points. Start with the totals code and the receipt formatter.')
    t.say("I'll start with how checkout computes the total, then compare it with the receipt.")
    t.tool('Read', {'file_path': str(store / 'src/checkout/totals.ts')}, (store / 'src/checkout/totals.ts').read_text(encoding='utf-8'))
    t.tool('Grep', {'pattern': 'toFixed|Math.round', 'path': str(store / 'src')}, 'src/checkout/totals.ts:14:  return Number(total.toFixed(2));\nsrc/lib/money.ts:1:export const toCents = (amount: number): number => Math.round(amount * 100);')
    t.tool('Bash', {'command': 'npm run dev', 'description': 'Start the dev server to reproduce in the browser', 'run_in_background': True},
           'Command running in background with ID: bg-dev-1', extra={'backgroundTaskId': 'bg-dev-1'})
    t.tool('Agent', {'description': 'Find receipt rounding', 'subagent_type': 'general-purpose', 'prompt': 'Find where emailed receipts compute their totals.'},
           'Async agent launched successfully.\nagentId: rcpt-1 (internal ID)\nThe agent is working in the background.')
    t.say('Found it. Checkout multiplies the **unrounded** subtotal by the tax rate and rounds once at the end; the receipt rounds '
          'every line to cents first. For 3 × $19.99 at 8.25% tax:\n\n| | Checkout | Receipt |\n| --- | --- | --- |\n'
          '| Subtotal | 59.97 | 59.97 |\n| Tax | 4.947525 | 4.95 |\n| **Total** | **64.92** | **64.93** |\n\n'
          'The fix is to work in whole cents everywhere. Shall I go ahead?')
    chats['rounding'] = (save(t), t.session)

    t = demo.Transcript(claude, store, '9d2e7b10-3c5a-4e8f-b6d1-7a0c2f9e5b33', 'Migrate product images to WebP', now - 3 * 24 * HOUR)
    t.user('Convert the product images to WebP and keep JPEG as a fallback.')
    t.tool('Bash', {'command': 'npx sharp-cli --input "public/products/*.jpg" --output public/products --format webp', 'description': 'Convert the product photos'},
           'Converted 48 files (31.2 MB -> 9.8 MB)')
    t.say('All 48 product photos now have a WebP version (31 MB down to 10 MB). `ProductImage` serves WebP with a JPEG fallback.')
    chats['webp'] = (save(t), t.session)

    t = demo.Transcript(claude, billing, 'c3a8e1f4-6b2d-4d9a-8e7c-1f5b0a3d2c64', 'October revenue report', now - 26 * HOUR)
    t.user('Make me a one-page October revenue report from the billing exports: totals, refunds, and the top products.')
    t.tool('Read', {'file_path': str(billing / 'exports/2026-10-charges.csv')}, 'id,amount_cents,refunded_cents,product\nch_1,5999,0,Daypack 24L\n...')
    t.say('Done: I published the report as **October revenue** (an HTML page in Artifacts). Gross $48,210, refunds $1,904, net $46,306.')
    t.user('The refund total looks low. Did you include partial refunds?')
    t.say('You were right: partial refunds were missing. Version 2 of the report counts them: refunds are $2,417 and net revenue $45,793.')
    chats['revenue'] = (save(t), t.session)

    t = demo.Transcript(claude, billing, 'e7f0a9b2-1d4c-4a6e-9b3f-8c2d5e7a1f08', 'Add idempotency keys to /charges', now - 5 * 24 * HOUR)
    t.user('Make POST /charges idempotent with an Idempotency-Key header.')
    t.say('Done: a repeated key within 24 hours returns the first charge instead of creating a new one. Tests cover the replay and a key reused with a different body (409).')
    chats['idempotency'] = (save(t), t.session)
    return chats


def write_wrappers(demo_root):
    """Launchers Studio runs: python <script> for Claude Code and Codex, opencode.cmd on PATH for the Beta agent."""
    bin_dir = demo_root / 'bin'
    bin_dir.mkdir(parents=True, exist_ok=True)
    for role in ('claude', 'codex'):
        (bin_dir / f'{role}_agent.py').write_text(
            'import runpy, sys\n'
            f'sys.argv = [{str(AGENT)!r}, {role!r}] + sys.argv[1:]\n'
            f'runpy.run_path({str(AGENT)!r}, run_name="__main__")\n', encoding='utf-8')
    # OMP is turned off in the demo; this launcher keeps a stray start away from a real install.
    if os.name == 'nt':
        (bin_dir / 'omp.cmd').write_text(f'@echo off\r\n"{sys.executable}" "{AGENT}" claude %*\r\n', encoding='utf-8')
        (bin_dir / 'opencode.cmd').write_text(f'@echo off\r\n"{sys.executable}" "{AGENT}" opencode %*\r\n', encoding='utf-8')
    else:
        launcher = bin_dir / 'opencode'
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{AGENT}" opencode "$@"\n', encoding='utf-8')
        launcher.chmod(0o755)
    return bin_dir


def generate(demo_root):
    now = time.time()
    for name in ('state', 'claude', 'omp', 'owners', 'gates', 'code'):
        (demo_root / name).mkdir(parents=True, exist_ok=True)
    store, billing = demo_root / 'code' / 'storefront', demo_root / 'code' / 'billing-api'
    make_project(store, STOREFRONT, STOREFRONT_HISTORY, now)
    make_project(billing, BILLING, BILLING_HISTORY, now)
    (billing / 'exports').mkdir(exist_ok=True)
    chats = transcripts(demo_root, store, billing, now)
    write_wrappers(demo_root)
    (demo_root / MARKER).write_text('Created by work/demo-studio/readme_shots.py. Safe to delete.\n', encoding='utf-8')
    (demo_root / 'chats.json').write_text(json.dumps({k: v[1] for k, v in chats.items()}), encoding='utf-8')
    return chats


def command(port, demo_root):
    bin_dir = demo_root / 'bin'
    return [demo.deno_executable(), 'run', '-A', '--quiet', str(demo.MAIN), 'serve', '--port', str(port), '--state-dir', str(demo_root / 'state'),
            '--omp-sessions', str(demo_root / 'omp'), '--claude-projects', str(demo_root / 'claude'), '--owners-dir', str(demo_root / 'owners'),
            '--in-process', '--no-auto-reconnect', '--no-owner-announcements', '--node-command', sys.executable,
            '--omp-command', str(bin_dir / ('omp.cmd' if os.name == 'nt' else 'omp')),
            '--claude-launcher', str(bin_dir / 'claude_agent.py'), '--codex-launcher', str(bin_dir / 'codex_agent.py')]


class Api:
    def __init__(self, port):
        self.base = f'http://127.0.0.1:{port}'
        self.token = json.loads(demo.http(self.base + '/api/live/bootstrap')[1])['token']

    def post(self, name, body):
        status, data = demo.http(self.base + '/api/live/' + name, body, {'X-Studio-Token': self.token, 'Origin': self.base}, timeout=60)
        return json.loads(data or b'{}')

    def get(self, path):
        return json.loads(demo.http(self.base + path, None, {'X-Studio-Token': self.token}, timeout=30)[1])


def wait(condition, seconds=60):
    deadline = time.time() + seconds
    while time.time() < deadline:
        value = condition()
        if value:
            return value
        time.sleep(0.3)
    raise RuntimeError('timed out')


REVENUE_V1 = '''<!doctype html><meta charset="utf-8"><title>October revenue</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1d232b}
main{max-width:760px;margin:0 auto;padding:32px 24px}
h1{font-size:26px;margin:0 0 4px}.sub{color:#5b6573;margin:0 0 24px}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:28px}
.tile{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:14px 16px}
.tile b{display:block;font-size:24px}.tile span{color:#5b6573;font-size:13px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e6ea;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 14px;border-bottom:1px solid #eef0f3}th{background:#fafbfc;font-size:13px;color:#5b6573}
td.n{text-align:right;font-variant-numeric:tabular-nums}
.bar{height:8px;background:#0f9b8e;border-radius:4px}
</style>
<main>
<h1>October revenue</h1>
<p class="sub">Billing exports, 1–31 October 2026</p>
<div class="tiles">
<div class="tile"><span>Gross</span><b>$48,210</b></div>
<div class="tile"><span>Refunds</span><b>$1,904</b></div>
<div class="tile"><span>Net</span><b>$46,306</b></div>
</div>
<table>
<tr><th>Product</th><th>Orders</th><th class="n">Revenue</th><th style="width:30%"></th></tr>
<tr><td>Daypack 24L</td><td>412</td><td class="n">$18,540</td><td><div class="bar" style="width:100%"></div></td></tr>
<tr><td>Trail bottle 750 ml</td><td>655</td><td class="n">$9,825</td><td><div class="bar" style="width:53%"></div></td></tr>
<tr><td>Rain shell</td><td>71</td><td class="n">$8,449</td><td><div class="bar" style="width:46%"></div></td></tr>
<tr><td>Packing cubes (set of 3)</td><td>298</td><td class="n">$7,152</td><td><div class="bar" style="width:39%"></div></td></tr>
<tr><td>Other</td><td>203</td><td class="n">$4,244</td><td><div class="bar" style="width:23%"></div></td></tr>
</table>
</main>
'''
REVENUE_V2 = (REVENUE_V1.replace('<b>$1,904</b>', '<b>$2,417</b>').replace('<b>$46,306</b>', '<b>$45,793</b>')
              .replace('Billing exports, 1–31 October 2026', 'Billing exports, 1–31 October 2026 · refunds include partial refunds (61 orders)'))


def stage(port, demo_root):
    api = Api(port)
    chats = json.loads((demo_root / 'chats.json').read_text(encoding='utf-8'))
    store, billing = demo_root / 'code' / 'storefront', demo_root / 'code' / 'billing-api'
    api.post('settings', {'agents': {'enabled': {'opencode': True, 'omp': False}}})
    # The revenue report: two versions of one artifact in the saved chat.
    first = api.post('artifacts/publish', {'conversationId': f'claude:{chats["revenue"]}', 'title': 'October revenue', 'content': REVENUE_V1,
                                           'filename': 'october-revenue.html'})
    art = (first.get('artifact') or first).get('id')
    api.post('artifacts/publish', {'conversationId': f'claude:{chats["revenue"]}', 'id': art, 'content': REVENUE_V2,
                                   'note': 'Counts partial refunds'})

    def chat(provider, cwd, text, resume=None):
        body = {'provider': provider, 'cwd': str(cwd), 'background': True}
        if resume:
            body['resume'] = resume
        connection = api.post('connect', body)
        cid = connection['id']
        wait(lambda: api.get(f'/api/live/state?id={cid}').get('ready'))
        api.post('prompt', {'id': cid, 'text': text, 'clientMessageId': uuid.uuid4().hex})
        time.sleep(1.5)
        return cid

    made = {}
    made['copy'] = chat('opencode', store, 'Update the product page copy: a shorter headline, and put the shipping promise up front.')
    made['refunds'] = chat('codex', billing, 'Write tests for refunds in billing/refunds.py, including partial refunds.')
    made['stripe'] = chat('claude', store, 'Bump the Stripe SDK to v18 and fix whatever breaks.')
    made['csv'] = chat('codex', store, 'Add CSV export to the orders page: a button that downloads the order list support sees.')
    made['rounding'] = chat('claude', store, 'Yes, go ahead with the rounding fix in whole cents, and check the other money formatters too.',
                            resume=chats['rounding'])
    (demo_root / 'live.json').write_text(json.dumps(made), encoding='utf-8')
    return made


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=8951)
    parser.add_argument('--stop', action='store_true')
    parser.add_argument('--release', choices=['rounding', 'csv'])
    parser.add_argument('--no-stage', action='store_true', help='Start Studio with the data but start no live chats')
    options = parser.parse_args(argv)
    problem = demo.refused_port(options.port)
    if problem:
        parser.error(problem)
    demo_root = pathlib.Path(tempfile.gettempdir()).resolve() / f'{PREFIX}{options.port}'
    if options.release:
        (demo_root / 'gates' / f'{options.release}.go').write_text('go', encoding='utf-8')
        return 0
    if options.stop or demo_root.exists():
        stopped = demo.stop_studio(options.port, demo_root)
        if stopped:
            print('Stopped PID ' + ', '.join(map(str, stopped)))
        if demo_root.exists():
            if not (demo_root / MARKER).is_file():
                print(f'{demo_root} is not a demo folder; left alone.', file=sys.stderr)
                return 2
            demo.remove_tree(demo_root)
        if options.stop:
            return 0
    for port in (options.port, options.port + 1):
        if demo.port_busy(port):
            print(f'Port {port} is in use.', file=sys.stderr)
            return 2
    demo_root.mkdir(parents=True)
    generate(demo_root)
    env = dict(os.environ, SHOWCASE_GATES=str(demo_root / 'gates'), SHOWCASE_TRANSCRIPTS=str(demo_root / 'claude'))
    env['PATH'] = str(demo_root / 'bin') + os.pathsep + env.get('PATH', '')
    log = open(demo_root / 'studio.log', 'ab')
    flags = 0
    if os.name == 'nt':
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    process = subprocess.Popen(command(options.port, demo_root), stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=flags,
                               cwd=str(demo_root), env=env)
    (demo_root / 'studio.pid').write_text(json.dumps({'pid': process.pid, 'port': options.port, 'startedAt': time.time()}), encoding='utf-8')
    if not demo.wait_ready(options.port, process, 60):
        print('Studio did not start:\n' + (demo_root / 'studio.log').read_text(encoding='utf-8', errors='replace')[-1500:], file=sys.stderr)
        demo.kill_tree(process.pid)
        return 1
    if not options.no_stage:
        print(json.dumps(stage(options.port, demo_root)))
    print(f'Studio: http://127.0.0.1:{options.port}/chat.html')
    print(f'PID: {process.pid}')
    print(f'Data: {demo_root}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
