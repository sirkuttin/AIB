/**
 * Owner decision (steer-on-send, final): "Inbox and phone replies the owner types steer too." End to end for the phone: a real Studio
 * (web server + separate agent host) with phone access on (a fake Tailscale CLI) and the steer fakes of work/fake_acp.py. A paired
 * phone's POST /api/remote/steer (what its Send button calls while the chat works and the snapshot says `steerable`):
 *  - goes in at once during the turn on a steerable agent, shown once as the user's bubble tagged `steered`;
 *  - is an ordinary prompt when the agent is idle;
 *  - waits for the turn to end on an agent that cannot steer;
 *  - is refused when the phone's Send switch (phone.prompt) is off, and nothing reaches the agent.
 * The phone snapshot carries `steerable`. The page side (which route Send picks, the "Sent while working" tag) is in
 * remote_phone_e2e_test.ts.
 */
import { assert, assertEquals } from "./_assert.ts";
import {
  DENO,
  httpJson,
  type Json,
  nativePath,
  SEP,
  sleep,
  until,
  type Web,
} from "./_host_fixture.ts";
import { WORK } from "./_parity.ts";
import { pickPort } from "./_ports.ts";
import {
  nonce,
  phoneHeaders,
  raw,
  serveStatus,
  tailscaleStatus,
} from "./_remote_fixture.ts";
import {
  type LabOptions,
  type SteerChat,
  SteerLab,
  TEST_OPTIONS,
} from "./_steer_lab.ts";
import { DEVICE_HEADER } from "../../outputs/agent-studio/server/remote/server.ts";

const LONG = 45;
const FAKE_TAILSCALE = nativePath(new URL("deno/_fake_tailscale.ts", WORK));

class PhoneSteerLab extends SteerLab {
  readonly phonePort = pickPort();
  readonly artifactPort = pickPort();
  readonly answers: string;
  constructor(options: LabOptions = {}) {
    super(options);
    this.answers = this.root + SEP + "tailscale.json";
    Deno.writeTextFileSync(
      this.state + SEP + "remote-port.json",
      JSON.stringify({
        version: 1,
        port: this.phonePort,
        artifactPort: this.artifactPort,
      }),
    );
    Deno.writeTextFileSync(
      this.state + SEP + "phone-access.json",
      JSON.stringify({ version: 1, on: true, via: "tailscale" }),
    );
    Deno.writeTextFileSync(
      this.answers,
      JSON.stringify({
        status: tailscaleStatus(),
        serve: serveStatus(this.phonePort, false),
      }),
    );
  }
  override get env(): Record<string, string> {
    return {
      ...super.env,
      AIB_TAILSCALE_CLI: JSON.stringify([
        DENO,
        "run",
        "-A",
        "--quiet",
        FAKE_TAILSCALE,
        this.answers,
      ]),
      AIB_TEST_REMOTE_BIND_MS: "1500",
    };
  }
}

async function started(options?: LabOptions) {
  const lab = new PhoneSteerLab(options);
  try {
    await lab.start();
    const web: Web = lab.web;
    const port = lab.phonePort;
    await until(
      async () =>
        (await raw(port, "GET", "/api/remote/bootstrap", phoneHeaders()))
          .status === 200,
      "the phone port",
      30,
    );
    const [, code] = await httpJson(
      "POST",
      web.port,
      "/api/live/devices/pair",
      web.token,
      {},
    );
    const claim = await raw(
      port,
      "POST",
      "/api/remote/pair/claim",
      phoneHeaders({}, "POST"),
      JSON.stringify({
        code: (code.words as string[]).join(" "),
        name: "Pixel 9",
        nonce: nonce(),
      }),
    );
    assertEquals(claim.status, 200, claim.text);
    const [, view] = await httpJson(
      "GET",
      web.port,
      "/api/live/devices",
      web.token,
    );
    const pending = ((view.pairing as Json).pending as Json[])[0];
    await httpJson("POST", web.port, "/api/live/devices/approve", web.token, {
      claim: pending.id,
    });
    const done = await raw(
      port,
      "POST",
      "/api/remote/pair/status",
      phoneHeaders({}, "POST"),
      JSON.stringify({
        claim: claim.json.claim,
        claimSecret: claim.json.claimSecret,
      }),
    );
    const token = done.json.token as string;
    const phone = {
      post: (op: string, body: Json) =>
        raw(
          port,
          "POST",
          `/api/remote/${op}`,
          phoneHeaders({ [DEVICE_HEADER]: token }, "POST"),
          JSON.stringify(body),
        ),
      chat: (id: string) =>
        raw(
          port,
          "GET",
          `/api/remote/chat?id=${id}&tail=100`,
          phoneHeaders({ [DEVICE_HEADER]: token }),
        ),
    };
    return { lab, phone, web };
  } catch (error) {
    await lab[Symbol.asyncDispose]();
    throw error;
  }
}

const userEvents = async (chat: SteerChat, text: string) =>
  (await chat.events("user")).filter((e) => (e.data as Json).text === text);
const working = (c: SteerChat) =>
  until(async () => (await c.state()).busy, "the turn is running", LONG);
const idle = (c: SteerChat) =>
  until(async () => !(await c.state()).busy, "the turn ended", LONG);

Deno.test({
  name:
    "PS1 phone Send steers a working steerable chat (shown once, steered), and is an ordinary prompt when idle",
  ...TEST_OPTIONS,
  async fn() {
    const { lab, phone } = await started();
    await using _lab = lab;
    const chat = await lab.chat("claude");
    const gate = lab.gate();
    await chat.prompt(`steer-wait:${gate}`, "first");
    await working(chat);
    const snap = await until(
      async () => {
        const c = await phone.chat(chat.id);
        return c.json.steerable === true ? c : null;
      },
      "the phone snapshot says steerable",
      LONG,
    );
    assertEquals(snap.json.busy, true);
    const r = await phone.post("steer", {
      id: chat.id,
      text: "from the phone",
      clientMessageId: "phone-s1",
    });
    assertEquals(r.status, 200, r.text);
    await until(
      async () =>
        (await chat.agentText()).includes("Steered reply: from the phone"),
      "the steered reply",
      LONG,
    );
    assertEquals(lab.steersReceived(chat).map((s) => s.text), [
      "from the phone",
    ]);
    assertEquals(
      lab.promptsReceived(chat),
      [`steer-wait:${gate}`],
      "it went in during the turn, not as a prompt",
    );
    const bubbles = await userEvents(chat, "from the phone");
    assertEquals(bubbles.length, 1);
    assertEquals((bubbles[0].data as Json).steered, true);
    const seen = JSON.stringify((await phone.chat(chat.id)).json.events);
    assert(
      seen.includes('"steered":true'),
      "the phone page gets the steered flag on the user event",
    );
    chat.open(gate);
    await idle(chat);
    assertEquals(
      (await phone.chat(chat.id)).json.steerable,
      false,
      "idle: not steerable",
    );
    const idleSend = await phone.post("steer", {
      id: chat.id,
      text: "and now idle",
      clientMessageId: "phone-s2",
    });
    assertEquals(idleSend.status, 200, idleSend.text);
    await until(
      async () =>
        (await chat.agentText()).includes("Fixture reply: and now idle"),
      "the idle reply",
      LONG,
    );
    assertEquals(
      lab.steersReceived(chat).length,
      1,
      "idle: an ordinary prompt, nothing steered",
    );
    assert(lab.promptsReceived(chat).includes("and now idle"));
    assert(!((await userEvents(chat, "and now idle"))[0].data as Json).steered);
    // a "/" command is still refused on the steer route
    const cmd = await phone.post("steer", {
      id: chat.id,
      text: "/compact",
      clientMessageId: "phone-s3",
    });
    assertEquals([cmd.status, cmd.json.code], [403, "text_only"]);
  },
});

Deno.test({
  name:
    "PS2 phone Send to an agent that cannot steer waits for the turn to end",
  ...TEST_OPTIONS,
  async fn() {
    const { lab, phone } = await started({ plain: ["claude"] });
    await using _lab = lab;
    const chat = await lab.chat("claude");
    const gate = lab.gate();
    await chat.prompt(`gate:${gate}`, "first");
    await working(chat);
    assertEquals(
      (await phone.chat(chat.id)).json.steerable,
      false,
      "the phone snapshot says not steerable",
    );
    const r = await phone.post("steer", {
      id: chat.id,
      text: "later from phone",
      clientMessageId: "phone-p1",
    });
    assertEquals(r.status, 200, r.text);
    await sleep(1500);
    assertEquals(
      lab.steersReceived(chat).length,
      0,
      "nothing injected mid-turn",
    );
    assertEquals(
      lab.promptsReceived(chat).includes("later from phone"),
      false,
      "nothing sent mid-turn",
    );
    chat.open(gate);
    await until(
      () => lab.promptsReceived(chat).includes("later from phone"),
      "sent after the turn",
      LONG,
    );
    assertEquals(
      lab.promptsReceived(chat).filter((t) => t === "later from phone").length,
      1,
    );
    assertEquals(lab.steersReceived(chat).length, 0);
  },
});

Deno.test({
  name:
    "PS3 phone Send is refused when the phone Send switch is off: nothing reaches the agent; back on, it steers",
  ...TEST_OPTIONS,
  async fn() {
    const { lab, phone, web } = await started();
    await using _lab = lab;
    const chat = await lab.chat("claude");
    const gate = lab.gate();
    await chat.prompt(`steer-wait:${gate}`, "first");
    await working(chat);
    const [, devices] = await httpJson(
      "GET",
      web.port,
      "/api/live/devices",
      web.token,
    );
    const id = (devices.devices as Json[])[0].id as string;
    assertEquals(
      (await httpJson("POST", web.port, "/api/live/devices/scopes", web.token, {
        id,
        scopes: ["phone.read"],
      }))[0],
      200,
    );
    const off = await phone.post("steer", {
      id: chat.id,
      text: "should not go",
      clientMessageId: "phone-o1",
    });
    assertEquals(off.status, 403, off.text);
    await sleep(1200);
    assertEquals(lab.steersReceived(chat).length, 0);
    assertEquals(lab.promptsReceived(chat), [`steer-wait:${gate}`]);
    await httpJson("POST", web.port, "/api/live/devices/scopes", web.token, {
      id,
      scopes: ["phone.read", "phone.answer", "phone.prompt", "phone.approve"],
    });
    const on = await phone.post("steer", {
      id: chat.id,
      text: "now it goes",
      clientMessageId: "phone-o2",
    });
    assertEquals(on.status, 200, on.text);
    await until(
      async () =>
        (await chat.agentText()).includes("Steered reply: now it goes"),
      "the steered reply",
      LONG,
    );
    assertEquals(lab.steersReceived(chat).map((s) => s.text), ["now it goes"]);
    chat.open(gate);
    await idle(chat);
  },
});
