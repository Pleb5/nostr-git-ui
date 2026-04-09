import { describe, expect, it, vi } from "vitest";

import { VendorReadRouter } from "./VendorReadRouter";

describe("VendorReadRouter.listRefs", () => {
  it("uses advertised git refs for non-vendor remotes", async () => {
    const router = new VendorReadRouter({
      getTokens: async () => [],
      preferVendorReads: true,
    });

    const workerManager = {
      listServerRefs: vi.fn(async () => [
        { ref: "HEAD", oid: "head" },
        { ref: "refs/heads/add-logos", oid: "111111" },
        { ref: "refs/heads/openwrt-packaging", oid: "222222" },
        { ref: "refs/tags/v0.2.0", oid: "333333" },
        { ref: "refs/tags/v0.2.0^{}", oid: "444444" },
      ]),
      listBranchesFromEvent: vi.fn(async () => []),
    } as any;

    const result = await router.listRefs({
      workerManager,
      repoEvent: { id: "repo", pubkey: "owner", tags: [] } as any,
      cloneUrls: ["https://example.com/owner/repo.git"],
    });

    expect(result.source.kind).toBe("git-remote");
    expect(result.refs.map((ref) => ref.name)).toEqual([
      "add-logos",
      "openwrt-packaging",
      "v0.2.0",
    ]);
    expect(workerManager.listServerRefs).toHaveBeenCalledTimes(1);
    expect(workerManager.listBranchesFromEvent).not.toHaveBeenCalled();
  });

  it("skips vendor REST reads for GRASP clone URLs and uses git refs directly", async () => {
    const router = new VendorReadRouter({
      getTokens: async () => [],
      preferVendorReads: true,
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const workerManager = {
      listServerRefs: vi.fn(async () => [
        { ref: "HEAD", oid: "head" },
        { ref: "refs/heads/main", oid: "111111" },
      ]),
      listBranchesFromEvent: vi.fn(async () => []),
    } as any;

    const result = await router.listRefs({
      workerManager,
      repoEvent: { id: "repo", pubkey: "owner", tags: [] } as any,
      cloneUrls: [
        "https://gitnostr.com/npub16p8v7varqwjes5hak6q7mz6pygqm4pwc6gve4mrned3xs8tz42gq7kfhdw/repo.git",
      ],
    });

    expect(result.source.kind).toBe("git-remote");
    expect(workerManager.listServerRefs).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
