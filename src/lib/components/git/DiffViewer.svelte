<script lang="ts">
  import { MessageSquare, Loader2, Share } from "@lucide/svelte";
  import { useRegistry } from "../../useRegistry";
  const { Avatar, AvatarFallback, AvatarImage, Button, Textarea } = useRegistry();
  import { formatDistanceToNow } from "date-fns";
  import { tick } from "svelte";
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
    enablePermalinks = true,
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
    enablePermalinks?: boolean;
  } = $props();

  let selectedLine = $state<number | null>(null);
  let selectedFileIdx = $state<number | null>(null);
  let selectedChunkIdx = $state<number | null>(null);
  let newComment = $state("");
  let expandedFiles = $state(new Set<string>());
  let isSubmitting = $state(false);
  let selectedFilePath = $state<string | null>(null);
  let selectedStartIndex = $state<number | null>(null);
  let selectedEndIndex = $state<number | null>(null);
  let touchTimer: number | null = $state(null);
  let touchStartX = $state(0);
  let touchStartY = $state(0);
  let touchMoved = $state(false);
  let touchIdentifier = $state<number | null>(null);
  let touchLongPress = $state(false);
  let lastInputWasTouch = $state(false);
  let isTouchSelecting = $state(false);
  let touchStartIndex = $state<number | null>(null);
  let touchStartFilePath = $state<string | null>(null);
  let selectionScrollParent = $state<HTMLElement | null>(null);
  let autoScrollFrame: number | null = $state(null);
  let autoScrollClientX = 0;
  let autoScrollClientY = 0;
  let autoScrollActive = false;
  let ignoreMenuCloseUntil = $state(0);
  let showPermalinkMenu = $state(false);
  let permalinkMenuX = $state(0);
  let permalinkMenuY = $state(0);
  let diffContainer: HTMLElement | null = $state(null);
  let diffAnchors = $state<Record<string, string>>({});
  const LONG_PRESS_MS = 300;
  const TOUCH_MOVE_THRESHOLD = 8;
  const AUTO_SCROLL_THRESHOLD = 36;
  const AUTO_SCROLL_STEP = 24;
  const MENU_WIDTH = 192;
  const MENU_PADDING = 8;

  const fileChunkOffsets = $derived.by(() => {
    return parsed.map((file) => {
      let offset = 0;
      const chunks = file.chunks || [];
      return chunks.map((chunk) => {
        const start = offset;
        if ("changes" in chunk && Array.isArray(chunk.changes)) {
          offset += chunk.changes.length;
        }
        return start;
      });
    });
  });

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
    const paths = Array.from(
      new Set(parsed.map((file) => file.to || file.from || "").filter(Boolean))
    );
    if (paths.length === 0) {
      diffAnchors = {};
      return;
    }
    let cancelled = false;
    Promise.all(paths.map(async (path) => [path, await githubPermalinkDiffId(path)] as const))
      .then((entries) => {
        if (!cancelled) diffAnchors = Object.fromEntries(entries);
      })
      .catch(() => {
        if (!cancelled) diffAnchors = {};
      });
    return () => {
      cancelled = true;
    };
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

  const findFilePathByHash = (hash: string) => {
    for (const [filePath, value] of Object.entries(diffAnchors)) {
      if (value === hash) return filePath;
    }
    return null;
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

  const ensureFileExpandedByPath = (filePath: string) => {
    const file = parsed.find((entry) => (entry.to || entry.from || "") === filePath);
    if (!file) return;
    const fileId = getFileLabel(file);
    if (expandedFiles.has(fileId)) return;
    const next = new Set(expandedFiles);
    next.add(fileId);
    expandedFiles = next;
  };

  const scrollToDiffHash = async () => {
    if (!diffContainer) return;
    const anchor = getDiffAnchorFromLocation();
    if (!anchor) return;
    const lineAnchor = parseDiffLineAnchor(anchor);
    if (lineAnchor) {
      const filePath = findFilePathByHash(lineAnchor.hash);
      if (filePath) ensureFileExpandedByPath(filePath);
      await tick();
      const lineEl = document.getElementById(
        `diff-${lineAnchor.hash}${lineAnchor.side}${lineAnchor.start}`
      ) as HTMLElement | null;
      if (lineEl) {
        scrollElementIntoView(lineEl, "center");
        const startIndex = Number(lineEl.dataset.diffIndex || "");
        const startPath = lineEl.dataset.filePath || filePath || null;
        let endIndex = startIndex;
        if (lineAnchor.end) {
          const endEl = document.getElementById(
            `diff-${lineAnchor.hash}${lineAnchor.side}${lineAnchor.end}`
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
    const hashMatch = anchor.match(/^diff-([a-f0-9]+)/i);
    const fileHash = hashMatch ? hashMatch[1] : null;
    if (!fileHash) return;
    const el = document.getElementById(`diff-${fileHash}`);
    if (el) scrollElementIntoView(el as HTMLElement, "start");
  };

  const scrollToCommentHash = async () => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash || "";
    if (!hash.startsWith("#comment-")) return;
    await tick();
    const el = document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView({ block: "center" });
  };

  $effect(() => {
    const handler = (e: MouseEvent) => {
      if (Date.now() < ignoreMenuCloseUntil) return;
      const target = e.target as HTMLElement;
      const inMenu = target.closest?.(".permalink-menu-popup");
      if (!inMenu) showPermalinkMenu = false;
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  });

  $effect(() => {
    const anchors = diffAnchors;
    if (!diffContainer || Object.keys(anchors).length === 0) return;
    void scrollToDiffHash();
  });

  $effect(() => {
    comments?.length;
    void scrollToCommentHash();
  });

  $effect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      void scrollToDiffHash();
      void scrollToCommentHash();
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  });

  $effect(() => {
    const container = diffContainer;
    if (!container || typeof window === "undefined") return;
    const handleSelectionChange = () => {
      if (!enablePermalinks) return;
      if (isTouchSelecting) return;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const startNode = range.startContainer;
      const endNode = range.endContainer;
      if (!container.contains(startNode) || !container.contains(endNode)) return;
      setSelectionFromDom();
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
      if (!enablePermalinks) return;
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
      if (!enablePermalinks) return;
      if (touchIdentifier !== null) return;
      const touch = e.changedTouches[0];
      if (!touch) return;
      lastInputWasTouch = true;
      touchIdentifier = touch.identifier;
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchMoved = false;
      touchLongPress = false;
      isTouchSelecting = false;
      touchStartIndex = null;
      touchStartFilePath = null;
      clearTouchTimer();
      touchTimer = window.setTimeout(() => {
        touchLongPress = true;
        const hit = getLineFromPoint(touchStartX, touchStartY);
        if (!hit) return;
        isTouchSelecting = true;
        touchStartFilePath = hit.filePath;
        touchStartIndex = hit.index;
        setDiffSelection(hit.filePath, hit.index, hit.index);
        updateAutoScroll(touchStartX, touchStartY);
      }, LONG_PRESS_MS);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!enablePermalinks) return;
      if (touchIdentifier === null) return;
      const touch = Array.from(e.changedTouches).find((t) => t.identifier === touchIdentifier);
      if (!touch) return;
      const dx = touch.clientX - touchStartX;
      const dy = touch.clientY - touchStartY;
      if (!isTouchSelecting && Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD) {
        touchMoved = true;
        clearTouchTimer();
        touchIdentifier = null;
        touchStartFilePath = null;
        touchStartIndex = null;
        stopAutoScroll();
        return;
      }

      if (!isTouchSelecting || !touchStartFilePath || touchStartIndex === null) return;
      e.preventDefault();
      const hit = getLineFromPoint(touch.clientX, touch.clientY);
      if (hit && hit.filePath === touchStartFilePath) {
        setDiffSelection(touchStartFilePath, touchStartIndex, hit.index);
      }
      updateAutoScroll(touch.clientX, touch.clientY);
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!enablePermalinks) return;
      if (touchIdentifier === null) return;
      const touch = Array.from(e.changedTouches).find((t) => t.identifier === touchIdentifier);
      if (!touch) return;
      clearTouchTimer();
      touchIdentifier = null;
      stopAutoScroll();
      if (!isTouchSelecting) return;

      const selection = getSelectionRange();
      const rect = getSelectionAnchorRect(selection) ?? getSelectionRect();
      ignoreMenuCloseUntil = Date.now() + 500;
      if (rect) {
        openPermalinkMenuAt(rect.left + MENU_PADDING, rect.bottom + 4);
      } else {
        openPermalinkMenuAt(touch.clientX, touch.clientY);
      }

      touchLongPress = false;
      isTouchSelecting = false;
      touchStartFilePath = null;
      touchStartIndex = null;
    };

    const handleTouchCancel = () => {
      clearTouchTimer();
      touchIdentifier = null;
      touchLongPress = false;
      touchMoved = false;
      isTouchSelecting = false;
      touchStartFilePath = null;
      touchStartIndex = null;
      stopAutoScroll();
    };

    container.addEventListener("contextmenu", handleContextMenu, { capture: true } as any);
    container.addEventListener("pointerdown", handlePointerDown, { capture: true } as any);
    container.addEventListener("touchstart", handleTouchStart, {
      capture: true,
      passive: true,
    } as any);
    container.addEventListener("touchmove", handleTouchMove, {
      capture: true,
      passive: false,
    } as any);
    container.addEventListener("touchend", handleTouchEnd, { capture: true } as any);
    container.addEventListener("touchcancel", handleTouchCancel, { capture: true } as any);
    return () => {
      container.removeEventListener("contextmenu", handleContextMenu, { capture: true } as any);
      container.removeEventListener("pointerdown", handlePointerDown, { capture: true } as any);
      container.removeEventListener("touchstart", handleTouchStart, { capture: true } as any);
      container.removeEventListener("touchmove", handleTouchMove, { capture: true } as any);
      container.removeEventListener("touchend", handleTouchEnd, { capture: true } as any);
      container.removeEventListener("touchcancel", handleTouchCancel, { capture: true } as any);
      stopAutoScroll();
    };
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

  function findSelectionScrollParent(element: HTMLElement | null): HTMLElement | null {
    if (!element || typeof window === "undefined") return null;
    let current: HTMLElement | null = element;
    while (current) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        current.scrollHeight > current.clientHeight
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function autoScrollForSelection(clientY: number) {
    const threshold = AUTO_SCROLL_THRESHOLD;
    const maxStep = AUTO_SCROLL_STEP;
    const scrollParent =
      selectionScrollParent &&
      selectionScrollParent.scrollHeight > selectionScrollParent.clientHeight
        ? selectionScrollParent
        : diffContainer
          ? findSelectionScrollParent(diffContainer)
          : null;

    if (scrollParent) {
      if (scrollParent !== selectionScrollParent) {
        selectionScrollParent = scrollParent;
      }
      const rect = scrollParent.getBoundingClientRect();
      if (clientY < rect.top + threshold) {
        const delta = Math.min(maxStep, rect.top + threshold - clientY);
        scrollParent.scrollTop -= delta;
      } else if (clientY > rect.bottom - threshold) {
        const delta = Math.min(maxStep, clientY - (rect.bottom - threshold));
        scrollParent.scrollTop += delta;
      }
      return;
    }

    if (clientY < threshold) {
      window.scrollBy({ top: -maxStep });
    } else if (clientY > window.innerHeight - threshold) {
      window.scrollBy({ top: maxStep });
    }
  }

  function startAutoScroll() {
    if (autoScrollFrame !== null) return;
    const tick = () => {
      if (!autoScrollActive) {
        autoScrollFrame = null;
        return;
      }
      autoScrollForSelection(autoScrollClientY);
      if (isTouchSelecting && touchStartFilePath && touchStartIndex !== null) {
        const hit = getLineFromPoint(autoScrollClientX, autoScrollClientY);
        if (hit && hit.filePath === touchStartFilePath) {
          setDiffSelection(touchStartFilePath, touchStartIndex, hit.index);
        }
      }
      autoScrollFrame = window.requestAnimationFrame(tick);
    };
    autoScrollFrame = window.requestAnimationFrame(tick);
  }

  function updateAutoScroll(clientX: number, clientY: number) {
    autoScrollClientX = clientX;
    autoScrollClientY = clientY;
    if (!autoScrollActive) {
      autoScrollActive = true;
      startAutoScroll();
    }
  }

  function stopAutoScroll() {
    autoScrollActive = false;
    if (autoScrollFrame !== null) {
      window.cancelAnimationFrame(autoScrollFrame);
      autoScrollFrame = null;
    }
  }

  function getLineFromPoint(clientX: number, clientY: number) {
    if (!diffContainer || typeof document === "undefined") return null;
    const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const lineEl = target?.closest?.("[data-diff-index]") as HTMLElement | null;
    if (!lineEl || !diffContainer.contains(lineEl)) return null;
    const filePath = lineEl.dataset.filePath;
    const index = Number(lineEl.dataset.diffIndex || "");
    if (!filePath || !Number.isFinite(index)) return null;
    return { filePath, index, element: lineEl };
  }

  function setDiffSelection(filePath: string, startIndex: number, endIndex: number) {
    selectedFilePath = filePath;
    selectedStartIndex = Math.min(startIndex, endIndex);
    selectedEndIndex = Math.max(startIndex, endIndex);
  }

  function getSelectionAnchorRect(selection: DiffSelection | null): DOMRect | null {
    if (!selection || !diffContainer) return null;
    const lineEl = diffContainer.querySelector(
      `[data-file-path="${CSS.escape(selection.filePath)}"][data-diff-index="${selection.end}"]`
    ) as HTMLElement | null;
    if (lineEl) return lineEl.getBoundingClientRect();
    return null;
  }

  function getSelectionRect(): DOMRect | null {
    if (typeof window === "undefined") return null;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (range.collapsed) return null;
    const rects = Array.from(range.getClientRects());
    if (rects.length > 0) return rects[0];
    return range.getBoundingClientRect();
  }

  function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }

  function openPermalinkMenuAt(clientX: number, clientY: number) {
    if (!enablePermalinks) return;
    if (!diffContainer) return;
    const rect = diffContainer.getBoundingClientRect();
    const minX = diffContainer.scrollLeft + MENU_PADDING;
    const maxX = Math.max(
      minX,
      diffContainer.scrollLeft + diffContainer.clientWidth - MENU_WIDTH - MENU_PADDING
    );
    const desiredX = clientX - rect.left + diffContainer.scrollLeft;
    permalinkMenuX = clamp(desiredX, minX, maxX);
    permalinkMenuY = Math.max(MENU_PADDING, clientY - rect.top + diffContainer.scrollTop);
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
    let index = 0;
    for (const chunk of file.chunks) {
      if (!("changes" in chunk)) continue;
      for (const change of chunk.changes) {
        if (index >= selection.start && index <= selection.end) {
          lines.push(change.content);
        }
        index += 1;
      }
    }
    return lines.join("\n");
  }

  function getRightAnchorRange(selection: DiffSelection): { start: number; end: number } | null {
    const file = parsed.find((f) => (f.to || f.from || "unknown") === selection.filePath);
    if (!file || !file.chunks) return null;
    const rightLines: number[] = [];
    let index = 0;
    for (const chunk of file.chunks) {
      if (!("changes" in chunk)) continue;
      for (const change of chunk.changes) {
        if (index >= selection.start && index <= selection.end) {
          const lineNumber = getLineNumberForSide(change, "R");
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

    const commitTag = (rootEvent as any)?.tags ? getTagValue(rootEvent as any, "commit") : "";
    const parentCommitTag = (rootEvent as any)?.tags
      ? getTagValue(rootEvent as any, "parent-commit")
      : "";

    if (commitTag) {
      tags.push(["commit", commitTag]);
      const ref = (repo.refs || []).find((r) => r.type === "heads" && r.commitId === commitTag);
      if (ref?.name) tags.push([`refs/heads/${ref.name}`, commitTag]);
    }
    if (parentCommitTag) tags.push(["parent-commit", parentCommitTag]);

    tags.push(["file", selection.filePath]);
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
      const rootRepoAddress =
        repo?.address || ((rootEvent as any)?.tags ? getTagValue(rootEvent as any, "a") : "");
      if (rootRepoAddress) {
        extraTags.push(["repo", rootRepoAddress] as unknown as CommentTag);
      }

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
    {@const filePath = file.to || file.from || "unknown"}
    {@const isExpanded = expandedFiles.has(fileId)}
    <div class="mb-4" id={diffAnchors[filePath] ? `diff-${diffAnchors[filePath]}` : undefined}>
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
                  {@const currentFilePath = filePath}
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
                  {@const chunkOffset = fileChunkOffsets[fileIdx]?.[chunkIdx] ?? 0}
                  {@const lineIndex = chunkOffset + i}
                  {@const isSelected = isLineWithinSelection(currentFilePath, lineIndex)}
                  {@const bgClass = isAdd
                    ? "border-l-4 border-emerald-600 bg-emerald-200/70 dark:bg-emerald-900/50"
                    : isDel
                      ? "border-l-4 border-rose-600 bg-rose-200/70 dark:bg-rose-900/50"
                      : "hover:bg-secondary/50"}

                  <div class="w-full">
                    <div
                      class={`flex group pl-2 pt-1 ${bgClass} w-full ${
                        isSelected ? "diff-line-selected" : ""
                      }`}
                      style="min-width: max-content;"
                      data-diff-index={lineIndex}
                      data-file-path={currentFilePath}
                      data-line-left={leftLine ?? ""}
                      data-line-right={rightLine ?? ""}
                    >
                      <div class="flex shrink-0 text-foreground select-none">
                        {#if showLineNumbers}
                          <span class="w-8 text-right pr-2">
                            <span
                              class="block cursor-pointer"
                              style="touch-action: none;"
                              id={diffAnchors[currentFilePath] && leftLine
                                ? `diff-${diffAnchors[currentFilePath]}L${leftLine}`
                                : undefined}
                            >
                              {leftLine ?? ""}
                            </span>
                          </span>
                          <span class="w-8 text-right pr-2 border-r border-border mr-2">
                            <span
                              class="block cursor-pointer"
                              style="touch-action: none;"
                              id={diffAnchors[currentFilePath] && rightLine
                                ? `diff-${diffAnchors[currentFilePath]}R${rightLine}`
                                : undefined}
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
                        {#if enablePermalinks}
                          <Button
                            variant="ghost"
                            size="icon"
                            onclick={(event) => {
                              event.stopPropagation();
                              selectedFilePath = currentFilePath;
                              selectedStartIndex = lineIndex;
                              selectedEndIndex = lineIndex;
                              openPermalinkMenuAt(event.clientX, event.clientY);
                            }}
                          >
                            <Share class="h-4 w-4" />
                          </Button>
                        {/if}
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
                          <div id={`comment-${c.id}`} data-event={c.id} class="flex gap-2">
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
  {#if enablePermalinks && showPermalinkMenu}
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

<style>
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

  @media (pointer: coarse) {
    :global(.git-diff-view) {
      -webkit-user-select: none;
      user-select: none;
      -webkit-touch-callout: none;
    }
  }
</style>
