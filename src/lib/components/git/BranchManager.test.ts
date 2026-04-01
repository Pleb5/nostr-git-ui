import { beforeEach, describe, expect, it, vi } from "vitest";

import { BranchManager } from "./BranchManager";

vi.mock("$lib/stores/context", () => ({
  context: {
    loading: vi.fn(() => null),
    remove: vi.fn(),
    update: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("$lib/stores/toast", () => ({
  toast: {
    push: vi.fn(),
  },
}));

describe("BranchManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces optimistic stale heads with discovered refs", async () => {
    const vendorReadRouter = {
      listRefs: vi.fn(async () => ({
        refs: [
          {
            name: "add-logos",
            type: "heads",
            fullRef: "refs/heads/add-logos",
            commitId: "abc123",
          },
          {
            name: "ci/nostr-release",
            type: "heads",
            fullRef: "refs/heads/ci/nostr-release",
            commitId: "def456",
          },
        ],
        fromVendor: false,
        source: {
          kind: "git-remote",
          label: "Git remote",
          remoteUrl: "https://relay.example/repo.git",
        },
      })),
    };

    const manager = new BranchManager({} as any, undefined, {
      vendorReadRouter: vendorReadRouter as any,
    });

    manager.setRepoEvent({
      id: "repo-event",
      pubkey: "owner",
      kind: 30617,
      created_at: 1,
      content: "",
      sig: "sig",
      tags: [["d", "repo"]],
    } as any);

    manager.processRepoStateEvent({
      id: "state-event",
      pubkey: "owner",
      kind: 30618,
      created_at: 1,
      content: "",
      sig: "sig",
      tags: [
        ["HEAD", "ref: refs/heads/maint"],
        ["refs/heads/maint", "111111"],
        ["refs/heads/openwrt-apk", "222222"],
      ],
    } as any);

    manager.setSelectedBranch("maint");

    await manager.loadAllRefs(async () => [
      {
        name: "maint",
        type: "heads",
        fullRef: "refs/heads/maint",
        commitId: "111111",
      },
      {
        name: "openwrt-apk",
        type: "heads",
        fullRef: "refs/heads/openwrt-apk",
        commitId: "222222",
      },
    ]);

    expect(manager.getAllRefs().map((ref) => ref.name)).toEqual(["add-logos", "ci/nostr-release"]);
    expect(manager.getMainBranch()).toBe("add-logos");
    expect(manager.getSelectedBranch()).toBe("add-logos");
    expect(manager.getRefDiscoverySource()?.kind).toBe("git-remote");
  });

  it("filters peeled tags from repo-state refs", async () => {
    const manager = new BranchManager({} as any);

    manager.processRepoStateEvent({
      id: "state-event",
      pubkey: "owner",
      kind: 30618,
      created_at: 1,
      content: "",
      sig: "sig",
      tags: [
        ["HEAD", "ref: refs/heads/add-logos"],
        ["refs/heads/add-logos", "111111"],
        ["refs/tags/v0.2.0", "222222"],
        ["refs/tags/v0.2.0^{}", "333333"],
      ],
    } as any);

    await manager.loadAllRefs(async () => [
      {
        name: "add-logos",
        type: "heads",
        fullRef: "refs/heads/add-logos",
        commitId: "111111",
      },
      {
        name: "v0.2.0",
        type: "tags",
        fullRef: "refs/tags/v0.2.0",
        commitId: "222222",
      },
      {
        name: "v0.2.0^{}",
        type: "tags",
        fullRef: "refs/tags/v0.2.0^{}",
        commitId: "333333",
      },
    ]);

    expect(manager.getAllRefs().map((ref) => ref.name)).toEqual(["add-logos", "v0.2.0"]);
  });

  it("reports repo-state snapshot when no remote discovery is available", async () => {
    const manager = new BranchManager({} as any);

    await manager.loadAllRefs(async () => [
      {
        name: "maint",
        type: "heads",
        fullRef: "refs/heads/maint",
        commitId: "111111",
      },
    ]);

    expect(manager.getRefDiscoverySource()?.kind).toBe("repo-state");
  });
});
