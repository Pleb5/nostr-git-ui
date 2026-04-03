export interface ForkRollbackPlanInput {
  provider: string;
  publishAttempted: boolean;
  graspEventsPublished: boolean;
  graspPushCompleted: boolean;
  graspPushAttempted: boolean;
  graspPushedRefsCount: number;
  hasPublishedRepoRollbackContext: boolean;
  hasRollbackPublishedRepoEvents: boolean;
  hasRollbackRemoteUrl: boolean;
  hasProviderToken: boolean;
  hasGitWorkerApi: boolean;
  hasRollbackLocalRepoId: boolean;
}

export interface ForkRollbackPlan {
  rollbackGraspArtifacts: boolean;
  rollbackPublishedEvents: boolean;
  rollbackRemoteRepo: boolean;
  rollbackLocalRepo: boolean;
  hasAnyRollback: boolean;
}

export function getForkRollbackPlan(input: ForkRollbackPlanInput): ForkRollbackPlan {
  const rollbackGraspArtifacts =
    input.provider === "grasp" &&
    !input.graspPushCompleted &&
    input.graspPushedRefsCount === 0 &&
    (input.publishAttempted || input.graspEventsPublished || input.graspPushAttempted);

  const rollbackPublishedEvents =
    input.hasPublishedRepoRollbackContext &&
    input.hasRollbackPublishedRepoEvents &&
    (rollbackGraspArtifacts || (input.provider !== "grasp" && input.publishAttempted));

  const rollbackRemoteRepo =
    input.provider !== "grasp" &&
    input.publishAttempted &&
    input.hasRollbackRemoteUrl &&
    input.hasProviderToken;

  const rollbackLocalRepo =
    input.hasGitWorkerApi &&
    input.hasRollbackLocalRepoId &&
    (rollbackGraspArtifacts || (input.provider !== "grasp" && input.publishAttempted));

  return {
    rollbackGraspArtifacts,
    rollbackPublishedEvents,
    rollbackRemoteRepo,
    rollbackLocalRepo,
    hasAnyRollback: rollbackPublishedEvents || rollbackRemoteRepo || rollbackLocalRepo,
  };
}
