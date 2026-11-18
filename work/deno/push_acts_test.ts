/**
 * Buttons on phone notifications (0.13, server/remote/push_acts.ts): which two buttons each row kind gets on a phone (Android Chrome
 * shows at most two), by the phone's switches and the risky-command rule, the buttons' payload part, and the one-time codes scoped
 * to the phone (ToastCodes with a device: refused for another phone, used, expired, or once the request changed).
 */
import { assert, assertEquals } from "./_assert.ts";
import type { InboxRow } from "../../outputs/agent-studio/server/attention/inbox_rules.ts";
import { ToastCodes } from "../../outputs/agent-studio/server/desktop/toast.ts";
import {
  CODED_ACTS,
  MAX_PUSH_ACTIONS,
  NOTIFY_NOTES,
  pushActs,
  pushButtons,
  rowSig,
  scopeOfAct,
} from "../../outputs/agent-studio/server/remote/push_acts.ts";

const ONCE = [
  { optionId: "yes", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];
const ALL = [
  "phone.read",
  "phone.answer",
  "phone.prompt",
  "phone.approve",
  "phone.push",
];
const READ_ONLY = ["phone.read", "phone.push"];

function row(kind: InboxRow["kind"], over: Partial<InboxRow> = {}): InboxRow {
  return {
    key: "claude:s1",
    id: "c1",
    section: kind === "finished" ? "review" : "needs",
    kind,
    what: "Run npm install stripe@18.0.0",
    whatCode: "npm install stripe@18.0.0",
    title: "Payments",
    project: { key: "p", name: "shopfront" },
    provider: "claude",
    agent: "Claude",
    since: 1000,
    at: 1000,
    needs: 1,
    more: 0,
    helpers: 0,
    request: kind === "approval"
      ? {
        kind: "permission",
        key: "p1",
        params: {
          toolCall: {
            toolCallId: "tc1",
            title: "Bash",
            rawInput: { command: "npm install stripe@18.0.0" },
          },
          options: ONCE,
        },
      }
      : null,
    ask: "",
    actions: [],
    ...over,
  };
}

const approval = (
  command: string,
  options: unknown[] = ONCE,
  extra: Record<string, unknown> = {},
) =>
  row("approval", {
    what: `Run ${command}`,
    whatCode: command,
    request: {
      kind: "permission",
      key: "p2",
      params: {
        toolCall: {
          toolCallId: "tc2",
          title: "Bash",
          rawInput: { command },
          ...extra,
        },
        options,
      },
    },
  });

Deno.test("phone buttons: the two most useful per kind (Allow · Deny, Reply · Open, Continue · Open, Retry · Open)", () => {
  assertEquals(pushActs(row("approval"), ALL), ["allow", "deny"]);
  assertEquals(pushActs(row("asks"), ALL), ["reply", "open"]);
  assertEquals(pushActs(row("finished"), ALL), ["reply", "open"]);
  assertEquals(pushActs(row("stalled"), ALL), ["continue", "open"]);
  assertEquals(pushActs(row("failed"), ALL), ["retry", "open"]);
  assertEquals(
    pushActs(row("question"), ALL),
    ["open"],
    "a question form is answered in the chat",
  );
  assertEquals(pushActs(row("signin"), ALL), ["open"]);
  assertEquals(pushActs(null, ALL), []);
  for (
    const kind of [
      "approval",
      "asks",
      "finished",
      "stalled",
      "failed",
      "question",
      "signin",
    ] as const
  ) {
    assert(pushActs(row(kind), ALL).length <= MAX_PUSH_ACTIONS, kind);
  }
});

Deno.test("phone buttons: risky commands, merges, lasting-only options and a missing Deny", () => {
  for (
    const command of [
      "git push origin main",
      "git push --force",
      "rm -rf build",
      "git reset --hard HEAD~1",
    ]
  ) {
    assertEquals(pushActs(approval(command), ALL), ["open"], command);
  }
  assertEquals(pushActs(approval("ls", ONCE, { kind: "delete" }), ALL), [
    "open",
  ], "a delete tool");
  assertEquals(
    pushActs(approval("ls", ONCE, { title: "merge_into_project" }), ALL),
    ["open"],
    "AIB's merge: PC only",
  );
  assertEquals(
    pushActs(approval("ls", [ONCE[0]]), ALL),
    ["allow", "open"],
    "no Deny: Allow · Open",
  );
  assertEquals(
    pushActs(approval("ls", [ONCE[1], ONCE[2]]), ALL),
    ["open"],
    "no once Allow",
  );
  // an allow_once whose words say it lasts ("for this session") is never one tap from a phone
  assertEquals(
    pushActs(
      approval("ls", [{
        optionId: "yes",
        name: "Allow for this session",
        kind: "allow_once",
      }, ONCE[2]]),
      ALL,
    ),
    ["open"],
  );
  // a mode switch disguised as allow_once (Claude's plan exit)
  assertEquals(
    pushActs(
      approval("ls", [{
        optionId: "acceptEdits",
        name: "Yes",
        kind: "allow_once",
      }, ONCE[2]]),
      ALL,
    ),
    ["open"],
  );
  const pcOnly = row("approval");
  pcOnly.request!.pcOnly = true;
  assertEquals(pushActs(pcOnly, ALL), ["open"]);
});

Deno.test("phone buttons: only what the phone's switches allow (Approve once, Send)", () => {
  assertEquals(pushActs(row("approval"), READ_ONLY), ["open"]);
  assertEquals(pushActs(row("approval"), ["phone.read", "phone.approve"]), [
    "allow",
    "deny",
  ]);
  assertEquals(pushActs(row("stalled"), READ_ONLY), ["open"]);
  assertEquals(pushActs(row("failed"), ["phone.read", "phone.approve"]), [
    "open",
  ]);
  assertEquals(
    pushActs(row("asks"), READ_ONLY),
    ["open"],
    "Reply needs Send (the composer)",
  );
  assertEquals([
    scopeOfAct("allow"),
    scopeOfAct("deny"),
    scopeOfAct("continue"),
    scopeOfAct("retry"),
  ], [
    "phone.approve",
    "phone.approve",
    "phone.prompt",
    "phone.prompt",
  ]);
});

Deno.test("phone buttons: the payload part (key, titles, a code only for answering buttons, issued for this chat and request)", () => {
  const issued: [string, string, string[]][] = [];
  const issue = (chat: string, sig: string, acts: string[]) => {
    issued.push([chat, sig, acts]);
    return "CODE";
  };
  assertEquals(pushButtons(row("approval"), ALL, issue), {
    key: "claude:s1",
    actions: [{ action: "allow", title: "Allow" }, {
      action: "deny",
      title: "Deny",
    }],
    code: "CODE",
  });
  assertEquals(issued, [["claude:s1", rowSig(row("approval")), [
    "allow",
    "deny",
  ]]]);
  issued.length = 0;
  assertEquals(pushButtons(row("finished"), ALL, issue), {
    key: "claude:s1",
    actions: [{ action: "reply", title: "Reply" }, {
      action: "open",
      title: "Open",
    }],
    code: "",
  });
  assertEquals(issued, [], "Reply and Open only open the page: no code");
  assertEquals(pushButtons(row("stalled"), ALL, issue)!.code, "CODE");
  assertEquals(issued.at(-1)![2], ["continue"]);
  assertEquals(pushButtons(approval("git push --force"), ALL, issue)!.actions, [
    { action: "open", title: "Open" },
  ]);
  assertEquals(issued.length, 1, "a risky command gets no code");
  assertEquals(pushButtons(null, ALL, issue), null);
  assertEquals([...CODED_ACTS], ["allow", "deny", "continue", "retry"]);
  for (
    const k of [
      "expired",
      "used",
      "answered",
      "scope",
      "offline",
      "not_allowed",
    ]
  ) assert(NOTIFY_NOTES[k], k);
});

Deno.test("phone codes: good once, for this phone, this chat and this request, until they expire", () => {
  let now = 1_000_000;
  const codes = new ToastCodes({ clock: () => now, ttlMs: 60_000 });
  const sig = rowSig(row("approval"));
  const a = codes.issue("claude:s1", sig, ["allow", "deny"], "phoneA");
  const b = codes.issue("claude:s1", sig, ["allow", "deny"], "phoneB");
  assertEquals(codes.check(a, "claude:s1", "allow", sig, "phoneB"), {
    ok: false,
    reason: "wrong_device",
  });
  assertEquals(codes.check(a, "claude:s1", "allow", sig, ""), {
    ok: false,
    reason: "wrong_device",
  }, "not a toast code");
  assertEquals(codes.check(a, "claude:s2", "allow", sig, "phoneA"), {
    ok: false,
    reason: "wrong_chat",
  });
  assertEquals(codes.check(a, "claude:s1", "continue", sig, "phoneA"), {
    ok: false,
    reason: "not_allowed",
  });
  assertEquals(codes.check(a, "claude:s1", "allow", "approval|tc9", "phoneA"), {
    ok: false,
    reason: "answered",
  }, "a newer request");
  assertEquals(codes.check(a, "claude:s1", "allow", null, "phoneA"), {
    ok: false,
    reason: "answered",
  }, "the row is gone");
  assertEquals(codes.check(a, "claude:s1", "allow", sig, "phoneA"), {
    ok: true,
  });
  assertEquals(codes.check(a, "claude:s1", "deny", sig, "phoneA"), {
    ok: false,
    reason: "used",
  });
  // a new notification for phone A's chat voids A's older code only, never phone B's
  const a2 = codes.issue("claude:s1", sig, ["allow", "deny"], "phoneA");
  assertEquals(codes.check(a2, "claude:s1", "deny", sig, "phoneA"), {
    ok: true,
  });
  now += 61_000;
  assertEquals(codes.check(b, "claude:s1", "allow", sig, "phoneB"), {
    ok: false,
    reason: "expired",
  });
  // answered elsewhere: one phone's codes revoked, or all of them
  const c = codes.issue("claude:s3", sig, ["continue"], "phoneA");
  const d = codes.issue("claude:s3", sig, ["continue"], "phoneB");
  codes.revokeChat("claude:s3", true, "phoneA");
  assertEquals(codes.check(c, "claude:s3", "continue", sig, "phoneA"), {
    ok: false,
    reason: "unknown",
  });
  codes.revokeChat("claude:s3");
  assertEquals(codes.check(d, "claude:s3", "continue", sig, "phoneB"), {
    ok: false,
    reason: "unknown",
  });
});

Deno.test("phone codes: kept as hashes with their phone in push-codes.json (a restart still knows them)", () => {
  const dir = Deno.makeTempDirSync({ prefix: "aib-push-codes-" });
  try {
    const file = `${dir}/push-codes.json`;
    const sig = rowSig(row("failed"));
    const code = new ToastCodes({ file }).issue(
      "claude:s1",
      sig,
      ["retry"],
      "phoneA",
    );
    const text = Deno.readTextFileSync(file);
    assert(!text.includes(code), "never the code itself");
    assert(text.includes('"device":"phoneA"'));
    const again = new ToastCodes({ file });
    assertEquals(again.check(code, "claude:s1", "retry", sig, "phoneB"), {
      ok: false,
      reason: "wrong_device",
    });
    assertEquals(again.check(code, "claude:s1", "retry", sig, "phoneA"), {
      ok: true,
    });
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
