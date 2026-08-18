import { describe, expect, it } from "vitest";
import { buildUri, dbUser, derivePassword, normalizeBranchName } from "../src/naming.js";
import { UsageError } from "../src/errors.js";

describe("derivePassword", () => {
  // Golden vectors computed with the on-host bash pipeline:
  //   printf "%s" "<token>:<clone>" | sha256sum | cut -c1-32
  it("matches the bash sha256 derivation bit-for-bit", () => {
    expect(derivePassword("testtoken123", "pr-42")).toBe("c9187738e9adeab249bd0c0dceaff1c6");
    expect(derivePassword("s3cr3t-TOKEN_abc", "smoke-1")).toBe("a85af5bae09782bde5200a3548f7daef");
  });
});

describe("normalizeBranchName", () => {
  it("maps bare PR numbers to pr-<n>", () => {
    expect(normalizeBranchName("42")).toBe("pr-42");
  });
  it("passes through valid names", () => {
    expect(normalizeBranchName("pr-42")).toBe("pr-42");
    expect(normalizeBranchName("smoke-1")).toBe("smoke-1");
  });
  it("rejects invalid names", () => {
    expect(() => normalizeBranchName("Bad_Name")).toThrow(UsageError);
    expect(() => normalizeBranchName("-leading")).toThrow(UsageError);
  });
});

describe("dbUser / buildUri", () => {
  it("swaps dashes for underscores", () => {
    expect(dbUser("pr-42")).toBe("pr_42");
  });
  it("builds the same URI shape as the bash clone_uri", () => {
    expect(
      buildUri({ user: "pr_42", password: "abc", host: "10.0.0.9", port: 6001, database: "app" }),
    ).toBe("postgres://pr_42:abc@10.0.0.9:6001/app");
  });
});
