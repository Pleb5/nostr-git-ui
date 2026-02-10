<script lang="ts">
  import { Plus, Minus, Share } from "@lucide/svelte";
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
  import { tick } from "svelte";
  import { toUserMessage } from "../../utils/gitErrorUi.js";
  import { GIT_PERMALINK, type PermalinkEvent } from "@nostr-git/core/types";
  import { githubPermalinkDiffId } from "@nostr-git/core/git";
  import type { Repo } from "./Repo.svelte";

  interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    patches: Array<{ line: string; type: "+" | "-" | " " }>;
  }

  interface Props {
    hunks: Hunk[];
    filepath?: string;
    repo?: Repo;
    publish?: (permalink: PermalinkEvent) => Promise<void>;
    commitSha?: string;
    parentSha?: string;
  }

  let { hunks, filepath, repo, publish, commitSha, parentSha }: Props = $props();

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

  let selectedFilePath = $state<string | null>(null);
  let selectedStartIndex = $state<number | null>(null);
  let selectedEndIndex = $state<number | null>(null);
  let touchTimer: number | null = $state(null);
  let touchStartX = $state(0);
  let touchStartY = $state(0);
  let touchLastX = $state(0);
  let touchLastY = $state(0);
  let touchMoved = $state(false);
  let touchIdentifier = $state<number | null>(null);
  let touchLongPress = $state(false);
  let lastInputWasTouch = $state(false);
  let pendingTouchMenu = $state(false);
  let touchMenuTimer: number | null = $state(null);
  let showPermalinkMenu = $state(false);
  let permalinkMenuX = $state(0);
  let permalinkMenuY = $state(0);
  let diffContainer: HTMLElement | null = $state(null);
  let diffAnchor = $state("");

  const pushErrorToast = (title: string, err: unknown, fallback?: string) => {
    const { message, theme } = toUserMessage(err, fallback ?? title);
    toast.push({
      title,
      description: message,
      variant: theme === "warning" ? "default" : "destructive",
    });
  };

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
    const path = filepath;
    if (!path) {
      diffAnchor = "";
      return;
    }
    let cancelled = false;
    githubPermalinkDiffId(path)
      .then((hash) => {
        if (!cancelled) diffAnchor = hash;
      })
      .catch(() => {
        if (!cancelled) diffAnchor = "";
      });
    return () => {
      cancelled = true;
    };
  });

  const hunkOffsets = $derived.by(() => {
    let offset = 0;
    return hunks.map((hunk) => {
      const start = offset;
      offset += hunk.patches.length;
      return start;
    });
  });

  const getDiffAnchorFromLocation = () => {
    if (typeof window === "undefined") return null;
    const hash = window.location.hash || "";
    if (!hash.startsWith("#diff-")) return null;
    return hash.slice(1);
  };

  const parseDiffLineAnchor = (anchor: string) => {
    const match = anchor.match(/^diff-([a-f0-9]+)([LR])(\d+)(?:-[LR](\d+))?/i);
    if (!match) return null;
    const start = Number.parseInt(match[3], 10);
    const end = match[4] ? Number.parseInt(match[4], 10) : null;
    if (Number.isNaN(start)) return null;
    return {
      hash: match[1],
      side: match[2] as "L" | "R",
      start,
      end: end && !Number.isNaN(end) ? end : null,
    };
  };

  const scrollElementIntoView = (el: HTMLElement, align: "start" | "center" = "center") => {
    const scrollParent = diffContainer?.closest(".scroll-container") as HTMLElement | null;
    if (!scrollParent) {
      el.scrollIntoView({ block: align });
      return;
    }
    const parentRect = scrollParent.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const offset = elRect.top - parentRect.top + scrollParent.scrollTop;
    const target = align === "center" ? offset - scrollParent.clientHeight / 2 : offset;
    scrollParent.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  };

  const scrollToDiffAnchor = async () => {
    if (!diffContainer || !diffAnchor) return;
    const anchor = getDiffAnchorFromLocation();
    if (!anchor) return;
    const lineAnchor = parseDiffLineAnchor(anchor);
    if (lineAnchor && lineAnchor.hash === diffAnchor) {
      await tick();
      const lineEl = document.getElementById(
        `diff-${diffAnchor}${lineAnchor.side}${lineAnchor.start}`
      ) as HTMLElement | null;
      if (lineEl) {
        scrollElementIntoView(lineEl, "center");
        const startIndex = Number(lineEl.dataset.diffIndex || "");
        const startPath = lineEl.dataset.filePath || filepath || null;
        let endIndex = startIndex;
        if (lineAnchor.end) {
          const endEl = document.getElementById(
            `diff-${diffAnchor}${lineAnchor.side}${lineAnchor.end}`
          ) as HTMLElement | null;
          const parsedEnd = Number(endEl?.dataset.diffIndex || "");
          if (Number.isFinite(parsedEnd)) {
            endIndex = parsedEnd;
          }
        }
        if (startPath && Number.isFinite(startIndex)) {
          selectedFilePath = startPath;
          selectedStartIndex = Math.min(startIndex, endIndex);
          selectedEndIndex = Math.max(startIndex, endIndex);
        }
        return;
      }
    }
    await tick();
    const el = document.getElementById(`diff-${diffAnchor}`);
    if (el) scrollElementIntoView(el as HTMLElement, "start");
  };

  $effect(() => {
    if (!diffAnchor) return;
    void scrollToDiffAnchor();
  });

  $effect(() => {
    if (typeof window === "undefined") return;
    const handler = () => void scrollToDiffAnchor();
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  });

  $effect(() => {
    const container = diffContainer;
    if (!container || typeof window === "undefined") return;
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const startNode = range.startContainer;
      const endNode = range.endContainer;
      if (!container.contains(startNode) || !container.contains(endNode)) return;
      setSelectionFromDom();
      if (pendingTouchMenu && touchLongPress) {
        const rect = range.getBoundingClientRect();
        if (touchMenuTimer) {
          window.clearTimeout(touchMenuTimer);
          touchMenuTimer = null;
        }
        touchMenuTimer = window.setTimeout(() => {
          if (!pendingTouchMenu || !touchLongPress) return;
          openPermalinkMenuAt(rect.left + rect.width / 2, rect.bottom + 4);
          pendingTouchMenu = false;
        }, 160);
      }
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  });

  $effect(() => {
    const container = diffContainer;
    if (!container) return;

    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!container.contains(target)) return;
      if (lastInputWasTouch) {
        e.preventDefault();
        return;
      }
      const selection = setSelectionFromDom();
      if (!selection) return;
      e.preventDefault();
      openPermalinkMenuAt(e.clientX, e.clientY);
    };

    const handlePointerDown = (e: PointerEvent) => {
      lastInputWasTouch = e.pointerType === "touch";
    };

    const handleTouchStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!container.contains(target)) return;
      const touch = e.changedTouches[0];
      if (!touch) return;
      lastInputWasTouch = true;
      touchIdentifier = touch.identifier;
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchLastX = touch.clientX;
      touchLastY = touch.clientY;
      touchMoved = false;
      touchLongPress = false;
      pendingTouchMenu = false;
      clearTouchTimer();
      touchTimer = window.setTimeout(() => {
        touchLongPress = true;
        pendingTouchMenu = true;
      }, 300);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (touchIdentifier === null) return;
      const touch = Array.from(e.changedTouches).find((t) => t.identifier === touchIdentifier);
      if (!touch) return;
      touchLastX = touch.clientX;
      touchLastY = touch.clientY;
      const dx = touch.clientX - touchStartX;
      const dy = touch.clientY - touchStartY;
      if (Math.hypot(dx, dy) > 6) {
        touchMoved = true;
        clearTouchTimer();
        pendingTouchMenu = false;
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (touchIdentifier === null) return;
      const touch = Array.from(e.changedTouches).find((t) => t.identifier === touchIdentifier);
      if (!touch) return;
      clearTouchTimer();
      if (touchMenuTimer) {
        window.clearTimeout(touchMenuTimer);
        touchMenuTimer = null;
      }
      touchIdentifier = null;
      if (!touchLongPress) return;
    };

    container.addEventListener("contextmenu", handleContextMenu, { capture: true } as any);
    container.addEventListener("pointerdown", handlePointerDown, { capture: true } as any);
    container.addEventListener("touchstart", handleTouchStart, {
      capture: true,
      passive: true,
    } as any);
    container.addEventListener("touchmove", handleTouchMove, {
      capture: true,
      passive: true,
    } as any);
    container.addEventListener("touchend", handleTouchEnd, { capture: true } as any);
    container.addEventListener("touchcancel", handleTouchEnd, { capture: true } as any);
    return () => {
      container.removeEventListener("contextmenu", handleContextMenu, { capture: true } as any);
      container.removeEventListener("pointerdown", handlePointerDown, { capture: true } as any);
      container.removeEventListener("touchstart", handleTouchStart, { capture: true } as any);
      container.removeEventListener("touchmove", handleTouchMove, { capture: true } as any);
      container.removeEventListener("touchend", handleTouchEnd, { capture: true } as any);
      container.removeEventListener("touchcancel", handleTouchEnd, { capture: true } as any);
    };
  });

  // Calculate line numbers for display
  const calculateLineNumbers = (hunk: Hunk) => {
    const lines: Array<{
      oldLineNum: number | null;
      newLineNum: number | null;
      content: string;
      type: "+" | "-" | " ";
    }> = [];

    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;

    for (const patch of hunk.patches) {
      if (patch.type === "+") {
        lines.push({
          oldLineNum: null,
          newLineNum: newLineNum,
          content: patch.line,
          type: patch.type,
        });
        newLineNum++;
      } else if (patch.type === "-") {
        lines.push({
          oldLineNum: oldLineNum,
          newLineNum: null,
          content: patch.line,
          type: patch.type,
        });
        oldLineNum++;
      } else {
        lines.push({
          oldLineNum: oldLineNum,
          newLineNum: newLineNum,
          content: patch.line,
          type: patch.type,
        });
        oldLineNum++;
        newLineNum++;
      }
    }

    return lines;
  };

  // Get line type styling
  const getLineClass = (type: "+" | "-" | " ") => {
    switch (type) {
      case "+":
        return "bg-emerald-200/70 border-l-2 border-l-emerald-600 dark:bg-emerald-900/50";
      case "-":
        return "bg-rose-200/70 border-l-2 border-l-rose-600 dark:bg-rose-900/50";
      default:
        return "bg-background";
    }
  };

  // Get line number styling
  const getLineNumClass = (type: "+" | "-" | " ") => {
    switch (type) {
      case "+":
        return "bg-emerald-300 text-emerald-950 dark:bg-emerald-800/70 dark:text-emerald-100";
      case "-":
        return "bg-rose-300 text-rose-950 dark:bg-rose-800/70 dark:text-rose-100";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  const getFileLanguage = (path: string): string => {
    const ext = path.split(".").pop()?.toLowerCase();
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
    } catch {
      return content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
  };

  type DiffSelection = { filePath: string; start: number; end: number };

  function getLineElementFromNode(node: Node): HTMLElement | null {
    if (node instanceof HTMLElement) return node.closest("[data-diff-index]");
    if (node.parentElement) return node.parentElement.closest("[data-diff-index]");
    return null;
  }

  function getSelectionRangeFromDom(): DiffSelection | null {
    if (typeof window === "undefined") return null;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (range.collapsed) return null;
    const startEl = getLineElementFromNode(range.startContainer);
    const endEl = getLineElementFromNode(range.endContainer);
    if (!startEl || !endEl) return null;
    const startPath = startEl.dataset.filePath;
    const endPath = endEl.dataset.filePath;
    if (!startPath || startPath !== endPath) return null;
    const startIndex = Number(startEl.dataset.diffIndex || "");
    const endIndex = Number(endEl.dataset.diffIndex || "");
    if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return null;
    return {
      filePath: startPath,
      start: Math.min(startIndex, endIndex),
      end: Math.max(startIndex, endIndex),
    };
  }

  function setSelectionFromDom(): DiffSelection | null {
    const selection = getSelectionRangeFromDom();
    if (!selection) return null;
    selectedFilePath = selection.filePath;
    selectedStartIndex = selection.start;
    selectedEndIndex = selection.end;
    return selection;
  }

  function clearTouchTimer() {
    if (touchTimer) {
      window.clearTimeout(touchTimer);
      touchTimer = null;
    }
  }

  function openPermalinkMenuAt(clientX: number, clientY: number) {
    if (!diffContainer) return;
    const rect = diffContainer.getBoundingClientRect();
    permalinkMenuX = Math.max(8, clientX - rect.left + diffContainer.scrollLeft);
    permalinkMenuY = Math.max(8, clientY - rect.top + diffContainer.scrollTop);
    showPermalinkMenu = true;
  }

  function getSelectionRange(): DiffSelection | null {
    if (!selectedFilePath || selectedStartIndex === null) return null;
    const endValue = selectedEndIndex ?? selectedStartIndex;
    const start = Math.min(selectedStartIndex, endValue);
    const end = Math.max(selectedStartIndex, endValue);
    return { filePath: selectedFilePath, start, end };
  }

  function isLineWithinSelection(filePath: string, lineIndex: number) {
    const selection = getSelectionRange();
    if (!selection) return false;
    if (selection.filePath !== filePath) return false;
    return lineIndex >= selection.start && lineIndex <= selection.end;
  }

  function getSelectionContent(selection: DiffSelection): string {
    const lines: string[] = [];
    let index = 0;
    for (const hunk of hunks) {
      const hunkLines = calculateLineNumbers(hunk);
      for (const line of hunkLines) {
        if (index >= selection.start && index <= selection.end) {
          const prefix = line.type === " " ? " " : line.type;
          lines.push(`${prefix}${line.content}`);
        }
        index += 1;
      }
    }
    return lines.join("\n");
  }

  function getRightAnchorRange(selection: DiffSelection): { start: number; end: number } | null {
    const rightLines: number[] = [];
    let index = 0;
    for (const hunk of hunks) {
      const hunkLines = calculateLineNumbers(hunk);
      for (const line of hunkLines) {
        if (index >= selection.start && index <= selection.end) {
          const lineNumber = line.newLineNum;
          if (lineNumber) rightLines.push(lineNumber);
        }
        index += 1;
      }
    }
    if (rightLines.length === 0) return null;
    return {
      start: Math.min(...rightLines),
      end: Math.max(...rightLines),
    };
  }

  function buildPermalinkEvent(): PermalinkEvent | null {
    const selection = getSelectionRange();
    if (!selection) return null;
    if (!repo) return null;

    const tags: string[][] = [];
    if (repo.address) tags.push(["a", repo.address]);
    const repoUrl = (repo.web && repo.web[0]) || (repo.clone && repo.clone[0]) || "";
    if (repoUrl) tags.push(["repo", repoUrl]);

    const commitTag = commitSha || "";
    const parentCommitTag = parentSha || "";

    if (commitTag) {
      tags.push(["commit", commitTag]);
      const ref = (repo.refs || []).find((r) => r.type === "heads" && r.commitId === commitTag);
      if (ref?.name) tags.push([`refs/heads/${ref.name}`, commitTag]);
    }
    if (parentCommitTag) tags.push(["parent-commit", parentCommitTag]);

    if (selection.filePath) tags.push(["file", selection.filePath]);
    const anchorRange = getRightAnchorRange(selection);
    if (anchorRange) {
      if (anchorRange.end !== anchorRange.start)
        tags.push(["lines", String(anchorRange.start), String(anchorRange.end)]);
      else tags.push(["lines", String(anchorRange.start)]);
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
    } catch (e) {
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
      const anchorRange = getRightAnchorRange(selection);
      const range =
        anchorRange && anchorRange.end !== anchorRange.start ? `-R${anchorRange.end}` : "";
      const anchor = anchorRange ? `#diff-${hash}R${anchorRange.start}${range}` : `#diff-${hash}`;
      const base = location.href.split("#")[0];
      await navigator.clipboard.writeText(`${base}${anchor}`);
      toast.push({ title: "Link copied", description: "Permalink copied to clipboard." });
    } catch (e) {
      pushErrorToast("Failed to copy", e, "Could not copy the link to clipboard.");
    }
  }
</script>

{#if hunks.length === 0}
  <div class="p-4 text-center text-muted-foreground">No changes to display</div>
{:else}
  <div
    class="min-w-fit rounded-md border border-border relative"
    bind:this={diffContainer}
    id={diffAnchor ? `diff-${diffAnchor}` : undefined}
  >
    {#each hunks as hunk, hunkIndex}
      {@const lines = calculateLineNumbers(hunk)}

      <!-- Hunk Header -->
      <div
        class="bg-muted px-4 py-2 text-sm font-mono text-muted-foreground border-b border-border whitespace-nowrap"
      >
        @@
        {#if hunk.oldLines > 0}
          -{hunk.oldStart},{hunk.oldLines}
        {:else}
          -{hunk.oldStart}
        {/if}
        {#if hunk.newLines > 0}
          +{hunk.newStart},{hunk.newLines}
        {:else}
          +{hunk.newStart}
        {/if}
        @@
        {#if filepath}
          <span class="ml-2 text-foreground">{filepath}</span>
        {/if}
      </div>

      <!-- Diff Lines -->
      <div class="divide-y divide-border">
        {#each lines as line, lineIndex}
          {@const language = getFileLanguage(filepath || "")}
          {@const hunkOffset = hunkOffsets[hunkIndex] ?? 0}
          {@const globalIndex = hunkOffset + lineIndex}
          {@const isSelected = isLineWithinSelection(filepath || "unknown", globalIndex)}
          <div
            class={`flex ${getLineClass(line.type)} ${isSelected ? "diff-line-selected" : ""}`}
            data-diff-index={globalIndex}
            data-file-path={filepath || "unknown"}
            data-line-left={line.oldLineNum ?? ""}
            data-line-right={line.newLineNum ?? ""}
          >
            <!-- Line Numbers -->
            <div class="flex shrink-0">
              <!-- Old Line Number -->
              <div
                class="w-12 px-2 py-1 text-right text-xs font-mono {getLineNumClass(
                  line.type
                )} border-r border-border"
              >
                <span
                  class="block cursor-pointer"
                  style="touch-action: none;"
                  id={diffAnchor && line.oldLineNum
                    ? `diff-${diffAnchor}L${line.oldLineNum}`
                    : undefined}
                >
                  {line.oldLineNum || ""}
                </span>
              </div>
              <!-- New Line Number -->
              <div
                class="w-12 px-2 py-1 text-right text-xs font-mono {getLineNumClass(
                  line.type
                )} border-r border-border"
              >
                <span
                  class="block cursor-pointer"
                  style="touch-action: none;"
                  id={diffAnchor && line.newLineNum
                    ? `diff-${diffAnchor}R${line.newLineNum}`
                    : undefined}
                >
                  {line.newLineNum || ""}
                </span>
              </div>
            </div>

            <!-- Change Indicator -->
            <div
              class="w-6 px-1 py-1 text-center text-xs font-mono shrink-0 {getLineNumClass(
                line.type
              )} border-r border-border"
            >
              {#if line.type === "+"}
                <Plus class="h-3 w-3 mx-auto text-green-600" />
              {:else if line.type === "-"}
                <Minus class="h-3 w-3 mx-auto text-red-600" />
              {:else}
                <span class="text-muted-foreground"> </span>
              {/if}
            </div>

            <!-- Line Content -->
            <div class="flex-1 px-2 py-1 font-mono text-sm whitespace-nowrap">
              <pre class="whitespace-pre m-0 inline">
                <span class="hljs">{@html highlightCode(line.content, language)}</span>
              </pre>
            </div>

            <div class="w-8 px-1 py-1 shrink-0 opacity-0 hover:opacity-100 transition-opacity">
              <button
                onclick={(event) => {
                  event.stopPropagation();
                  selectedFilePath = filepath || "unknown";
                  selectedStartIndex = globalIndex;
                  selectedEndIndex = globalIndex;
                  openPermalinkMenuAt(event.clientX, event.clientY);
                }}
                class="w-6 h-6 rounded-sm bg-background border border-border hover:bg-muted flex items-center justify-center"
                title="Permalink"
              >
                <Share class="h-3 w-3 text-muted-foreground" />
              </button>
            </div>
          </div>
        {/each}
      </div>

      <!-- Hunk Separator -->
      {#if hunkIndex < hunks.length - 1}
        <div class="h-2 bg-muted border-t border-border"></div>
      {/if}
    {/each}
    {#if showPermalinkMenu}
      {@const selection = getSelectionRange()}
      {@const anchorRange = selection ? getRightAnchorRange(selection) : null}
      <div
        class="permalink-menu-popup absolute z-20 w-48 rounded border bg-popover text-popover-foreground shadow-md"
        style="left: {permalinkMenuX}px; top: {permalinkMenuY}px; border-color: hsl(var(--border));"
      >
        <button class="w-full text-left px-3 py-2 hover:bg-secondary/50" onclick={copyLinkToLines}>
          Copy link to {anchorRange
            ? anchorRange.start === anchorRange.end
              ? `line ${anchorRange.start}`
              : `lines ${anchorRange.start}-${anchorRange.end}`
            : "file"}
        </button>
        <button class="w-full text-left px-3 py-2 hover:bg-secondary/50" onclick={createPermalink}>
          Create permalink
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Ensure code content doesn't break layout */
  pre {
    margin: 0;
    font-family:
      ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;
  }

  /* Custom scrollbar for horizontal overflow */
  .overflow-x-auto::-webkit-scrollbar {
    height: 6px;
  }

  .overflow-x-auto::-webkit-scrollbar-track {
    background: transparent;
  }

  .overflow-x-auto::-webkit-scrollbar-thumb {
    background-color: rgba(0, 0, 0, 0.2);
    border-radius: 3px;
  }

  .overflow-x-auto::-webkit-scrollbar-thumb:hover {
    background-color: rgba(0, 0, 0, 0.3);
  }

  :global(.hljs) {
    background: transparent !important;
    color: inherit !important;
  }

  :global(.hljs-keyword),
  :global(.hljs-selector-tag),
  :global(.hljs-literal),
  :global(.hljs-title),
  :global(.hljs-section),
  :global(.hljs-type) {
    color: hsl(var(--primary));
  }

  :global(.hljs-string),
  :global(.hljs-attr),
  :global(.hljs-attribute),
  :global(.hljs-template-tag),
  :global(.hljs-template-variable) {
    color: hsl(var(--accent-foreground));
  }

  :global(.hljs-number),
  :global(.hljs-symbol),
  :global(.hljs-bullet) {
    color: hsl(var(--secondary-foreground));
  }

  :global(.hljs-comment),
  :global(.hljs-quote) {
    color: hsl(var(--muted-foreground));
    font-style: italic;
  }

  :global(.diff-line-selected) {
    outline: 1px solid hsl(var(--ring));
    outline-offset: -1px;
  }
</style>
