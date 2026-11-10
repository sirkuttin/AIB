/**
 * Shared by worktree_merge_test.ts and worktree_merge_clash_test.ts (one file split in two so the halves run in parallel): a chat
 * with a worktree over a fake studio, and the small helpers both use. Only temp folders.
 */
import { assertEquals, assertRejects } from "./_assert.ts";
import { FakeStudio, runGit, Sandbox } from "./_worktree_fixtures.ts";
import * as wt from "../../outputs/agent-studio/server/worktrees/worktrees.ts";
import * as m from "../../outputs/agent-studio/server/worktrees/merge.ts";

export const { merge, Refused, WAITING } = m;

export interface Ctx {
  box: Sandbox;
  studio: FakeStudio;
  manager: wt.Manager;
  wt: string;
  id: string;
  key: string;
}

export async function chat(
  box: Sandbox,
  id = "c1",
  key = "a".repeat(32),
  studio?: FakeStudio,
): Promise<Ctx> {
  runGit(box.project, "config", "core.autocrlf", "false"); // the helpers commit with autocrlf off: keep checkouts byte for byte
  const manager = new wt.Manager(box.state);
  const plan = (await manager.plan(box.project, key))!;
  await manager.create(plan);
  studio ??= new FakeStudio(box.state);
  studio.add(id, plan.path);
  return { box, studio, manager, wt: plan.path, id, key };
}

export async function refused(
  ctx: Ctx,
  code: string,
  fromTool = false,
): Promise<string> {
  const error = await assertRejects(
    () => merge(ctx.studio, ctx.id, "T", fromTool),
    Refused,
  ) as m.Refused;
  assertEquals(error.code, code, error.message);
  return error.message;
}

export function record(ctx: Ctx): wt.WorktreeRecord & { key: string } {
  return { ...ctx.manager.registry.get(ctx.key)!, key: ctx.key };
}

export const main = (ctx: Ctx) => runGit(ctx.box.project, "rev-parse", "main").trim();
export const tree = (ctx: Ctx, ref = "main") =>
  runGit(ctx.box.project, "ls-tree", "-r", "--name-only", ref).split("\n")
    .filter(Boolean);
export const show = (ctx: Ctx, spec: string) => runGit(ctx.box.project, "show", spec);
