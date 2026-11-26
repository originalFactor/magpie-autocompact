import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionLocks } from "../lib/session-store.js";

test("session locks survive overlapping hosts and are released by a process crash", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "magpie-locks-"));
  const module = new URL("../lib/session-store.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { SessionLocks } from ${JSON.stringify(module)};
    await new SessionLocks(process.argv[1]).run("conversation", undefined, async () => {
      process.stdout.write("locked\\n");
      await new Promise(() => { setInterval(() => {}, 1000); });
    });
  `, root], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    await rm(root, { recursive: true, force: true });
  });
  await once(child.stdout, "data");
  let entered = false;
  const waiting = new SessionLocks(root).run("conversation", AbortSignal.timeout(3000), async () => { entered = true; });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(entered, false, "a different process still owns this conversation");
  // Independent sessions continue while the first session streams.
  await new SessionLocks(root).run("another", AbortSignal.timeout(500), async () => {});
  child.kill("SIGKILL"); await once(child, "exit");
  await waiting;
  assert.equal(entered, true);
});

test("a cancelled lock waiter does not release another owner's transaction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "magpie-locks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release, started;
  const ready = new Promise((r) => { started = r; });
  const owner = new SessionLocks(root).run("same", undefined, async () => { started(); await new Promise((r) => { release = r; }); });
  await ready;
  await assert.rejects(new SessionLocks(root).run("same", AbortSignal.timeout(30), () => assert.fail("cancelled waiter entered")));
  await assert.rejects(new SessionLocks(root).run("same", AbortSignal.timeout(30), () => assert.fail("owner lock released too early")));
  release(); await owner;
  await new SessionLocks(root).run("same", undefined, async () => {});
});
