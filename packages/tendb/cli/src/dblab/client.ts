import { z } from "zod";
import { CapacityError, TenDBError } from "../errors.js";
import {
  branchSchema,
  cloneSchema,
  snapshotSchema,
  statusSchema,
  type Branch,
  type Clone,
  type InstanceStatus,
  type Snapshot,
} from "./types.js";

/** Substrings that mark a clone-create failure as capacity exhaustion. */
const CAPACITY_RE = /exhaust|no (available|free) (port|clone)|out of ports|too many clones|port pool/i;

/**
 * Already-gone signals across DLE 4.1.x's inconsistent grammar, e.g.
 * "clone not found" (500) and "failed to found dataset of the branch" (400).
 */
const GONE_RE = /not found|failed to found|no such|does not exist/i;

export class DblabClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown; text: string }> {
    const headers: Record<string, string> = { "Verification-Token": this.token };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new TenDBError(
        `cannot reach DBLab API at ${this.baseUrl}: ${(err as Error).message}`,
        1,
        "is the tunnel/engine up? try `tendb status`",
      );
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed, text };
  }

  private errorMessage(body: unknown, text: string): string {
    if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
      return body.message;
    }
    return text.slice(0, 500) || "(empty response body)";
  }

  private fail(op: string, status: number, body: unknown, text: string): never {
    throw new TenDBError(`${op} failed (HTTP ${status}): ${this.errorMessage(body, text)}`);
  }

  async healthz(): Promise<boolean> {
    try {
      const { status } = await this.request("GET", "/healthz");
      return status === 200;
    } catch {
      return false;
    }
  }

  async status(): Promise<InstanceStatus> {
    const { status, body, text } = await this.request("GET", "/status");
    if (status !== 200) this.fail("get status", status, body, text);
    return statusSchema.parse(body);
  }

  async listSnapshots(): Promise<Snapshot[]> {
    const { status, body, text } = await this.request("GET", "/snapshots");
    if (status !== 200) this.fail("list snapshots", status, body, text);
    return z.array(snapshotSchema).parse(body ?? []);
  }

  async listBranches(): Promise<Branch[]> {
    const { status, body, text } = await this.request("GET", "/branches");
    if (status !== 200) this.fail("list branches", status, body, text);
    return z.array(branchSchema).parse(body ?? []);
  }

  async createBranch(branchName: string, baseBranch = "main"): Promise<void> {
    const { status, body, text } = await this.request("POST", "/branch", { branchName, baseBranch });
    if (status !== 200 && status !== 201) this.fail(`create branch ${branchName}`, status, body, text);
  }

  /** Already-gone counts as success (DLE 4.1.x answers 500 "… not found", not 404). */
  async deleteBranch(branchName: string): Promise<void> {
    const { status, body, text } = await this.request("DELETE", `/branch/${branchName}`);
    if ([200, 204, 404].includes(status)) return;
    if (GONE_RE.test(this.errorMessage(body, text))) return;
    this.fail(`delete branch ${branchName}`, status, body, text);
  }

  /** Returns null when the clone does not exist. */
  async getClone(id: string): Promise<Clone | null> {
    const { status, body, text } = await this.request("GET", `/clone/${id}`);
    if (status === 404) return null;
    if (status !== 200) this.fail(`get clone ${id}`, status, body, text);
    return cloneSchema.parse(body);
  }

  async createClone(opts: {
    id: string;
    branch: string;
    username: string;
    password: string;
  }): Promise<void> {
    const { status, body, text } = await this.request("POST", "/clone", {
      id: opts.id,
      branch: opts.branch,
      protected: false,
      db: { username: opts.username, password: opts.password, restricted: false },
    });
    if (![200, 201, 202].includes(status)) {
      const message = this.errorMessage(body, text);
      if (CAPACITY_RE.test(message)) {
        throw new CapacityError(
          `clone capacity exhausted: ${message}`,
          "delete an idle branch (`tendb branches list`) or grow the port pool (terraform `clone_port_range`)",
        );
      }
      this.fail(`create clone ${opts.id}`, status, body, text);
    }
  }

  /** Already-gone counts as success (DLE 4.1.x answers 500 "clone not found", not 404). */
  async deleteClone(id: string): Promise<void> {
    const { status, body, text } = await this.request("DELETE", `/clone/${id}`);
    if ([200, 202, 204, 404].includes(status)) return;
    if (GONE_RE.test(this.errorMessage(body, text))) return;
    this.fail(`delete clone ${id}`, status, body, text);
  }

  /**
   * Trigger a full data refresh. Endpoint availability on DLE 4.1.x is
   * probe-based: returns false when the engine does not expose it.
   */
  async fullRefresh(): Promise<boolean> {
    const { status, body, text } = await this.request("POST", "/full-refresh");
    if (status === 404 || status === 405) return false;
    if (![200, 201, 202].includes(status)) this.fail("full refresh", status, body, text);
    return true;
  }
}
