<script lang="ts">
  import { cn } from "../../utils";
  import {
    GitBranch,
    GitFork,
    RotateCcw,
    Settings,
    Bookmark,
    AlertTriangle,
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
  } = $props();
  const name = $derived.by(() => repoClass.name);
  const description = $derived.by(() => repoClass.description);
  const canEdit = $derived.by(() => !!repoClass.editable);

  // Track clone URL errors from the Repo class
  // DISABLED: Returning false positives, needs investigation
  // const cloneUrlErrors = $derived(repoClass.cloneUrlErrors);
  // const hasCloneUrlErrors = $derived(cloneUrlErrors.length > 0);
  const cloneUrlErrors: Array<{ url: string; error: string; status?: number }> = [];
  const hasCloneUrlErrors = false;

  // Dismiss errors
  function dismissErrors() {
    repoClass.clearCloneUrlErrors();
  }

  // Format error message for display
  function formatError(error: { url: string; error: string; status?: number }): string {
    const urlShort = error.url.replace(/^https?:\/\//, "").replace(/\.git$/, "");
    if (error.status === 404) {
      return `Repository not found: ${urlShort}`;
    } else if (error.status === 401 || error.status === 403) {
      return `Access denied: ${urlShort}`;
    } else if (error.status && error.status >= 500) {
      return `Server error (${error.status}): ${urlShort}`;
    }
    return `${urlShort}: ${error.error}`;
  }
</script>

<div class="border-b border-border pb-4">
  {#if hasCloneUrlErrors}
    <div class="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md">
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-start gap-2 min-w-0">
          <AlertTriangle class="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
          <div class="min-w-0">
            <p class="text-sm font-medium text-destructive">Clone URL Error</p>
            <ul class="mt-1 text-sm text-muted-foreground space-y-1">
              {#each cloneUrlErrors as error}
                <li class="truncate" title={error.error}>{formatError(error)}</li>
              {/each}
            </ul>
          </div>
        </div>
        <button
          onclick={dismissErrors}
          class="text-muted-foreground hover:text-foreground p-1 rounded-sm hover:bg-muted flex-shrink-0"
          title="Dismiss"
        >
          <X class="h-4 w-4" />
        </button>
      </div>
    </div>
  {/if}
  <div class="flex flex-col gap-2 mb-4">
    <h1 class="text-xl sm:text-2xl font-bold flex items-center gap-2 min-w-0">
      <GitBranch class="h-5 w-5 sm:h-6 sm:w-6 flex-shrink-0" />
      <button onclick={overviewRepo} class="truncate text-left" title={name}>
        {name}
      </button>
    </h1>
    <div class="flex items-center flex-wrap gap-2 sm:gap-3">
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
      <div class="flex-shrink-0 min-w-0 sm:ml-auto">
        <BranchSelector repo={repoClass} />
      </div>
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
  <nav class={cn("bg-muted text-muted-foreground rounded-md w-full")}>
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
