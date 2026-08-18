import type { ApiSession } from "../context.js";
import { NotFoundError, TenDBError, TimeoutError } from "../errors.js";
import { buildUri, dbUser } from "../naming.js";
import { progress } from "../output.js";
import type { Clone } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function cloneUri(session: ApiSession, clone: Clone): string {
  const host = clone.db?.host;
  const port = clone.db?.port;
  if (!host || !port) {
    throw new TenDBError(`clone ${clone.id} has no connection details (state ${clone.status.code})`);
  }
  return buildUri({
    user: clone.db?.username ?? dbUser(clone.id),
    password: session.derivePassword(clone.id),
    host,
    port,
    database: session.database(),
  });
}

/**
 * Right after the platform comes up the initial dump/restore may still be
 * running — wait until at least one snapshot exists (bash: 90 × 10 s).
 */
export async function waitForFirstSnapshot(
  session: ApiSession,
  timeoutSeconds: number,
  pollMs = 10_000,
): Promise<void> {
  progress("waiting for DBLab engine + first snapshot…");
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    try {
      const snapshots = await session.client.listSnapshots();
      if (snapshots.length > 0) return;
    } catch {
      // Engine still starting; keep polling until the deadline.
    }
    if (Date.now() > deadline) {
      throw new TimeoutError(
        `no snapshot after ${Math.round(timeoutSeconds / 60)}m`,
        "check `docker logs dblab_server` and /var/log/dblab-init.log on the host",
      );
    }
    await sleep(pollMs);
  }
}

async function waitCloneGone(session: ApiSession, id: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if ((await session.client.getClone(id)) === null) return;
    await sleep(2000);
  }
  throw new TimeoutError(`clone ${id} still present after delete`);
}

async function waitCloneOk(session: ApiSession, id: string, timeoutSeconds: number): Promise<Clone> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const clone = await session.client.getClone(id);
    if (clone === null) throw new TenDBError(`clone ${id} vanished while provisioning`);
    if (clone.status.code === "OK") return clone;
    if (clone.status.code === "FATAL") {
      throw new TimeoutError(`clone ${id} failed: ${clone.status.message ?? "(no message)"}`);
    }
    if (Date.now() > deadline) throw new TimeoutError(`clone ${id} never reached OK`);
    await sleep(2000);
  }
}

/**
 * Idempotent create-or-reuse, port of `dblab-branch.sh ensure`:
 * existing OK clone short-circuits; a wedged clone is recreated; the branch is
 * created when absent. Returns the clone and its connection URI.
 */
export async function ensureBranch(
  session: ApiSession,
  name: string,
  opts: { from?: string } = {},
): Promise<{ clone: Clone; uri: string }> {
  const existing = await session.client.getClone(name);
  if (existing?.status.code === "OK") {
    progress(`clone ${name} already running`);
    return { clone: existing, uri: cloneUri(session, existing) };
  }
  if (existing) {
    progress(`clone ${name} exists in state ${existing.status.code} — deleting and recreating`);
    await session.client.deleteClone(name);
    await waitCloneGone(session, name);
  }

  await waitForFirstSnapshot(session, session.config.snapshotTimeoutSeconds);

  const branches = await session.client.listBranches();
  if (!branches.some((b) => b.name === name)) {
    progress(`creating branch ${name}…`);
    await session.client.createBranch(name, opts.from ?? "main");
  }

  progress(`creating clone ${name} on branch ${name}…`);
  await session.client.createClone({
    id: name,
    branch: name,
    username: dbUser(name),
    password: session.derivePassword(name),
  });
  const clone = await waitCloneOk(session, name, session.config.cloneTimeoutSeconds);
  return { clone, uri: cloneUri(session, clone) };
}

/** Port of `dblab-branch.sh delete`: tolerant of absent clone/branch. */
export async function deleteBranch(session: ApiSession, name: string): Promise<void> {
  progress(`deleting clone ${name}…`);
  await session.client.deleteClone(name);
  await waitCloneGone(session, name);
  await session.client.deleteBranch(name);
  progress(`deleted branch ${name}`);
}

/**
 * Reset = recreate the clone on its existing branch (fresh copy-on-write from
 * the branch snapshot). `POST /clone/{id}/reset` is unverified on DLE 4.1.x,
 * so delete+recreate — semantics proven by the bash flow — is the
 * implementation.
 */
export async function resetBranch(session: ApiSession, name: string): Promise<{ clone: Clone; uri: string }> {
  const existing = await session.client.getClone(name);
  if (existing === null) throw new NotFoundError(`clone ${name} not found`);
  progress(`resetting ${name} (recreate on branch)…`);
  await session.client.deleteClone(name);
  await waitCloneGone(session, name);
  await session.client.createClone({
    id: name,
    branch: name,
    username: dbUser(name),
    password: session.derivePassword(name),
  });
  const clone = await waitCloneOk(session, name, session.config.cloneTimeoutSeconds);
  return { clone, uri: cloneUri(session, clone) };
}

export async function getBranchClone(session: ApiSession, name: string): Promise<{ clone: Clone; uri: string }> {
  const clone = await session.client.getClone(name);
  if (clone === null) throw new NotFoundError(`clone ${name} not found`);
  return { clone, uri: cloneUri(session, clone) };
}
