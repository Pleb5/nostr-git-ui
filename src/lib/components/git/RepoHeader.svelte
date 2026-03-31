<script lang="ts">
  import { cn } from "../../utils";
  import { filterValidCloneUrls } from "@nostr-git/core/utils";
  import { classifyCloneUrlIssue, getCloneUrlBannerTitle } from "../../utils/cloneUrlIssues";
  import {
    GitBranch,
    GitFork,
    RotateCcw,
    Settings,
    Bookmark,
    AlertTriangle,
    LoaderCircle,
    Bell,
    X,
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
  <div class="flex flex-col gap-4 mb-5">
    <h1
      class="text-xl sm:text-2xl font-bold flex flex-col items-start gap-3 min-w-0 sm:flex-row sm:items-center"
      style="margin-bottom:0.75rem;"
    >
      <div class="flex min-w-0 items-center gap-2">
        <GitBranch class="h-5 w-5 sm:h-6 sm:w-6 flex-shrink-0" />
        <button onclick={overviewRepo} class="truncate text-left" title={name}>
          {name}
        </button>
      </div>
      <div class="w-full min-w-0 sm:ml-3 sm:w-auto" style="margin-top:0.25rem;">
        <BranchSelector repo={repoClass} />
      </div>
    </h1>
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
  <nav class={cn("bg-muted text-muted-foreground rounded-md w-full")} style="margin-top:1rem;">
    <div class="flex overflow-x-auto scrollbar-hide">
      <div class="w-full flex justify-evenly gap-1 m-1 min-w-max">
        {@render children?.(activeTab)}
      </div>
    </div>
  </nav>
</div>

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
