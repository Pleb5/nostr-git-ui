import { describe, expect, it } from "vitest";

import { deriveBranchCopyFilterState, getUniqueBranchNames } from "./fork-branch-filter";

describe("fork-branch-filter", () => {
  it("deduplicates and trims branch names", () => {
    expect(getUniqueBranchNames([" main ", "main", "release", "", "release "])).toEqual([
      "main",
      "release",
    ]);
  });

  it("shows toggle mode when trusted branches are a subset of a large repo", () => {
    const state = deriveBranchCopyFilterState({
      branchNames: ["main", "release", "feature"],
      branchCopyFilter: {
        branchNames: ["release"],
        label: "Copy only trusted branches",
        minBranchCount: 2,
        status: "ready",
      },
    });

    expect(state.mode).toBe("toggle");
    expect(state.trustedBranchNames).toEqual(["release"]);
  });

  it("shows empty mode when no trusted branches are found for a large repo", () => {
    const state = deriveBranchCopyFilterState({
      branchNames: ["main", "release", "feature"],
      branchCopyFilter: {
        branchNames: [],
        label: "Copy only trusted branches",
        minBranchCount: 2,
        status: "ready",
      },
    });

    expect(state.mode).toBe("empty");
    expect(state.totalBranches).toBe(3);
  });

  it("hides the branch filter below the threshold", () => {
    const state = deriveBranchCopyFilterState({
      branchNames: ["main", "release"],
      branchCopyFilter: {
        branchNames: ["release"],
        label: "Copy only trusted branches",
        minBranchCount: 20,
        status: "ready",
      },
    });

    expect(state.mode).toBe("hidden");
  });

  it("shows loading mode while trust metrics are still resolving", () => {
    const state = deriveBranchCopyFilterState({
      branchNames: ["main", "release", "feature"],
      branchCopyFilter: {
        branchNames: [],
        label: "Copy only trusted branches",
        minBranchCount: 2,
        status: "loading",
      },
    });

    expect(state.mode).toBe("loading");
    expect(state.totalBranches).toBe(3);
  });
});
