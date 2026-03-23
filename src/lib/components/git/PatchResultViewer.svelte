<script lang="ts">
  import {
    AlertCircle,
    AlertTriangle,
    CheckCircle,
    FileText,
    GitMerge,
    XCircle,
  } from "@lucide/svelte";
  import { useRegistry } from "../../useRegistry";
  import DiffViewer from "./DiffViewer.svelte";
  const { Card, CardHeader, CardTitle, CardContent, Badge, Alert, AlertDescription } =
    useRegistry();

  const { result } = $props();

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return { icon: CheckCircle, color: "text-emerald-600 dark:text-emerald-300" };
      case "conflicts":
        return { icon: AlertTriangle, color: "text-orange-500" };
      case "error":
        return { icon: XCircle, color: "text-rose-600 dark:text-rose-300" };
      default:
        return { icon: AlertCircle, color: "text-muted-foreground" };
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "success":
        return "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30";
      case "conflicts":
        return "border-orange-200 bg-orange-50 dark:border-orange-900 dark:bg-orange-950/30";
      case "error":
        return "border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30";
      default:
        return "border-border bg-muted/40";
    }
  };
</script>

<Card class={`${getStatusColor(result.status)}`}>
  <CardHeader class="pb-3">
    <CardTitle class="text-sm flex items-center gap-2">
      {getStatusIcon(result.status)}
      Patch Application Result: {result.patchName}
      <Badge variant="outline" class="ml-auto">
        {result.status}
      </Badge>
    </CardTitle>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if result.status === "success"}
      <Alert
        class="border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30"
      >
        <CheckCircle class="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
        <AlertDescription class="text-emerald-900 dark:text-emerald-200">
          Patch applied successfully! {result.stats.filesChanged} files changed, +{result.stats
            .insertions} insertions, -{result.stats.deletions} deletions.
        </AlertDescription>
      </Alert>
    {/if}

    {#if result.status === "conflicts"}
      <Alert class="border-orange-200 bg-orange-50 dark:border-orange-900 dark:bg-orange-950/30">
        <AlertTriangle class="h-4 w-4 text-orange-600" />
        <AlertDescription class="text-orange-900 dark:text-orange-200">
          Patch applied with merge conflicts. {result.conflicts?.length} files need manual resolution.
        </AlertDescription>
      </Alert>
    {/if}

    {#if result.status === "error"}
      <Alert class="border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30">
        <XCircle class="h-4 w-4 text-rose-700 dark:text-rose-300" />
        <AlertDescription class="text-rose-900 dark:text-rose-200">
          Failed to apply patch: {result.errorMessage}
        </AlertDescription>
      </Alert>
    {/if}

    <div class="grid grid-cols-3 gap-4 text-sm">
      <div class="text-center">
        <div class="text-lg font-semibold text-sky-700 dark:text-sky-300">
          {result.filesModified.length}
        </div>
        <div class="text-muted-foreground">Modified</div>
      </div>
      <div class="text-center">
        <div class="text-lg font-semibold text-emerald-700 dark:text-emerald-300">
          {result.filesAdded.length}
        </div>
        <div class="text-muted-foreground">Added</div>
      </div>
      <div class="text-center">
        <div class="text-lg font-semibold text-rose-700 dark:text-rose-300">
          {result.filesDeleted.length}
        </div>
        <div class="text-muted-foreground">Deleted</div>
      </div>
    </div>

    {#if result.conflicts && result.conflicts.length > 0}
      <div class="space-y-3">
        <h4 class="font-medium flex items-center gap-2">
          <GitMerge class="h-4 w-4" />
          Merge Conflicts ({result.conflicts.length})
        </h4>
        {#each result.conflicts as conflict (conflict.path)}
          <Card class="border-orange-200 dark:border-orange-900">
            <CardHeader class="pb-2">
              <CardTitle class="text-sm flex items-center gap-2">
                <FileText class="h-4 w-4" />
                {conflict.path}
                <Badge variant="destructive" class="ml-auto">
                  {conflict.conflictMarkers.length} conflicts
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div class="space-y-2">
                {#each conflict.conflictMarkers as marker (marker.path)}
                  <div class="border rounded p-3 bg-background">
                    <div class="text-xs text-muted-foreground mb-2">
                      Conflict at lines {marker.start}-{marker.end}
                    </div>
                    <pre class="text-xs font-mono whitespace-pre-wrap bg-secondary/50 p-2 rounded">
                        {marker.content}
                      </pre>
                  </div>
                {/each}
              </div>
            </CardContent>
          </Card>
        {/each}
      </div>
    {/if}

    {#if result.diff}
      <div class="space-y-2">
        <h4 class="font-medium">Changes Preview</h4>
        <DiffViewer diff={result.diff} showLineNumbers={true} enablePermalinks={false} />
      </div>
    {/if}

    {#if result.filesModified.length > 0 || result.filesAdded.length > 0 || result.filesDeleted.length > 0}
      <div class="space-y-3">
        <h4 class="font-medium">File Changes</h4>

        {#if result.filesModified.length > 0}
          <div>
            <h5 class="text-sm font-medium text-sky-700 dark:text-sky-300 mb-2">Modified Files</h5>
            <div class="space-y-1">
              {#each result.filesModified as file (file.path)}
                <div class="text-xs font-mono bg-sky-50 dark:bg-sky-950/30 px-2 py-1 rounded">
                  {file.path}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#if result.filesAdded.length > 0}
          <div>
            <h5 class="text-sm font-medium text-emerald-700 dark:text-emerald-300 mb-2">
              Added Files
            </h5>
            <div class="space-y-1">
              {#each result.filesAdded as file (file.path)}
                <div
                  class="text-xs font-mono bg-emerald-50 dark:bg-emerald-950/30 px-2 py-1 rounded"
                >
                  + {file.path}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#if result.filesDeleted.length > 0}
          <div>
            <h5 class="text-sm font-medium text-rose-700 dark:text-rose-300 mb-2">Deleted Files</h5>
            <div class="space-y-1">
              {#each result.filesDeleted as file (file.path)}
                <div class="text-xs font-mono bg-rose-50 dark:bg-rose-950/30 px-2 py-1 rounded">
                  - {file.path}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </CardContent>
</Card>
