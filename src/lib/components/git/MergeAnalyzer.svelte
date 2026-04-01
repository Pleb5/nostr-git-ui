<script lang="ts">
  import {
    FileText,
    TrendingUp,
    AlertTriangle,
    CheckCircle,
    GitMerge,
    Info,
    XCircle,
    AlertCircle,
  } from "@lucide/svelte";
  import { useRegistry } from "../../useRegistry";
  const { Card, CardContent, CardHeader, CardTitle, Progress, Badge } = useRegistry();
  import DiffViewer from "./DiffViewer.svelte";

  interface Props {
    analysis: {
      similarity: number;
      autoMergeable: boolean;
      affectedFiles: string[];
      conflictCount: number;
      errorMessage?: string;
      conflictDetails?: Array<{
        file: string;
        type: "content" | "rename" | "delete" | "binary";
        conflictMarkers: Array<{
          start: number;
          end: number;
          content: string;
          type: "both-modified" | "deleted-by-us" | "deleted-by-them" | "added-by-both";
        }>;
        baseContent?: string;
        headContent?: string;
        patchContent?: string;
      }>;
      analysis?: string;
    };
    // Can be a diff array or an object containing a `diff` field
    patch: any;
    analyzing?: boolean;
    onAnalyze?: () => void;
  }

  const { analysis, patch, analyzing, onAnalyze }: Props = $props();

  function handleAnalyze() {
    onAnalyze?.();
  }

  // Normalize diff input for DiffViewer
  const normalizedDiff = $derived(Array.isArray(patch) ? patch : (patch?.diff ?? []));
</script>

<div class="space-y-6">
  <!-- Compatibility Score -->
  <Card>
    <CardHeader class="pb-3">
      <div class="flex items-center justify-between">
        <CardTitle class="text-lg flex items-center gap-2">
          <TrendingUp class="h-5 w-5" />
          Compatibility Analysis
        </CardTitle>
        <button
          class="inline-flex items-center gap-2 rounded border px-3 py-1.5 text-sm transition-colors hover:bg-muted disabled:opacity-50"
          disabled={!!analyzing}
          onclick={handleAnalyze}
          aria-label="Analyze patch"
        >
          <GitMerge class="h-4 w-4" />
          Analyze
        </button>
      </div>
    </CardHeader>
    <CardContent>
      <div class="space-y-4">
        <!-- Error Display -->
        {#if analysis.errorMessage}
          <div
            class="rounded-lg border border-rose-200 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950/30"
          >
            <div class="flex items-start gap-3">
              <XCircle class="mt-0.5 h-5 w-5 flex-shrink-0 text-rose-700 dark:text-rose-300" />
              <div class="flex-1">
                <h4 class="text-sm font-medium text-rose-900 dark:text-rose-200">
                  Analysis Failed
                </h4>
                <p class="mt-1 text-sm text-rose-800 dark:text-rose-300">{analysis.errorMessage}</p>
                {#if analysis.analysis}
                  <div class="mt-2">
                    <span class="text-xs text-rose-700 dark:text-rose-400 font-mono"
                      >Type: {analysis.analysis}</span
                    >
                  </div>
                {/if}
              </div>
            </div>
          </div>
        {/if}

        <!-- Analysis Status -->
        {#if analyzing}
          <div
            class="rounded-lg border border-sky-200 bg-sky-50 p-4 dark:border-sky-900 dark:bg-sky-950/30"
          >
            <div class="flex items-center gap-3">
              <AlertCircle class="h-5 w-5 text-sky-700 dark:text-sky-300 animate-pulse" />
              <div>
                <h4 class="text-sm font-medium text-sky-900 dark:text-sky-200">Analyzing Patch</h4>
                <p class="text-sm text-sky-800 dark:text-sky-300">
                  Checking compatibility and potential conflicts...
                </p>
              </div>
            </div>
          </div>
        {/if}

        <!-- Compatibility Score -->
        {#if !analysis.errorMessage}
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm font-medium">Code Similarity</span>
              <span class="text-sm text-muted-foreground">
                {Math.round(analysis.similarity * 100)}%
              </span>
            </div>
            <Progress value={analysis.similarity * 100} class="h-2" />

            <!-- Similarity Explanation -->
            <div class="mt-2 flex items-start gap-2">
              <Info class="h-3 w-3 text-muted-foreground mt-0.5" />
              <p class="text-xs text-muted-foreground">
                {analysis.similarity > 0.9
                  ? "High similarity - likely compatible changes"
                  : analysis.similarity > 0.7
                    ? "Moderate similarity - review recommended"
                    : "Low similarity - careful review required"}
              </p>
            </div>
          </div>
        {/if}

        {#if !analysis.errorMessage}
          <div class="grid grid-cols-3 gap-4 pt-2">
            <div class="text-center">
              <div class="flex items-center justify-center gap-1 mb-1">
                {#if analysis.autoMergeable}
                  <CheckCircle class="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
                {:else}
                  <AlertTriangle class="h-4 w-4 text-orange-500" />
                {/if}
                <span class="text-sm font-medium">Merge Status</span>
              </div>
              <Badge variant={analysis.autoMergeable ? "default" : "destructive"}>
                {analysis.autoMergeable ? "Auto-mergeable" : "Manual required"}
              </Badge>
            </div>

            <div class="text-center">
              <div class="text-lg font-bold text-violet-700 dark:text-violet-300">
                {analysis.affectedFiles.length}
              </div>
              <div class="text-xs text-muted-foreground">Files affected</div>
            </div>

            <div class="text-center">
              <div class="text-lg font-bold text-orange-600">
                {analysis.conflictCount}
              </div>
              <div class="text-xs text-muted-foreground">Potential conflicts</div>
            </div>
          </div>
        {/if}
      </div>
    </CardContent>
  </Card>

  <!-- File Impact Analysis -->
  <Card>
    <CardHeader class="pb-3">
      <CardTitle class="text-lg flex items-center gap-2">
        <FileText class="h-5 w-5" />
        File Impact Analysis
      </CardTitle>
    </CardHeader>
    <CardContent>
      {#if analysis.errorMessage}
        <div
          class="rounded-lg border border-orange-200 bg-orange-50 p-4 dark:border-orange-900 dark:bg-orange-950/30"
        >
          <div class="flex items-start gap-3">
            <AlertTriangle class="mt-0.5 h-5 w-5 flex-shrink-0 text-orange-600" />
            <div>
              <h4 class="text-sm font-medium text-orange-800 dark:text-orange-200">
                Analysis Unavailable
              </h4>
              <p class="text-sm text-orange-700 dark:text-orange-300">
                File impact analysis could not be completed due to analysis errors.
              </p>
            </div>
          </div>
        </div>
      {:else if analysis.affectedFiles.length === 0}
        <div
          class="rounded-lg border border-sky-200 bg-sky-50 p-4 dark:border-sky-900 dark:bg-sky-950/30"
        >
          <div class="flex items-start gap-3">
            <Info class="mt-0.5 h-5 w-5 flex-shrink-0 text-sky-700 dark:text-sky-300" />
            <div>
              <h4 class="text-sm font-medium text-sky-900 dark:text-sky-200">No Files Affected</h4>
              <p class="text-sm text-sky-800 dark:text-sky-300">
                This patch doesn't appear to modify any files.
              </p>
            </div>
          </div>
        </div>
      {:else}
        <div class="space-y-3">
          <!-- Conflict Summary -->
          {#if analysis.conflictCount > 0}
            <div
              class="rounded-lg border border-rose-200 bg-rose-50 p-3 dark:border-rose-900 dark:bg-rose-950/30"
            >
              <div class="flex items-center gap-2">
                <AlertTriangle class="h-4 w-4 text-rose-700 dark:text-rose-300" />
                <span class="text-sm font-medium text-rose-900 dark:text-rose-200">
                  {analysis.conflictCount} potential conflict{analysis.conflictCount > 1 ? "s" : ""} detected
                </span>
              </div>
              {#if analysis.conflictDetails && analysis.conflictDetails.length > 0}
                <div class="mt-2 text-xs text-rose-800 dark:text-rose-300">
                  <p>Conflicts detected in:</p>
                  <ul class="mt-1 list-disc list-inside space-y-1">
                    {#each analysis.conflictDetails.slice(0, 3) as conflict}
                      <li>
                        <code class="font-mono">{conflict.file}</code>
                        <span class="text-muted-foreground">({conflict.type})</span>
                        {#if conflict.conflictMarkers && conflict.conflictMarkers.length > 0}
                          <span class="text-muted-foreground">
                            - {conflict.conflictMarkers.length} conflict region{conflict
                              .conflictMarkers.length > 1
                              ? "s"
                              : ""}</span
                          >
                        {/if}
                      </li>
                    {/each}
                    {#if analysis.conflictDetails.length > 3}
                      <li>... and {analysis.conflictDetails.length - 3} more files</li>
                    {/if}
                  </ul>
                </div>
              {/if}
            </div>
          {:else}
            <div
              class="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/30"
            >
              <div class="flex items-center gap-2">
                <CheckCircle class="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
                <span class="text-sm font-medium text-emerald-900 dark:text-emerald-200">
                  No conflicts detected
                </span>
              </div>
            </div>
          {/if}

          <!-- File List -->
          {#each analysis.affectedFiles as file, index (file)}
            {@const conflictDetail = analysis.conflictDetails?.find((c) => c.file === file)}
            {@const hasConflict =
              conflictDetail || (analysis.conflictCount > 0 && index < analysis.conflictCount)}
            <div
              class="flex items-center justify-between p-3 rounded border gap-3 {hasConflict
                ? 'border-rose-200 bg-rose-50/50 dark:border-rose-900 dark:bg-rose-950/20'
                : ''}"
            >
              <div class="flex items-center gap-3 min-w-0 flex-1">
                <FileText class="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div class="min-w-0 flex-1">
                  <code class="text-sm font-mono truncate block" title={file}>{file}</code>
                  {#if conflictDetail?.type}
                    <p class="text-xs text-rose-700 dark:text-rose-400 mt-1 truncate">
                      Type: {conflictDetail.type}
                      {#if conflictDetail.conflictMarkers && conflictDetail.conflictMarkers.length > 0}
                        - {conflictDetail.conflictMarkers.length} conflict region{conflictDetail
                          .conflictMarkers.length > 1
                          ? "s"
                          : ""}
                      {/if}
                    </p>
                  {/if}
                </div>
              </div>
              <div class="flex items-center gap-2 flex-shrink-0">
                {#if hasConflict}
                  <Badge variant="destructive" class="text-xs whitespace-nowrap">
                    <AlertTriangle class="h-2.5 w-2.5 mr-1" />
                    Conflict
                  </Badge>
                  {#if conflictDetail?.conflictMarkers && conflictDetail.conflictMarkers.length > 0}
                    <span
                      class="text-xs text-rose-700 dark:text-rose-400"
                      title={`${conflictDetail.conflictMarkers.length} conflict region${conflictDetail.conflictMarkers.length > 1 ? "s" : ""} detected`}
                    >
                      {conflictDetail.conflictMarkers.length} region{conflictDetail.conflictMarkers
                        .length > 1
                        ? "s"
                        : ""}
                    </span>
                  {/if}
                {:else}
                  <Badge variant="secondary" class="text-xs whitespace-nowrap">
                    <CheckCircle class="h-2.5 w-2.5 mr-1" />
                    Clean
                  </Badge>
                {/if}
                <span class="text-xs text-muted-foreground whitespace-nowrap"> -- lines </span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </CardContent>
  </Card>

  <!-- Preview Changes -->
  <Card>
    <CardHeader class="pb-3">
      <CardTitle class="text-lg flex items-center gap-2">
        <GitMerge class="h-5 w-5" />
        Preview Changes
      </CardTitle>
    </CardHeader>
    <CardContent>
      {#if analysis.errorMessage}
        <div
          class="rounded-lg border border-orange-200 bg-orange-50 p-4 dark:border-orange-900 dark:bg-orange-950/30"
        >
          <div class="flex items-start gap-3">
            <AlertTriangle class="mt-0.5 h-5 w-5 flex-shrink-0 text-orange-600" />
            <div>
              <h4 class="text-sm font-medium text-orange-800 dark:text-orange-200">
                Preview Unavailable
              </h4>
              <p class="text-sm text-orange-700 dark:text-orange-300">
                Change preview could not be generated due to analysis errors.
              </p>
              <p class="text-xs text-orange-600 dark:text-orange-400 mt-1">
                Try re-running the analysis to resolve the issue.
              </p>
            </div>
          </div>
        </div>
      {:else if normalizedDiff.length === 0}
        <div
          class="rounded-lg border border-sky-200 bg-sky-50 p-4 dark:border-sky-900 dark:bg-sky-950/30"
        >
          <div class="flex items-start gap-3">
            <Info class="mt-0.5 h-5 w-5 flex-shrink-0 text-sky-700 dark:text-sky-300" />
            <div>
              <h4 class="text-sm font-medium text-sky-900 dark:text-sky-200">
                No Changes to Preview
              </h4>
              <p class="text-sm text-sky-800 dark:text-sky-300">
                This patch doesn't contain any code changes to display.
              </p>
            </div>
          </div>
        </div>
      {:else}
        <div class="space-y-3">
          <!-- Change Summary -->
          <div class="rounded-lg border border-muted bg-muted/30 p-3">
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium">Change Summary</span>
              <span class="text-xs text-muted-foreground">
                {normalizedDiff.length} file{normalizedDiff.length > 1 ? "s" : ""} modified
              </span>
            </div>
            {#if analysis.conflictCount > 0}
              <div class="mt-2 flex items-center gap-2 text-xs text-orange-600">
                <AlertTriangle class="h-3 w-3" />
                <span
                  >Contains {analysis.conflictCount} potential conflict{analysis.conflictCount > 1
                    ? "s"
                    : ""} - review carefully</span
                >
              </div>
            {:else}
              <div
                class="mt-2 flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300"
              >
                <CheckCircle class="h-3 w-3" />
                <span>Clean changes - ready for merge</span>
              </div>
            {/if}
          </div>

          <!-- Diff Viewer -->
          <div class="border rounded-lg overflow-hidden">
            <DiffViewer diff={normalizedDiff} showLineNumbers={true} enablePermalinks={false} />
          </div>
        </div>
      {/if}
    </CardContent>
  </Card>
</div>
