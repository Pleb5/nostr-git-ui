<script lang="ts">
  import { ChevronDown, Loader2 } from "@lucide/svelte";
  import type { Repo } from "./Repo.svelte";
  import { isDisplayableGitRef } from "./branch-ref";

  const { repo }: { repo: Repo } = $props();

  // Get all refs (branches and tags) from repo
  const refs = $derived.by(() => repo.refs);
  const mainBranch = $derived.by(() => repo.mainBranch || "");
  const branches = $derived.by(() =>
    refs.filter((ref) => ref.type === "heads" && isDisplayableGitRef(ref))
  );
  const tags = $derived.by(() =>
    refs.filter((ref) => ref.type === "tags" && isDisplayableGitRef(ref))
  );
  const selectedBranch = $derived.by(() => repo.selectedBranch || mainBranch || "");
  const selectedLabel = $derived.by(() => {
    if (!refs.length) return "No branches found";
    if (!selectedBranch) return "";
    const isMainBranch =
      selectedBranch === mainBranch && branches.some((branch) => branch.name === selectedBranch);
    return isMainBranch ? `${selectedBranch} (default)` : selectedBranch;
  });
  const selectWidthCh = $derived.by(() => {
    const label = selectedLabel || "Branch";
    const paddingCh = 6;
    const minCh = 12;
    return Math.max(minCh, label.length + paddingCh);
  });
  const isSwitching = $derived.by(() => repo.isBranchSwitching);

  // Debug logging disabled for performance - uncomment if needed for debugging
  // $effect(() => {
  //   console.log(
  //     "[BranchSelector] refs:",
  //     refs.length,
  //     "branches:",
  //     branches.length,
  //     "tags:",
  //     tags.length
  //   );
  //   console.log("[BranchSelector] selectedBranch:", selectedBranch, "mainBranch:", mainBranch);
  //   console.log("[BranchSelector] isSwitching:", isSwitching);
  // });

  function handleChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    const branchName = target.value;
    const currentSelected = repo.selectedBranch;
    console.log(
      "[BranchSelector] handleChange called with:",
      branchName,
      "current:",
      currentSelected,
      "isSwitching:",
      isSwitching
    );
    if (branchName && !isSwitching && branchName !== currentSelected) {
      console.log("[BranchSelector] Calling setSelectedBranch with:", branchName);
      repo.setSelectedBranch(branchName);
    } else if (branchName === currentSelected) {
      console.log("[BranchSelector] Branch already selected, skipping:", branchName);
    }
  }
</script>

<div class="flex items-center gap-2 min-w-0">
  <div class="relative min-w-0">
    <select
      value={selectedBranch}
      onchange={handleChange}
      disabled={isSwitching}
      aria-busy={isSwitching}
      aria-label="Branch selector"
      style:width={`${selectWidthCh}ch`}
      class="appearance-none rounded-md border border-border bg-background pl-2 pr-9 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed min-w-0 max-w-full sm:pl-3 sm:pr-10"
    >
      {#if refs.length === 0}
        <option value="">No branches found</option>
      {:else}
        {#if branches.length > 0}
          <optgroup label="Branches">
            {#each branches as branch (branch.name)}
              <option value={branch.name}>
                {branch.name}{branch.name === mainBranch ? " (default)" : ""}
              </option>
            {/each}
          </optgroup>
        {/if}
        {#if tags.length > 0}
          <optgroup label="Tags">
            {#each tags as tag (tag.name)}
              <option value={tag.name}>{tag.name}</option>
            {/each}
          </optgroup>
        {/if}
      {/if}
    </select>

    <span
      class="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-muted-foreground sm:right-3"
      aria-hidden="true"
    >
      {#if isSwitching}
        <Loader2 class="h-3.5 w-3.5 animate-spin" />
      {:else}
        <ChevronDown class="h-3.5 w-3.5 opacity-70" />
      {/if}
    </span>

    {#if isSwitching}
      <span class="sr-only" aria-live="polite">Switching to {selectedBranch}</span>
    {/if}
  </div>
</div>
