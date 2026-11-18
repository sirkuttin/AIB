/**
 * Updates from remote devices (owner, 2026-11-16: "start updates from the phone and the remote computer"): the phone page and a
 * paired computer's page see the PC's update status (the same UpdateService status the PC's updates-ui.js shows) and may start the
 * same install the PC's Update button starts (the helper swaps the files, AIB restarts, the keeper keeps the chats running).
 *
 * A .deb install on Linux is the exception: installing it asks for the system password on the PC, and a password prompt must never
 * pop up on the PC when nobody there just asked for it. So Install from a remote device opens no prompt on a .deb install: it
 * answers 409 `password_on_pc` ("Installing AIB <version> needs your system password on the PC ... Click Install now in AIB on the
 * PC when you are ready."), and AIB on the PC shows Install now waiting for that click. `password` (true only then) lets the device
 * say so before anyone taps.
 *
 * Routes (remote/server.ts, auth kind 'update'):
 *   GET  /api/remote/update          See chats: the status below, with the notes of the waiting version
 *   POST /api/remote/update/install  Send (phone.prompt, the switch that already lets a device send to chats and stop turns):
 *                                    {whenIdle?: boolean}; the PC's postUpdateInstall (from 'remote'), answered before AIB quits
 *   POST /api/remote/update/check    See chats: check now (GitHub and, on a test build, the local feed); the page polls GET
 * The home payload carries the short form (no notes) so the phone's list shows "Update ready" without another request.
 */
import { postUpdateInstall, type ReleaseNote, type UpdateService } from '../desktop/updater.ts';

export interface RemoteUpdate {
  /** The version running now (after a restart: the new one). */
  current: string;
  /** UpdateStatus.state: 'ready' is the only one a remote device acts on. */
  state: string;
  checking: boolean;
  /** The verified version waiting to install ('' when none is ready). */
  version: string;
  /** It installs in place (the desktop app); false: a source run (install on the PC by hand). */
  canInstall: boolean;
  /** Present (true) on a .deb install: installing needs the system password on the PC; a tap here leaves Install now waiting there. */
  password?: boolean;
  /** Install when chats finish was asked for. */
  installWhenIdle: boolean;
  /** Why the last check failed, for error / refused ('' otherwise). */
  error: string;
  notes?: ReleaseNote[];
}

/** The status a remote device sees; `withNotes` adds the waiting version's notes (GET /api/remote/update only). */
export function remoteUpdate(svc: UpdateService | null | undefined, withNotes = false): RemoteUpdate | null {
  if (!svc || typeof svc.status !== 'function') return null; // tests that build a context without the updater
  const st = svc.status();
  const ready = st.state === 'ready';
  const out: RemoteUpdate = {
    current: st.current,
    state: st.state,
    checking: st.checking,
    version: ready ? String(st.available?.version ?? '') : '',
    canInstall: ready && st.inPlace,
    installWhenIdle: st.installWhenIdle,
    error: st.state === 'error' || st.state === 'refused' ? st.error : '',
  };
  if (ready && st.password) out.password = true;
  if (withNotes) out.notes = ready ? svc.upcomingNotes() : [];
  return out;
}

/** POST /api/remote/update/install: the PC's install route with only {whenIdle} taken from the device; never a password prompt. */
export async function remoteInstall(svc: UpdateService, body: Record<string, unknown> | null): Promise<[number, Record<string, unknown>]> {
  const whenIdle = body?.whenIdle === true;
  const [status, reply] = await postUpdateInstall(svc, { whenIdle }, 'remote');
  return [status, { ...reply, update: remoteUpdate(svc) }];
}
