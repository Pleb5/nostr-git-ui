<script lang="ts">
  import {
    X,
    Download,
    AlertCircle,
    CheckCircle2,
    Loader2,
    Calendar,
    GitBranch,
    MessageSquare,
    FileText,
    Globe,
    Trash2,
    Plus,
    ExternalLink,
  } from "@lucide/svelte";
  import {
    useImportRepo,
    type ImportProgress,
    type ImportResult,
    type ImportRemoteTarget,
    IMPORT_PHASES,
    IMPORT_PHASE_LABELS,
    type ImportPhase,
  } from "../../hooks/useImportRepo.svelte";
  import { tokens } from "../../stores/tokens.js";
  import { graspServersStore } from "../../stores/graspServers.js";
  import {
    parseRepoUrl,
    DEFAULT_RELAYS,
    getGitServiceApi,
    getGitServiceApiFromUrl,
    checkRepoOwnership,
  } from "@nostr-git/core";
  import { tryTokensForHost } from "../../utils/tokenHelpers.js";
  import { matchesHost } from "../../utils/tokenMatcher.js";
  import { checkGraspRepoExists } from "../../utils/grasp-availability.js";
  import { AllTokensFailedError, TokenNotFoundError } from "../../utils/tokenErrors.js";
  import { toast } from "../../stores/toast";
  import type { Token } from "../../stores/tokens.js";
  import type { EventIO, NostrEvent } from "@nostr-git/core";
  import type { ImportConfig } from "@nostr-git/core";

  interface Props {
    pubkey: string;
    workerApi?: any;
    onSignEvent?: (event: Omit<NostrEvent, "id" | "sig" | "pubkey">) => Promise<NostrEvent>; // Optional - works with all signers
    eventIO?: EventIO;
    onFetchEvents?: (filters: import("@nostr-git/core").NostrFilter[]) => Promise<NostrEvent[]>;
    onClose: () => void;
    onPublishEvent?: (event: NostrEvent) => Promise<unknown>;
    onRollbackPublishedRepoEvents?: (params: {
      repoName: string;
      relays: string[];
    }) => Promise<void>;
    onImportComplete?: (result: ImportResult) => void;
    onNavigateToRepo?: (result: ImportResult) => void; // Optional callback to navigate to the imported repo
    onAbortImport?: () => Promise<void> | void;
    defaultRelays?: string[];
  }

  const {
    pubkey,
    workerApi,
    onSignEvent,
    eventIO,
    onFetchEvents,
    onClose,
    onPublishEvent,
    onRollbackPublishedRepoEvents,
    onImportComplete,
    onNavigateToRepo,
    onAbortImport,
    defaultRelays = DEFAULT_RELAYS.default.slice(0, 2),
  }: Props = $props();

  // Validate that we have at least one signing method
  if (!onSignEvent && !eventIO) {
    throw new Error("Either onSignEvent callback or eventIO must be provided for signing events");
  }

  // Initialize the useImportRepo hook
  const importState = useImportRepo({
    userPubkey: pubkey,
    workerApi,
    onSignEvent,
    eventIO,
    onFetchEvents,
    onProgress: (progress) => {
      currentProgress = progress;
    },
    onImportCompleted: (result) => {
      completedResult = result;
      // Ensure currentProgress reflects completion
      if (currentProgress) {
        currentProgress = { ...currentProgress, isComplete: true };
      }
      toast.push({
        message: "Repository imported successfully!",
        variant: "default",
      });
      onImportComplete?.(result);
    },
    onPublishEvent,
    onRollbackPublishedRepoEvents,
  });

  // Step management (1: URL + Token + Date, 2: Preview + Config, 3: Progress)
  let currentStep = $state(1);
  let currentProgress = $state<ImportProgress | undefined>();
  let completedResult = $state<ImportResult | null>(null);

  // Form state - Step 1
  let repoUrl = $state("");
  let selectedHost = $state<string | null>(null);
  let sinceDate = $state<Date | undefined>(undefined);
  let sourceToken = $state<string | null>(null);
  let tokenValidated = $state(false);
  let isValidatingToken = $state(false);
  let tokenValidationError = $state<string | undefined>();
  let validatedForUrl = $state<string | null>(null);
  let validationTimer: ReturnType<typeof setTimeout> | null = null;
  let sourceValidationRunId = 0;

  // Form state - Step 2
  let repoMetadata = $state<{
    owner: string;
    name: string;
    defaultBranch: string;
    description?: string;
    htmlUrl: string;
    isOwner: boolean;
  } | null>(null);
  let selectedRelays = $state<string[]>([...defaultRelays]);
  let announceRepo = $state(true); // Always enabled
  let mirrorIssues = $state(true);
  let mirrorPullRequests = $state(true);
  let mirrorComments = $state(true);

  type ImportTargetStatus = "checking" | "ready" | "failed" | "unsupported" | "no-token";
  type ImportTargetOption = {
    id: string;
    label: string;
    provider: "github" | "gitlab" | "gitea" | "bitbucket" | "grasp";
    host?: string;
    relayUrl?: string;
    status: ImportTargetStatus;
    detail?: string;
    validatedToken?: string;
    existsAlready?: boolean;
    existingRemoteUrl?: string;
    existingWebUrl?: string;
  };

  let importTargets = $state<ImportTargetOption[]>([]);
  let selectedImportTargetIds = $state<string[]>([]);
  let initializedTargetSelection = $state(false);
  let targetPreflightRunId = 0;
  let graspServerOptions = $state<string[]>([]);
  let graspRelayUrls = $state<string[]>([]);
  let newGraspRelayUrl = $state("");

  type ImportBranchOption = {
    name: string;
    commitSha?: string;
    commitDate?: string;
    timestampMs: number;
    isDefault: boolean;
  };

  let defaultImportBranch = $state("main");
  let importBranchOptions = $state<ImportBranchOption[]>([]);
  let selectedAdditionalBranchNames = $state<string[]>([]);
  let isLoadingImportBranches = $state(false);
  let importBranchLoadError = $state<string | undefined>();

  // UI state
  let validationError = $state<string | undefined>();
  let isCheckingOwnership = $state(false);

  // Token management
  let tokenList = $state<Token[]>([]);
  tokens.subscribe((t) => {
    tokenList = t;
  });

  graspServersStore.subscribe((urls) => {
    graspServerOptions = urls;
    if (graspRelayUrls.length === 0 && urls.length > 0) {
      graspRelayUrls = [...urls];
      syncGraspRelaysToPreferredRelays(urls);
    }
  });

  async function waitForTokens(): Promise<Token[]> {
    return await tokens.waitForInitialization();
  }

  function normalizeRelayUrl(value: string): string {
    return (value || "").trim().replace(/\/+$/, "");
  }

  function syncGraspRelaysToPreferredRelays(urls: string[]) {
    const normalized = (urls || []).map(normalizeRelayUrl).filter(Boolean);
    if (normalized.length === 0) return;
    selectedRelays = Array.from(new Set([...(selectedRelays || []), ...normalized]));
  }

  function normalizeTokenHostForTarget(host: string): string {
    const normalized = (host || "").trim().toLowerCase();
    if (normalized === "api.github.com") return "github.com";
    return normalized;
  }

  function inferProvider(host: string, token: string): ImportTargetOption["provider"] | null {
    const normalizedHost = host.toLowerCase();
    const normalizedToken = token.toLowerCase();

    if (normalizedHost.includes("github")) return "github";
    if (normalizedHost.includes("gitlab")) return "gitlab";
    if (normalizedHost.includes("gitea") || normalizedHost === "codeberg.org") return "gitea";
    if (normalizedHost.includes("bitbucket")) return "bitbucket";

    if (normalizedToken.startsWith("github_pat_") || normalizedToken.startsWith("ghp_")) {
      return "github";
    }
    if (normalizedToken.startsWith("glpat-")) return "gitlab";

    return null;
  }

  function providerLabel(provider: ImportTargetOption["provider"]): string {
    if (provider === "github") return "GitHub";
    if (provider === "gitlab") return "GitLab";
    if (provider === "gitea") return "Gitea";
    if (provider === "bitbucket") return "Bitbucket";
    return "GRASP";
  }

  async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    if (items.length === 0) return [];

    const concurrency = Math.max(1, Math.min(limit, items.length));
    const results = new Array<R>(items.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const currentIndex = cursor;
        cursor += 1;
        if (currentIndex >= items.length) return;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
  }

  function parseDateToTimestampMs(value?: string): number {
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function buildSmartHttpCandidateUrls(sourceRepoUrl: string): string[] {
    const trimmed = sourceRepoUrl.trim().replace(/\/+$/, "");
    if (!trimmed) return [];

    const candidates: string[] = [];
    const add = (value: string) => {
      const normalized = value.trim();
      if (normalized && !candidates.includes(normalized)) {
        candidates.push(normalized);
      }
    };

    if (/^https?:\/\//i.test(trimmed) && !trimmed.endsWith(".git")) {
      add(`${trimmed}.git`);
    }

    add(trimmed);

    return candidates;
  }

  async function loadImportBranches(
    sourceRepoUrl: string,
    owner: string,
    repo: string,
    token: string,
    preferredDefaultBranch?: string
  ) {
    isLoadingImportBranches = true;
    importBranchLoadError = undefined;

    try {
      const normalizedDefaultBranch = (preferredDefaultBranch || "main").trim() || "main";
      defaultImportBranch = normalizedDefaultBranch;

      const branchByName = new Map<string, { name: string; commitSha?: string }>();

      if (workerApi?.listServerRefs) {
        for (const candidateUrl of buildSmartHttpCandidateUrls(sourceRepoUrl)) {
          try {
            const refs = await workerApi.listServerRefs({
              url: candidateUrl,
              prefix: "refs/heads/",
              symrefs: false,
            });

            for (const item of refs || []) {
              const rawRef = String(item?.ref || "");
              if (!rawRef.startsWith("refs/heads/")) continue;
              const branchName = rawRef.replace(/^refs\/heads\//, "").trim();
              if (!branchName) continue;
              const commitSha =
                typeof item?.oid === "string" && item.oid.trim() ? item.oid.trim() : undefined;
              branchByName.set(branchName, { name: branchName, commitSha });
            }

            if (branchByName.size > 0) {
              break;
            }
          } catch {
            // try next candidate URL before falling back to provider API
          }
        }
      }

      const api = getGitServiceApiFromUrl(sourceRepoUrl, token);

      if (branchByName.size === 0) {
        const sourceBranches = await api.listBranches(owner, repo);
        for (const branch of sourceBranches || []) {
          const branchName = String(branch?.name || "").trim();
          if (!branchName) continue;
          const commitSha =
            typeof branch?.commit?.sha === "string" && branch.commit.sha.trim()
              ? branch.commit.sha.trim()
              : undefined;
          branchByName.set(branchName, { name: branchName, commitSha });
        }
      }

      if (!branchByName.has(normalizedDefaultBranch)) {
        branchByName.set(normalizedDefaultBranch, { name: normalizedDefaultBranch });
      }

      const branchCandidates = Array.from(branchByName.values());
      const enriched = await mapWithConcurrency(branchCandidates, 6, async (candidate) => {
        try {
          let commitDate = "";
          let commitSha = candidate.commitSha;

          if (commitSha) {
            const commit = await api.getCommit(owner, repo, commitSha);
            commitDate = commit?.committer?.date || commit?.author?.date || "";
          } else {
            const commits = await api.listCommits(owner, repo, {
              sha: candidate.name,
              per_page: 1,
            });
            const latest = Array.isArray(commits) ? commits[0] : undefined;
            commitSha = latest?.sha || commitSha;
            commitDate = latest?.committer?.date || latest?.author?.date || "";
          }

          return {
            name: candidate.name,
            commitSha,
            commitDate,
            timestampMs: parseDateToTimestampMs(commitDate),
            isDefault: candidate.name === normalizedDefaultBranch,
          } satisfies ImportBranchOption;
        } catch {
          return {
            name: candidate.name,
            commitSha: candidate.commitSha,
            commitDate: undefined,
            timestampMs: 0,
            isDefault: candidate.name === normalizedDefaultBranch,
          } satisfies ImportBranchOption;
        }
      });

      enriched.sort((a, b) => {
        if (b.timestampMs !== a.timestampMs) return b.timestampMs - a.timestampMs;
        return a.name.localeCompare(b.name);
      });

      importBranchOptions = enriched;
      selectedAdditionalBranchNames = [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      importBranchLoadError = message || "Failed to load branch options";
      importBranchOptions = [
        {
          name: defaultImportBranch,
          isDefault: true,
          timestampMs: 0,
        },
      ];
      selectedAdditionalBranchNames = [];
    } finally {
      isLoadingImportBranches = false;
    }
  }

  function selectAllAdditionalBranches() {
    selectedAdditionalBranchNames = importBranchOptions
      .filter((branch) => !branch.isDefault)
      .map((branch) => branch.name);
  }

  function clearAdditionalBranches() {
    selectedAdditionalBranchNames = [];
  }

  const selectedBranchNamesForImport = $derived.by(() => {
    const defaultBranch = defaultImportBranch || "main";
    const selected = Array.from(
      new Set([
        defaultBranch,
        ...selectedAdditionalBranchNames.filter((name) => name && name !== defaultBranch),
      ])
    );
    return selected;
  });

  function getProviderBaseUrl(
    provider: ImportTargetOption["provider"],
    host?: string
  ): string | undefined {
    if (!host || provider === "grasp") return undefined;
    const normalizedHost = host.toLowerCase();

    if (provider === "github") {
      if (normalizedHost === "github.com") return undefined;
      return `https://${host}/api/v3`;
    }
    if (provider === "gitlab") {
      if (normalizedHost === "gitlab.com") return undefined;
      return `https://${host}/api/v4`;
    }
    if (provider === "gitea") {
      return `https://${host}/api/v1`;
    }
    if (provider === "bitbucket") {
      if (normalizedHost === "bitbucket.org") return undefined;
      return `https://${host}/api/2.0`;
    }
    return undefined;
  }

  function upsertGraspRelay(url: string) {
    const normalized = normalizeRelayUrl(url);
    if (!normalized) return;
    if (!graspRelayUrls.includes(normalized)) {
      graspRelayUrls = [...graspRelayUrls, normalized];
      initializedTargetSelection = false;
    }
    syncGraspRelaysToPreferredRelays([normalized]);
  }

  function removeGraspRelay(index: number) {
    graspRelayUrls = graspRelayUrls.filter((_, i) => i !== index);
    initializedTargetSelection = false;
  }

  function commitNewGraspRelay() {
    if (!newGraspRelayUrl.trim()) return;
    upsertGraspRelay(newGraspRelayUrl);
    newGraspRelayUrl = "";
  }

  const targetRepoName = $derived.by(() => {
    if (!repoMetadata) return "";
    return repoMetadata.name;
  });

  function buildImportTargets(): ImportTargetOption[] {
    const targetMap = new Map<string, ImportTargetOption>();

    const tokenByHost = new Map<string, string>();
    for (const entry of tokenList) {
      const normalizedHost = normalizeTokenHostForTarget(entry.host);
      if (!normalizedHost) continue;
      if (!tokenByHost.has(normalizedHost)) tokenByHost.set(normalizedHost, entry.token);
    }

    for (const [host, sampleToken] of tokenByHost.entries()) {
      const provider = inferProvider(host, sampleToken);
      if (!provider) {
        targetMap.set(`unsupported:${host}`, {
          id: `unsupported:${host}`,
          label: `${host}`,
          provider: "github",
          host,
          status: "unsupported",
          detail: "Could not infer provider from token host",
        });
        continue;
      }

      targetMap.set(`git:${host}`, {
        id: `git:${host}`,
        label: `${providerLabel(provider)} (${host})`,
        provider,
        host,
        status: "checking",
      });
    }

    graspRelayUrls.forEach((relayUrl, index) => {
      const normalized = normalizeRelayUrl(relayUrl);
      if (!normalized) return;
      targetMap.set(`grasp:${normalized}`, {
        id: `grasp:${normalized}`,
        label: `GRASP (${normalized.replace(/^wss?:\/\//, "")})`,
        provider: "grasp",
        relayUrl: normalized,
        status: "checking",
        detail: index === 0 ? "Primary relay" : undefined,
      });
    });

    return Array.from(targetMap.values());
  }

  function isNotFoundError(error: unknown): boolean {
    const anyError = error as any;
    const message = error instanceof Error ? error.message : String(error || "");
    const lowered = message.toLowerCase();
    const statusCode = anyError?.statusCode ?? anyError?.status ?? anyError?.context?.statusCode;
    return statusCode === 404 || lowered.includes("404") || lowered.includes("not found");
  }

  function toFriendlyTargetPreflightError(error: unknown, host: string): string {
    const classify = (message: string): string => {
      const normalized = message.toLowerCase();
      if (normalized.includes("404") || normalized.includes("not found")) {
        return "Repository not found or token has no access";
      }
      if (
        normalized.includes("401") ||
        normalized.includes("unauthorized") ||
        normalized.includes("bad credentials")
      ) {
        return "Invalid token credentials";
      }
      if (normalized.includes("403") || normalized.includes("forbidden")) {
        return "Token lacks required repository permissions";
      }
      return "Token could not access this host";
    };

    if (error instanceof TokenNotFoundError) {
      return `No token found for ${host}`;
    }

    if (error instanceof AllTokensFailedError) {
      const reasons = Array.from(new Set(error.errors.map((entry) => classify(entry.message))));
      return `No usable token for ${host} (${reasons.join(", ")})`;
    }

    if (error instanceof Error) {
      return classify(error.message);
    }

    return `No usable token for ${host}`;
  }

  async function runTargetPreflight() {
    if (currentStep !== 2 || !repoMetadata || !targetRepoName) return;

    const currentRun = ++targetPreflightRunId;
    const seeds = buildImportTargets();
    importTargets = seeds;

    const nextTargets: ImportTargetOption[] = await Promise.all(
      seeds.map(async (target) => {
        if (target.status === "unsupported") return target;

        if (target.provider === "grasp") {
          if (!target.relayUrl) {
            return { ...target, status: "failed" as const, detail: "Missing relay URL" };
          }
          try {
            const probe = await checkGraspRepoExists({
              relayUrl: target.relayUrl,
              userPubkey: pubkey,
              owner: pubkey,
              repoName: targetRepoName,
            });
            if (probe.exists) {
              const existingWebUrl = probe.htmlUrl;
              const existingRemoteUrl = existingWebUrl
                ? existingWebUrl.endsWith(".git")
                  ? existingWebUrl
                  : `${existingWebUrl.replace(/\/+$/, "")}.git`
                : undefined;
              return {
                ...target,
                status: "ready" as const,
                detail: "Repository exists, will push to existing destination",
                existsAlready: true,
                existingWebUrl,
                existingRemoteUrl,
              };
            }
            return {
              ...target,
              status: "ready" as const,
              detail: target.detail || "Relay available",
            };
          } catch (error) {
            return {
              ...target,
              status: "failed" as const,
              detail: error instanceof Error ? error.message : String(error),
            };
          }
        }

        if (!target.host) {
          return { ...target, status: "failed" as const, detail: "Missing host" };
        }

        const normalizedTargetHost = normalizeTokenHostForTarget(target.host);

        try {
          const token = await tryTokensForHost(
            tokenList,
            (tokenHost: string) => {
              const normalizedTokenHost = normalizeTokenHostForTarget(tokenHost);
              return (
                matchesHost(normalizedTokenHost, normalizedTargetHost) ||
                matchesHost(normalizedTargetHost, normalizedTokenHost)
              );
            },
            async (candidateToken: string, matchedHost: string) => {
              const api = getGitServiceApi(
                target.provider,
                candidateToken,
                getProviderBaseUrl(target.provider, target.host)
              );

              const user = await api.getCurrentUser();
              const username = user.login || (user as any).username;
              if (!username) {
                throw new Error("Unable to determine token user");
              }

              const repoNameForHost = targetRepoName;

              try {
                const existingRepo = await api.getRepo(username, repoNameForHost);
                return {
                  token: candidateToken,
                  detail: "Repository exists, will push to existing destination",
                  existsAlready: true,
                  existingRemoteUrl: existingRepo.cloneUrl,
                  existingWebUrl: existingRepo.htmlUrl,
                };
              } catch (error) {
                if (isNotFoundError(error)) {
                  return {
                    token: candidateToken,
                    detail: `Ready (${normalizeTokenHostForTarget(matchedHost)})`,
                    existsAlready: false,
                  };
                }
                throw error;
              }
            }
          );

          return {
            ...target,
            status: "ready" as const,
            validatedToken: token.token,
            detail: token.detail,
            existsAlready: token.existsAlready,
            existingRemoteUrl: token.existingRemoteUrl,
            existingWebUrl: token.existingWebUrl,
          };
        } catch (error) {
          if (error instanceof TokenNotFoundError) {
            return { ...target, status: "no-token" as const, detail: "No token for host" };
          }
          return {
            ...target,
            status: "failed" as const,
            detail: toFriendlyTargetPreflightError(error, target.host),
          };
        }
      })
    );

    if (currentRun !== targetPreflightRunId) return;

    importTargets = nextTargets;
    const readyTargets = nextTargets.filter((target) => target.status === "ready");

    selectedImportTargetIds = selectedImportTargetIds.filter((id) =>
      readyTargets.some((target) => target.id === id)
    );

    if (!initializedTargetSelection) {
      const readyGitTargets = readyTargets
        .filter((target) => target.provider !== "grasp")
        .map((target) => target.id);
      const readyGraspTargets = readyTargets
        .filter((target) => target.provider === "grasp")
        .map((target) => target.id);

      selectedImportTargetIds = [
        ...readyGitTargets,
        ...(readyGraspTargets.length > 0 ? [readyGraspTargets[0]] : []),
      ];
      initializedTargetSelection = true;
    }
  }

  // Detect provider from URL
  $effect(() => {
    const trimmed = repoUrl.trim();
    if (!trimmed) {
      selectedHost = null;
      return;
    }

    try {
      const parsed = parseRepoUrl(trimmed);
      selectedHost = parsed.host;
    } catch {
      selectedHost = null;
    }
  });

  // Validate URL
  function validateUrl(url: string): string | undefined {
    const trimmed = url.trim();

    if (!trimmed) {
      return "Repository URL is required";
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      return "Repository URL must start with https:// or http://";
    }

    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return "Repository URL must use https:// or http://";
    }

    const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
    if (pathSegments.length < 2) {
      return "Repository URL must include owner and repo (https://host/owner/repo)";
    }

    try {
      parseRepoUrl(trimmed);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : "Invalid repository URL format";
    }
  }

  interface SourceAccessResult {
    token: string;
    ownership: Awaited<ReturnType<typeof checkRepoOwnership>>;
  }

  function toFriendlySourceAccessError(error: unknown, host: string): string {
    if (error instanceof TokenNotFoundError) {
      return `No token found for ${host}. Please add one in settings.`;
    }

    const classify = (message: string): string => {
      const normalized = message.toLowerCase();
      if (normalized.includes("404") || normalized.includes("not found")) {
        return "Repository not found or token has no access";
      }
      if (
        normalized.includes("401") ||
        normalized.includes("unauthorized") ||
        normalized.includes("bad credentials")
      ) {
        return "Invalid token credentials";
      }
      if (normalized.includes("403") || normalized.includes("forbidden")) {
        return "Token lacks required repository permissions";
      }
      return "Token could not access this repository";
    };

    if (error instanceof AllTokensFailedError) {
      const reasons = Array.from(new Set(error.errors.map((entry) => classify(entry.message))));
      return `None of your tokens for ${host} can access this repository (${reasons.join(", ")}).`;
    }

    if (error instanceof Error) {
      return classify(error.message);
    }

    return "Unable to access source repository with available tokens";
  }

  async function resolveSourceAccess(
    parsed: ReturnType<typeof parseRepoUrl>
  ): Promise<SourceAccessResult> {
    const allTokens = await waitForTokens();
    const normalizedRepoUrl = repoUrl.trim();
    const normalizedSourceHost = normalizeTokenHostForTarget(parsed.host);

    return await tryTokensForHost(
      allTokens,
      (tokenHost: string) => {
        const normalizedTokenHost = normalizeTokenHostForTarget(tokenHost);
        return (
          matchesHost(normalizedTokenHost, normalizedSourceHost) ||
          matchesHost(normalizedSourceHost, normalizedTokenHost)
        );
      },
      async (candidateToken: string) => {
        const api = getGitServiceApiFromUrl(normalizedRepoUrl, candidateToken);
        const ownership = await checkRepoOwnership(api, parsed.owner, parsed.repo);
        return { token: candidateToken, ownership };
      }
    );
  }

  async function validateSourceToken() {
    const runId = ++sourceValidationRunId;
    const urlError = validateUrl(repoUrl);
    if (urlError) {
      if (runId === sourceValidationRunId) {
        tokenValidationError = urlError;
        tokenValidated = false;
        sourceToken = null;
        validatedForUrl = null;
      }
      return;
    }

    let parsed: ReturnType<typeof parseRepoUrl>;
    try {
      parsed = parseRepoUrl(repoUrl.trim());
    } catch (error) {
      if (runId === sourceValidationRunId) {
        tokenValidationError =
          error instanceof Error ? error.message : "Invalid repository URL format";
        tokenValidated = false;
        sourceToken = null;
        validatedForUrl = null;
      }
      return;
    }

    if (runId === sourceValidationRunId) {
      isValidatingToken = true;
      tokenValidationError = undefined;
    }

    try {
      const access = await resolveSourceAccess(parsed);
      if (runId !== sourceValidationRunId) return;
      sourceToken = access.token;
      tokenValidated = true;
      validatedForUrl = repoUrl.trim();
    } catch (error) {
      if (runId !== sourceValidationRunId) return;
      sourceToken = null;
      tokenValidated = false;
      validatedForUrl = null;
      tokenValidationError = toFriendlySourceAccessError(error, parsed.host);
    } finally {
      if (runId === sourceValidationRunId) {
        isValidatingToken = false;
      }
    }
  }

  let lastSourceTokenUrl: string | null = null;
  $effect(() => {
    const normalizedUrl = repoUrl.trim();
    if (normalizedUrl === lastSourceTokenUrl) return;
    lastSourceTokenUrl = normalizedUrl;
    sourceValidationRunId++;
    if (validationTimer) {
      clearTimeout(validationTimer);
      validationTimer = null;
    }
    sourceToken = null;
    tokenValidated = false;
    tokenValidationError = undefined;
    validatedForUrl = null;
  });

  $effect(() => {
    void repoUrl;
    void selectedHost;
    void currentStep;

    if (currentStep !== 1) return;

    const normalizedUrl = repoUrl.trim();
    if (!normalizedUrl || !selectedHost) return;
    if (validatedForUrl === normalizedUrl) return;

    const urlError = validateUrl(normalizedUrl);
    if (urlError) {
      tokenValidated = false;
      sourceToken = null;
      validatedForUrl = null;
      tokenValidationError = urlError;
      return;
    }

    if (validationTimer) clearTimeout(validationTimer);
    validationTimer = setTimeout(() => {
      void validateSourceToken();
    }, 450);

    return () => {
      if (validationTimer) {
        clearTimeout(validationTimer);
        validationTimer = null;
      }
    };
  });

  $effect(() => {
    void currentStep;
    void repoMetadata;
    void targetRepoName;
    void tokenList;
    void graspRelayUrls;

    if (currentStep !== 2 || !repoMetadata || !targetRepoName) {
      return;
    }

    void runTargetPreflight();
  });

  // Step 1: Validate and proceed to Step 2
  async function handleStep1Next() {
    const urlError = validateUrl(repoUrl);
    if (urlError) {
      validationError = urlError;
      return;
    }

    if (!tokenValidated || validatedForUrl !== repoUrl.trim() || !sourceToken) {
      validationError = "Please validate source access before continuing";
      return;
    }

    validationError = undefined;

    // Parse URL and get repo metadata
    try {
      const normalizedRepoUrl = repoUrl.trim();
      const parsed = parseRepoUrl(normalizedRepoUrl);

      // Fetch repo metadata and check ownership
      isCheckingOwnership = true;
      try {
        const api = getGitServiceApiFromUrl(normalizedRepoUrl, sourceToken);
        const ownership = await checkRepoOwnership(api, parsed.owner, parsed.repo);

        repoMetadata = {
          owner: parsed.owner,
          name: parsed.repo,
          defaultBranch: ownership.repo.defaultBranch || "main",
          description: ownership.repo.description,
          htmlUrl: ownership.repo.htmlUrl,
          isOwner: ownership.isOwner,
        };

        // Owner: mirror issues/PRs/comments by default; non-owner: start conservative
        const mirrorByDefault = ownership.isOwner;
        mirrorIssues = mirrorByDefault;
        mirrorPullRequests = mirrorByDefault;
        mirrorComments = mirrorByDefault;
        initializedTargetSelection = false;
        selectedImportTargetIds = [];

        currentStep = 2;
        void loadImportBranches(
          normalizedRepoUrl,
          parsed.owner,
          parsed.repo,
          sourceToken || "",
          ownership.repo.defaultBranch || "main"
        );
      } catch (err) {
        validationError = toFriendlySourceAccessError(err, parsed.host);
      } finally {
        isCheckingOwnership = false;
      }
    } catch (err) {
      validationError = err instanceof Error ? err.message : "Failed to initialize import";
    }
  }

  // Step 2: Validate and start import
  async function handleStep2Next() {
    if (!repoMetadata) {
      validationError = "Repository metadata not available";
      return;
    }

    // Validate relays
    if (selectedRelays.length === 0) {
      validationError = "At least one relay is required";
      return;
    }

    const selectedTargets: ImportRemoteTarget[] = importTargets
      .filter((target) => selectedImportTargetIds.includes(target.id) && target.status === "ready")
      .map((target) => ({
        id: target.id,
        label: target.label,
        provider: target.provider,
        host: target.host,
        relayUrl: target.relayUrl,
        token: target.validatedToken,
        existsAlready: target.existsAlready,
        existingRemoteUrl: target.existingRemoteUrl,
        existingWebUrl: target.existingWebUrl,
      }));

    if (!repoMetadata.isOwner && selectedTargets.length === 0) {
      validationError = "Select at least one writable import target";
      return;
    }

    validationError = undefined;

    if (!sourceToken) {
      validationError = "Source repository access token is missing. Go back and re-open Step 2.";
      return;
    }
    const token = sourceToken;

    // Create import config
    const config: ImportConfig = {
      maxRetries: 3,
      enableProgressTracking: true,
      sinceDate: sinceDate,
      forkRepo: false,
      mirrorIssues,
      mirrorPullRequests,
      mirrorComments,
      relays: selectedRelays,
    };
    (config as ImportConfig & { selectedBranches?: string[] }).selectedBranches =
      selectedBranchNamesForImport;

    // Start import
    currentStep = 3;
    try {
      await importState.importRepository(repoUrl, token, config, selectedTargets);
    } catch (err) {
      // Error is handled by the hook and shown in progress
      console.error("Import failed:", err);
    }
  }

  // Relay management
  function addRelay() {
    const newRelay = prompt("Enter relay URL (wss://...):");
    if (newRelay && newRelay.trim()) {
      const trimmed = newRelay.trim();
      if (!selectedRelays.includes(trimmed)) {
        selectedRelays = [...selectedRelays, trimmed];
      }
    }
  }

  function removeRelay(index: number) {
    if (selectedRelays.length > 1) {
      selectedRelays = selectedRelays.filter((_, i) => i !== index);
    }
  }

  function handleImportTargetSelectionChange() {
    initializedTargetSelection = true;
  }

  function targetStatusLabel(target: ImportTargetOption): string {
    if (target.status === "ready") return "Ready";
    if (target.status === "checking") return "Checking";
    if (target.status === "no-token") return "No token";
    if (target.status === "unsupported") return "Unsupported";
    return "Failed";
  }

  function targetStatusTone(target: ImportTargetOption): string {
    if (target.status === "ready") return "text-green-400";
    if (target.status === "checking") return "text-gray-400";
    if (target.status === "no-token") return "text-yellow-400";
    if (target.status === "unsupported") return "text-yellow-400";
    return "text-red-400";
  }

  // Track if we should close after abort completes
  let shouldCloseAfterAbort = $state(false);
  let isCancelingImport = $state(false);

  // Watch for when import completes after abort
  $effect(() => {
    if (shouldCloseAfterAbort && !importState.isImporting) {
      shouldCloseAfterAbort = false;
      isCancelingImport = false;
      onClose();
    }
  });

  $effect(() => {
    if (!importState.isImporting) {
      isCancelingImport = false;
    }
  });

  // Cleanup: abort import if component unmounts while import is in progress
  $effect(() => {
    return () => {
      // Cleanup function runs when component unmounts
      if (importState.isImporting) {
        void requestImportAbort("Component unmounted");
      }
    };
  });

  // Handle explicit close (X button) - will abort if importing
  function handleClose() {
    if (importState.isImporting) {
      // Explicit close during import: abort and close after abort completes
      shouldCloseAfterAbort = true;
      void requestImportAbort("User cancelled import");
    } else {
      onClose();
    }
  }

  // Prevent dialog close when importing (backdrop click)
  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget && !importState.isImporting) {
      onClose();
    }
  }

  // Handle keyboard events for accessibility (Escape key)
  function handleBackdropKeydown(event: KeyboardEvent) {
    console.log("🚀 ImportRepoDialog: handleBackdropKeydown called", {
      event,
      importState: importState.isImporting,
    });
    if (event.key === "Escape" && !importState.isImporting) {
      onClose();
    }
  }

  async function requestImportAbort(reason: string) {
    if (isCancelingImport) return;
    isCancelingImport = true;
    importState.abortImport(reason);
    try {
      await onAbortImport?.();
    } catch {
      // pass
    } finally {
      // Keep canceling state while import teardown finishes
      if (!importState.isImporting) {
        isCancelingImport = false;
      }
    }
  }

  function handleAbort() {
    // Abort and close after abort completes
    shouldCloseAfterAbort = true;
    void requestImportAbort("User cancelled import");
  }

  // Computed properties
  const canProceedStep1 = $derived(
    repoUrl.trim().length > 0 && tokenValidated && !isValidatingToken && !isCheckingOwnership
  );
  const canProceedStep2 = $derived(
    repoMetadata !== null &&
      selectedRelays.length > 0 &&
      (repoMetadata.isOwner ||
        importTargets.some(
          (target) => selectedImportTargetIds.includes(target.id) && target.status === "ready"
        ))
  );
  const targetPreflightPending = $derived(
    currentStep === 2 && importTargets.some((target) => target.status === "checking")
  );
  const isProgressComplete = $derived(currentProgress?.isComplete && completedResult !== null);
  const workflowScopeIssue = $derived.by(() =>
    Boolean(currentProgress?.error && /workflow|\.github\/workflows/i.test(currentProgress.error))
  );

  // Phased progress from hook: use explicit phase and IMPORT_PHASES order (no string matching)
  type PhaseStatus = "completed" | "active" | "pending";
  const progressPhases = $derived.by(() => {
    const p = currentProgress;
    const list = IMPORT_PHASES.map(
      (
        id
      ): {
        id: ImportPhase;
        label: string;
        status: PhaseStatus;
        detail?: string;
        current?: number;
        total?: number;
        mirroredCount?: number;
      } => ({
        id,
        label: IMPORT_PHASE_LABELS[id],
        status: "pending" as PhaseStatus,
      })
    );
    if (!p) return list;

    const c = p.completedCounts;
    list.forEach((ph) => {
      if (ph.id === "issues" && c?.issues != null) ph.mirroredCount = c.issues;
      if (ph.id === "pull_requests" && c?.pull_requests != null) ph.mirroredCount = c.pull_requests;
      if (ph.id === "comments" && c?.comments != null) ph.mirroredCount = c.comments;
    });

    const phaseIndex =
      p.phase === "complete"
        ? list.length
        : IMPORT_PHASES.indexOf((p.phase ?? "connecting") as (typeof IMPORT_PHASES)[number]);
    const activeIndex = phaseIndex >= 0 ? Math.min(phaseIndex, list.length - 1) : 0;

    if (p.isComplete) {
      list.forEach((ph) => (ph.status = "completed"));
      return list;
    }

    list.forEach((ph, i) => {
      ph.status = i < activeIndex ? "completed" : i === activeIndex ? "active" : "pending";
      if (i === activeIndex) {
        ph.detail = p.step;
        ph.current = p.current;
        ph.total = p.total;
      }
    });
    return list;
  });
</script>

<svelte:window onkeydown={handleBackdropKeydown} />

<!-- Import Repository Dialog -->
<div
  class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0 isolate"
  role="dialog"
  aria-modal="true"
  aria-labelledby="import-dialog-title"
  aria-busy={importState.isImporting}
  tabindex="-1"
  onclick={handleBackdropClick}
  onkeydown={handleBackdropKeydown}
>
  <div
    class="bg-gray-900 rounded-lg shadow-xl w-full max-w-2xl border border-gray-700 overflow-hidden max-h-[90vh] flex flex-col"
  >
    <!-- Header -->
    <div class="flex items-center justify-between p-6 border-b border-gray-700">
      <div class="flex items-center space-x-3">
        <Download class="w-6 h-6 text-blue-400" />
        <h2 id="import-dialog-title" class="text-xl font-semibold text-white">Import Repository</h2>
      </div>
      {#if !importState.isImporting}
        <button
          type="button"
          onclick={handleClose}
          class="text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label="Close dialog"
          title={"Close"}
        >
          <X class="w-5 h-5" />
        </button>
      {/if}
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 space-y-6">
      <!-- Step 1: URL + Token + Date -->
      {#if currentStep === 1}
        <div class="space-y-4">
          <div>
            <h3 class="text-lg font-medium text-white mb-4">Step 1: Repository URL</h3>

            <!-- URL Input -->
            <div class="mb-4">
              <label for="repo-url" class="block text-sm font-medium text-gray-300 mb-2">
                Repository URL *
              </label>
              <input
                id="repo-url"
                type="text"
                bind:value={repoUrl}
                placeholder="https://github.com/owner/repo"
                class="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                aria-invalid={!!validationError}
              />
              {#if validationError}
                <p class="mt-1 text-sm text-red-400 flex items-center gap-1">
                  <AlertCircle class="w-4 h-4" />
                  {validationError}
                </p>
              {/if}
            </div>

            <!-- Token Validation -->
            {#if selectedHost}
              <div class="mb-4">
                <div class="flex items-center justify-between mb-2">
                  <span class="text-sm font-medium text-gray-300">
                    Source Access for {selectedHost}
                  </span>
                  <button
                    type="button"
                    onclick={validateSourceToken}
                    disabled={isValidatingToken}
                    class="text-sm text-blue-400 hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isValidatingToken ? "Validating..." : "Validate"}
                  </button>
                </div>
                <div class="flex items-center space-x-2">
                  {#if tokenValidated}
                    <CheckCircle2 class="w-5 h-5 text-green-400" />
                    <span class="text-sm text-green-400">Source access validated</span>
                  {:else if tokenValidationError}
                    <AlertCircle class="w-5 h-5 text-red-400" />
                    <span class="text-sm text-red-400">{tokenValidationError}</span>
                  {:else if isValidatingToken}
                    <Loader2 class="w-5 h-5 text-gray-400 animate-spin" />
                    <span class="text-sm text-gray-400">Validating token access...</span>
                  {:else}
                    <AlertCircle class="w-5 h-5 text-yellow-400" />
                    <span class="text-sm text-yellow-400">Validate source access to continue</span>
                  {/if}
                </div>
              </div>
            {/if}

            <!-- Date Picker -->
            <div class="mb-4">
              <label
                for="since-date"
                class="flex items-center gap-2 text-sm font-medium text-gray-300 mb-2"
              >
                <Calendar class="w-4 h-4" />
                <span>Only import items after (optional):</span>
              </label>
              <input
                id="since-date"
                type="date"
                value={sinceDate ? sinceDate.toISOString().split("T")[0] : ""}
                onchange={(e) => {
                  const value = (e.target as HTMLInputElement).value;
                  sinceDate = value ? new Date(value) : undefined;
                }}
                class="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Leave empty to import all items"
              />
              <p class="mt-1 text-xs text-gray-400">
                Only import issues, comments, and PRs created after this date
              </p>
            </div>

            <!-- Next Button -->
            <div class="flex justify-end">
              <button
                type="button"
                onclick={handleStep1Next}
                disabled={!canProceedStep1 || isCheckingOwnership}
                class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {#if isCheckingOwnership}
                  <Loader2 class="w-4 h-4 animate-spin" />
                  Checking repository...
                {:else}
                  Next: Review & Configure
                {/if}
              </button>
            </div>
          </div>
        </div>

        <!-- Step 2: Preview + Config -->
      {:else if currentStep === 2 && repoMetadata}
        <div class="space-y-4">
          <div>
            <h3 class="text-lg font-medium text-white mb-4">Step 2: Configure Import</h3>

            <!-- Repo Preview -->
            <div class="bg-gray-800 rounded-lg p-4 border border-gray-600 mb-4">
              <div class="flex items-start space-x-3">
                <GitBranch class="w-5 h-5 text-gray-400 mt-0.5" />
                <div class="flex-1 min-w-0">
                  <h4 class="text-sm font-medium text-white">
                    {repoMetadata.owner}/{repoMetadata.name}
                  </h4>
                  {#if repoMetadata.description}
                    <p class="text-sm text-gray-400 mt-1">{repoMetadata.description}</p>
                  {/if}
                  <a
                    href={repoMetadata.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-sm text-blue-400 hover:text-blue-300 mt-1 inline-flex items-center gap-1"
                  >
                    View on {selectedHost}
                    <ExternalLink class="w-3 h-3" />
                  </a>
                </div>
              </div>
            </div>

            <!-- Branch Selection -->
            <div class="mb-4">
              <h4 class="text-sm font-medium text-gray-300 mb-2">Branches to Import</h4>
              <p class="text-xs text-gray-400 mb-3">
                Branches are ordered by latest commit time (newest first). Default branch is always
                included.
              </p>

              <div class="space-y-2 bg-gray-800 rounded-lg p-4 border border-gray-600">
                <div class="flex items-center justify-between gap-2">
                  <div class="text-xs text-gray-400">
                    {#if isLoadingImportBranches}
                      Loading branch metadata...
                    {:else}
                      Importing {selectedBranchNamesForImport.length} of {importBranchOptions.length}
                      branches
                    {/if}
                  </div>
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="px-2 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:border-blue-400 hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      onclick={selectAllAdditionalBranches}
                      disabled={isLoadingImportBranches || importBranchOptions.length <= 1}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      class="px-2 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:border-blue-400 hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      onclick={clearAdditionalBranches}
                      disabled={isLoadingImportBranches ||
                        selectedAdditionalBranchNames.length === 0}
                    >
                      Deselect all
                    </button>
                  </div>
                </div>

                {#if importBranchLoadError}
                  <p class="text-xs text-amber-300">
                    {importBranchLoadError}. Using default branch only.
                  </p>
                {/if}

                <div class="max-h-64 overflow-y-auto rounded border border-gray-700 bg-gray-900/60">
                  {#if isLoadingImportBranches}
                    <div class="flex items-center gap-2 px-3 py-3 text-xs text-gray-300">
                      <Loader2 class="w-3.5 h-3.5 animate-spin" />
                      Resolving branch activity timestamps...
                    </div>
                  {:else if importBranchOptions.length === 0}
                    <p class="px-3 py-3 text-xs text-gray-400">No branches detected.</p>
                  {:else}
                    <div class="divide-y divide-gray-700">
                      {#each importBranchOptions as branch (branch.name)}
                        <label class="flex items-center justify-between gap-2 px-3 py-2">
                          <span class="flex items-center gap-2 min-w-0">
                            <input
                              type="checkbox"
                              checked={branch.isDefault ||
                                selectedAdditionalBranchNames.includes(branch.name)}
                              disabled={branch.isDefault || importState.isImporting}
                              onchange={(event) => {
                                if (branch.isDefault) return;
                                const isChecked = (event.currentTarget as HTMLInputElement).checked;
                                if (isChecked) {
                                  selectedAdditionalBranchNames = Array.from(
                                    new Set([...selectedAdditionalBranchNames, branch.name])
                                  );
                                } else {
                                  selectedAdditionalBranchNames =
                                    selectedAdditionalBranchNames.filter(
                                      (name) => name !== branch.name
                                    );
                                }
                              }}
                              class="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                            <span class="text-sm text-white truncate" title={branch.name}
                              >{branch.name}</span
                            >
                            {#if branch.isDefault}
                              <span
                                class="px-1.5 py-0.5 text-[10px] rounded bg-blue-500/20 text-blue-200 border border-blue-500/30"
                                >default</span
                              >
                            {/if}
                          </span>
                          <span class="text-[11px] text-gray-400 whitespace-nowrap">
                            {#if branch.commitDate}
                              {new Date(branch.commitDate).toLocaleString()}
                            {:else}
                              unknown
                            {/if}
                          </span>
                        </label>
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
            </div>

            <!-- Import Targets -->
            <div class="mb-4">
              <h4 class="text-sm font-medium text-gray-300 mb-2">Import Targets *</h4>
              <p class="text-xs text-gray-400 mb-3">
                Select where this repository should be created and pushed. One target failing will
                not stop other targets from syncing.
              </p>

              <div class="mb-3 bg-gray-800 rounded-lg p-3 border border-gray-600 space-y-2">
                <p class="text-xs font-medium text-gray-300">GRASP relays</p>
                <div class="flex flex-wrap gap-2">
                  {#each graspRelayUrls as relayUrl, idx (relayUrl + idx)}
                    <span
                      class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-blue-500/20 text-blue-200 border border-blue-500/30"
                    >
                      <span class="max-w-[220px] truncate" title={relayUrl}
                        >{relayUrl.replace(/^wss?:\/\//, "")}</span
                      >
                      <button
                        type="button"
                        class="hover:text-red-300"
                        onclick={() => removeGraspRelay(idx)}
                        title="Remove GRASP relay"
                      >
                        x
                      </button>
                    </span>
                  {/each}
                  <div class="inline-flex items-center">
                    <input
                      type="text"
                      bind:value={newGraspRelayUrl}
                      placeholder="wss://relay.example.com"
                      class="w-48 px-2 py-1 text-xs bg-gray-900 border border-gray-600 rounded-l-full text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      onkeydown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitNewGraspRelay();
                        }
                      }}
                    />
                    <button
                      type="button"
                      class="px-2 py-1 text-xs bg-blue-600 text-white rounded-r-full hover:bg-blue-700"
                      onclick={commitNewGraspRelay}
                    >
                      +
                    </button>
                  </div>
                </div>
                {#if graspServerOptions.length > 0}
                  <div class="flex flex-wrap gap-1">
                    {#each graspServerOptions.filter((opt) => !graspRelayUrls.includes(normalizeRelayUrl(opt))) as opt}
                      <button
                        type="button"
                        class="px-2 py-1 text-xs rounded-full border border-dashed border-gray-500 text-gray-300 hover:border-blue-400 hover:text-blue-300"
                        onclick={() => upsertGraspRelay(opt)}
                      >
                        + {opt.replace(/^wss?:\/\//, "")}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>

              <div class="space-y-2 bg-gray-800 rounded-lg p-4 border border-gray-600">
                {#if importTargets.length === 0}
                  <p class="text-sm text-gray-400">No writable targets detected yet.</p>
                  <p class="text-xs text-gray-500">
                    Add host tokens in settings and/or add GRASP relay URLs above.
                  </p>
                {:else}
                  {#each importTargets as target (target.id)}
                    <label class="flex items-start gap-3">
                      <input
                        type="checkbox"
                        value={target.id}
                        bind:group={selectedImportTargetIds}
                        disabled={target.status !== "ready" || importState.isImporting}
                        onchange={handleImportTargetSelectionChange}
                        class="mt-1 w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center justify-between gap-2">
                          <span class="text-sm text-white truncate">{target.label}</span>
                          <span class={`text-xs ${targetStatusTone(target)}`}
                            >{targetStatusLabel(target)}</span
                          >
                        </div>
                        {#if target.detail}
                          <p class="text-xs text-gray-400 mt-0.5">{target.detail}</p>
                        {/if}
                      </div>
                    </label>
                  {/each}
                {/if}
              </div>
              {#if targetPreflightPending}
                <p class="text-xs text-gray-400 mt-2">Running access preflight checks...</p>
              {:else}
                <p class="text-xs text-gray-400 mt-2">
                  {#if repoMetadata.isOwner}
                    Selecting import targets is optional for repositories you own.
                  {:else}
                    Select at least one target with Ready status.
                  {/if}
                </p>
              {/if}
            </div>

            <!-- Relay Selection -->
            <div class="mb-4">
              <div class="flex items-center gap-2 mb-2">
                <Globe class="w-4 h-4" />
                <span class="text-sm font-medium text-gray-300">Nostr Relays *</span>
              </div>
              <div class="space-y-2">
                {#each selectedRelays as relay, index}
                  <div class="flex items-center space-x-2">
                    <input
                      type="text"
                      bind:value={selectedRelays[index]}
                      class="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="wss://relay.example.com"
                    />
                    <button
                      type="button"
                      onclick={() => removeRelay(index)}
                      disabled={selectedRelays.length === 1}
                      class="p-2 text-red-400 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label="Remove relay"
                    >
                      <Trash2 class="w-4 h-4" />
                    </button>
                  </div>
                {/each}
                <button
                  type="button"
                  onclick={addRelay}
                  class="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300"
                >
                  <Plus class="w-4 h-4" />
                  Add Relay
                </button>
              </div>
              <p class="mt-1 text-xs text-gray-400">
                Repository metadata will be published to these relays
              </p>
            </div>

            <!-- Confirmation Checkboxes -->
            <div class="mb-4">
              <h4 class="text-sm font-medium text-gray-300 mb-2">Import Options</h4>
              <div class="space-y-3 bg-gray-800 rounded-lg p-4 border border-gray-600">
                <!-- Announce Repo (always enabled) -->
                <label class="flex items-start space-x-3 cursor-not-allowed">
                  <input
                    type="checkbox"
                    checked={announceRepo}
                    disabled
                    class="mt-1 w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 cursor-not-allowed"
                  />
                  <div class="flex-1">
                    <span class="text-sm text-white">Announce Repo on Nostr</span>
                    <p class="text-xs text-gray-400 mt-0.5">
                      Repository will be announced on Nostr (always enabled)
                    </p>
                  </div>
                </label>

                <!-- Mirror Issues -->
                <label class="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    bind:checked={mirrorIssues}
                    class="mt-1 w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                  />
                  <div class="flex-1">
                    <span class="text-sm text-white flex items-center gap-2">
                      <FileText class="w-4 h-4" />
                      Mirror Issues
                    </span>
                    <p class="text-xs text-gray-400 mt-0.5">Import all issues</p>
                  </div>
                </label>

                <!-- Mirror Pull Requests -->
                <label class="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    bind:checked={mirrorPullRequests}
                    class="mt-1 w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                  />
                  <div class="flex-1">
                    <span class="text-sm text-white flex items-center gap-2">
                      <GitBranch class="w-4 h-4" />
                      Mirror Pull Requests
                    </span>
                    <p class="text-xs text-gray-400 mt-0.5">Import all pull requests</p>
                  </div>
                </label>

                <!-- Mirror Comments -->
                <label class="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    bind:checked={mirrorComments}
                    disabled={!mirrorIssues && !mirrorPullRequests}
                    class="mt-1 w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <div class="flex-1">
                    <span class="text-sm text-white flex items-center gap-2">
                      <MessageSquare class="w-4 h-4" />
                      Mirror Comments
                    </span>
                    <p class="text-xs text-gray-400 mt-0.5">
                      Import all comments for issues and PRs
                    </p>
                  </div>
                </label>
              </div>
              <p class="text-xs text-gray-400 mt-3">
                Note: For issues and comments, placeholder Nostr accounts will be created on the fly
                with matching names of the original authors.
              </p>
            </div>

            {#if validationError}
              <div class="bg-red-900/50 border border-red-500 rounded-lg p-4">
                <div class="flex items-start space-x-3">
                  <AlertCircle class="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
                  <p class="text-sm text-red-400">{validationError}</p>
                </div>
              </div>
            {/if}

            <!-- Action Buttons -->
            <div class="flex justify-between">
              <button
                type="button"
                onclick={() => (currentStep = 1)}
                disabled={importState.isImporting}
                class="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Back
              </button>
              <button
                type="button"
                onclick={handleStep2Next}
                disabled={!canProceedStep2 || importState.isImporting}
                class="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                SET THIS REPO FREE
              </button>
            </div>
          </div>
        </div>

        <!-- Step 3: Progress -->
      {:else if currentStep === 3}
        <div class="space-y-4">
          <div>
            <h3 class="text-lg font-medium text-white mb-1">Import progress</h3>
            <p class="text-sm text-gray-400 mb-4">
              {#if currentProgress?.isComplete}
                All done. Your repository is ready.
              {:else if currentProgress?.error}
                Something went wrong. You can cancel and try again.
              {:else}
                This may take a few minutes. Don’t close this window.
              {/if}
            </p>

            <!-- Phased stepper -->
            {#if currentProgress}
              <div class="space-y-0 mb-4">
                {#each progressPhases as phase, i}
                  {@const isLast = i === progressPhases.length - 1}
                  <div class="flex gap-3">
                    <!-- Left: icon + connector line -->
                    <div class="flex flex-col items-center flex-shrink-0">
                      <div
                        class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors"
                        class:bg-green-600={phase.status === "completed"}
                        class:bg-blue-600={phase.status === "active" && !currentProgress.error}
                        class:bg-red-600={phase.status === "active" && currentProgress.error}
                        class:bg-gray-600={phase.status === "pending"}
                      >
                        {#if phase.status === "completed"}
                          <CheckCircle2 class="w-4 h-4 text-white" />
                        {:else if phase.status === "active"}
                          {#if currentProgress.error}
                            <AlertCircle class="w-4 h-4 text-white" />
                          {:else}
                            <Loader2 class="w-4 h-4 text-white animate-spin" />
                          {/if}
                        {:else}
                          <span class="text-xs font-medium text-gray-300">{i + 1}</span>
                        {/if}
                      </div>
                      {#if !isLast}
                        <div
                          class="w-0.5 h-6 mt-1 rounded-full transition-colors"
                          class:bg-green-600={phase.status === "completed"}
                          class:bg-gray-600={phase.status !== "completed"}
                        ></div>
                      {/if}
                    </div>
                    <!-- Right: label + detail + progress -->
                    <div class="flex-1 min-w-0 pb-4">
                      <p
                        class="text-sm font-medium transition-colors"
                        class:text-green-400={phase.status === "completed"}
                        class:text-blue-400={phase.status === "active" && !currentProgress.error}
                        class:text-red-400={phase.status === "active" && currentProgress.error}
                        class:text-gray-500={phase.status === "pending"}
                      >
                        {phase.label}
                      </p>
                      {#if phase.status === "completed" && phase.mirroredCount != null}
                        <p class="text-xs text-green-300/90 mt-0.5">
                          {phase.mirroredCount} mirrored
                        </p>
                      {/if}
                      {#if phase.status === "active" && phase.detail}
                        <p class="text-sm text-gray-400 mt-0.5 truncate" title={phase.detail}>
                          {phase.detail}
                        </p>
                        {#if phase.current != null && phase.total != null && phase.total > 0}
                          <div class="mt-2 flex items-center gap-2">
                            <div class="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                              <div
                                class="h-full bg-blue-500 rounded-full transition-all duration-300"
                                style="width: {(phase.total && phase.total >= 1
                                  ? Math.min(100, ((phase.current ?? 0) / phase.total) * 100)
                                  : 0) + '%'}"
                              ></div>
                            </div>
                            <span class="text-xs text-gray-500 tabular-nums"
                              >{phase.current} / {phase.total}</span
                            >
                          </div>
                        {:else if phase.current != null}
                          <p class="text-xs text-gray-500 mt-0.5">{phase.current} so far</p>
                        {/if}
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>

              <!-- Error message (inline with stepper, or banner) -->
              {#if currentProgress.error}
                <div class="bg-red-900/50 border border-red-500 rounded-lg p-4 mb-4">
                  <div class="flex items-start space-x-3">
                    <AlertCircle class="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
                    <div class="flex-1">
                      <p class="text-sm text-red-400 font-medium">Import failed</p>
                      <p class="text-sm text-red-300 mt-1">{currentProgress.error}</p>
                      {#if workflowScopeIssue}
                        <div class="mt-3 text-xs text-red-200/80">
                          GitHub requires the workflow token scope to push files under
                          <span class="font-mono">.github/workflows</span>.
                          <a
                            href="/settings/profile"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="ml-2 inline-flex items-center text-red-200 hover:text-red-100 underline"
                          >
                            Open settings
                          </a>
                        </div>
                      {/if}
                    </div>
                  </div>
                </div>
              {:else if currentProgress.isComplete && completedResult}
                <div class="bg-green-900/50 border border-green-500 rounded-lg p-4 mb-4">
                  <div class="flex items-start space-x-3">
                    <CheckCircle2 class="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" />
                    <div class="flex-1">
                      <p class="text-sm text-green-400 font-medium">Import completed</p>
                      <p class="text-sm text-green-300 mt-1">
                        {completedResult.issuesImported} issues,
                        {completedResult.commentsImported} comments,
                        {completedResult.prsImported} PRs, and {completedResult.profilesCreated} profiles
                        created.
                      </p>
                      {#if completedResult.remotePushResults && completedResult.remotePushResults.length > 0}
                        {@const remoteSuccessCount = completedResult.remotePushResults.filter(
                          (r) => r.success
                        ).length}
                        {@const remoteFailureCount =
                          completedResult.remotePushResults.length - remoteSuccessCount}
                        <p class="text-sm text-green-300 mt-1">
                          Remote sync: {remoteSuccessCount} succeeded{#if remoteFailureCount > 0}, {remoteFailureCount}
                            failed{/if}.
                        </p>
                        {#if remoteFailureCount > 0}
                          <div class="mt-2 space-y-1">
                            {#each completedResult.remotePushResults.filter((r) => !r.success) as failedRemote (failedRemote.id)}
                              <p class="text-xs text-yellow-300">
                                {failedRemote.label}: {failedRemote.error || "Push failed"}
                              </p>
                            {/each}
                          </div>
                        {/if}
                      {/if}
                    </div>
                  </div>
                </div>
              {/if}
            {/if}

            <!-- Abort Button -->
            {#if currentStep === 3 && currentProgress && !currentProgress.isComplete}
              <div class="flex justify-center pt-2">
                <button
                  type="button"
                  onclick={handleAbort}
                  disabled={isCancelingImport}
                  class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {#if isCancelingImport}
                    <Loader2 class="w-4 h-4 animate-spin" />
                    Canceling...
                  {:else}
                    Cancel import
                  {/if}
                </button>
              </div>
            {/if}

            <!-- Action Buttons (when complete) -->
            {#if isProgressComplete}
              <div class="flex justify-between pt-2 border-t border-gray-700">
                <button
                  type="button"
                  onclick={handleClose}
                  class="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600"
                >
                  Close
                </button>
                {#if onNavigateToRepo && completedResult}
                  <button
                    type="button"
                    onclick={() => {
                      if (completedResult) {
                        onNavigateToRepo(completedResult);
                        handleClose();
                      }
                    }}
                    class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2"
                  >
                    <ExternalLink class="w-4 h-4" />
                    View repository
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
