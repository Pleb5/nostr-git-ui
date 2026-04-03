import { describe, expect, it } from "vitest";

import { getForkRollbackPlan } from "./fork-rollback";

describe("fork rollback policy", () => {
  it("rolls back a GRASP fork only when no refs landed", () => {
    const plan = getForkRollbackPlan({
      provider: "grasp",
      publishAttempted: true,
      graspEventsPublished: true,
      graspPushCompleted: false,
      graspPushAttempted: true,
      graspPushedRefsCount: 0,
      hasPublishedRepoRollbackContext: true,
      hasRollbackPublishedRepoEvents: true,
      hasRollbackRemoteUrl: true,
      hasProviderToken: true,
      hasGitWorkerApi: true,
      hasRollbackLocalRepoId: true,
    });

    expect(plan).toEqual({
      rollbackGraspArtifacts: true,
      rollbackPublishedEvents: true,
      rollbackRemoteRepo: false,
      rollbackLocalRepo: true,
      hasAnyRollback: true,
    });
  });

  it("does not roll back a partial GRASP push after refs landed", () => {
    const plan = getForkRollbackPlan({
      provider: "grasp",
      publishAttempted: true,
      graspEventsPublished: true,
      graspPushCompleted: false,
      graspPushAttempted: true,
      graspPushedRefsCount: 1,
      hasPublishedRepoRollbackContext: true,
      hasRollbackPublishedRepoEvents: true,
      hasRollbackRemoteUrl: true,
      hasProviderToken: true,
      hasGitWorkerApi: true,
      hasRollbackLocalRepoId: true,
    });

    expect(plan).toEqual({
      rollbackGraspArtifacts: false,
      rollbackPublishedEvents: false,
      rollbackRemoteRepo: false,
      rollbackLocalRepo: false,
      hasAnyRollback: false,
    });
  });

  it("rolls back non-GRASP fork artifacts after publish fails", () => {
    const plan = getForkRollbackPlan({
      provider: "github",
      publishAttempted: true,
      graspEventsPublished: false,
      graspPushCompleted: false,
      graspPushAttempted: false,
      graspPushedRefsCount: 0,
      hasPublishedRepoRollbackContext: true,
      hasRollbackPublishedRepoEvents: true,
      hasRollbackRemoteUrl: true,
      hasProviderToken: true,
      hasGitWorkerApi: true,
      hasRollbackLocalRepoId: true,
    });

    expect(plan).toEqual({
      rollbackGraspArtifacts: false,
      rollbackPublishedEvents: true,
      rollbackRemoteRepo: true,
      rollbackLocalRepo: true,
      hasAnyRollback: true,
    });
  });

  it("skips rollback when a non-GRASP fork failed before publish", () => {
    const plan = getForkRollbackPlan({
      provider: "github",
      publishAttempted: false,
      graspEventsPublished: false,
      graspPushCompleted: false,
      graspPushAttempted: false,
      graspPushedRefsCount: 0,
      hasPublishedRepoRollbackContext: true,
      hasRollbackPublishedRepoEvents: true,
      hasRollbackRemoteUrl: true,
      hasProviderToken: true,
      hasGitWorkerApi: true,
      hasRollbackLocalRepoId: true,
    });

    expect(plan).toEqual({
      rollbackGraspArtifacts: false,
      rollbackPublishedEvents: false,
      rollbackRemoteRepo: false,
      rollbackLocalRepo: false,
      hasAnyRollback: false,
    });
  });
});
