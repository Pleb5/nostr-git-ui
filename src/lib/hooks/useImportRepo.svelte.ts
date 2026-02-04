/**
 * Repository Import Hook
 *
 * Main import logic for importing repositories from Git hosting providers
 * (GitHub, GitLab, Gitea, Bitbucket) into the Nostr Git system.
 */

import {
  getGitServiceApi,
  getGitServiceApiFromUrl,
  parseRepoUrl,
  validateTokenPermissions,
  checkRepoOwnership,
  type ImportConfig,
  DEFAULT_IMPORT_CONFIG,
  ImportAbortController,
  ImportAbortedError,
  RateLimiter,
  generatePlatformUserProfile,
  getProfileMapKey,
  convertRepoToNostrEvent,
  convertRepoToStateEvent,
  convertIssuesToNostrEvents,
  convertIssueStatusesToEvents,
  convertCommentsToNostrEvents,
  convertPullRequestsToNostrEvents,
  signEvent,
  type UserProfileMap,
  type CommentEventMap,
  type ConvertedComment,
  type GitServiceApi,
  type ListCommentsOptions,
} from "@nostr-git/core";
import type {
  RepoAnnouncementEvent,
  RepoStateEvent,
  NostrEvent,
  NostrFilter,
  EventIO,
} from "@nostr-git/core";
import type {
  GitIssue as Issue,
  GitComment as Comment,
  GitPullRequest as PullRequest,
  RepoMetadata,
} from "@nostr-git/core";
import { nip19 } from "nostr-tools";

/**
 * Import progress information
 */
export interface ImportProgress {
  /**
   * Current step/message
   */
  step: string;

  /**
   * Current item number (for batch operations)
   */
  current?: number;

  /**
   * Total items (for batch operations)
   */
  total?: number;

  /**
   * Whether the import is complete
   */
  isComplete: boolean;

  /**
   * Error message if import failed
   */
  error?: string;
}

/**
 * Import result
 */
export interface ImportResult {
  /**
   * Repository announcement event
   */
  announcementEvent: RepoAnnouncementEvent;

  /**
   * Repository state event
   */
  stateEvent: RepoStateEvent;

  /**
   * Number of issues imported
   */
  issuesImported: number;

  /**
   * Number of comments imported
   */
  commentsImported: number;

  /**
   * Number of PRs imported
   */
  prsImported: number;

  /**
   * Number of profiles created
   */
  profilesCreated: number;

  /**
   * Final repository metadata (after forking if needed)
   */
  repo: RepoMetadata;
}

/**
 * Options for the import hook
 */
export interface UseImportRepoOptions {
  /**
   * EventIO instance for publishing events
   */
  eventIO?: EventIO;

  /**
   * Fetch events from Nostr relays. Used for NIP-39 bridged identity lookups.
   * Can use host app's relay pool directly (e.g. welshman load) without needing full EventIO.
   */
  onFetchEvents?: (filters: NostrFilter[]) => Promise<NostrEvent[]>;

  /**
   * Function to sign events (required if eventIO not provided)
   */
  onSignEvent?: (event: Omit<NostrEvent, "id" | "sig" | "pubkey">) => Promise<NostrEvent>;

  /**
   * Function to publish events (required if eventIO not provided)
   */
  onPublishEvent?: (event: NostrEvent) => Promise<void>;

  /**
   * Progress callback
   */
  onProgress?: (progress: ImportProgress) => void;

  /**
   * Import completed callback
   */
  onImportCompleted?: (result: ImportResult) => void;

  /**
   * User's Nostr public key (hex format)
   */
  userPubkey: string;
}

// ===== Import Context & Types =====

/**
 * Shared context for import operations
 * Holds all state and dependencies needed throughout the import process
 */
interface ImportContext {
  // Core dependencies
  abortController: ImportAbortController;
  rateLimiter: RateLimiter;
  withRateLimit: <T>(provider: string, method: string, operation: () => Promise<T>) => Promise<T>;
  updateProgress: (step: string, current?: number, total?: number) => void;

  // API and platform info
  api: Awaited<ReturnType<typeof getGitServiceApiFromUrl>>;
  platform: string;
  parsed: ReturnType<typeof parseRepoUrl>;

  // Repository info
  finalRepo: RepoMetadata | null;
  repoAddr: string;

  // Timestamps
  importTimestamp: number;
  startTimestamp: number;
  currentTimestamp: number; // Increments for each event published

  // User profiles
  userProfiles: UserProfileMap;
  profileEvents: Map<string, NostrEvent>;

  // NIP-39 bridged identities: platform:username -> Nostr pubkey (when profile has i-tag proof)
  bridgedNostrPubkeys: Map<string, string>;
  nip39CheckedKeys: Set<string>; // profileKeys we've already looked up (avoid re-query)

  // Lightweight tracking maps (for dependency resolution)
  issueEventIdMap: Map<number, string>; // issue.number -> nostr event ID
  prEventIdMap: Map<number, string>; // pr.number -> nostr event ID
  commentEventMap: Map<string, string>; // platformCommentId -> nostr event ID (for threading)

  // Running counters
  issuesPublished: number;
  prsPublished: number;
  commentsPublished: number;

  // Configuration
  config: ImportConfig;
  userPubkey: string;
  batchSize: number; // Number of events per batch
  batchDelay: number; // Delay between batches (ms)

  // Batched event publishing
  eventQueue: NostrEvent[]; // Queue of events waiting to be published

  // Event publishing
  onSignEvent?: (event: Omit<NostrEvent, "id" | "sig" | "pubkey">) => Promise<NostrEvent>;
  onPublishEvent?: (event: NostrEvent) => Promise<void>;
  eventIO?: EventIO;
  onFetchEvents?: (filters: NostrFilter[]) => Promise<NostrEvent[]>;
}

// ===== Batch Publishing Functions =====

/**
 * Publish a single event using batched publishing
 * Events are collected into batches and published together for better performance
 */
async function publishEventBatched(context: ImportContext, event: NostrEvent): Promise<void> {
  context.eventQueue.push(event);

  // If queue reaches batch size, flush it
  if (context.eventQueue.length >= context.batchSize) {
    await flushEventQueue(context);
  }
}

/**
 * Flush all queued events by publishing them in parallel, then wait before next batch
 */
async function flushEventQueue(context: ImportContext): Promise<void> {
  if (context.eventQueue.length === 0) return;

  const batch = [...context.eventQueue];
  context.eventQueue = [];

  // Publish all events in batch in parallel
  await Promise.allSettled(
    batch.map((event) => {
      if (context.onPublishEvent) {
        return context.onPublishEvent(event);
      }
      // If no onPublishEvent, just resolve (events can't be published)
      return Promise.resolve();
    })
  );

  // Single delay after the batch (not per event)
  if (context.batchDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, context.batchDelay));
  }
}

// ===== Setup Functions =====

/**
 * Create and configure rate limiter
 */
function createRateLimiter(
  updateProgress: (step: string, current?: number, total?: number) => void
): RateLimiter {
  const rateLimiter = new RateLimiter({
    secondsBetweenRequests: 0.25,
    secondaryRateWait: 60,
    maxRetries: 3,
  });

  rateLimiter.onProgress = (message: string) => {
    updateProgress(message);
  };

  return rateLimiter;
}

/**
 * Create rate limit wrapper function
 */
function createWithRateLimit(rateLimiter: RateLimiter, abortController: ImportAbortController) {
  return async function withRateLimit<T>(
    provider: string,
    method: string,
    operation: () => Promise<T>
  ): Promise<T> {
    let attempt = 1;

    while (true) {
      abortController?.throwIfAborted();

      // Throttle before making the request
      await rateLimiter.throttle(provider, method);

      try {
        // Execute the operation
        const result = await operation();
        return result;
      } catch (error: any) {
        // Check if we should retry
        const retryDecision = await rateLimiter.shouldRetry(error, attempt);

        if (!retryDecision.retry) {
          // Don't retry - throw the error
          throw error;
        }

        // Wait with progress updates if delay is significant
        if (retryDecision.delay > 0) {
          await rateLimiter.waitWithProgress(provider, retryDecision.delay);
        }

        attempt++;
      }
    }
  };
}

/**
 * Initialize import context with parsed URL and API connection
 */
async function initializeImportContext(
  repoUrl: string,
  token: string,
  config: ImportConfig,
  userPubkey: string,
  updateProgress: (step: string, current?: number, total?: number) => void,
  abortController: ImportAbortController,
  withRateLimit: ImportContext["withRateLimit"],
  onSignEvent?: (event: Omit<NostrEvent, "id" | "sig" | "pubkey">) => Promise<NostrEvent>,
  onPublishEvent?: (event: NostrEvent) => Promise<void>,
  eventIO?: EventIO,
  onFetchEvents?: (filters: NostrFilter[]) => Promise<NostrEvent[]>
): Promise<Partial<ImportContext>> {
  updateProgress("Parsing repository URL...");
  abortController.throwIfAborted();

  const parsed = parseRepoUrl(repoUrl);
  const platform = parsed.provider;

  updateProgress(`Connecting to ${platform}...`);
  abortController.throwIfAborted();

  if (!token || !token.trim()) {
    throw new Error(
      `Authentication token required for ${platform}. Please add a token in settings.`
    );
  }

  const api = getGitServiceApiFromUrl(repoUrl, token);

  return {
    abortController,
    platform,
    parsed,
    api,
    config,
    userPubkey,
    batchSize: config.relayBatchSize ?? 30,
    batchDelay: config.relayBatchDelay ?? 250,
    eventQueue: [],
    onSignEvent,
    onPublishEvent,
    eventIO,
    onFetchEvents,
    withRateLimit,
    updateProgress,
  };
}

// ===== Validation Functions =====

/**
 * Validate token permissions and check repository ownership
 */
async function validateTokenAndOwnership(
  context: ImportContext
): Promise<{ repo: RepoMetadata; isOwner: boolean }> {
  // Step 3: Validate token permissions
  context.updateProgress("Validating token permissions...");
  context.abortController.throwIfAborted();

  const tokenValidation = await context.withRateLimit(context.platform, "GET", () =>
    validateTokenPermissions(context.api, {
      owner: context.parsed.owner,
      repo: context.parsed.repo,
    })
  );

  if (!tokenValidation.valid) {
    throw new Error(`Token validation failed: ${tokenValidation.error || "Invalid token"}`);
  }

  if (!tokenValidation.hasRead) {
    throw new Error("Token does not have read permissions");
  }

  // Step 4: Check repository ownership
  context.updateProgress("Checking repository ownership...");
  context.abortController.throwIfAborted();

  const ownership = await context.withRateLimit(context.platform, "GET", () =>
    checkRepoOwnership(context.api, context.parsed.owner, context.parsed.repo)
  );

  return {
    repo: ownership.repo,
    isOwner: ownership.isOwner,
  };
}

/**
 * Fork repository if needed (mandatory for non-owned repos)
 */
async function ensureForkedRepo(context: ImportContext, isOwner: boolean): Promise<RepoMetadata> {
  if (isOwner) {
    if (!context.finalRepo) {
      throw new Error("Repository metadata is missing");
    }
    return context.finalRepo;
  }

  if (!context.config.forkRepo) {
    throw new Error(
      "Forking is required for repositories you don't own. Please enable 'Fork repo' to proceed."
    );
  }

  context.updateProgress("Creating fork...");
  context.abortController.throwIfAborted();

  // Use user-provided fork name if available, otherwise default to {repo}-imported
  const forkName = context.config.forkName || `${context.parsed.repo}-imported`;
  const forkedRepo = await context.withRateLimit(context.platform, "POST", () =>
    context.api.forkRepo(context.parsed.owner, context.parsed.repo, { name: forkName })
  );

  context.updateProgress(`Fork created: ${forkedRepo.fullName}`);
  return forkedRepo;
}

/**
 * Fetch repository metadata (if not already fetched)
 */
async function fetchRepoMetadata(
  context: ImportContext,
  ownershipRepo: RepoMetadata
): Promise<RepoMetadata> {
  // If we already have the repo from ownership check, we might need to fetch full metadata
  // For now, we'll fetch it if it's the same reference (meaning we didn't fork)
  if (context.finalRepo === ownershipRepo) {
    context.updateProgress("Fetching repository metadata...");
    context.abortController.throwIfAborted();
    return await context.withRateLimit(context.platform, "GET", () =>
      context.api.getRepo(context.parsed.owner, context.parsed.repo)
    );
  }

  // At this point finalRepo should be set (either from fork or ownership check)
  if (!context.finalRepo) {
    throw new Error("Repository metadata is unexpectedly null");
  }
  
  return context.finalRepo;
}

// ===== Profile Management Functions =====

const NIP39_VERIFICATION_PREFIX =
  "Verifying that I control the following Nostr public key: ";
// npub is "npub1" + 52 bech32 chars; use {50,60} for flexibility
const NIP39_NPUB_REGEX =
  /Verifying that I control the following Nostr public key:\s*(npub1[a-zA-HJ-NP-Z0-9]{50,60})/;

/**
 * Verify NIP-39 GitHub Gist proof.
 * Fetches the gist, checks owner matches username, and that content contains
 * the attestation text with npub that decodes to expectedPubkey.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/39.md#github
 */
async function verifyGitHubGistProof(
  username: string,
  proof: string,
  expectedPubkey: string,
  withRateLimit: ImportContext["withRateLimit"]
): Promise<boolean> {
  if (!proof || !/^[a-f0-9]{32}$|^[a-zA-Z0-9]+$/.test(proof)) {
    return false;
  }

  try {
    const res = await withRateLimit("github", "GET", () =>
      fetch(`https://api.github.com/gists/${proof}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      })
    );

    if (!res.ok) return false;

    const gist = (await res.json()) as {
      owner?: { login?: string };
      files?: Record<string, { content?: string }>;
    };

    const ownerLogin = gist.owner?.login;
    if (!ownerLogin) return false;

    if (ownerLogin.toLowerCase() !== username.toLowerCase()) {
      return false;
    }

    const files = gist.files;
    if (!files || typeof files !== "object") return false;

    let foundNpub: string | null = null;
    for (const file of Object.values(files)) {
      const content = file?.content ?? "";
      const match = content.match(NIP39_NPUB_REGEX);
      if (match) {
        foundNpub = match[1];
        break;
      }
      if (content.includes(NIP39_VERIFICATION_PREFIX)) {
        const idx = content.indexOf(NIP39_VERIFICATION_PREFIX);
        const after = content.slice(idx + NIP39_VERIFICATION_PREFIX.length);
        const npubMatch = after.match(/^(npub1[a-zA-HJ-NP-Z0-9]{50,60})/);
        if (npubMatch) {
          foundNpub = npubMatch[1];
          break;
        }
      }
    }

    if (!foundNpub) return false;

    const decoded = nip19.decode(foundNpub);
    if (decoded.type !== "npub") return false;

    const verifiedPubkey = decoded.data as string;
    return verifiedPubkey === expectedPubkey;
  } catch {
    return false;
  }
}

/**
 * Look up Nostr pubkey for a platform user via NIP-39 identity proof.
 * Queries kind 0 (profile) events with ["i", "platform:identity", proof] tags.
 * Verifies the GitHub Gist proof before accepting. Returns the pubkey if a
 * verified bridged profile is found, null otherwise.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/39.md
 */
async function lookupNip39BridgedPubkey(
  context: ImportContext,
  platform: string,
  username: string
): Promise<string | null> {
  const profileKey = getProfileMapKey(platform, username);
  if (context.bridgedNostrPubkeys.has(profileKey)) {
    return context.bridgedNostrPubkeys.get(profileKey)!;
  }
  if (context.nip39CheckedKeys.has(profileKey)) {
    return null;
  }

  // NIP-39 supports github, twitter, etc. For now we only look up GitHub.
  if (platform !== "github") {
    return null;
  }

  const identity = `github:${username}`;

  const fetchEvents = context.onFetchEvents ?? context.eventIO?.fetchEvents;
  if (!fetchEvents) {
    return null;
  }

  try {
    const events = await fetchEvents([
      { kinds: [0], "#i": [identity], limit: 1 },
    ]);

    if (events.length > 0) {
      // Take the most recent (relays often return newest first)
      const profile = events.reduce((a, b) =>
        (a.created_at > b.created_at ? a : b)
      );

      const iTag = profile.tags?.find(
        (t) => t[0] === "i" && t[1] === identity
      ) as [string, string, string] | undefined;
      const proof = iTag?.[2];

      if(proof) {
        const verified = await verifyGitHubGistProof(
          username,
          proof,
          profile.pubkey,
          context.withRateLimit
        );
        if (verified) {
          context.bridgedNostrPubkeys.set(profileKey, profile.pubkey);
          return profile.pubkey;
        }
  
      }
    }
  } catch (err) {
    console.warn(`[import] NIP-39 lookup failed for ${identity}:`, err);
  }

  context.nip39CheckedKeys.add(profileKey);
  return null;
}

/**
 * Add p-tag for bridged Nostr identity when NIP-39 match exists.
 * Being tagged notifies the user and allows them to later claim the event.
 */
function addBridgedPTags(
  event: Omit<NostrEvent, "id" | "sig" | "pubkey">,
  platform: string,
  username: string,
  bridgedNostrPubkeys: Map<string, string>
): void {
  const profileKey = getProfileMapKey(platform, username);
  const bridgedPubkey = bridgedNostrPubkeys.get(profileKey);
  if (bridgedPubkey && bridgedPubkey.length === 64) {
    event.tags = event.tags || [];
    event.tags.push(["p", bridgedPubkey]);
  }
}

/**
 * Ensure a user profile exists in the context
 * Uses provided username and avatarUrl directly (no API call needed)
 */
async function ensureUserProfile(context: ImportContext, username: string, avatarUrl?: string) {
  const profileKey = getProfileMapKey(context.platform, username);
  if (context.userProfiles.has(profileKey)) {
    return;
  }

  // Try NIP-39 lookup for bridged identities (github:username -> Nostr pubkey)
  await lookupNip39BridgedPubkey(context, context.platform, username);

  // Generate profile directly from available data (no API call needed!)
  // GitHub already provides username and avatarUrl in issues/PRs/comments
  const profile = generatePlatformUserProfile(context.platform, username);

  context.userProfiles.set(profileKey, {
    privkey: profile.privkey,
    pubkey: profile.pubkey,
  });
  context.profileEvents.set(profileKey, profile.profileEvent);
}

// ===== Streaming Fetch and Publish Functions =====

/**
 * Fetch and publish issues in streaming fashion (page-by-page)
 * Processes and publishes each issue immediately, keeping only ID mappings in memory
 */
async function fetchAndPublishIssuesStreaming(
  context: ImportContext
): Promise<{ count: number; statusEventsPublished: number }> {
  context.updateProgress("Fetching and publishing issues...");
  context.abortController.throwIfAborted();

  let page = 1;
  const perPage = 100;
  let totalIssues = 0;
  let statusEventsPublished = 0;
  // Track pages to estimate progress (we don't know total upfront, so we'll gradually progress through the range)
  let totalPages = 1; // Start with 1, will update as we discover more pages

  while (true) {
    context.abortController.throwIfAborted();

    const sinceDate = context.config.sinceDate ? context.config.sinceDate.toISOString() : undefined;

    // Fetch one page of issues
    const pageIssues = await context.withRateLimit(context.platform, "GET", () =>
      context.api.listIssues(context.parsed.owner, context.parsed.repo, {
        per_page: perPage,
        page,
        since: sinceDate,
        state: "all",
      })
    );

    if (pageIssues.length === 0) {
      break;
    }

    // Filter by sinceDate if provided (API might not support it)
    const filteredIssues = context.config.sinceDate
      ? pageIssues.filter((issue) => {
          const issueDate = new Date(issue.createdAt);
          return issueDate >= context.config.sinceDate!;
        })
      : pageIssues;

    // Process and publish each issue immediately
    for (const issue of filteredIssues) {
      context.abortController.throwIfAborted();

      // Generate profile if needed (incremental)
      await ensureUserProfile(context, issue.author.login, issue.author.avatarUrl);

      // Convert single issue to Nostr event
      const issueEventData = convertIssuesToNostrEvents(
        [issue], // Single issue
        context.repoAddr,
        context.platform,
        context.userProfiles,
        context.importTimestamp,
        context.currentTimestamp
      );

      if (issueEventData.length > 0) {
        const [eventData] = issueEventData;

        // Add p-tag for bridged Nostr identity (NIP-39) when match found
        addBridgedPTags(
          eventData.event,
          context.platform,
          issue.author.login,
          context.bridgedNostrPubkeys
        );

        // Sign issue event
        const signedIssueEvent = signEvent(eventData.event, eventData.privkey);

        // Publish issue event (batched)
        await publishEventBatched(context, signedIssueEvent);

        // Store only ID mapping (lightweight)
        context.issueEventIdMap.set(issue.number, signedIssueEvent.id);
        context.currentTimestamp += 1;
        totalIssues++;
        context.issuesPublished = totalIssues;

        // Generate and publish status events immediately
        const statusEvents = convertIssueStatusesToEvents(
          signedIssueEvent.id,
          issue.state,
          issue.closedAt,
          context.userPubkey,
          context.repoAddr,
          context.importTimestamp,
          context.currentTimestamp
        );

        for (const statusData of statusEvents) {
          context.abortController.throwIfAborted();

          // Sign status event
          let signedStatusEvent: NostrEvent;
          if (context.onSignEvent) {
            signedStatusEvent = await context.onSignEvent(statusData.event);
          } else if (context.eventIO) {
            const result = await context.eventIO.publishEvent(statusData.event);
            if (!result.ok) {
              throw new Error(
                `Failed to publish status event for issue #${issue.number}: ${result.error || "Unknown error"}`
              );
            }
            context.currentTimestamp += 1;
            statusEventsPublished++;
            continue; // EventIO already published it
          } else {
            throw new Error("No signing method available for status events");
          }

          // Publish status event (batched)
          await publishEventBatched(context, signedStatusEvent);

          context.currentTimestamp += 1;
          statusEventsPublished++;
        }

        // Update progress with count of published issues
        context.updateProgress(`Publishing issues... (${totalIssues} published)`, totalIssues);
      }
    }

    // Estimate total pages if this page was full (for progress estimation)
    if (pageIssues.length === perPage) {
      totalPages = page + 1; // Likely more pages ahead
    } else {
      totalPages = page; // This was likely the last page
    }

    page++;
  }

  // Flush any remaining events in the queue
  await flushEventQueue(context);

  return { count: totalIssues, statusEventsPublished };
}

/**
 * Fetch and publish pull requests in streaming fashion (page-by-page)
 * Processes and publishes each PR immediately, keeping only ID mappings in memory
 */
async function fetchAndPublishPRsStreaming(context: ImportContext): Promise<number> {
  console.log('[DEBUG] fetchAndPublishPRsStreaming START, finalRepo:', context.finalRepo?.name);
  context.updateProgress("Fetching and publishing pull requests...");
  context.abortController.throwIfAborted();

  let page = 1;
  const perPage = 100;
  let totalPRs = 0;

  while (true) {
    console.log('[DEBUG] PR loop iteration, page:', page, 'finalRepo:', context.finalRepo?.name);
    context.abortController.throwIfAborted();

    const sinceDate = context.config.sinceDate ? context.config.sinceDate.toISOString() : undefined;

    // Fetch one page of PRs
    const pagePrs = await context.withRateLimit(context.platform, "GET", () =>
      context.api.listPullRequests(context.parsed.owner, context.parsed.repo, {
        per_page: perPage,
        page,
        state: "all",
      })
    );

    // Filter by sinceDate if provided
    const filteredPrs = context.config.sinceDate
      ? pagePrs.filter((pr) => {
          const prDate = new Date(pr.createdAt);
          return prDate >= context.config.sinceDate!;
        })
      : pagePrs;

    if (filteredPrs.length === 0) {
      break;
    }

    // Process and publish each PR immediately
    for (const pr of filteredPrs) {
      console.log('[DEBUG] Processing PR #', pr.number, 'finalRepo:', context.finalRepo?.name);
      context.abortController.throwIfAborted();

      // Generate profile if needed (incremental)
      await ensureUserProfile(context, pr.author.login, pr.author.avatarUrl);

      // Optionally fetch PR commits when the API supports it (for richer import)
      let prCommits: Map<number, string[]> | undefined;
      if (context.api.listPullRequestCommits) {
        try {
          const allShas: string[] = [];
          let commitPage = 1;
          const perPage = 100;
          while (true) {
            context.abortController.throwIfAborted();
            const commits = await context.withRateLimit(context.platform, "GET", () =>
              context.api.listPullRequestCommits!(
                context.parsed.owner,
                context.parsed.repo,
                pr.number,
                { per_page: perPage, page: commitPage }
              )
            );
            for (const c of commits) allShas.push(c.sha);
            if (commits.length < perPage) break;
            commitPage++;
          }
          if (allShas.length > 0) {
            prCommits = new Map([[pr.number, allShas]]);
          }
        } catch (err) {
          console.warn(`[import] Could not fetch commits for PR #${pr.number}:`, err);
        }
      }

      // Convert single PR to Nostr event (with title, body, branch, base, labels, commits)
      console.log('[DEBUG] About to convert PR to Nostr event, finalRepo:', context.finalRepo?.name);
      const prEventData = convertPullRequestsToNostrEvents(
        [pr], // Single PR
        context.repoAddr,
        context.platform,
        context.userProfiles,
        context.importTimestamp,
        context.currentTimestamp,
        prCommits
      );

      if (prEventData.length > 0) {
        const [eventData] = prEventData;

        // Add p-tag for bridged Nostr identity (NIP-39) when match found
        addBridgedPTags(
          eventData.event,
          context.platform,
          pr.author.login,
          context.bridgedNostrPubkeys
        );

        // Sign PR event
        const signedPrEvent = signEvent(eventData.event, eventData.privkey);

        // Store PR event ID for comment linking
        context.prEventIdMap.set(pr.number, signedPrEvent.id);

        // Publish PR event (batched)
        await publishEventBatched(context, signedPrEvent);

        context.currentTimestamp += 1;
        totalPRs++;
        context.prsPublished = totalPRs;

        // Update progress with count of published PRs
        context.updateProgress(`Publishing PRs... (${totalPRs} published)`, totalPRs);
      }
    }

    // Check if we should continue
    if (pagePrs.length < perPage) {
      break;
    }

    page++;
  }

  // Flush any remaining events in the queue
  await flushEventQueue(context);

  return totalPRs;
}

/**
 * Fetch and publish comments in streaming fashion (page-by-page)
 * Only processes comments for issues/PRs that were successfully published
 */
async function fetchAndPublishCommentsStreaming(
  context: ImportContext,
  issueNumbers: Set<number>,
  prNumbers: Set<number>
): Promise<number> {
  if (issueNumbers.size === 0 && prNumbers.size === 0) {
    return 0;
  }

  context.updateProgress("Fetching and publishing comments...");
  context.abortController.throwIfAborted();

  // Check if the API supports bulk comment fetching
  const apiWithBulkComments = context.api;
  let totalCommentsPublished = 0;
  const commentEventMap: CommentEventMap = new Map(); // For threading within each issue/PR

  if (apiWithBulkComments.listAllIssueComments) {
    // Use bulk endpoint if available
    const sinceDate = context.config.sinceDate ? context.config.sinceDate.toISOString() : undefined;
    let page = 1;
    const perPage = 100;

    while (true) {
      context.abortController.throwIfAborted();

      // Fetch one page of comments
      const pageComments: Array<Comment & { issueNumber: number; isPullRequest: boolean }> =
        await context.withRateLimit(context.platform, "GET", () =>
          apiWithBulkComments.listAllIssueComments!(context.parsed.owner, context.parsed.repo, {
            per_page: perPage,
            page,
            since: sinceDate,
          })
        );

      if (pageComments.length === 0) {
        break;
      }

      // Filter by sinceDate if provided
      const filteredComments = context.config.sinceDate
        ? pageComments.filter((comment) => {
            const commentDate = new Date(comment.createdAt);
            return commentDate >= context.config.sinceDate!;
          })
        : pageComments;

      // Process and publish each comment immediately
      for (const comment of filteredComments) {
        context.abortController.throwIfAborted();

        // Determine if this is a PR comment or issue comment
        const isPrComment = prNumbers.has(comment.issueNumber);
        const isIssueComment = issueNumbers.has(comment.issueNumber);

        // Only process comments for published issues/PRs
        if (!isPrComment && !isIssueComment) {
          continue;
        }

        // Get parent event ID
        const parentEventId = isPrComment
          ? context.prEventIdMap.get(comment.issueNumber)
          : context.issueEventIdMap.get(comment.issueNumber);

        if (!parentEventId) {
          console.warn(
            `Skipping comment for ${isPrComment ? "PR" : "issue"} #${comment.issueNumber} - parent event ID not found`
          );
          continue;
        }

        // Generate profile if needed
        await ensureUserProfile(context, comment.author.login, comment.author.avatarUrl);

        // Convert single comment to Nostr event
        const convertedComments = convertCommentsToNostrEvents(
          [comment],
          parentEventId,
          context.platform,
          context.userProfiles,
          commentEventMap,
          context.importTimestamp,
          context.currentTimestamp
        );

        if (convertedComments.length > 0) {
          const [convertedComment] = convertedComments;

          // Add p-tag for bridged Nostr identity (NIP-39) when match found
          addBridgedPTags(
            convertedComment.event,
            context.platform,
            comment.author.login,
            context.bridgedNostrPubkeys
          );

          // Sign comment event
          const signedCommentEvent = signEvent(convertedComment.event, convertedComment.privkey);

          // Publish comment event (batched)
          await publishEventBatched(context, signedCommentEvent);

          // Store comment event ID for threading (within same issue/PR)
          commentEventMap.set(convertedComment.platformCommentId, signedCommentEvent.id);

          context.currentTimestamp += 1;
          totalCommentsPublished++;
          context.commentsPublished = totalCommentsPublished;
        }
      }

      // Update progress with count of published comments
      context.updateProgress(
        `Publishing comments... (${totalCommentsPublished} published)`,
        totalCommentsPublished
      );

      if (pageComments.length < perPage) {
        break;
      }

      page++;
    }

    // Flush any remaining events in the queue after bulk comments
    await flushEventQueue(context);
  } else {
    // Fallback: fetch comments per issue/PR (less efficient but works)
    // This is a simplified version - in practice, you might want to optimize this further
    for (const issueNumber of issueNumbers) {
      context.abortController.throwIfAborted();

      const issueEventId = context.issueEventIdMap.get(issueNumber);
      if (!issueEventId) continue;

      const sinceDate = context.config.sinceDate
        ? context.config.sinceDate.toISOString()
        : undefined;
      let commentPage = 1;
      const commentsPerPage = 100;

      while (true) {
        context.abortController.throwIfAborted();

        const pageComments = await context.withRateLimit(context.platform, "GET", () =>
          context.api.listIssueComments(context.parsed.owner, context.parsed.repo, issueNumber, {
            per_page: commentsPerPage,
            page: commentPage,
            since: sinceDate,
          })
        );

        if (pageComments.length === 0) {
          break;
        }

        // Filter and publish each comment
        for (const comment of pageComments) {
          if (context.config.sinceDate) {
            const commentDate = new Date(comment.createdAt);
            if (commentDate < context.config.sinceDate!) {
              continue;
            }
          }

          await ensureUserProfile(context, comment.author.login, comment.author.avatarUrl);

          const convertedComments = convertCommentsToNostrEvents(
            [comment],
            issueEventId,
            context.platform,
            context.userProfiles,
            commentEventMap,
            context.importTimestamp,
            context.currentTimestamp
          );

          if (convertedComments.length > 0) {
            const [convertedComment] = convertedComments;

            addBridgedPTags(
              convertedComment.event,
              context.platform,
              comment.author.login,
              context.bridgedNostrPubkeys
            );

            const signedCommentEvent = signEvent(convertedComment.event, convertedComment.privkey);

            // Publish comment event (batched)
            await publishEventBatched(context, signedCommentEvent);

            commentEventMap.set(convertedComment.platformCommentId, signedCommentEvent.id);
            context.currentTimestamp += 1;
            totalCommentsPublished++;
            context.commentsPublished = totalCommentsPublished;
          }
        }

        if (pageComments.length < commentsPerPage) {
          break;
        }

        commentPage++;
      }

      // Clear commentEventMap after each issue to free memory
      commentEventMap.clear();
    }

    // Similar for PRs
    for (const prNumber of prNumbers) {
      context.abortController.throwIfAborted();

      const prEventId = context.prEventIdMap.get(prNumber);
      if (!prEventId) continue;

      const sinceDate = context.config.sinceDate
        ? context.config.sinceDate.toISOString()
        : undefined;
      let commentPage = 1;
      const commentsPerPage = 100;

      while (true) {
        context.abortController.throwIfAborted();

        const pageComments = await context.withRateLimit(context.platform, "GET", () =>
          context.api.listPullRequestComments(context.parsed.owner, context.parsed.repo, prNumber, {
            per_page: commentsPerPage,
            page: commentPage,
            since: sinceDate,
          })
        );

        if (pageComments.length === 0) {
          break;
        }

        for (const comment of pageComments) {
          if (context.config.sinceDate) {
            const commentDate = new Date(comment.createdAt);
            if (commentDate < context.config.sinceDate!) {
              continue;
            }
          }

          await ensureUserProfile(context, comment.author.login, comment.author.avatarUrl);

          const convertedComments = convertCommentsToNostrEvents(
            [comment],
            prEventId,
            context.platform,
            context.userProfiles,
            commentEventMap,
            context.importTimestamp,
            context.currentTimestamp
          );

          if (convertedComments.length > 0) {
            const [convertedComment] = convertedComments;

            addBridgedPTags(
              convertedComment.event,
              context.platform,
              comment.author.login,
              context.bridgedNostrPubkeys
            );

            const signedCommentEvent = signEvent(convertedComment.event, convertedComment.privkey);

            // Publish comment event (batched)
            await publishEventBatched(context, signedCommentEvent);

            commentEventMap.set(convertedComment.platformCommentId, signedCommentEvent.id);
            context.currentTimestamp += 1;
            totalCommentsPublished++;
            context.commentsPublished = totalCommentsPublished;
          }
        }

        if (pageComments.length < commentsPerPage) {
          break;
        }

        commentPage++;
      }

      commentEventMap.clear();
    }

    // Flush any remaining events in the queue after fallback comment fetching
    await flushEventQueue(context);
  }

  return totalCommentsPublished;
}

// ===== Event Conversion Functions =====

/**
 * Convert repository metadata to Nostr events
 */
function convertRepoEvents(context: ImportContext): {
  announcement: Omit<NostrEvent, "id" | "sig" | "pubkey">;
  state: Omit<NostrEvent, "id" | "sig" | "pubkey">;
} {
  context.updateProgress("Converting repository metadata...");
  context.abortController.throwIfAborted();

  if (!context.finalRepo) {
    throw new Error("Repository metadata is not available for conversion");
  }

  // Get relays from config (required for repo announcement)
  const relays: string[] = context.config.relays || [];

  if (relays.length === 0) {
    throw new Error("At least one relay is required for repository announcement");
  }

  const repoAnnouncementEventTemplate = convertRepoToNostrEvent(
    context.finalRepo,
    relays,
    context.userPubkey,
    context.importTimestamp
  );

  const repoStateEventTemplate = convertRepoToStateEvent(
    context.finalRepo,
    context.importTimestamp
  );

  return {
    announcement: repoAnnouncementEventTemplate,
    state: repoStateEventTemplate,
  };
}

// ===== Event Publishing Functions =====

/**
 * Sign and publish repository events
 */
async function publishRepoEvents(
  context: ImportContext,
  repoEvents: {
    announcement: Omit<NostrEvent, "id" | "sig" | "pubkey">;
    state: Omit<NostrEvent, "id" | "sig" | "pubkey">;
  }
): Promise<{ announcement: NostrEvent; state: NostrEvent }> {
  context.updateProgress("Publishing repository events...");
  context.abortController.throwIfAborted();

  let signedRepoAnnouncement: NostrEvent;
  let signedRepoState: NostrEvent;

  // Sign repo announcement event using available signer method
  // Note: We need the signed event to get its ID, so we can't use EventIO directly
  if (context.onSignEvent) {
    signedRepoAnnouncement = await context.onSignEvent(repoEvents.announcement);
    signedRepoState = await context.onSignEvent(repoEvents.state);
  } else if (context.eventIO) {
    // EventIO signs internally but doesn't return the signed event
    // We need the event ID, so we can't use EventIO for events that need IDs
    throw new Error(
      "EventIO cannot be used for repo events that need IDs. Please provide onSignEvent callback."
    );
  } else {
    throw new Error("onSignEvent callback is required to sign repo events");
  }

  // Publish signed repo events
  if (context.onPublishEvent) {
    await context.onPublishEvent(signedRepoAnnouncement);
    await context.onPublishEvent(signedRepoState);
  } else if (context.eventIO) {
    // EventIO doesn't accept already-signed events, so we need onPublishEvent
    throw new Error("onPublishEvent callback is required to publish signed events");
  } else {
    throw new Error("Either onPublishEvent callback must be provided to publish events");
  }

  return {
    announcement: signedRepoAnnouncement,
    state: signedRepoState,
  };
}

/**
 * Publish profile events (kind 0) for all platform users
 */
async function publishProfileEvents(context: ImportContext): Promise<void> {
  context.updateProgress(`Publishing ${context.profileEvents.size} user profiles...`);
  context.abortController.throwIfAborted();

  let profileCount = 0;
  for (const [profileKey, profileEvent] of context.profileEvents.entries()) {
    context.abortController.throwIfAborted();
    context.updateProgress(
      `Publishing profile ${++profileCount}/${context.profileEvents.size}...`,
      profileCount,
      context.profileEvents.size
    );

    // Publish profile event (batched)
    await publishEventBatched(context, profileEvent);
  }
}

/**
 * Svelte 5 composable for importing repositories from Git hosting providers
 */
export function useImportRepo(options: UseImportRepoOptions) {
  const { onProgress, onImportCompleted, userPubkey, eventIO, onFetchEvents, onSignEvent, onPublishEvent } =
    options;

  // Validate that we have a way to sign user events (repo events, status events)
  if (!onSignEvent && !eventIO) {
    throw new Error("Either onSignEvent callback or eventIO must be provided to sign user events");
  }

  let isImporting = $state(false);
  let progress = $state<ImportProgress | undefined>();
  let error = $state<string | null>(null);
  let abortController: ImportAbortController | null = null;

  /**
   * Update progress state and call callback
   */
  function updateProgress(step: string, current?: number, total?: number): void {
    progress = {
      step,
      current,
      total,
      isComplete: false,
    };
    onProgress?.(progress);
  }

  /**
   * Main import function
   *
   * @param repoUrl - Repository URL to import (e.g., "https://github.com/owner/repo")
   * @param token - Authentication token for the Git hosting provider
   * @param config - Import configuration options
   * @returns Import result with events and statistics
   */
  async function importRepository(
    repoUrl: string,
    token: string,
    config: ImportConfig = DEFAULT_IMPORT_CONFIG
  ): Promise<ImportResult> {
    if (isImporting) {
      throw new Error("Import operation already in progress");
    }

    isImporting = true;
    error = null;
    abortController = new ImportAbortController();

    // Create rate limiter and wrapper
    const rateLimiter = createRateLimiter(updateProgress);
    const withRateLimitFn = createWithRateLimit(rateLimiter, abortController);

    try {
      // Initialize context
      const partialContext = await initializeImportContext(
        repoUrl,
        token,
        config,
        userPubkey,
        updateProgress,
        abortController,
        withRateLimitFn,
        onSignEvent,
        onPublishEvent,
        eventIO,
        onFetchEvents
      );

      // Complete context initialization
      const context: ImportContext = {
        ...partialContext,
        rateLimiter,
        withRateLimit: withRateLimitFn,
        finalRepo: null, // Will be set during repository setup
        repoAddr: "", // Will be set below
        importTimestamp: Math.floor(Date.now() / 1000),
        startTimestamp: 0, // Will be set below
        currentTimestamp: 0, // Will be set below
        userProfiles: new Map(),
        profileEvents: new Map(),
        bridgedNostrPubkeys: new Map(),
        nip39CheckedKeys: new Set(),
        issueEventIdMap: new Map(),
        prEventIdMap: new Map(),
        commentEventMap: new Map(),
        issuesPublished: 0,
        prsPublished: 0,
        commentsPublished: 0,
      } as ImportContext;

      // Validation & Repository Setup
      const { repo: ownershipRepo, isOwner } = await validateTokenAndOwnership(context);
      
      if (!ownershipRepo) {
        throw new Error("Failed to fetch repository information");
      }
      
      // Set initial repo
      context.finalRepo = ownershipRepo;
      console.log('[DEBUG] Set initial finalRepo:', context.finalRepo?.name);
      
      // Fork if needed (this updates context.finalRepo)
      const forkedOrOriginalRepo = await ensureForkedRepo(context, isOwner);
      if (!forkedOrOriginalRepo) {
        throw new Error("Failed to ensure repository access");
      }
      context.finalRepo = forkedOrOriginalRepo;
      console.log('[DEBUG] After fork/ensure, finalRepo:', context.finalRepo?.name);
      
      // Fetch full metadata if needed
      const repoWithMetadata = await fetchRepoMetadata(context, ownershipRepo);
      if (!repoWithMetadata) {
        throw new Error("Failed to fetch repository metadata");
      }
      context.finalRepo = repoWithMetadata;
      console.log('[DEBUG] After metadata fetch, finalRepo:', context.finalRepo?.name);

      // Final safety check before proceeding
      if (!context.finalRepo) {
        throw new Error("Repository metadata is null after setup - this should not happen");
      }

      // Initialize repo address and timestamps
      console.log('[DEBUG] About to access finalRepo.name, finalRepo is:', context.finalRepo);
      const repoName = context.finalRepo.fullName.split("/").pop() || context.finalRepo.name;
      console.log('[DEBUG] Successfully got repoName:', repoName);
      context.repoAddr = `30617:${userPubkey}:${repoName}`;
      context.startTimestamp = context.importTimestamp - 3600; // Start from 1 hour ago
      context.currentTimestamp = context.startTimestamp;

      // Step 1: Convert and publish repo events (unchanged)
      console.log('[DEBUG] Before convertRepoEvents, finalRepo:', context.finalRepo?.name);
      const repoEvents = convertRepoEvents(context);
      console.log('[DEBUG] After convertRepoEvents, finalRepo:', context.finalRepo?.name);
      const { announcement: signedRepoAnnouncement, state: signedRepoState } =
        await publishRepoEvents(context, repoEvents);
      console.log('[DEBUG] After publishRepoEvents, finalRepo:', context.finalRepo?.name);

      // Step 2: Stream issues (fetch, process, publish immediately)
      let issuesImported = 0;
      if (config.mirrorIssues) {
        const issueResult = await fetchAndPublishIssuesStreaming(context);
        issuesImported = issueResult.count;
      }

      // Step 3: Stream PRs (fetch, process, publish immediately)
      let prsImported = 0;
      if (config.mirrorPullRequests) {
        console.log('[DEBUG] Before PRs, finalRepo:', context.finalRepo?.name);
        prsImported = await fetchAndPublishPRsStreaming(context);
        console.log('[DEBUG] After PRs, finalRepo:', context.finalRepo?.name);
      }

      // Step 4: Stream comments (if enabled)
      let commentsImported = 0;
      if (config.mirrorComments) {
        console.log('[DEBUG] Before comments, finalRepo:', context.finalRepo?.name);
        const issueNumbers = new Set(Array.from(context.issueEventIdMap.keys()));
        const prNumbers = new Set(Array.from(context.prEventIdMap.keys()));
        commentsImported = await fetchAndPublishCommentsStreaming(context, issueNumbers, prNumbers);
        console.log('[DEBUG] After comments, finalRepo:', context.finalRepo?.name);
      }

      // Step 5: Publish profiles (batch at end - small memory footprint)
      await publishProfileEvents(context);

      // Final flush: ensure all queued events are published before completing
      await flushEventQueue(context);

      // Complete
      updateProgress("Import completed successfully!");
      if (progress) {
        progress.isComplete = true;
      }

      // Final validation before returning result
      console.log('[DEBUG] Before creating result, finalRepo:', context.finalRepo);
      if (!context.finalRepo) {
        console.error('[DEBUG] ERROR: finalRepo is null when creating result!');
        throw new Error("Repository metadata was lost during import");
      }

      const result: ImportResult = {
        announcementEvent: signedRepoAnnouncement as RepoAnnouncementEvent,
        stateEvent: signedRepoState as RepoStateEvent,
        issuesImported,
        commentsImported,
        prsImported,
        profilesCreated: context.userProfiles.size,
        repo: context.finalRepo,
      };

      onImportCompleted?.(result);

      return result;
    } catch (err: unknown) {
      const errorMessage =
        err instanceof ImportAbortedError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      error = errorMessage;

      if (progress) {
        progress.error = errorMessage;
        progress.isComplete = false;
      }

      // Re-throw ImportAbortedError as-is, wrap others
      if (err instanceof ImportAbortedError) {
        throw err;
      }
      throw new Error(errorMessage);
    } finally {
      isImporting = false;
      abortController = null;
    }
  }

  /**
   * Abort the current import operation
   */
  function abortImport(reason?: string): void {
    if (abortController) {
      abortController.abort(reason);
    }
  }

  return {
    importRepository,
    abortImport,
    get isImporting() {
      return isImporting;
    },
    get progress() {
      return progress;
    },
    get error() {
      return error;
    },
  };
}
