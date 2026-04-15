<script lang="ts">
  import { cn } from "../../utils";
  import { filterValidCloneUrls } from "@nostr-git/core/utils";
  import { classifyCloneUrlIssue, getCloneUrlBannerTitle } from "../../utils/cloneUrlIssues";
  import {
    GitFork,
    RotateCcw,
    Settings,
    Bookmark,
    AlertTriangle,
    LoaderCircle,
    Bell,
    X,
    Info,
    Globe,
  } from "@lucide/svelte";
  import { useRegistry } from "../../useRegistry";
  const { Button, Markdown } = useRegistry();
  import { Repo } from "./Repo.svelte";
  import BranchSelector from "./BranchSelector.svelte";

  const {
    repoClass,
    activeTab = "overview",
    children,
    refreshRepo,
    isRefreshing = false,
    forkRepo,
    settingsRepo,
    overviewRepo,
    bookmarkRepo,
    isBookmarked = false,
    isTogglingBookmark = false,
    watchRepo,
    isWatching = false,
    canEditSettings,
    updateRepoState,
    hasRepoStateUpdate = false,
    isCheckingRepoStateUpdate = false,
    resolveCloneUrlIssues,
  }: {
    repoClass: Repo;
    activeTab?: string;
    children?: any;
    refreshRepo?: () => Promise<void>;
    forkRepo?: () => void;
    overviewRepo?: () => void;
    isRefreshing?: boolean;
    settingsRepo?: () => void;
    bookmarkRepo?: () => void | Promise<void>;
    isBookmarked?: boolean;
    isTogglingBookmark?: boolean;
    watchRepo?: () => void | Promise<void>;
    isWatching?: boolean;
    canEditSettings?: boolean;
    updateRepoState?: () => void | Promise<void>;
    hasRepoStateUpdate?: boolean;
    isCheckingRepoStateUpdate?: boolean;
    resolveCloneUrlIssues?: () => void;
  } = $props();
  const name = $derived.by(() => repoClass.name);
  const description = $derived.by(() => repoClass.description);
  const canEdit = $derived.by(() =>
    typeof canEditSettings === "boolean" ? canEditSettings : !!repoClass.editable
  );

  const normalizeUrl = (url: string): string => {
    const raw = String(url || "").trim();
    if (!raw) return "";

    const stripGit = (value: string) => value.replace(/\.git$/i, "");
    try {
      const parsed = new URL(raw);
      return `${parsed.hostname.toLowerCase()}${stripGit(parsed.pathname.replace(/\/+$/, "").toLowerCase())}`;
    } catch {
      return stripGit(
        raw
          .replace(/^https?:\/\//i, "")
          .replace(/\/+$/, "")
          .toLowerCase()
      );
    }
  };

  const getRepoTabsScrollKey = () => {
    if (typeof window === "undefined") return "";

    const match = window.location.pathname.match(/(\/spaces\/[^/]+\/git\/[^/]+)/);
    return `repo-tabs-scroll:${match?.[1] || window.location.pathname}`;
  };

  const readTabsScroll = (key: string) => {
    if (!key || typeof window === "undefined") return 0;

    try {
      const value = Number(window.sessionStorage.getItem(key) || "0");
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  };

  const writeTabsScroll = (key: string, value: number) => {
    if (!key || typeof window === "undefined") return;

    try {
      window.sessionStorage.setItem(key, String(value));
    } catch {
      // pass
    }
  };

  function persistTabsScroll(node: HTMLElement) {
    if (typeof window === "undefined") {
      return { destroy: () => {} };
    }

    const key = getRepoTabsScrollKey();
    let raf = 0;
    let timeout = 0;

    const restore = () => {
      const storedScrollLeft = readTabsScroll(key);

      if (Math.abs(node.scrollLeft - storedScrollLeft) > 1) {
        node.scrollLeft = storedScrollLeft;
      }
    };

    const persist = () => writeTabsScroll(key, node.scrollLeft);

    raf = window.requestAnimationFrame(restore);
    timeout = window.setTimeout(restore, 0);

    node.addEventListener("scroll", persist, { passive: true });
    node.addEventListener("pointerdown", persist, true);
    node.addEventListener("click", persist, true);

    return {
      destroy: () => {
        window.cancelAnimationFrame(raf);
        window.clearTimeout(timeout);
        node.removeEventListener("scroll", persist);
        node.removeEventListener("pointerdown", persist, true);
        node.removeEventListener("click", persist, true);
      },
    };
  }

  const primaryCloneUrl = $derived.by(() =>
    normalizeUrl(filterValidCloneUrls(repoClass.cloneUrls || [])[0] || "")
  );

  const cloneUrlErrors = $derived.by(() => {
    const errors = repoClass.cloneUrlErrors || [];
    return errors.filter((error) => {
      const status = Number(error?.status || 0);
      if (status >= 400) return true;
      const text = String(error?.error || "").toLowerCase();
      return (
        text.includes("timeout") ||
        text.includes("failed to fetch") ||
        text.includes("network") ||
        text.includes("cors") ||
        text.includes("not found") ||
        text.includes("authentication required") ||
        text.includes("bad credentials") ||
        text.includes("no tokens found") ||
        text.includes("forbidden") ||
        text.includes("unauthorized") ||
        text.includes("rate limit")
      );
    });
  });

  const primaryCloneErrors = $derived.by(() => {
    if (!primaryCloneUrl) return [] as Array<{ url: string; error: string; status?: number }>;
    return cloneUrlErrors.filter((error) => normalizeUrl(error.url) === primaryCloneUrl);
  });

  const displayCloneUrlErrors = $derived.by(() =>
    (primaryCloneErrors.length > 0 ? primaryCloneErrors : cloneUrlErrors).slice(0, 4)
  );

  const cloneUrlBannerTitle = $derived.by(() =>
    getCloneUrlBannerTitle({
      hasPrimaryIssue: primaryCloneErrors.length > 0,
      issueCount: primaryCloneErrors.length > 0 ? primaryCloneErrors.length : cloneUrlErrors.length,
    })
  );

  const hasCloneUrlErrors = $derived.by(() => cloneUrlErrors.length > 0);
  const refDiscoverySource = $derived.by(() => repoClass.refDiscoverySource);
  const cloneUrls = $derived.by(() => filterValidCloneUrls(repoClass.cloneUrls || []));

  function getRemoteLabel(url?: string): string {
    const raw = String(url || "").trim();
    if (!raw) return "Unknown remote";

    try {
      const parsed = new URL(raw);
      return `${parsed.hostname}${parsed.pathname.replace(/\.git$/i, "")}`;
    } catch {
      const sshMatch = raw.match(/^git@([^:]+):(.+)$/i);
      if (sshMatch) {
        return `${sshMatch[1]}/${sshMatch[2].replace(/\.git$/i, "")}`;
      }
      return raw.replace(/\.git$/i, "");
    }
  }

  const refSourceSummary = $derived.by(() => {
    if (!refDiscoverySource) return "Ref source unknown";
    const remote = refDiscoverySource.remoteUrl
      ? ` via ${getRemoteLabel(refDiscoverySource.remoteUrl)}`
      : "";
    return `${refDiscoverySource.label}${remote}`;
  });

  const refSourceRows = $derived.by(() =>
    cloneUrls.map((url) => ({
      url,
      label: getRemoteLabel(url),
      isActive:
        !!refDiscoverySource?.remoteUrl &&
        normalizeUrl(url) === normalizeUrl(refDiscoverySource.remoteUrl),
      hasIssue: cloneUrlErrors.some((error) => normalizeUrl(error.url) === normalizeUrl(url)),
    }))
  );

  // Dismiss errors
  function dismissErrors() {
    repoClass.clearCloneUrlErrors();
  }

  // Format error message for display
  function formatError(error: { url: string; error: string; status?: number }): string {
    const urlShort = error.url.replace(/^https?:\/\//, "").replace(/\.git$/, "");
    const issue = classifyCloneUrlIssue(error.error, error.status);
    return `${issue.summary}: ${urlShort}`;
  }
</script>

<div class="border-b border-border pb-4">
  {#if hasCloneUrlErrors}
    <div class="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-start gap-2 min-w-0">
          <AlertTriangle class="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400" />
          <div class="min-w-0">
            <p class="text-sm font-medium text-amber-300">{cloneUrlBannerTitle}</p>
            <ul class="mt-1 text-sm text-muted-foreground space-y-1">
              {#each displayCloneUrlErrors as error}
                <li class="truncate" title={error.error}>{formatError(error)}</li>
              {/each}
            </ul>
          </div>
        </div>
        <div class="flex items-center gap-1 flex-shrink-0">
          {#if resolveCloneUrlIssues}
            <button
              onclick={resolveCloneUrlIssues}
              class="rounded border border-amber-500/30 px-2 py-1 text-xs text-amber-300 hover:bg-amber-500/10"
              title="Review remote read issues"
            >
              Review
            </button>
          {/if}
          <button
            onclick={dismissErrors}
            class="text-muted-foreground hover:text-foreground p-1 rounded-sm hover:bg-muted"
            title="Dismiss"
          >
            <X class="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  {/if}
  <div class="mb-5 flex flex-col gap-4">
    <div class="w-full min-w-0" style="margin-top:0.25rem;">
      <BranchSelector repo={repoClass} />
    </div>
    <div class="flex items-center flex-wrap gap-2 sm:gap-3" style="margin-top:0.5rem;">
      {#if bookmarkRepo}
        <Button
          variant={isBookmarked ? "default" : "outline"}
          size="sm"
          class="gap-1 sm:gap-2 px-2 sm:px-3 flex-shrink-0"
          onclick={bookmarkRepo}
          disabled={isTogglingBookmark}
          title={isBookmarked ? "Remove bookmark" : "Bookmark"}
        >
          <Bookmark class="h-4 w-4 {isBookmarked ? 'fill-current' : ''}" />
          <span class="hidden sm:inline">{isBookmarked ? "Bookmarked" : "Bookmark"}</span>
        </Button>
      {/if}
      {#if watchRepo}
        <Button
          variant={isWatching ? "default" : "outline"}
          size="sm"
          class="gap-1 sm:gap-2 px-2 sm:px-3 flex-shrink-0"
          onclick={watchRepo}
          title={isWatching ? "Watching" : "Watch"}
        >
          <Bell class="h-4 w-4 {isWatching ? 'fill-current' : ''}" />
          <span class="hidden sm:inline">{isWatching ? "Watching" : "Watch"}</span>
        </Button>
      {/if}
      {#if forkRepo}
        <Button
          variant="outline"
          size="sm"
          class="gap-1 sm:gap-2 px-2 sm:px-3 flex-shrink-0"
          onclick={forkRepo}
          title="Fork"
        >
          <GitFork class="h-4 w-4" />
          <span class="hidden sm:inline">Fork</span>
        </Button>
      {/if}
      <Button
        variant="outline"
        size="sm"
        class="gap-1 sm:gap-2 px-2 sm:px-3 flex-shrink-0"
        onclick={refreshRepo}
        disabled={isRefreshing}
        title={isRefreshing ? "Syncing..." : "Refresh"}
      >
        <RotateCcw class="h-4 w-4 {isRefreshing ? 'animate-spin' : ''}" />
        <span class="hidden sm:inline">{isRefreshing ? "Syncing..." : "Refresh"}</span>
      </Button>
      {#if resolveCloneUrlIssues}
        <Button
          variant="outline"
          size="sm"
          class="gap-1 sm:gap-2 px-2 sm:px-3 flex-shrink-0"
          onclick={resolveCloneUrlIssues}
          title="Review remotes and backfill"
        >
          <Globe class="h-4 w-4" />
          <span class="hidden sm:inline">Remotes</span>
        </Button>
      {/if}
      {#if canEdit}
        <Button
          variant="outline"
          size="sm"
          class="gap-1 sm:gap-2 px-2 sm:px-3 flex-shrink-0"
          onclick={settingsRepo}
          title="Settings"
        >
          <Settings class="h-4 w-4" />
          <span class="hidden sm:inline">Settings</span>
        </Button>
      {/if}
      {#if updateRepoState}
        <div class="ml-auto flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            class={cn(
              "gap-1 sm:gap-2 px-2 sm:px-3",
              hasRepoStateUpdate &&
                "border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30"
            )}
            onclick={updateRepoState}
            disabled={isCheckingRepoStateUpdate}
            title={isCheckingRepoStateUpdate
              ? "Checking for updates..."
              : "Update published repo state"}
          >
            {#if isCheckingRepoStateUpdate}
              <LoaderCircle class="h-4 w-4 animate-spin" />
            {:else}
              <AlertTriangle class="h-4 w-4 {hasRepoStateUpdate ? 'text-amber-500' : ''}" />
            {/if}
            <span class="hidden sm:inline">
              {isCheckingRepoStateUpdate ? "Checking..." : "Update state"}
            </span>
          </Button>
        </div>
      {/if}
    </div>
    {#if refDiscoverySource || cloneUrls.length > 0}
      <details
        class="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
      >
        <summary class="flex cursor-pointer list-none items-center gap-2">
          <Info class="h-3.5 w-3.5 flex-shrink-0" />
          <span class="truncate">Refs: {refSourceSummary}</span>
        </summary>
        <div class="mt-3 space-y-3">
          {#if refDiscoverySource}
            <div>
              <p class="font-medium text-foreground">Current source</p>
              <p>{refSourceSummary}</p>
              {#if refDiscoverySource.details}
                <p class="mt-1">{refDiscoverySource.details}</p>
              {/if}
            </div>
          {/if}

          {#if refSourceRows.length > 0}
            <div>
              <p class="font-medium text-foreground">Available remotes</p>
              <div class="mt-1 space-y-1">
                {#each refSourceRows as remote (remote.url)}
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="truncate">{remote.label}</span>
                    {#if remote.isActive}
                      <span
                        class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300"
                      >
                        active
                      </span>
                    {/if}
                    {#if remote.hasIssue}
                      <span
                        class="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300"
                      >
                        issue seen
                      </span>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </details>
    {/if}
  </div>
  {#if description}
    <div class="repo-description text-muted-foreground mb-4">
      {#if Markdown}
        <Markdown content={description} variant="comment" />
      {:else}
        <p class="text-sm sm:text-base break-words">{description}</p>
      {/if}
    </div>
  {/if}
</div>

<nav
  data-repo-tabs
  class={cn(
    "sticky top-0 z-10 w-full rounded-md bg-base-200/95 text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-base-200/80"
  )}
>
  <div use:persistTabsScroll data-repo-tabs-scroll class="flex overflow-x-auto scrollbar-hide">
    <div class="m-1 flex w-full min-w-max justify-evenly gap-1">
      {@render children?.(activeTab)}
    </div>
  </div>
</nav>

<style>
  /* Ensure long commit messages don't break layout */
  .break-words {
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .repo-description :global(.markdown) {
    font-size: 0.875rem;
    line-height: 1.5;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  @media (min-width: 640px) {
    .repo-description :global(.markdown) {
      font-size: 1rem;
    }
  }
</style>
