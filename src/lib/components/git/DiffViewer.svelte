<script lang="ts">
  import { MessageSquare, Loader2, Share } from "@lucide/svelte";
  import { useRegistry } from "../../useRegistry";
  const { Avatar, AvatarFallback, AvatarImage, Button, Textarea } = useRegistry();
  import { formatDistanceToNow } from "date-fns";
  import parseDiff from "parse-diff";
  import { ChevronDown, ChevronUp } from "@lucide/svelte";
  import { createCommentEvent, getTagValue } from "@nostr-git/core/events";
  import type { CommentEvent, CommentTag } from "@nostr-git/core/events";
  import type { NostrEvent } from "nostr-tools";
  import hljs from "highlight.js/lib/core";
  import javascript from "highlight.js/lib/languages/javascript";
  import typescript from "highlight.js/lib/languages/typescript";
  import python from "highlight.js/lib/languages/python";
  import rust from "highlight.js/lib/languages/rust";
  import go from "highlight.js/lib/languages/go";
  import java from "highlight.js/lib/languages/java";
  import cpp from "highlight.js/lib/languages/cpp";
  import c from "highlight.js/lib/languages/c";
  import csharp from "highlight.js/lib/languages/csharp";
  import ruby from "highlight.js/lib/languages/ruby";
  import php from "highlight.js/lib/languages/php";
  import css from "highlight.js/lib/languages/css";
  import scss from "highlight.js/lib/languages/scss";
  import xml from "highlight.js/lib/languages/xml";
  import json from "highlight.js/lib/languages/json";
  import yaml from "highlight.js/lib/languages/yaml";
  import markdown from "highlight.js/lib/languages/markdown";
  import bash from "highlight.js/lib/languages/bash";
  import sql from "highlight.js/lib/languages/sql";
  import plaintext from "highlight.js/lib/languages/plaintext";
  import { toast } from "../../stores/toast.js";
  import { toUserMessage } from "../../utils/gitErrorUi.js";
  import { GIT_PERMALINK, type PermalinkEvent } from "@nostr-git/core/types";
  import { githubPermalinkDiffId } from "@nostr-git/core/git";
  import type { Repo } from "./Repo.svelte";

  interface Comment {
    id: string;
    lineNumber: number;
    filePath?: string;
    content: string;
    author: {
      name: string;
      avatar: string;
    };
    createdAt: string;
  }

  // Use parse-diff File type
  type AnyFileChange = import("parse-diff").File;

  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("rust", rust);
  hljs.registerLanguage("go", go);
  hljs.registerLanguage("java", java);
  hljs.registerLanguage("cpp", cpp);
  hljs.registerLanguage("c", c);
  hljs.registerLanguage("csharp", csharp);
  hljs.registerLanguage("ruby", ruby);
  hljs.registerLanguage("php", php);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("scss", scss);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("html", xml);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("yaml", yaml);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("plaintext", plaintext);

  function getFileLabel(file: AnyFileChange): string {
    // parse-diff: file.from and file.to
    if (file.from && file.to && file.from !== file.to) {
      return `${file.from} → ${file.to}`;
    }
    return file.from || file.to || "unknown";
  }

  function getFileIsBinary(file: AnyFileChange): boolean {
    // parse-diff does not provide isBinary, so always return false for now
    return false;
  }

  const getFileLanguage = (filepath: string): string => {
    const ext = filepath.split(".").pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      js: "javascript",
      ts: "typescript",
      jsx: "javascript",
      tsx: "typescript",
      py: "python",
      rb: "ruby",
      go: "go",
      rs: "rust",
      java: "java",
      cpp: "cpp",
      c: "c",
      cs: "csharp",
      php: "php",
      html: "html",
      css: "css",
      scss: "scss",
      sass: "scss",
      json: "json",
      xml: "xml",
      yaml: "yaml",
      yml: "yaml",
      md: "markdown",
      sh: "bash",
      bash: "bash",
      zsh: "bash",
      fish: "bash",
    };
    return langMap[ext || ""] || "plaintext";
  };

  const highlightCode = (content: string, language: string): string => {
    if (!content) return "";
    try {
      if (hljs.getLanguage(language)) {
        const result = hljs.highlight(content, { language, ignoreIllegals: true });
        return result.value;
      }
      const result = hljs.highlightAuto(content);
      return result.value;
    } catch (e) {
      return content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
  };

  const {
    diff = undefined,
    showLineNumbers = true,
    expandAll = false,
    comments = [],
    rootEvent,
    onComment,
    currentPubkey,
    repo,
    publish,
  }: {
    diff: AnyFileChange[] | string | undefined;
    showLineNumbers?: boolean;
    expandAll?: boolean;
    comments?: Comment[];
    rootEvent?: NostrEvent | { id: string; pubkey?: string; kind?: number };
    onComment?: (comment: Omit<CommentEvent, "id" | "pubkey" | "sig">) => void;
    currentPubkey?: string | null;
    repo?: Repo;
    publish?: (permalink: PermalinkEvent) => Promise<void>;
  } = $props();

  let selectedLine = $state<number | null>(null);
  let selectedFileIdx = $state<number | null>(null);
  let selectedChunkIdx = $state<number | null>(null);
  let newComment = $state("");
  let expandedFiles = $state(new Set<string>());
  let isSubmitting = $state(false);
  let selectedFilePath = $state<string | null>(null);
  let selectedSide = $state<"L" | "R" | null>(null);
  let selectedStartLine = $state<number | null>(null);
  let selectedEndLine = $state<number | null>(null);
  let isDragging = $state(false);
  let dragSide = $state<"L" | "R" | null>(null);
  let dragFilePath = $state<string | null>(null);
  let touchTimer: number | null = $state(null);
  let touchStartX = $state(0);
  let touchStartY = $state(0);
  let touchMoved = $state(false);
  let touchIdentifier = $state<number | null>(null);
  let showPermalinkMenu = $state(false);
  let permalinkMenuX = $state(0);
  let permalinkMenuY = $state(0);
  let diffContainer: HTMLElement | null = $state(null);

  const pushErrorToast = (title: string, err: unknown, fallback?: string) => {
    const { message, theme } = toUserMessage(err, fallback ?? title);
    toast.push({
      title,
      description: message,
      variant: theme === "warning" ? "default" : "destructive",
    });
  };

  // Accept both AST and raw string for dev ergonomics
  let parsed = $state<AnyFileChange[]>([]);
  $effect(() => {
    let initialExpanded = new Set<string>();
    if (typeof diff === "string") {
      try {
        parsed = parseDiff(diff);
      } catch (e) {
        parsed = [];
      }
    } else if (diff && Array.isArray(diff)) {
      // If diff is already the correct, fully-typed object
      parsed = diff;
    } else {
      parsed = [];
    }
    // Initially expand all files
    if (expandAll) {
      parsed.forEach((file) => initialExpanded.add(getFileLabel(file)));
    }
    expandedFiles = initialExpanded;
  });

  $effect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const inMenu = target.closest?.(".permalink-menu-popup");
      if (!inMenu) showPermalinkMenu = false;
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  });

  $effect(() => {
    const stop = () => {
      if (!isDragging) return;
      isDragging = false;
      dragSide = null;
      dragFilePath = null;
      touchIdentifier = null;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  });

  // Comments by file/hunk/line
  // Match comments based on actual line numbers from the change object and file path
  function getCommentsForLine(change: import("parse-diff").Change, filePath: string): Comment[] {
    // Extract the actual line number from the change based on its type
    // We use a single line number per change to ensure comments appear exactly once
    let lineNumberToMatch: number | null = null;

    if (change.type === "add") {
      // For added lines, use the new line number
      lineNumberToMatch = change.ln ?? null;
    } else if (change.type === "del") {
      // For deleted lines, use the old line number
      lineNumberToMatch = change.ln ?? null;
    } else if (change.type === "normal") {
      // For normal changes, use the new line number (ln2) since that's what
      // the user sees in the final file and what's stored when creating comments
      // (see submitComment which prefers ln2)
      lineNumberToMatch = change.ln2 ?? change.ln1 ?? null;
    }

    // Match comments that have this line number AND file path
    if (lineNumberToMatch === null) {
      return [];
    }

    return comments.filter((c) => {
      // Match line number
      if (c.lineNumber !== lineNumberToMatch) {
        return false;
      }
      // If comment has a filePath, it must match; if comment doesn't have filePath (legacy), allow it
      // This provides backward compatibility with old comments that don't have file paths
      if (c.filePath !== undefined && c.filePath !== "") {
        return c.filePath === filePath;
      }
      // Legacy comments without filePath are allowed (backward compatibility)
      return true;
    });
  }

  type DiffSelection = { filePath: string; side: "L" | "R"; start: number; end: number };

  function updateSelection(
    side: "L" | "R",
    lineNumber: number | null,
    filePath: string,
    shiftKey: boolean
  ) {
    if (!lineNumber) return;
    if (shiftKey && selectedStartLine && selectedSide === side && selectedFilePath === filePath) {
      selectedEndLine = lineNumber;
      return;
    }
    selectedSide = side;
    selectedFilePath = filePath;
    selectedStartLine = lineNumber;
    selectedEndLine = null;
  }

  function startDrag(side: "L" | "R", lineNumber: number | null, filePath: string) {
    if (!lineNumber) return;
    isDragging = true;
    dragSide = side;
    dragFilePath = filePath;
    selectedSide = side;
    selectedFilePath = filePath;
    selectedStartLine = lineNumber;
    selectedEndLine = null;
  }

  function dragOver(side: "L" | "R", lineNumber: number | null, filePath: string) {
    if (!isDragging || dragSide !== side || dragFilePath !== filePath) return;
    if (!lineNumber) return;
    selectedEndLine = lineNumber;
  }

  function handleLineMouseDown(
    event: MouseEvent,
    side: "L" | "R",
    lineNumber: number | null,
    filePath: string
  ) {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (event.shiftKey) {
      updateSelection(side, lineNumber, filePath, true);
      return;
    }
    startDrag(side, lineNumber, filePath);
  }

  function clearTouchTimer() {
    if (touchTimer) {
      window.clearTimeout(touchTimer);
      touchTimer = null;
    }
  }

  function openPermalinkMenuAt(clientX: number, clientY: number) {
    if (!diffContainer) return;
    isDragging = false;
    dragSide = null;
    dragFilePath = null;
    const rect = diffContainer.getBoundingClientRect();
    permalinkMenuX = Math.max(8, clientX - rect.left + diffContainer.scrollLeft);
    permalinkMenuY = Math.max(8, clientY - rect.top + diffContainer.scrollTop);
    showPermalinkMenu = true;
  }

  function handleLineTouchStart(
    event: TouchEvent,
    side: "L" | "R",
    lineNumber: number | null,
    filePath: string
  ) {
    if (!lineNumber) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    touchIdentifier = touch.identifier;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchMoved = false;
    startDrag(side, lineNumber, filePath);
    clearTouchTimer();
    touchTimer = window.setTimeout(() => {
      if (!touchMoved) {
        openPermalinkMenuAt(touchStartX, touchStartY);
      }
    }, 500);
  }

  function handleLineTouchMove(event: TouchEvent) {
    if (!isDragging) return;
    event.preventDefault();
    const touch = Array.from(event.changedTouches).find((t) => t.identifier === touchIdentifier);
    if (!touch) return;
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    if (Math.hypot(dx, dy) > 6) {
      touchMoved = true;
      clearTouchTimer();
    }
    const el = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null;
    const target = el?.closest?.("[data-diff-line]") as HTMLElement | null;
    if (!target) return;
    const side = (target.dataset.side as "L" | "R" | undefined) || null;
    const filePath = target.dataset.filePath || "";
    const lineNumber = Number(target.dataset.lineNumber || "0");
    if (!side || !lineNumber || !filePath) return;
    dragOver(side, lineNumber, filePath);
  }

  function handleLineTouchEnd() {
    clearTouchTimer();
    isDragging = false;
    dragSide = null;
    dragFilePath = null;
    touchIdentifier = null;
  }

  function openPermalinkMenu(event: MouseEvent) {
    openPermalinkMenuAt(event.clientX, event.clientY);
  }

  function getSelectionRange(): DiffSelection | null {
    if (!selectedFilePath || !selectedSide || !selectedStartLine) return null;
    const endValue = selectedEndLine ?? selectedStartLine;
    const start = Math.min(selectedStartLine, endValue);
    const end = Math.max(selectedStartLine, endValue);
    return { filePath: selectedFilePath, side: selectedSide, start, end };
  }

  function isLineWithinSelection(side: "L" | "R", filePath: string, lineNumber: number | null) {
    if (!lineNumber) return false;
    const selection = getSelectionRange();
    if (!selection) return false;
    if (selection.side !== side || selection.filePath !== filePath) return false;
    return lineNumber >= selection.start && lineNumber <= selection.end;
  }

  function getLineNumberForSide(change: import("parse-diff").Change, side: "L" | "R") {
    if (side === "L") {
      if (change.type === "add") return null;
      if (change.type === "del") return change.ln ?? null;
      return change.ln1 ?? null;
    }
    if (change.type === "del") return null;
    if (change.type === "add") return change.ln ?? null;
    return change.ln2 ?? null;
  }

  function getSelectionContent(selection: DiffSelection): string {
    const file = parsed.find((f) => (f.to || f.from || "unknown") === selection.filePath);
    if (!file || !file.chunks) return "";
    const lines: string[] = [];
    for (const chunk of file.chunks) {
      if (!("changes" in chunk)) continue;
      for (const change of chunk.changes) {
        const lineNumber = getLineNumberForSide(change, selection.side);
        if (!lineNumber) continue;
        if (lineNumber < selection.start || lineNumber > selection.end) continue;
        lines.push(change.content);
      }
    }
    return lines.join("\n");
  }

  function buildPermalinkEvent(): PermalinkEvent | null {
    const selection = getSelectionRange();
    if (!selection) return null;
    if (!repo) return null;

    const tags: string[][] = [];
    if (repo.address) tags.push(["a", repo.address]);
    const repoUrl = (repo.web && repo.web[0]) || (repo.clone && repo.clone[0]) || "";
    if (repoUrl) tags.push(["repo", repoUrl]);

    const commitTag = (rootEvent as any)?.tags ? getTagValue(rootEvent as any, "commit") : "";
    const parentCommitTag = (rootEvent as any)?.tags
      ? getTagValue(rootEvent as any, "parent-commit")
      : "";
    const commitForLines = selection.side === "L" && parentCommitTag ? parentCommitTag : commitTag;
    const parentForTags = selection.side === "L" && parentCommitTag ? commitTag : parentCommitTag;

    if (commitForLines) {
      tags.push(["commit", commitForLines]);
      const ref = (repo.refs || []).find(
        (r) => r.type === "heads" && r.commitId === commitForLines
      );
      if (ref?.name) tags.push([`refs/heads/${ref.name}`, commitForLines]);
    }
    if (parentForTags) tags.push(["parent-commit", parentForTags]);

    tags.push(["file", selection.filePath]);
    if (selection.start) {
      if (selection.end !== selection.start)
        tags.push(["lines", String(selection.start), String(selection.end)]);
      else tags.push(["lines", String(selection.start)]);
    }

    const language = getFileLanguage(selection.filePath);
    if (language) tags.push(["l", language]);

    return {
      kind: GIT_PERMALINK,
      content: getSelectionContent(selection),
      tags,
      pubkey: "",
      created_at: Math.floor(Date.now() / 1000),
      id: "",
      sig: "",
    };
  }

  async function createPermalink(event?: MouseEvent) {
    event?.stopPropagation();
    showPermalinkMenu = false;
    const evt = buildPermalinkEvent();
    if (!evt) {
      const missing = !repo ? "repo context" : "selected diff lines";
      toast.push({
        title: "Cannot create permalink",
        description: `Missing ${missing}`,
        variant: "destructive",
      });
      return;
    }
    if (!evt.content) {
      toast.push({
        title: "Cannot create permalink",
        description: "No diff content found for the selected lines",
        variant: "destructive",
      });
      return;
    }

    toast.push({ title: "Creating permalink...", description: "Publishing to relays" });
    try {
      if (publish) {
        await publish(evt);
        toast.push({
          title: "Permalink published",
          description: "Permalink published successfully",
        });
      } else {
        await navigator.clipboard.writeText(JSON.stringify(evt));
        toast.push({ title: "Permalink copied", description: "JSON copied to clipboard" });
      }
    } catch (e: any) {
      pushErrorToast("Permalink failed", e, "Failed to create permalink.");
    }
  }

  async function copyLinkToLines(event?: MouseEvent) {
    event?.stopPropagation();
    showPermalinkMenu = false;
    const selection = getSelectionRange();
    if (!selection) {
      toast.push({
        title: "Select diff lines",
        description: "Choose diff lines to copy a link.",
        variant: "destructive",
      });
      return;
    }
    try {
      const hash = await githubPermalinkDiffId(selection.filePath);
      const range =
        selection.end && selection.end !== selection.start
          ? `-${selection.side}${selection.end}`
          : "";
      const anchor = `#diff-${hash}${selection.side}${selection.start}${range}`;
      const base = location.href.split("#")[0];
      await navigator.clipboard.writeText(`${base}${anchor}`);
      toast.push({ title: "Link copied", description: "Permalink copied to clipboard." });
    } catch (e) {
      pushErrorToast("Failed to copy", e, "Could not copy the link to clipboard.");
    }
  }

  function toggleCommentBox(line: number, fileIdx: number, chunkIdx: number) {
    if (selectedLine === line && selectedFileIdx === fileIdx && selectedChunkIdx === chunkIdx) {
      selectedLine = null;
      selectedFileIdx = null;
      selectedChunkIdx = null;
    } else {
      selectedLine = line;
      selectedFileIdx = fileIdx;
      selectedChunkIdx = chunkIdx;
    }
    newComment = "";
  }

  async function submitComment(
    line: number,
    fileIdx: number,
    chunkIdx: number,
    filePath: string,
    lineNumber: number | null
  ) {
    if (!newComment.trim() || !rootEvent || !onComment || !currentPubkey) {
      console.warn("[DiffViewer] Cannot submit comment: missing required props");
      return;
    }

    if (isSubmitting) return;

    isSubmitting = true;
    try {
      // Get the actual line number from the change
      const file = parsed[fileIdx];
      if (!file || !file.chunks) {
        throw new Error("Invalid file or chunk");
      }

      const chunk = file.chunks[chunkIdx];
      if (!chunk || !("changes" in chunk)) {
        throw new Error("Invalid chunk");
      }

      // Find the change at this line index
      const change = chunk.changes[line - 1];
      if (!change) {
        throw new Error("Invalid change");
      }

      // Determine the actual line number based on change type
      let actualLineNumber: number | null = null;
      if (change.type === "add") {
        actualLineNumber = (change as any).ln ?? null;
      } else if (change.type === "del") {
        actualLineNumber = (change as any).ln ?? null;
      } else if (change.type === "normal") {
        // For normal changes, prefer the new line number (ln2)
        actualLineNumber = (change as any).ln2 ?? (change as any).ln1 ?? null;
      }

      // Build comment content with context
      const commentContent = newComment.trim();
      const contextInfo = `File: ${filePath}${actualLineNumber !== null ? `\nLine: ${actualLineNumber}` : ""}`;
      const fullContent = `${commentContent}\n\n---\n${contextInfo}`;

      // No extra tags needed - file/line info is in content
      const extraTags: CommentTag[] = [];

      // Create NIP-22 comment event
      const commentEvent = createCommentEvent({
        content: fullContent,
        root: {
          type: "E",
          value: rootEvent.id,
          kind: rootEvent.kind?.toString() || "",
          pubkey: rootEvent.pubkey,
        },
        authorPubkey: currentPubkey,
        extraTags,
      });

      // Publish the comment
      onComment(commentEvent);

      // Reset state
      selectedLine = null;
      selectedFileIdx = null;
      selectedChunkIdx = null;
      newComment = "";
    } catch (error) {
      console.error("[DiffViewer] Failed to submit comment:", error);
      // Optionally show error to user via toast or other UI feedback
    } finally {
      isSubmitting = false;
    }
  }
</script>

<div
  class="git-diff-view border border-border rounded-md relative"
  style="border-color: hsl(var(--border));"
  bind:this={diffContainer}
>
  {#if parsed.length === 0}
    <div class="text-muted-foreground italic">No diff to display.</div>
  {/if}
  {#each parsed as file, fileIdx (getFileLabel(file))}
    {@const fileId = getFileLabel(file)}
    {@const isExpanded = expandedFiles.has(fileId)}
    <div class="mb-4">
      <button
        type="button"
        class="font-bold mb-1 flex items-center w-full text-left hover:bg-muted/50 p-1 rounded"
        onclick={() => {
          const newSet = new Set(expandedFiles);
          if (isExpanded) {
            newSet.delete(fileId);
          } else {
            newSet.add(fileId);
          }
          expandedFiles = newSet;
        }}
        aria-expanded={isExpanded}
        aria-controls={`file-diff-${fileIdx}`}
      >
        {#if isExpanded}
          <ChevronUp class="h-4 w-4 mr-2 shrink-0" />
        {:else}
          <ChevronDown class="h-4 w-4 mr-2 shrink-0" />
        {/if}
        <span>{fileId}</span>
        {#if getFileIsBinary(file)}
          <span class="ml-2 text-xs text-orange-400 shrink-0">[binary]</span>
        {/if}
      </button>
      {#if isExpanded && file.chunks}
        <div id={`file-diff-${fileIdx}`}>
          {#each file.chunks as chunk, chunkIdx}
            <div class="mb-2">
              {#if "changes" in chunk}
                <div class="text-xs text-muted-foreground mb-1">{chunk.content}</div>
                {#each chunk.changes as change, i}
                  {@const ln = i + 1}
                  {@const currentFilePath = file.to || file.from || "unknown"}
                  {@const lineComments = getCommentsForLine(change, currentFilePath)}
                  {@const hasComments = lineComments.length > 0}
                  {@const isAdd = change.type === "add"}
                  {@const isDel = change.type === "del"}
                  {@const isNormal = change.type === "normal"}
                  {@const language = getFileLanguage(currentFilePath)}
                  {@const leftLine = isDel
                    ? (change.ln ?? null)
                    : isNormal
                      ? (change.ln1 ?? null)
                      : null}
                  {@const rightLine = isAdd
                    ? (change.ln ?? null)
                    : isNormal
                      ? (change.ln2 ?? null)
                      : null}
                  {@const defaultSide = rightLine ? "R" : "L"}
                  {@const defaultLine = defaultSide === "R" ? rightLine : leftLine}
                  {@const bgClass = isAdd
                    ? "border-l-4 border-emerald-600 bg-emerald-200/70 dark:bg-emerald-900/50"
                    : isDel
                      ? "border-l-4 border-rose-600 bg-rose-200/70 dark:bg-rose-900/50"
                      : "hover:bg-secondary/50"}

                  <div class="w-full">
                    <div
                      class={`flex group pl-2 pt-1 ${bgClass} w-full`}
                      style="min-width: max-content;"
                    >
                      <div class="flex shrink-0 text-foreground select-none">
                        {#if showLineNumbers}
                          <span class="w-8 text-right pr-2">
                            <span
                              class="block cursor-pointer"
                              style="touch-action: none;"
                              data-diff-line
                              data-side="L"
                              data-file-path={currentFilePath}
                              data-line-number={leftLine}
                              onmousedown={(event) =>
                                handleLineMouseDown(event, "L", leftLine, currentFilePath)}
                              ontouchstart={(event) =>
                                handleLineTouchStart(event, "L", leftLine, currentFilePath)}
                              ontouchmove={handleLineTouchMove}
                              ontouchend={handleLineTouchEnd}
                              ontouchcancel={handleLineTouchEnd}
                              onmouseenter={() => dragOver("L", leftLine, currentFilePath)}
                              oncontextmenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (!isLineWithinSelection("L", currentFilePath, leftLine)) {
                                  updateSelection("L", leftLine, currentFilePath, event.shiftKey);
                                }
                                if (leftLine) openPermalinkMenu(event);
                              }}
                            >
                              {leftLine ?? ""}
                            </span>
                          </span>
                          <span class="w-8 text-right pr-2 border-r border-border mr-2">
                            <span
                              class="block cursor-pointer"
                              style="touch-action: none;"
                              data-diff-line
                              data-side="R"
                              data-file-path={currentFilePath}
                              data-line-number={rightLine}
                              onmousedown={(event) =>
                                handleLineMouseDown(event, "R", rightLine, currentFilePath)}
                              ontouchstart={(event) =>
                                handleLineTouchStart(event, "R", rightLine, currentFilePath)}
                              ontouchmove={handleLineTouchMove}
                              ontouchend={handleLineTouchEnd}
                              ontouchcancel={handleLineTouchEnd}
                              onmouseenter={() => dragOver("R", rightLine, currentFilePath)}
                              oncontextmenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (!isLineWithinSelection("R", currentFilePath, rightLine)) {
                                  updateSelection("R", rightLine, currentFilePath, event.shiftKey);
                                }
                                if (rightLine) openPermalinkMenu(event);
                              }}
                            >
                              {rightLine ?? ""}
                            </span>
                          </span>
                        {/if}
                      </div>
                      <span class="font-mono whitespace-pre px-2 flex-shrink-0">
                        <span class="hljs">{@html highlightCode(change.content, language)}</span>
                      </span>
                      <div
                        class="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          onclick={(event) => {
                            event.stopPropagation();
                            if (!isLineWithinSelection(defaultSide, currentFilePath, defaultLine)) {
                              updateSelection(
                                defaultSide,
                                defaultLine,
                                currentFilePath,
                                event.shiftKey
                              );
                            }
                            if (defaultLine) openPermalinkMenu(event);
                          }}
                        >
                          <Share class="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onclick={() => toggleCommentBox(ln, fileIdx, chunkIdx)}
                        >
                          <MessageSquare class="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    {#if hasComments}
                      <div
                        class="bg-secondary/30 border-l-4 border-primary ml-10 pl-4 py-2 space-y-3"
                      >
                        {#each lineComments as c}
                          <div class="flex gap-2">
                            <Avatar class="h-8 w-8">
                              <AvatarImage src={c.author.avatar} alt={c.author.name} />
                              <AvatarFallback
                                >{c.author.name.slice(0, 2).toUpperCase()}</AvatarFallback
                              >
                            </Avatar>
                            <div class="flex-1">
                              <div class="flex items-center gap-2">
                                <span class="font-medium text-sm">{c.author.name}</span>
                                <span class="text-xs" style="color: hsl(var(--muted-foreground));">
                                  {formatDistanceToNow(new Date(c.createdAt), {
                                    addSuffix: true,
                                  })}
                                </span>
                              </div>
                              <p class="text-sm mt-1">{c.content}</p>
                            </div>
                          </div>
                        {/each}
                      </div>
                    {/if}
                    {#if selectedLine === ln && selectedFileIdx === fileIdx && selectedChunkIdx === chunkIdx}
                      <div class="bg-secondary/20 border-l-4 border-primary ml-10 pl-4 py-2">
                        <div class="flex gap-2">
                          <Avatar class="h-8 w-8">
                            <AvatarFallback>ME</AvatarFallback>
                          </Avatar>
                          <div class="flex-1 space-y-2">
                            <Textarea
                              bind:value={newComment}
                              placeholder="Add a comment..."
                              class="min-h-[60px] resize-none"
                              disabled={isSubmitting}
                            />
                            <div class="flex justify-end gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onclick={() => {
                                  selectedLine = null;
                                  selectedFileIdx = null;
                                  selectedChunkIdx = null;
                                }}
                                disabled={isSubmitting}
                              >
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                class="gap-1 bg-git hover:bg-git-hover"
                                disabled={!newComment.trim() ||
                                  isSubmitting ||
                                  !rootEvent ||
                                  !onComment ||
                                  !currentPubkey}
                                onclick={() => {
                                  const filePath = file.to || file.from || "unknown";
                                  const lineNum = isAdd
                                    ? (change.ln ?? null)
                                    : isNormal
                                      ? (change.ln2 ?? change.ln1 ?? null)
                                      : (change.ln ?? null);
                                  submitComment(ln, fileIdx, chunkIdx, filePath, lineNum);
                                }}
                              >
                                {#if isSubmitting}
                                  <Loader2 class="h-3.5 w-3.5 animate-spin" />
                                {:else}
                                  <MessageSquare class="h-3.5 w-3.5" />
                                {/if}
                                Comment
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    {/if}
                  </div>
                {/each}
              {:else}
                <div class="text-xs text-muted-foreground italic">(Non-text chunk)</div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
  {#if showPermalinkMenu}
    {@const selection = getSelectionRange()}
    <div
      class="permalink-menu-popup absolute z-20 w-48 rounded border bg-popover text-popover-foreground shadow-md"
      style="left: {permalinkMenuX}px; top: {permalinkMenuY}px; border-color: hsl(var(--border));"
    >
      <button class="w-full text-left px-3 py-2 hover:bg-secondary/50" onclick={copyLinkToLines}>
        Copy link to {selection
          ? selection.start === selection.end
            ? `line ${selection.start}`
            : `lines ${selection.start}-${selection.end}`
          : "line"}
      </button>
      <button class="w-full text-left px-3 py-2 hover:bg-secondary/50" onclick={createPermalink}>
        Create permalink
      </button>
    </div>
  {/if}
</div>

<style>
  :global(.hljs) {
    background: transparent !important;
    color: inherit !important;
  }
</style>
