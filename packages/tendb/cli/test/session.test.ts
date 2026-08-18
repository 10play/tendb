import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MockDblab } from "./mock-dblab.js";
import { startPortForward, type Tunnel } from "../src/aws/session.js";
import type { SsmFacade, StartedSession } from "../src/aws/params.js";

const fakeBinDir = join(dirname(fileURLToPath(import.meta.url)), "bin");

let mock: MockDblab;
let mockUrl: string;
let terminated: string[];
let tunnel: Tunnel | undefined;

function fakeSsm(): SsmFacade {
  return {
    region: async () => "eu-north-1",
    profile: undefined,
    getParameter: async () => null,
    putParameter: async () => {},
    startSession: async (): Promise<StartedSession> => ({
      sessionId: "sess-1",
      tokenValue: "tok",
      // The fake plugin proxies to whatever StreamUrl points at.
      streamUrl: mockUrl.replace("http://", "tcp://"),
    }),
    terminateSession: async (id) => {
      terminated.push(id);
    },
  };
}

beforeAll(() => {
  process.env.PATH = `${fakeBinDir}:${process.env.PATH}`;
});

beforeEach(async () => {
  mock = new MockDblab();
  mockUrl = await mock.listen();
  terminated = [];
});

afterEach(async () => {
  await tunnel?.close();
  tunnel = undefined;
  await mock.close();
});

describe("startPortForward", () => {
  it("spawns the plugin with the six-argv contract and forwards TCP", async () => {
    tunnel = await startPortForward(fakeSsm(), { instanceId: "i-0abc", remotePort: 2345 });
    const res = await fetch(`http://127.0.0.1:${tunnel.localPort}/healthz`);
    expect(res.status).toBe(200);
  });

  it("terminates the SSM session on close", async () => {
    tunnel = await startPortForward(fakeSsm(), { instanceId: "i-0abc", remotePort: 2345 });
    await tunnel.close();
    expect(terminated).toEqual(["sess-1"]);
    tunnel = undefined;
  });

  it("honors an explicit local port", async () => {
    const explicit = 39_431;
    tunnel = await startPortForward(fakeSsm(), { instanceId: "i-0abc", remotePort: 2345, localPort: explicit });
    expect(tunnel.localPort).toBe(explicit);
    const res = await fetch(`http://127.0.0.1:${explicit}/healthz`);
    expect(res.status).toBe(200);
  });
});
