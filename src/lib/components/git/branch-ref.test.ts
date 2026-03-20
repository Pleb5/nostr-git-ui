import { describe, expect, it } from "vitest";
import { normalizeGitRefName } from "./branch-ref";

describe("normalizeGitRefName", () => {
  it("preserves slash-containing branch names", () => {
    expect(normalizeGitRefName("fix/ipk-builds")).toBe("fix/ipk-builds");
    expect(normalizeGitRefName("ci/nostr-release")).toBe("ci/nostr-release");
  });

  it("normalizes known git ref prefixes", () => {
    expect(normalizeGitRefName("refs/heads/fix/ipk-builds")).toBe("fix/ipk-builds");
    expect(normalizeGitRefName("refs/remotes/origin/ci/nostr-release")).toBe("ci/nostr-release");
    expect(normalizeGitRefName("origin/fix/ipk-builds")).toBe("fix/ipk-builds");
  });

  it("supports HEAD-style symbolic ref values", () => {
    expect(normalizeGitRefName("ref: refs/heads/main")).toBe("main");
    expect(normalizeGitRefName("ref: refs/heads/feature/x")).toBe("feature/x");
  });
});
