import type { RepoAnnouncementEvent, RepoStateEvent } from "@nostr-git/core/events";
import type { Token } from "$lib/stores/tokens";
import { createRepoAnnouncementEvent, createRepoStateEvent } from "@nostr-git/core/events";
import { nip19 } from "nostr-tools";
import { tokens as tokensStore } from "$lib/stores/tokens";
import { getGitServiceApi } from "@nostr-git/core/git";
import { tryTokensForHost, getTokensForHost } from "../utils/tokenHelpers.js";
import {
  createGraspAnnouncementAndState,
  didRelayAckGraspEvents,
  extractPublishRelayAck,
  type GraspPublishRelayAck,
  toNpubOrSelf,
  waitForGraspProvisioning,
} from "../utils/grasp-pipeline.js";

// Types for fork configuration and progress
export interface ForkConfig {
  forkName: string;
  visibility?: "public" | "private"; // Optional since NIP-34 doesn't support private/public repos yet
  provider?: "github" | "gitlab" | "gitea" | "bitbucket" | "grasp";
  relayUrl?: string; // Required for GRASP
  earliestUniqueCommit?: string; // Optional commit hash to identify the fork
  tags?: string[]; // NIP-34 topic tags
  maintainers?: string[]; // Additional maintainers
  relays?: string[]; // Preferred relays
  workflowFilesAction?: "include" | "omit";
}

export interface ForkProgress {
  step: string;
  message: string;
  status: "pending" | "running" | "completed" | "error";
  error?: string;
}

export interface ForkResult {
  repoId: string;
  forkUrl: string;
  defaultBranch: string;
  branches: string[];
  tags: string[];
  announcementEvent: RepoAnnouncementEvent;
  stateEvent: RepoStateEvent;
  pushReport?: {
    pushedRefs: string[];
    failedRefs: Array<{ ref: string; error: string }>;
    warnings: string[];
    partialSuccess: boolean;
  };
}

export interface ForkWorkflowDecision {
  requiresWorkflowDecision: true;
  workflowFiles: string[];
  error: string;
}

export type ForkRepositoryResult = ForkResult | ForkWorkflowDecision;

export interface UseForkRepoOptions {
  workerApi?: any; // Git worker API instance (optional for backward compatibility)
  userPubkey?: string; // Nostr pubkey of the user creating the fork (required for maintainers)
  onProgress?: (progress: ForkProgress[]) => void;
  onForkCompleted?: (result: ForkResult) => void;
  onPublishEvent?: (event: RepoAnnouncementEvent | RepoStateEvent) => Promise<unknown>;
  onRollbackPublishedRepoEvents?: (params: { repoName: string; relays: string[] }) => Promise<void>;
}

/**
 * Parsed fork error information
 */
interface ParsedForkError {
  type: "FORK_OWN_REPO" | "FORK_EXISTS" | "FORK_NAME_MISMATCH" | "UNKNOWN";
  forkName?: string;
  forkUrl?: string;
  provider?: string;
  originalMessage: string;
}

/**
 * Parse structured fork error messages into a typed format
 */
function parseForkErrorStructure(errorMessage: string): ParsedForkError {
  const result: ParsedForkError = {
    type: "UNKNOWN",
    originalMessage: errorMessage,
  };

  // Check for FORK_OWN_REPO
  if (errorMessage.includes("FORK_OWN_REPO:")) {
    result.type = "FORK_OWN_REPO";
    return result;
  }

  // Check for FORK_EXISTS
  if (errorMessage.includes("FORK_EXISTS:")) {
    result.type = "FORK_EXISTS";
    // Try multiple patterns to extract fork name and URL
    const patterns = [
      /named "([^"]+)".*?(?:GitHub|GitLab|Bitbucket|Gitea)?.*?URL: (.+)/,
      /named "([^"]+)".*?URL: (.+)/,
      /"([^"]+)".*?URL: (.+)/,
    ];

    for (const pattern of patterns) {
      const match = errorMessage.match(pattern);
      if (match) {
        result.forkName = match[1];
        result.forkUrl = match[2];
        break;
      }
    }

    // Extract provider from message
    if (errorMessage.includes("GitHub")) {
      result.provider = "github";
    } else if (errorMessage.includes("GitLab")) {
      result.provider = "gitlab";
    } else if (errorMessage.includes("Bitbucket")) {
      result.provider = "bitbucket";
    } else if (errorMessage.includes("Gitea")) {
      result.provider = "gitea";
    }

    return result;
  }

  // Check for FORK_NAME_MISMATCH
  if (errorMessage.includes("FORK_NAME_MISMATCH:")) {
    result.type = "FORK_NAME_MISMATCH";
    // Try multiple patterns to extract fork name and URL
    const patterns = [
      /name "([^"]+)".*?URL: (.+)/,
      /named "([^"]+)".*?URL: (.+)/,
      /"([^"]+)".*?URL: (.+)/,
    ];

    for (const pattern of patterns) {
      const match = errorMessage.match(pattern);
      if (match) {
        result.forkName = match[1];
        result.forkUrl = match[2];
        break;
      }
    }

    // Extract provider from message
    if (errorMessage.includes("GitHub")) {
      result.provider = "github";
    } else if (errorMessage.includes("GitLab")) {
      result.provider = "gitlab";
    } else if (errorMessage.includes("Bitbucket")) {
      result.provider = "bitbucket";
    } else if (errorMessage.includes("Gitea")) {
      result.provider = "gitea";
    }

    return result;
  }

  return result;
}

/**
 * Convert parsed fork error into user-friendly message
 */
function formatForkErrorMessage(
  parsed: ParsedForkError,
  defaultProvider: string = "github"
): string {
  const provider = parsed.provider || defaultProvider;
  const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);

  switch (parsed.type) {
    case "FORK_OWN_REPO":
      return "You cannot fork your own repository. Consider creating a new branch or working directly in the repository instead.";

    case "FORK_EXISTS": {
      if (parsed.forkName && parsed.forkUrl) {
        let providerMessage: string;
        switch (provider) {
          case "github":
            providerMessage = "GitHub does not allow multiple forks of the same repository";
            break;
          case "gitlab":
            providerMessage = "GitLab allows only one fork per namespace";
            break;
          case "bitbucket":
            providerMessage = "Bitbucket does not allow multiple forks of the same repository";
            break;
          case "gitea":
            providerMessage = "Gitea does not allow multiple forks of the same repository";
            break;
          default:
            providerMessage = `${providerName} does not allow multiple forks of the same repository`;
        }
        return `You already have a fork of this repository named "${parsed.forkName}". ${providerMessage}. You can use your existing fork or delete it first. View it at: ${parsed.forkUrl}`;
      }
      // Fallback if parsing failed
      return parsed.originalMessage.replace("FORK_EXISTS: ", "").trim();
    }

    case "FORK_NAME_MISMATCH": {
      if (parsed.forkName && parsed.forkUrl) {
        let providerMessage: string;
        switch (provider) {
          case "github":
            providerMessage = "GitHub does not support renaming existing forks";
            break;
          case "gitlab":
            providerMessage = "GitLab does not support renaming existing forks";
            break;
          case "bitbucket":
            providerMessage = "Bitbucket does not support renaming existing forks";
            break;
          case "gitea":
            providerMessage = "Gitea does not support renaming existing forks";
            break;
          default:
            providerMessage = `${providerName} does not support renaming existing forks`;
        }
        return `A fork already exists with the name "${parsed.forkName}". ${providerMessage}. Please delete the existing fork first or choose a different name. View it at: ${parsed.forkUrl}`;
      }
      // Fallback if parsing failed
      return parsed.originalMessage.replace("FORK_NAME_MISMATCH: ", "").trim();
    }

    case "UNKNOWN":
    default:
      // Return original message for unknown errors
      return parsed.originalMessage;
  }
}

/**
 * Parse and format fork errors into user-friendly messages
 */
function parseForkError(error: unknown, defaultProvider: string = "github"): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const parsed = parseForkErrorStructure(errorMessage);
  return formatForkErrorMessage(parsed, defaultProvider);
}

function dedupeCloneUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const trimmed = String(url || "").trim();

    if (!trimmed) continue;
    if (trimmed.startsWith("nostr://") || trimmed.startsWith("nostr:")) continue;

    // Never persist relay origins as clone URLs.
    try {
      const parsed = new URL(trimmed);
      const isBareOrigin = !parsed.pathname || parsed.pathname === "/";
      const isRelayProtocol = parsed.protocol === "ws:" || parsed.protocol === "wss:";
      if (isBareOrigin || isRelayProtocol) continue;
    } catch {
      // Keep non-URL forms as-is.
    }

    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

interface CloneAttemptPhase {
  type: "start" | "failed" | "succeeded";
  attempt: number;
  total: number;
  url: string;
  error?: string;
}

function parseCloneAttemptPhase(phase: string): CloneAttemptPhase | null {
  const startMatch = phase.match(/^Trying source clone URL \((\d+)\/(\d+)\):\s*(.+)$/);
  if (startMatch) {
    return {
      type: "start",
      attempt: Number(startMatch[1]),
      total: Number(startMatch[2]),
      url: String(startMatch[3] || "").trim(),
    };
  }

  const successMatch = phase.match(/^Source clone succeeded \((\d+)\/(\d+)\):\s*(.+)$/);
  if (successMatch) {
    return {
      type: "succeeded",
      attempt: Number(successMatch[1]),
      total: Number(successMatch[2]),
      url: String(successMatch[3] || "").trim(),
    };
  }

  const failureMatch = phase.match(
    /^Source clone failed \((\d+)\/(\d+)\):\s*(.+?)(?:\s*\((.*)\))?$/
  );
  if (failureMatch) {
    return {
      type: "failed",
      attempt: Number(failureMatch[1]),
      total: Number(failureMatch[2]),
      url: String(failureMatch[3] || "").trim(),
      error: String(failureMatch[4] || "").trim() || undefined,
    };
  }

  return null;
}

function compactCloneUrlLabel(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "unknown URL";
  try {
    const parsed = new URL(raw);
    const compactPath = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.host}${compactPath}`;
  } catch {
    return raw;
  }
}

function pubkeyToHexOrNull(value?: string): string | null {
  const raw = (value || "").trim();
  if (!raw) return null;

  if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();

  if (raw.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(raw);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        return decoded.data.toLowerCase();
      }
    } catch {
      return null;
    }
  }

  return null;
}

function isSamePubkeyOwner(owner: string, userPubkey?: string): boolean {
  const ownerHex = pubkeyToHexOrNull(owner);
  const userHex = pubkeyToHexOrNull(userPubkey);
  if (!ownerHex || !userHex) return false;
  return ownerHex === userHex;
}

function getLogicalRepoOwner(
  sourceRepoId: string | undefined,
  fallbackOwner: string | undefined
): string {
  const repoId = String(sourceRepoId || "").trim();
  if (repoId) {
    const slashIndex = repoId.indexOf("/");
    if (slashIndex > 0) return repoId.slice(0, slashIndex);

    const colonIndex = repoId.indexOf(":");
    if (colonIndex > 0) return repoId.slice(0, colonIndex);
  }

  return String(fallbackOwner || "").trim();
}

/**
 * Svelte 5 composable for managing fork repository workflow
 * Handles git-worker integration, progress tracking, and NIP-34 event emission
 *
 * @example
 * ```typescript
 * const { forkRepository, isForking, progress, error } = useForkRepo({
 *   onProgress: (steps) => console.log('Progress:', steps),
 *   onForkCompleted: (result) => console.log('Forked:', result),
 *   onPublishEvent: async (event) => await publishToRelay(event)
 * });
 *
 * // Fork a repository
 * await forkRepository({
 *   owner: 'original-owner',
 *   name: 'repo-name',
 *   description: 'Original repo description'
 * }, {
 *   forkName: 'my-fork',
 *   visibility: 'public'
 * });
 * ```
 */
export function useForkRepo(options: UseForkRepoOptions = {}) {
  let isForking = $state(false);
  let progress = $state<ForkProgress[]>([]);
  let error = $state<string | null>(null);
  let warning = $state<string | null>(null);

  let tokens = $state<Token[]>([]);

  // Prevent duplicate GRASP signing listener registration per session
  // EventIO handles signing internally - no more signer setup needed

  // Subscribe to token store changes and update reactive state
  tokensStore.subscribe((t: Token[]) => {
    tokens = t;
    console.log("🔐 Token store updated, now have", t.length, "tokens");
  });

  const { onProgress, onForkCompleted, onPublishEvent, onRollbackPublishedRepoEvents, userPubkey } =
    options;

  function updateProgress(
    step: string,
    message: string,
    status: "pending" | "running" | "completed" | "error",
    errorMessage?: string
  ) {
    const existingIndex = progress.findIndex((p) => p.step === step);
    const progressItem: ForkProgress = { step, message, status, error: errorMessage };

    if (existingIndex >= 0) {
      progress[existingIndex] = progressItem;
    } else {
      progress.push(progressItem);
    }

    // Force reactivity by reassigning the array with a snapshot
    // This ensures $derived computations in consumers (like ForkRepoDialog) re-run
    progress = $state.snapshot(progress) as ForkProgress[];

    onProgress?.($state.snapshot(progress) as ForkProgress[]);
  }

  /**
   * Fork a repository with full workflow
   * 1. Create remote fork via GitHub API
   * 2. Poll until fork is ready
   * 3. Clone fork locally
   * 4. Create and emit NIP-34 events
   */
  async function forkRepository(
    originalRepo: {
      owner: string;
      name: string;
      description?: string;
      cloneUrls?: string[];
      sourceRepoId?: string;
    },
    config: ForkConfig
  ): Promise<ForkRepositoryResult | null> {
    if (isForking) {
      throw new Error("Fork operation already in progress");
    }

    isForking = true;
    error = null;
    warning = null;
    progress = [];

    let graspEventsPublished = false;
    let graspPushCompleted = false;
    let graspPushAttempted = false;
    let graspPublishAck: GraspPublishRelayAck | null = null;
    let graspRollbackContext: { repoName: string; relays: string[] } | null = null;
    let graspPushReport:
      | {
          pushedRefs: string[];
          failedRefs: Array<{ ref: string; error: string }>;
          warnings: string[];
          partialSuccess: boolean;
        }
      | undefined;

    const cloneAttemptStepByAttempt = new Map<number, string>();
    const cloneAttemptMeta = new Map<number, { total: number; url: string }>();
    const finalizedCloneAttempts = new Set<number>();
    let activeCloneAttempt: number | null = null;
    let lastWorkerPhase = "";

    const getCloneAttemptStep = (attempt: number): string => {
      const existing = cloneAttemptStepByAttempt.get(attempt);
      if (existing) return existing;
      const step = `clone-source-url-${attempt}`;
      cloneAttemptStepByAttempt.set(attempt, step);
      return step;
    };

    const handleForkWorkerProgress = (event: MessageEvent | { data?: any } | any): void => {
      const payload = event?.data && typeof event.data === "object" ? event.data : event;
      if (!payload || typeof payload !== "object") return;
      if (payload.type !== "clone-progress") return;

      const phase = String(payload.phase || "").trim();
      if (!phase) return;

      const attemptPhase = parseCloneAttemptPhase(phase);
      if (attemptPhase) {
        const attempt = attemptPhase.attempt;
        const step = getCloneAttemptStep(attempt);
        const compactUrl = compactCloneUrlLabel(attemptPhase.url);
        cloneAttemptMeta.set(attempt, {
          total: attemptPhase.total,
          url: compactUrl,
        });

        if (attemptPhase.type === "start") {
          activeCloneAttempt = attempt;
          finalizedCloneAttempts.delete(attempt);
          updateProgress(
            "fork",
            `Cloning source repository (URL ${attempt}/${attemptPhase.total})...`,
            "running"
          );
          updateProgress(
            step,
            `Clone URL ${attempt}/${attemptPhase.total}: ${compactUrl}`,
            "running"
          );
          return;
        }

        if (attemptPhase.type === "failed") {
          finalizedCloneAttempts.add(attempt);
          if (activeCloneAttempt === attempt) activeCloneAttempt = null;
          const reason = attemptPhase.error ? ` (${attemptPhase.error})` : "";
          updateProgress(
            step,
            `Clone URL ${attempt}/${attemptPhase.total} failed: ${compactUrl}${reason}`,
            "error"
          );
          if (attempt < attemptPhase.total) {
            updateProgress(
              "fork",
              `Clone attempt ${attempt} failed, trying next source URL...`,
              "running"
            );
          }
          return;
        }

        finalizedCloneAttempts.add(attempt);
        if (activeCloneAttempt === attempt) activeCloneAttempt = null;
        updateProgress(
          step,
          `Clone URL ${attempt}/${attemptPhase.total} succeeded: ${compactUrl}`,
          "completed"
        );
        updateProgress(
          "fork",
          `Source clone succeeded via URL ${attempt}/${attemptPhase.total}`,
          "running"
        );
        return;
      }

      if (activeCloneAttempt != null && !finalizedCloneAttempts.has(activeCloneAttempt)) {
        const currentMeta = cloneAttemptMeta.get(activeCloneAttempt);
        if (currentMeta) {
          if (
            phase.startsWith("Downloading objects") ||
            phase.startsWith("Resolving deltas") ||
            phase.startsWith("Cloning source repository")
          ) {
            const step = getCloneAttemptStep(activeCloneAttempt);
            updateProgress(
              step,
              `Clone URL ${activeCloneAttempt}/${currentMeta.total}: ${currentMeta.url} - ${phase}`,
              "running"
            );
            return;
          }
        }
      }

      if (phase !== lastWorkerPhase) {
        lastWorkerPhase = phase;
        updateProgress("fork", phase, "running");
      }
    };

    try {
      // Validate inputs early
      if (!originalRepo?.owner || !originalRepo?.name) {
        throw new Error(
          `Invalid original repo: owner="${originalRepo?.owner}", name="${originalRepo?.name}"`
        );
      }
      if (!config?.forkName || !config.forkName.trim()) {
        throw new Error("Fork name is required");
      }

      // Step 1: Determine provider and validate token (skip token for GRASP)
      const provider = config.provider || "github"; // Default to GitHub for backward compatibility
      const providerHost =
        provider === "github"
          ? "github.com"
          : provider === "gitlab"
            ? "gitlab.com"
            : provider === "gitea"
              ? "gitea.com"
              : provider === "bitbucket"
                ? "bitbucket.org"
                : "github.com";

      let providerToken: string | undefined;
      let pubkey: string | undefined;
      let relayUrl: string | undefined;

      if (provider === "grasp") {
        updateProgress("validate", "Validating GRASP configuration...", "running");
        // EventIO handles signing internally - no more signer passing anti-pattern!
        if (!config.relayUrl) {
          throw new Error("GRASP requires a relay URL");
        }
        if (!userPubkey) {
          throw new Error("GRASP requires a user pubkey (userPubkey option)");
        }
        relayUrl = config.relayUrl;
        // For GRASP, the "token" parameter is actually the user's pubkey
        pubkey = userPubkey;
        providerToken = userPubkey; // Use actual pubkey for GraspApiProvider
        updateProgress("validate", "GRASP configuration validated", "completed");
      } else {
        updateProgress("validate", `Validating ${provider} token...`, "running");
        const matchingTokens = getTokensForHost(tokens, providerHost);
        if (matchingTokens.length === 0) {
          throw new Error(
            `${provider} token not found. Please add a ${provider} token in settings.`
          );
        }
        updateProgress("validate", `${provider} token validated`, "completed");
      }

      // Step 2: Get current user and fork repository using tryTokensForHost for fallback retries
      updateProgress("user", "Getting current user info...", "running");

      // Use passed workerApi if available, otherwise create new worker
      let gitWorkerApi: any, worker: Worker;
      if (options.workerApi) {
        gitWorkerApi = options.workerApi;
        // Need worker for GRASP - create temporary one if not available
        const { getGitWorker } = await import("@nostr-git/core/worker");
        const workerInstance = getGitWorker({ onProgress: handleForkWorkerProgress });
        worker = workerInstance.worker;
      } else {
        const { getGitWorker } = await import("@nostr-git/core/worker");
        const workerInstance = getGitWorker({ onProgress: handleForkWorkerProgress });
        gitWorkerApi = workerInstance.api;
        worker = workerInstance.worker;
      }

      // Use fork name as default local directory path (browser virtual file system).
      // For GRASP, this is overridden to a canonical owner/name path after getCurrentUser.
      let destinationPath = config.forkName;

      // EventIO handles signing internally - no more signer registration needed!
      let workerResult: any;
      let graspCurrentUser: string | undefined;

      if (provider === "grasp") {
        // EventIO will be configured by the worker internally
        // For GRASP, proceed directly without token retry
        const gitServiceApi = getGitServiceApi(provider as any, providerToken!, relayUrl);
        const userData = await gitServiceApi.getCurrentUser();
        const currentUser = userData.login;
        graspCurrentUser = currentUser;
        updateProgress("user", `Current user: ${currentUser}`, "completed");

        // Ensure worker local repo path is canonical (owner/name) so subsequent pushToRemote
        // can resolve repoId -> dir correctly.
        destinationPath = `${currentUser}/${config.forkName}`;

        // Do not hard-block when a GRASP repo appears to exist already.
        // Existing empty repos can happen after partial failures and should be recoverable by retrying push.

        // Step 3: Fork and clone repository using git-worker
        updateProgress("fork", "Creating fork and cloning repository...", "running");
        workerResult = await gitWorkerApi.forkAndCloneRepo({
          owner: originalRepo.owner,
          repo: originalRepo.name,
          forkName: config.forkName,
          visibility: config.visibility,
          token: providerToken!,
          provider: provider,
          baseUrl: relayUrl,
          dir: destinationPath,
          sourceCloneUrls: originalRepo.cloneUrls ? [...originalRepo.cloneUrls] : undefined, // Convert to plain array for Comlink
          sourceRepoId: originalRepo.sourceRepoId || undefined, // Pass source repo ID for finding existing local clone
          workflowFilesAction: config.workflowFilesAction,
          // Note: onProgress callback removed - functions cannot be serialized through Comlink
        });
        console.log("[useForkRepo] forkAndCloneRepo returned", workerResult);
      } else {
        // For standard Git providers, use tryTokensForHost for fallback retries
        workerResult = await tryTokensForHost(
          tokens,
          providerHost,
          async (token: string, host: string) => {
            // Get current user with this token
            const gitServiceApi = getGitServiceApi(provider as any, token, relayUrl);
            const userData = await gitServiceApi.getCurrentUser();
            const currentUser = userData.login;
            updateProgress("user", `Current user: ${currentUser}`, "completed");

            // Fork and clone repository using git-worker with this token
            updateProgress("fork", "Creating fork and cloning repository...", "running");
            const result = await gitWorkerApi.forkAndCloneRepo({
              owner: originalRepo.owner,
              repo: originalRepo.name,
              forkName: config.forkName,
              visibility: config.visibility,
              token: token,
              provider: provider,
              baseUrl: relayUrl,
              dir: destinationPath,
              sourceCloneUrls: originalRepo.cloneUrls ? [...originalRepo.cloneUrls] : undefined, // Convert to plain array for Comlink
              sourceRepoId: originalRepo.sourceRepoId || undefined, // Pass source repo ID for finding existing local clone
              workflowFilesAction: config.workflowFilesAction,
              // Note: onProgress callback removed - functions cannot be serialized through Comlink
            });
            console.log("[useForkRepo] forkAndCloneRepo returned", result);

            if (result?.requiresWorkflowDecision) {
              return result;
            }
            if (!result.success) {
              const ctx = `owner=${originalRepo.owner} repo=${originalRepo.name} forkName=${config.forkName} provider=${provider}`;
              throw new Error(`${result.error || "Fork operation failed"} (${ctx})`);
            }

            return result;
          }
        );
      }

      if (workerResult?.requiresWorkflowDecision) {
        return {
          requiresWorkflowDecision: true,
          workflowFiles: workerResult.workflowFiles || [],
          error: workerResult.error || "Workflow scope required",
        };
      }
      if (!workerResult.success) {
        const ctx = `owner=${originalRepo.owner} repo=${originalRepo.name} forkName=${config.forkName} provider=${provider}`;
        throw new Error(`${workerResult.error || "Fork operation failed"} (${ctx})`);
      }

      if (provider === "grasp" && relayUrl && userPubkey) {
        const ownerNpub = toNpubOrSelf(userPubkey);
        const baseHttp = relayUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
        workerResult.forkUrl = `${baseHttp}/${ownerNpub}/${config.forkName}.git`;
        workerResult.repoId = `${ownerNpub}/${config.forkName}`;
      }
      updateProgress("fork", "Repository forked and cloned successfully", "completed");

      // Step 4: Create NIP-34 events
      updateProgress("events", "Creating Nostr events...", "running");

      // Create Repository Announcement event (kind 30617)
      // For same logical repo (same owner pubkey + same name), keep existing clone URLs
      // and append the newly created target clone URL.
      const logicalOwner = getLogicalRepoOwner(originalRepo.sourceRepoId, originalRepo.owner);
      const sameLogicalRepo =
        config.forkName === originalRepo.name && isSamePubkeyOwner(logicalOwner, userPubkey);
      const cloneUrlSeed = sameLogicalRepo
        ? [workerResult.forkUrl, ...(originalRepo.cloneUrls ?? [])]
        : [workerResult.forkUrl];
      const cloneUrls = dedupeCloneUrls(cloneUrlSeed);

      const requestedRelays = (config.relays || []).map((r) => r.trim()).filter(Boolean);
      const relays = [...requestedRelays];

      const rawMaintainers = [userPubkey, ...(config.maintainers || [])].filter(
        (value): value is string => Boolean(value && value.trim())
      );
      const maintainers = Array.from(new Set(rawMaintainers));

      const hashtags = (config.tags || []).map((tag) => tag.trim()).filter(Boolean);

      const branchCommits: Record<string, string> = workerResult.branchCommits || {};
      const tagCommits: Record<string, string> = workerResult.tagCommits || {};
      const allCandidateRefs = [
        ...workerResult.branches
          .map((branch: string) => ({
            type: "heads" as const,
            name: branch,
            commit: branchCommits[branch],
          }))
          .filter((ref: { commit?: string }) => Boolean(ref.commit)),
        ...workerResult.tags
          .map((tag: string) => ({
            type: "tags" as const,
            name: tag,
            commit: tagCommits[tag],
          }))
          .filter((ref: { commit?: string }) => Boolean(ref.commit)),
      ].filter((ref) => !(ref.type === "heads" && ref.name === "HEAD"));

      // For GRASP: verify each ref is actually resolvable in the local clone.
      // Only locally-resolved refs go into the state event and push plan.
      // This prevents the auth mismatch where the relay rejects a push because
      // the pushed refs don't match what was declared in the state event.
      const localRepoIdForVerify = workerResult.localRepoId || workerResult.repoId;
      const unresolvedRefs: Array<{ ref: string; reason: string }> = [];
      const refs: Array<{ type: "heads" | "tags"; name: string; commit: string }> = [];

      if (provider === "grasp") {
        updateProgress("events", "Verifying locally-resolvable refs...", "running");
        for (const candidate of allCandidateRefs) {
          const fullRef = `refs/${candidate.type}/${candidate.name}`;
          try {
            // Use the worker's resolveBranch for heads, or rely on branchCommits/tagCommits
            // branchCommits already validated in repo-management, but double-check here
            if (candidate.commit && /^[0-9a-f]{7,64}$/i.test(candidate.commit)) {
              refs.push(candidate);
            } else {
              unresolvedRefs.push({ ref: fullRef, reason: "no OID in local clone" });
            }
          } catch {
            unresolvedRefs.push({ ref: fullRef, reason: "resolution failed" });
          }
        }
        if (unresolvedRefs.length > 0) {
          console.warn(
            `[GRASP] Skipping ${unresolvedRefs.length} unresolvable refs from state/push plan:`,
            unresolvedRefs
          );
        }
      } else {
        refs.push(...allCandidateRefs);
      }

      let announcementEvent = createRepoAnnouncementEvent({
        repoId: workerResult.repoId,
        name: config.forkName,
        description:
          originalRepo.description || `Fork of ${originalRepo.owner}/${originalRepo.name}`,
        clone: cloneUrls,
        web: [workerResult.forkUrl.replace(/\.git$/, "")],
        maintainers: maintainers.length > 0 ? maintainers : undefined,
        hashtags: hashtags.length > 0 ? hashtags : undefined,
        ...(relays.length > 0 ? { relays } : {}),
        ...(config.earliestUniqueCommit
          ? { earliestUniqueCommit: config.earliestUniqueCommit }
          : {}),
      });

      let stateEvent = createRepoStateEvent({
        repoId: provider === "grasp" ? config.forkName : workerResult.repoId,
        refs: refs.length > 0 ? refs : undefined,
        head: workerResult.defaultBranch,
      });

      if (provider === "grasp") {
        const graspEvents = createGraspAnnouncementAndState({
          relayUrl: relayUrl || "",
          ownerPubkey: userPubkey || providerToken || "",
          repoName: config.forkName,
          description:
            originalRepo.description || `Fork of ${originalRepo.owner}/${originalRepo.name}`,
          relays,
          cloneUrls,
          webUrls: [workerResult.forkUrl.replace(/\.git$/, "")],
          maintainers: maintainers.length > 0 ? maintainers : undefined,
          hashtags: hashtags.length > 0 ? hashtags : undefined,
          earliestUniqueCommit: config.earliestUniqueCommit,
          refs,
          head: workerResult.defaultBranch,
        });
        announcementEvent = graspEvents.announcementEvent;
        stateEvent = graspEvents.stateEvent;
        graspRollbackContext = {
          repoName: config.forkName,
          relays: Array.from(new Set([relayUrl || "", ...(relays || [])])).filter(Boolean),
        };
      }

      updateProgress("events", "Nostr events created successfully", "completed");

      // Step 5: Publish announcement + provisioning, then per-ref state/push cycles
      if (onPublishEvent) {
        try {
          if (provider === "grasp") {
            // GRASP step 1: publish ONLY the announcement (30617).
            // The state (30618) is published before each push and must represent the
            // repository refs that should exist after that push (already-accepted refs +
            // the current ref). Publishing an out-of-date state causes policy rejection.
            updateProgress(
              "publish-announcement",
              "Publishing GRASP announcement event...",
              "running"
            );
            const announcementResult = await onPublishEvent(announcementEvent);
            graspPublishAck = extractPublishRelayAck(announcementResult);
            console.log("✅ Published GRASP repo announcement event");
            graspEventsPublished = true;
            updateProgress(
              "publish-announcement",
              "Published GRASP announcement event",
              "completed"
            );
          } else {
            updateProgress("publish", "Publishing to Nostr relays...", "running");
            await onPublishEvent(announcementEvent);
            console.log("✅ Published repo announcement event");
            await onPublishEvent(stateEvent);
            console.log("✅ Published repo state event");
            updateProgress("publish", "Successfully published to Nostr relays", "completed");
          }
        } catch (publishError) {
          console.error("❌ Failed to publish Nostr events:", publishError);
          if (provider === "grasp") {
            throw publishError;
          }
          const message =
            publishError instanceof Error ? publishError.message : String(publishError);
          warning = `Fork succeeded, but publishing Nostr events failed: ${message}`;
          updateProgress("publish", "Publishing to Nostr relays failed (non-fatal)", "completed");
        }
      } else if (provider === "grasp") {
        throw new Error("GRASP fork requires publishing repo announcement and state events");
      }

      if (provider === "grasp") {
        if (
          relayUrl &&
          graspPublishAck?.hasRelayOutcomes &&
          !didRelayAckGraspEvents(graspPublishAck, relayUrl)
        ) {
          throw new Error("Selected GRASP relay did not ACK announcement event; skipping push");
        }

        // GRASP step 2: wait for relay to provision the bare git repo from the announcement.
        updateProgress(
          "preflight",
          "Preflight: checking GRASP relay endpoint readiness...",
          "running"
        );
        const ownerForProbe = graspCurrentUser || userPubkey || "";
        try {
          await waitForGraspProvisioning({
            relayUrl: relayUrl || "",
            userPubkey: providerToken || "",
            owner: ownerForProbe,
            repoName: config.forkName,
            maxAttempts: 15,
            delayMs: 3000,
            onAttempt: ({ attempt, maxAttempts, repoExists, receivePackReady }) => {
              const availability = [
                repoExists ? "read endpoint ready" : "read endpoint pending",
                receivePackReady ? "write endpoint ready" : "write endpoint pending",
              ].join(", ");
              updateProgress(
                "preflight",
                `Preflight (${attempt}/${maxAttempts}): ${availability}`,
                "running"
              );
            },
          });
          updateProgress(
            "preflight",
            "Preflight complete: relay reports provisioning signal (read or write endpoint ready)",
            "completed"
          );
        } catch (provisionError) {
          const message =
            provisionError instanceof Error ? provisionError.message : String(provisionError || "");
          warning =
            "GRASP provisioning checks did not confirm readiness in time. Attempting push anyway...";
          updateProgress(
            "preflight",
            `Preflight timed out (${message}). Continuing with push retries...`,
            "completed"
          );
        }

        const refPushPlan = refs.map((ref) => ({
          type: ref.type,
          name: ref.name,
          ref: `refs/${ref.type}/${ref.name}`,
          commit: ref.commit,
        }));

        refPushPlan.sort((a, b) => {
          const rank = (item: (typeof refPushPlan)[number]) => {
            if (item.type === "heads" && item.name === workerResult.defaultBranch) return 0;
            if (item.type === "heads") return 1;
            return 2;
          };

          const rankDiff = rank(a) - rank(b);
          if (rankDiff !== 0) return rankDiff;
          return a.name.localeCompare(b.name);
        });

        if (refPushPlan.length === 0) {
          throw new Error(
            `No pushable refs resolved in local fork clone${
              unresolvedRefs.length > 0
                ? ` (${unresolvedRefs.map((r) => `${r.ref}: ${r.reason}`).join("; ")})`
                : ""
            }`
          );
        }

        // Surface any refs that were skipped due to local resolution failure
        if (unresolvedRefs.length > 0) {
          warning = [
            warning,
            `${unresolvedRefs.length} ref(s) skipped (not found in local clone): ${unresolvedRefs.map((r) => r.ref).join(", ")}`,
          ]
            .filter(Boolean)
            .join(" | ");
        }

        updateProgress(
          "push",
          `Pushing git refs to GRASP Smart HTTP (0/${refPushPlan.length})...`,
          "running"
        );
        const localRepoId = workerResult.localRepoId || workerResult.repoId;
        graspPushAttempted = true;
        const pushedRefs: string[] = [];
        const failedRefs: Array<{ ref: string; error: string }> = [];
        const pushWarnings: string[] = [];
        const acceptedRefsForState = new Set<string>();
        const refDetailsByFullRef = new Map(
          refPushPlan
            .filter((item) => Boolean(item.commit))
            .map((item) => [
              item.ref,
              {
                type: item.type,
                name: item.name,
                commit: item.commit,
              },
            ])
        );

        // GRASP step 3: per-ref publish-state -> push cycle.
        // For each ref, publish a cumulative state that includes refs already accepted by
        // the relay plus the ref we're about to push. This keeps state aligned with the
        // repository's effective ref set during multi-step pushes.
        for (let i = 0; i < refPushPlan.length; i++) {
          const item = refPushPlan[i];
          updateProgress(
            "push",
            `Publishing state for ${item.type === "heads" ? "branch" : "tag"} ${item.name} (${i + 1}/${refPushPlan.length})...`,
            "running"
          );

          // Build a cumulative state event for refs that should exist after this push.
          // Include previously accepted refs to avoid dropping already-present refs
          // (e.g., default branch during subsequent tag pushes).
          if (onPublishEvent) {
            try {
              const stateRefKeys = Array.from(new Set([...acceptedRefsForState, item.ref]));
              const stateRefs = stateRefKeys
                .map((fullRef) => refDetailsByFullRef.get(fullRef))
                .filter(
                  (
                    ref
                  ): ref is {
                    type: "heads" | "tags";
                    name: string;
                    commit: string;
                  } => Boolean(ref?.commit)
                );
              const declaredHeads = stateRefs
                .filter((ref) => ref.type === "heads")
                .map((ref) => ref.name);
              const stateHead = declaredHeads.includes(workerResult.defaultBranch)
                ? workerResult.defaultBranch
                : declaredHeads[0] || workerResult.defaultBranch;

              const cumulativeState = createRepoStateEvent({
                repoId: config.forkName,
                refs: stateRefs.length > 0 ? stateRefs : undefined,
                head: stateHead,
              });
              if (
                relays.length > 0 &&
                !(cumulativeState.tags as any[]).some((t) => t[0] === "relays")
              ) {
                cumulativeState.tags = [...cumulativeState.tags, ["relays", ...relays] as any];
              }
              await onPublishEvent(cumulativeState);
              stateEvent = cumulativeState;
              // Small pause to let the relay process the state before the push arrives
              await new Promise((resolve) => setTimeout(resolve, 400));
            } catch (stateErr) {
              const msg = stateErr instanceof Error ? stateErr.message : String(stateErr || "");
              failedRefs.push({ ref: item.ref, error: `state publish failed: ${msg}` });
              continue;
            }
          }

          updateProgress(
            "push",
            `Pushing ${item.type === "heads" ? "branch" : "tag"} ${item.name} (${i + 1}/${refPushPlan.length})...`,
            "running"
          );

          const pushResult = await gitWorkerApi.pushToRemote({
            repoId: localRepoId,
            remoteUrl: workerResult.forkUrl,
            branch: workerResult.defaultBranch,
            ref: item.ref,
            token: providerToken,
            provider,
          });

          if (pushResult?.success) {
            const details = pushResult?.details;
            const pushedRefsForIteration =
              Array.isArray(details?.pushedRefs) && details.pushedRefs.length > 0
                ? details.pushedRefs
                : [item.ref];
            if (Array.isArray(details?.pushedRefs) && details.pushedRefs.length > 0) {
              pushedRefs.push(...details.pushedRefs);
            } else {
              pushedRefs.push(item.ref);
            }
            for (const pushedRef of pushedRefsForIteration) {
              if (refDetailsByFullRef.has(pushedRef)) {
                acceptedRefsForState.add(pushedRef);
              }
            }
            if (Array.isArray(details?.failedRefs) && details.failedRefs.length > 0) {
              failedRefs.push(...details.failedRefs);
            }
            if (Array.isArray(details?.warnings) && details.warnings.length > 0) {
              pushWarnings.push(...details.warnings);
            }
            continue;
          }

          failedRefs.push({
            ref: item.ref,
            error: pushResult?.error || "Failed to push ref",
          });
        }

        const uniquePushedRefs = Array.from(new Set(pushedRefs));
        const uniqueFailedRefs = Array.from(
          new Map(failedRefs.map((item) => [item.ref, item])).values()
        );
        const uniquePushWarnings = Array.from(new Set(pushWarnings));

        if (uniquePushedRefs.length === 0) {
          throw new Error(
            `Failed to push any refs to GRASP repository (${uniqueFailedRefs
              .map((item) => `${item.ref}: ${item.error}`)
              .join("; ")})`
          );
        }

        // GRASP step 4: publish a final cumulative state reflecting all successfully pushed refs.
        // ngit-grasp will immediately verify these refs exist in the git repo and commit the state.
        if (onPublishEvent && uniquePushedRefs.length > 0) {
          try {
            updateProgress("publish-final-state", "Publishing final GRASP state...", "running");
            const pushedHead = uniquePushedRefs.find(
              (r) => r === `refs/heads/${workerResult.defaultBranch}`
            )
              ? workerResult.defaultBranch
              : (uniquePushedRefs.find((r) => r.startsWith("refs/heads/")) || "").replace(
                  /^refs\/heads\//,
                  ""
                ) || workerResult.defaultBranch;

            const finalStateRefs = uniquePushedRefs
              .map((fullRef) => {
                const candidate = refs.find((r) => `refs/${r.type}/${r.name}` === fullRef);
                if (!candidate) return null;
                return { type: candidate.type, name: candidate.name, commit: candidate.commit };
              })
              .filter((r): r is { type: "heads" | "tags"; name: string; commit: string } =>
                Boolean(r)
              );

            const finalStateEvent = createRepoStateEvent({
              repoId: config.forkName,
              refs: finalStateRefs.length > 0 ? finalStateRefs : undefined,
              head: pushedHead,
            });
            if (
              relays.length > 0 &&
              !(finalStateEvent.tags as any[]).some((t) => t[0] === "relays")
            ) {
              finalStateEvent.tags = [...finalStateEvent.tags, ["relays", ...relays] as any];
            }
            await onPublishEvent(finalStateEvent);
            stateEvent = finalStateEvent;
            updateProgress("publish-final-state", "Final GRASP state published", "completed");
          } catch (finalStateErr) {
            const msg =
              finalStateErr instanceof Error ? finalStateErr.message : String(finalStateErr || "");
            pushWarnings.push(`Final state publish failed: ${msg}`);
            updateProgress(
              "publish-final-state",
              `Final GRASP state publish failed (${msg}). Push result preserved.`,
              "completed"
            );
          }
        }

        const partialPush = uniqueFailedRefs.length > 0;
        graspPushReport = {
          pushedRefs: uniquePushedRefs,
          failedRefs: uniqueFailedRefs,
          warnings: uniquePushWarnings,
          partialSuccess: partialPush,
        };
        if (partialPush) {
          warning = `Fork partially pushed to GRASP. Pushed ${uniquePushedRefs.length}/${refPushPlan.length} refs. Failed: ${uniqueFailedRefs
            .map((item) => item.ref)
            .join(", ")}`;
          updateProgress(
            "push",
            `Partially pushed refs (${uniquePushedRefs.length}/${refPushPlan.length}). You can retry failed refs later.`,
            "completed"
          );
        } else {
          updateProgress(
            "push",
            `Git refs pushed to GRASP successfully (${uniquePushedRefs.length}/${refPushPlan.length})`,
            "completed"
          );
        }

        if (uniquePushWarnings.length > 0) {
          warning = [warning, ...uniquePushWarnings].filter(Boolean).join(" | ");
        }

        graspPushCompleted = true;
      }

      const result: ForkResult = {
        repoId: workerResult.repoId,
        forkUrl: workerResult.forkUrl,
        defaultBranch: workerResult.defaultBranch,
        branches: workerResult.branches,
        tags: workerResult.tags,
        announcementEvent,
        stateEvent,
        ...(graspPushReport ? { pushReport: graspPushReport } : {}),
      };

      onForkCompleted?.(result);
      return result;
    } catch (err) {
      if (
        config.provider === "grasp" &&
        graspEventsPublished &&
        !graspPushCompleted &&
        !graspPushAttempted &&
        graspRollbackContext &&
        onRollbackPublishedRepoEvents
      ) {
        updateProgress("rollback", "Rolling back published GRASP repo events...", "running");
        try {
          await onRollbackPublishedRepoEvents(graspRollbackContext);
          updateProgress("rollback", "Rolled back published GRASP repo events", "completed");
        } catch (rollbackError) {
          const rollbackMessage =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          updateProgress(
            "rollback",
            `Rollback failed: ${rollbackMessage}`,
            "error",
            rollbackMessage
          );
        }
      }

      const errorMessage = parseForkError(err, config.provider || "github");
      error = errorMessage;

      // Update the current step to error status
      const currentStep = progress.find((p) => p.status === "running");
      if (currentStep) {
        updateProgress(currentStep.step, `Failed: ${errorMessage}`, "error", errorMessage);
      }

      console.error("Repository fork failed:", err);
      return null;
    } finally {
      isForking = false;
    }
  }

  /**
   * Reset the fork state
   * Useful for retrying after errors or starting fresh
   */
  function reset(): void {
    progress = [];
    error = null;
    isForking = false;
  }

  // Return reactive state and methods
  return {
    // Reactive state (automatically reactive in Svelte 5)
    get progress() {
      return progress;
    },
    get error() {
      return error;
    },
    get warning() {
      return warning;
    },
    get isForking() {
      return isForking;
    },

    // Methods
    forkRepository,
    reset,
  };
}
