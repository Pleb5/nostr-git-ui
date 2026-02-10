<script lang="ts">
  import {
    FileCode,
    Folder,
    Share,
    Download,
    Copy,
    Info,
    MoreVertical,
    ChevronLeft,
  } from "@lucide/svelte";
  import { tick } from "svelte";
  import { useRegistry } from "../../useRegistry.js";
  const { Button, Spinner } = useRegistry();
  import { toast } from "../../stores/toast.js";
  import { toUserMessage } from "../../utils/gitErrorUi";
  import type { FileEntry, PermalinkEvent } from "@nostr-git/core/types";
  import { GIT_PERMALINK } from "@nostr-git/core/types";
  import type { Repo } from "./Repo.svelte";
  import CodeMirror from "svelte-codemirror-editor";
  import { detectFileType, type FileTypeInfo } from "../../utils/fileTypeDetection.js";
  import FileMetadataPanel from "./FileMetadataPanel.svelte";
  import {
    ImageViewer,
    PDFViewer,
    VideoViewer,
    AudioViewer,
    BinaryViewer,
  } from "./viewers/index.js";
  import { lineNumbers } from "@codemirror/view";
  import type { EditorView } from "@codemirror/view";
  import { nip19 } from "nostr-tools";

  const {
    file,
    getFileContent,
    setDirectory,
    repo,
    publish,
    editable,
    autoOpenPath,
    displayMode = "inline",
    onSelectFile,
    onClose,
    showActions = true,
    isActive = false,
  }: {
    file: FileEntry;
    getFileContent: (path: string) => Promise<string>;
    setDirectory: (path: string) => void;
    repo?: Repo;
    publish?: (permalink: PermalinkEvent) => Promise<void>;
    editable?: boolean;
    autoOpenPath?: string;
    displayMode?: "inline" | "list" | "viewer";
    onSelectFile?: (file: FileEntry) => void;
    onClose?: () => void;
    showActions?: boolean;
    isActive?: boolean;
  } = $props();

  const effectiveEditable = $derived.by(() =>
    typeof editable === "boolean" ? editable : (repo?.editable ?? false)
  );

  const pushErrorToast = (title: string, err: unknown, fallback?: string) => {
    const { message, theme } = toUserMessage(err, fallback ?? title);
    toast.push({
      title,
      description: message,
      variant: theme === "warning" ? "default" : "destructive",
    });
  };

  const name = $derived(file.name);
  const type = $derived((file.type ?? "file") as string);
  const path = $derived(file.path);
  const isList = $derived(displayMode === "list");
  const isViewer = $derived(displayMode === "viewer");
  const isInline = $derived(displayMode === "inline");
  const shouldAutoOpen = $derived(!!autoOpenPath && autoOpenPath === path);
  const instanceId = Math.random().toString(36).substring(7);
  let content = $state("");
  let isExpanded = $state(isViewer);
  let isMetadataPanelOpen = $state(false);
  let isLoading = $state(false);
  let showFileMenu = $state(false);

  let fileTypeInfo = $state<FileTypeInfo | null>(null);
  let metadata = $state<Record<string, string>>({});
  let selectedStart: number | null = $state(null);
  let selectedEnd: number | null = $state(null);
  let cmExtensions: any[] = $state([]);
  let showPermalinkMenu = $state(false);
  let editorHost: HTMLElement | null = $state(null);
  // Gutter context menu state (positioned near click)
  let showGutterMenu = $state(false);
  let gutterMenuX = $state(0);
  let gutterMenuY = $state(0);
  let isDraggingSelect = $state(false);
  let isTouchSelecting = $state(false);
  let touchTimer: number | null = $state(null);
  let touchStartX = $state(0);
  let touchStartY = $state(0);
  let touchMoved = $state(false);
  let touchIdentifier = $state<number | null>(null);

  let hasAutoOpened = $state(false);
  let lastAppliedHash = $state<string | null>(null);

  let hasLoadedOnce = false;
  let fileViewElement: HTMLElement | null = $state(null);
  let lastFilePath = $state(path);
  let editorView: EditorView | null = $state(null);

  $effect(() => {
    if (path === lastFilePath) return;
    lastFilePath = path;
    content = "";
    fileTypeInfo = null;
    metadata = {};
    selectedStart = null;
    selectedEnd = null;
    cmExtensions = [];
    showPermalinkMenu = false;
    showGutterMenu = false;
    showFileMenu = false;
    lastAppliedHash = null;
    hasLoadedOnce = false;
  });

  $effect(() => {
    if (isViewer && !isExpanded) {
      isExpanded = true;
    }
  });

  function handleEditorReady(view: EditorView) {
    editorView = view;
  }

  const containerClass = $derived.by(() => {
    if (isList) return "file-view border-b border-border last:border-b-0";
    if (isViewer) return "file-view rounded-lg border border-border";
    return "file-view mb-2 rounded-lg border border-border";
  });

  const headerClass = $derived.by(() => {
    const base =
      "flex items-center justify-between gap-3 px-3 py-2 text-sm sm:text-[0.95rem] transition-colors";
    const interactive = isViewer ? "cursor-default" : "cursor-pointer hover:bg-secondary/30";
    const active = isActive ? "bg-secondary/40" : "";
    return `${base} ${interactive} ${active}`.trim();
  });

  function handleRowActivate() {
    if (isViewer) return;
    if (type === "directory") {
      if (isList) {
        setDirectory(path);
        return;
      }
    }
    if (type === "file" && isList) {
      onSelectFile?.(file);
      return;
    }
    isExpanded = !isExpanded;
  }

  function handleClose(event?: MouseEvent) {
    event?.stopPropagation();
    onClose?.();
  }

  function toggleFileMenu(event?: MouseEvent) {
    event?.stopPropagation();
    showPermalinkMenu = false;
    showGutterMenu = false;
    refreshSelectionFromEditor();
    showFileMenu = !showFileMenu;
  }

  $effect(() => {
    if (isExpanded && type === "file") {
      // Clear selection only when FIRST opening a file, not on every re-render
      if (!hasLoadedOnce) {
        console.log(`[${instanceId}:${path}] file expanded for first time, clearing selection`);
        selectedStart = null;
        selectedEnd = null;
        hasLoadedOnce = true;

        // Scroll to the top of this file view
        if (fileViewElement && !isViewer) {
          fileViewElement.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }

      if (!content) {
        isLoading = true;
        getFileContent(path)
          .then((c) => {
            content = c;
            isLoading = false;

            fileTypeInfo = detectFileType(name, c);
            void loadLanguageExtension(name, fileTypeInfo);
          })
          .catch((error) => {
            pushErrorToast("Failed to load file content", error, "Failed to load file content");
          })
          .finally(() => {
            isLoading = false;
          });
      }
    } else if (isExpanded && type === "directory") {
      content = "";
      setDirectory(path);
    }
  });

  $effect(() => {
    if (!shouldAutoOpen || hasAutoOpened || type !== "file") return;
    if (isList) {
      onSelectFile?.(file);
      hasAutoOpened = true;
      return;
    }
    isExpanded = true;
    hasAutoOpened = true;
  });

  function parseLineHash(hash: string): { start: number; end: number } | null {
    const match = hash.match(/^#L(\d+)(?:-L(\d+))?$/);
    if (!match) return null;
    const start = Number.parseInt(match[1], 10);
    const end = match[2] ? Number.parseInt(match[2], 10) : start;
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    return { start, end };
  }

  function scrollLineIntoView(lineNumber: number) {
    if (!editorHost) return;
    const lines = Array.from(editorHost.querySelectorAll(".cm-line")) as HTMLElement[];
    const idx = lineNumber - 1;
    const lineEl = lines[idx];
    if (!lineEl) return;
    lineEl.scrollIntoView({ block: "center" });
  }

  async function applyHashSelection() {
    if (!shouldAutoOpen || !isExpanded || !editorHost || !content) return;
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash || hash === lastAppliedHash) return;
    const parsed = parseLineHash(hash);
    if (!parsed) return;
    lastAppliedHash = hash;
    await tick();
    selectedStart = parsed.start;
    selectedEnd = parsed.end;
    selectLinesInEditor(parsed.start, parsed.end);
    scrollLineIntoView(parsed.start);
  }

  $effect(() => {
    if (!shouldAutoOpen || !isExpanded || !editorHost || !content) return;
    void applyHashSelection();
  });

  // Update URL hash from current selection when user selects lines
  function syncHashFromSelection() {
    console.log(
      `[${instanceId}:${path}] syncHash called, start=${selectedStart}, end=${selectedEnd}, current hash=${location.hash}`
    );
    if (selectedStart) {
      const hash = `#L${selectedStart}${selectedEnd ? `-L${selectedEnd}` : ""}`;
      if (location.hash !== hash) {
        console.log(`[${instanceId}:${path}] updating hash from ${location.hash} to ${hash}`);
        // Just update the hash directly - simple and works
        location.hash = hash;
        console.log(`[${instanceId}:${path}] hash is now ${location.hash}`);
      }
    }
  }

  // Get line numbers from browser's text selection
  function getLinesFromSelection(): { start: number; end: number } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return null;

    // startContainer/endContainer can be text nodes, so we need to get their parent element
    const getLineElement = (node: Node): HTMLElement | null => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return (node as HTMLElement).closest(".cm-line");
      } else if (node.parentElement) {
        return node.parentElement.closest(".cm-line");
      }
      return null;
    };

    const startLine = getLineElement(range.startContainer);
    const endLine = getLineElement(range.endContainer);

    if (!startLine || !endLine) return null;

    // Get all lines in the editor
    const allLines = Array.from(editorHost!.querySelectorAll(".cm-line")) as HTMLElement[];
    const startIdx = allLines.indexOf(startLine);
    const endIdx = allLines.indexOf(endLine);

    if (startIdx === -1 || endIdx === -1) return null;

    // Convert to 1-based line numbers
    return {
      start: Math.min(startIdx, endIdx) + 1,
      end: Math.max(startIdx, endIdx) + 1,
    };
  }

  function getLinesFromEditorSelection(): { start: number; end: number } | null {
    if (!editorView) return null;
    const selection = editorView.state.selection.main;
    if (!selection || selection.empty) return null;
    const startLine = editorView.state.doc.lineAt(selection.from).number;
    const endLine = editorView.state.doc.lineAt(selection.to).number;
    return {
      start: Math.min(startLine, endLine),
      end: Math.max(startLine, endLine),
    };
  }

  function refreshSelectionFromEditor(): boolean {
    const lines = getLinesFromEditorSelection() || getLinesFromSelection();
    if (!lines) return false;
    selectedStart = lines.start;
    selectedEnd = lines.end;
    return true;
  }

  // Select lines in the CodeMirror editor
  function selectLinesInEditor(startLine: number, endLine: number) {
    if (!editorHost) return;

    const lines = Array.from(editorHost.querySelectorAll(".cm-line")) as HTMLElement[];
    if (lines.length === 0) return;

    // Ensure start <= end
    const start = Math.min(startLine, endLine);
    const end = Math.max(startLine, endLine);

    // Convert to 0-based indices
    const startIdx = start - 1;
    const endIdx = end - 1;

    if (startIdx < 0 || endIdx >= lines.length) return;

    const startLineEl = lines[startIdx];
    const endLineEl = lines[endIdx];

    if (!startLineEl || !endLineEl) return;

    // Create a range and select it
    const range = document.createRange();
    range.setStart(startLineEl, 0);
    range.setEnd(endLineEl, endLineEl.childNodes.length);

    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  $effect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Check if click is inside any menu popup
      const inMenu =
        target.closest?.(".permalink-menu-popup") || target.closest?.(".file-actions-menu");

      // Close menus if clicking outside
      if (!inMenu) {
        showPermalinkMenu = false;
        showGutterMenu = false;
        showFileMenu = false;
      }
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  });

  $effect(() => {
    if (typeof window === "undefined") return;
    const handler = () => void applyHashSelection();
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  });

  // Watch for text selection changes in the editor
  $effect(() => {
    if (!editorHost) return;
    const editor = editorHost; // Capture for closure

    const handleSelectionChange = () => {
      // Only process if the selection is within our editor
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);
      const startNode = range.startContainer;
      const endNode = range.endContainer;

      // Check if selection is within our editor
      if (!editor.contains(startNode) || !editor.contains(endNode)) return;

      // Get the selected lines
      const lines = getLinesFromEditorSelection() || getLinesFromSelection();
      if (lines) {
        selectedStart = lines.start;
        selectedEnd = lines.end;
        syncHashFromSelection();
      }
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  });

  // Capture gutter interactions from CodeMirror reliably
  $effect(() => {
    if (!editorHost) return;
    const getLineFromGutter = (el: HTMLElement | null) => {
      const text = el?.textContent || "";
      const n = parseInt(text.trim(), 10);
      return isNaN(n) ? null : n;
    };

    const handleClickOrContext = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      const gutterEl = el?.closest?.(".cm-gutterElement") as HTMLElement | null;
      if (!gutterEl) return;

      const n = getLineFromGutter(gutterEl);
      if (n == null) return;

      // On left-click: just update selection, don't open menu
      if (e.type === "click") {
        console.log(
          `[${instanceId}:${path}] click line ${n}, shift=${(e as MouseEvent).shiftKey}, current start=${selectedStart}`
        );
        if ((e as MouseEvent).shiftKey && selectedStart) {
          // Extend selection: keep start, set end
          selectedEnd = n;
          console.log(
            `[${instanceId}:${path}] after shift-click: start=${selectedStart}, end=${selectedEnd}`
          );

          // Select the text in the editor
          selectLinesInEditor(selectedStart, selectedEnd);
        } else {
          // New selection: set start, clear end
          selectedStart = n;
          selectedEnd = null;
          console.log(
            `[${instanceId}:${path}] after click: start=${selectedStart}, end=${selectedEnd}`
          );
        }
        syncHashFromSelection();
        return;
      }

      // On right-click: open menu with current selection (or set to clicked line)
      if (e.type === "contextmenu") {
        e.preventDefault();

        const selection = getLinesFromEditorSelection() || getLinesFromSelection();
        if (selection) {
          selectedStart = selection.start;
          selectedEnd = selection.end;
          syncHashFromSelection();
        } else if (!selectedStart) {
          // If no selection exists, select the clicked line
          selectedStart = n;
          selectedEnd = null;
          syncHashFromSelection();
        }

        // Open menu at mouse position
        const rect = editorHost!.getBoundingClientRect();
        gutterMenuX = Math.max(8, e.clientX - rect.left + editorHost!.scrollLeft);
        gutterMenuY = Math.max(8, e.clientY - rect.top + editorHost!.scrollTop);
        showPermalinkMenu = false;
        showGutterMenu = true;
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      const gutterEl = el?.closest?.(".cm-gutterElement") as HTMLElement | null;
      // Allow starting selection from gutter or content
      if (!gutterEl && !el.closest?.(".cm-content")) return;
      const n = gutterEl ? getLineFromGutter(gutterEl) : null;
      if (n == null && gutterEl) return; // Gutter click but no line number
      if (n != null) {
        // Mark that we're potentially starting a drag, but don't change selection yet
        // The click handler will handle selection for simple clicks
        isDraggingSelect = true;
        showGutterMenu = false;
        if (gutterEl) e.preventDefault();
      }
    };
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingSelect) return;
      const el = e.target as HTMLElement;
      const gutterEl = el?.closest?.(".cm-gutterElement") as HTMLElement | null;
      const n = getLineFromGutter(gutterEl);
      if (n != null) {
        selectedEnd = n;
      }
      // Update hash during drag so user sees the range
      if (selectedStart && selectedEnd) {
        syncHashFromSelection();
      }
    };
    const handleMouseUp = (e: MouseEvent) => {
      if (isDraggingSelect) {
        isDraggingSelect = false;
        syncHashFromSelection();
        // Don't open menu on mouseup - wait for contextmenu
      }
    };

    const clearTouchTimer = () => {
      if (touchTimer) {
        window.clearTimeout(touchTimer);
        touchTimer = null;
      }
    };

    const openGutterMenuAt = (clientX: number, clientY: number) => {
      const rect = editorHost!.getBoundingClientRect();
      gutterMenuX = Math.max(8, clientX - rect.left + editorHost!.scrollLeft);
      gutterMenuY = Math.max(8, clientY - rect.top + editorHost!.scrollTop);
      showPermalinkMenu = false;
      showGutterMenu = true;
      isTouchSelecting = false;
      touchIdentifier = null;
      clearTouchTimer();
    };

    const handleTouchStart = (e: TouchEvent) => {
      const el = e.target as HTMLElement;
      const gutterEl = el?.closest?.(".cm-gutterElement") as HTMLElement | null;
      if (!gutterEl) return;

      const n = getLineFromGutter(gutterEl);
      if (n == null) return;

      const touch = e.changedTouches[0];
      if (!touch) return;

      touchIdentifier = touch.identifier;
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchMoved = false;

      selectedStart = n;
      selectedEnd = null;
      isTouchSelecting = true;
      showGutterMenu = false;
      showPermalinkMenu = false;
      syncHashFromSelection();

      clearTouchTimer();
      touchTimer = window.setTimeout(() => {
        if (!touchMoved) {
          openGutterMenuAt(touchStartX, touchStartY);
        }
      }, 500);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isTouchSelecting) return;
      const touch = Array.from(e.changedTouches).find((t) => t.identifier === touchIdentifier);
      if (!touch) return;

      e.preventDefault();

      const dx = touch.clientX - touchStartX;
      const dy = touch.clientY - touchStartY;
      if (Math.hypot(dx, dy) > 6) {
        touchMoved = true;
        clearTouchTimer();
      }

      const target = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null;
      const gutterEl = target?.closest?.(".cm-gutterElement") as HTMLElement | null;
      const n = getLineFromGutter(gutterEl);
      if (n == null || !selectedStart) return;

      if (n !== selectedStart && !touchMoved) {
        touchMoved = true;
        clearTouchTimer();
      }

      selectedEnd = n;
      selectLinesInEditor(selectedStart, selectedEnd);
      syncHashFromSelection();
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!isTouchSelecting) return;
      const touch = Array.from(e.changedTouches).find((t) => t.identifier === touchIdentifier);
      if (!touch) return;

      clearTouchTimer();
      isTouchSelecting = false;
      touchIdentifier = null;
    };

    const handleContentContextMenu = (e: MouseEvent) => {
      // Check if this is a right-click on selected text in content
      const el = e.target as HTMLElement;
      if (!el.closest?.(".cm-content")) return;

      const lines = getLinesFromEditorSelection() || getLinesFromSelection();
      if (!lines) return;
      e.preventDefault();
      selectedStart = lines.start;
      selectedEnd = lines.end;
      syncHashFromSelection();
      const rect = editorHost!.getBoundingClientRect();
      gutterMenuX = Math.max(8, e.clientX - rect.left + editorHost!.scrollLeft);
      gutterMenuY = Math.max(8, e.clientY - rect.top + editorHost!.scrollTop);
      showPermalinkMenu = false;
      showGutterMenu = true;
    };

    editorHost.addEventListener("click", handleClickOrContext, { capture: true } as any);
    editorHost.addEventListener("contextmenu", handleClickOrContext, { capture: true } as any);
    editorHost.addEventListener("contextmenu", handleContentContextMenu, { capture: true } as any);
    editorHost.addEventListener("mousedown", handleMouseDown, { capture: true } as any);
    editorHost.addEventListener("touchstart", handleTouchStart, {
      capture: true,
      passive: true,
    } as any);
    editorHost.addEventListener("touchmove", handleTouchMove, {
      capture: true,
      passive: false,
    } as any);
    editorHost.addEventListener("touchend", handleTouchEnd, { capture: true } as any);
    editorHost.addEventListener("touchcancel", handleTouchEnd, { capture: true } as any);
    window.addEventListener("mousemove", handleMouseMove, { capture: true } as any);
    window.addEventListener("mouseup", handleMouseUp, { capture: true } as any);
    return () => {
      editorHost?.removeEventListener("click", handleClickOrContext, { capture: true } as any);
      editorHost?.removeEventListener("contextmenu", handleClickOrContext, {
        capture: true,
      } as any);
      editorHost?.removeEventListener("contextmenu", handleContentContextMenu, {
        capture: true,
      } as any);
      editorHost?.removeEventListener("mousedown", handleMouseDown, { capture: true } as any);
      editorHost?.removeEventListener("touchstart", handleTouchStart, { capture: true } as any);
      editorHost?.removeEventListener("touchmove", handleTouchMove, { capture: true } as any);
      editorHost?.removeEventListener("touchend", handleTouchEnd, { capture: true } as any);
      editorHost?.removeEventListener("touchcancel", handleTouchEnd, { capture: true } as any);
      window.removeEventListener("mousemove", handleMouseMove, { capture: true } as any);
      window.removeEventListener("mouseup", handleMouseUp, { capture: true } as any);
    };
  });

  async function copyContent(event: MouseEvent | undefined) {
    event?.stopPropagation();
    try {
      if (!content) {
        content = await getFileContent(path);
      }

      if (fileTypeInfo?.category === "binary") {
        toast.push({
          title: "Cannot copy binary file",
          description: "Binary files cannot be copied to clipboard. Use download instead.",
          variant: "destructive",
        });
        return;
      }

      navigator.clipboard.writeText(content);
      toast.push({
        title: "Copied to clipboard",
        description: `${name} content has been copied to your clipboard.`,
      });
    } catch (e) {
      pushErrorToast("Failed to copy", e, "Could not copy the content to clipboard.");
    }
  }

  async function downloadFile(event: MouseEvent | undefined) {
    event?.stopPropagation();
    try {
      if (!content) {
        content = await getFileContent(path);
      }

      // Use application/octet-stream for binary files to prevent extension changes
      const mimeType = fileTypeInfo?.mimeType || "application/octet-stream";
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name; // Use the original filename with its extension
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      pushErrorToast("Download failed", e, "Failed to download file.");
    }
  }

  function parseRepoAddress(address: string) {
    const parts = address.split(":");
    if (parts.length < 3) return null;
    const [kindStr, pubkey, ...identifierParts] = parts;
    const kind = Number.parseInt(kindStr, 10);
    const identifier = identifierParts.join(":");
    if (!kind || !pubkey || !identifier) return null;
    return { kind, pubkey, identifier };
  }

  function deriveRelayFromLocation() {
    if (typeof window === "undefined") return null;
    const match = window.location.pathname.match(/\/spaces\/([^/]+)\//);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function deriveBasePath() {
    if (typeof window === "undefined") return "";
    const repoAddress = repo?.address || "";
    let repoNaddr = "";
    if (repoAddress) {
      const parsed = parseRepoAddress(repoAddress);
      if (parsed) {
        try {
          repoNaddr = nip19.naddrEncode({
            kind: parsed.kind,
            pubkey: parsed.pubkey,
            identifier: parsed.identifier,
            relays: [],
          });
        } catch {
          repoNaddr = "";
        }
      }
    }
    const relayValue = deriveRelayFromLocation();
    if (repoNaddr && relayValue) {
      return `/spaces/${encodeURIComponent(relayValue)}/git/${repoNaddr}`;
    }
    const match = window.location.pathname.match(/\/spaces\/[^/]+\/git\/[^/]+/);
    return match ? match[0] : "";
  }

  function shareLink(event?: MouseEvent) {
    event?.stopPropagation();
    const hash = selectedStart ? `#L${selectedStart}${selectedEnd ? `-L${selectedEnd}` : ""}` : "";
    const basePath = deriveBasePath();
    if (!basePath || !path) {
      toast.push({
        title: "Link unavailable",
        description: "Could not build a permalink for this file.",
        variant: "destructive",
      });
      return;
    }
    const shareUrl = `${location.origin}${basePath}/code?path=${encodeURIComponent(path)}${hash}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(shareUrl);
      toast.push({
        title: "Link copied",
        description: "Permalink copied to clipboard.",
      });
    } else {
      toast.push({
        title: "Error",
        description: "Clipboard not available",
        variant: "destructive",
      });
    }
  }

  async function showMetadata(event?: MouseEvent) {
    event?.stopPropagation();

    // Ensure fileTypeInfo is populated
    if (!fileTypeInfo) {
      // If content is already loaded, detect type from it
      if (content) {
        fileTypeInfo = detectFileType(name, content);
      } else {
        // Otherwise, detect from filename only
        fileTypeInfo = detectFileType(name, "");
      }
    }

    isMetadataPanelOpen = true;
  }

  function togglePermalinkMenu(event?: MouseEvent) {
    event?.stopPropagation();
    showGutterMenu = false;
    showFileMenu = false;
    refreshSelectionFromEditor();
    showPermalinkMenu = !showPermalinkMenu;
  }

  async function loadLanguageExtension(filename: string, info: FileTypeInfo | null) {
    try {
      const ext = (filename.split(".").pop() || "").toLowerCase();
      let mod: any | null = null;
      switch (ext) {
        case "ts":
        case "tsx":
        case "js":
        case "jsx":
          mod = await import("@codemirror/lang-javascript");
          cmExtensions = [mod.javascript({ jsx: true, typescript: ext.startsWith("ts") })];
          break;
        case "json":
          mod = await import("@codemirror/lang-json");
          cmExtensions = [mod.json()];
          break;
        case "css":
        case "scss":
        case "less":
          mod = await import("@codemirror/lang-css");
          cmExtensions = [mod.css()];
          break;
        case "html":
        case "svelte":
          mod = await import("@codemirror/lang-html");
          cmExtensions = [mod.html()];
          break;
        case "md":
        case "markdown":
          mod = await import("@codemirror/lang-markdown");
          cmExtensions = [mod.markdown()];
          break;
        case "py":
          mod = await import("@codemirror/lang-python");
          cmExtensions = [mod.python()];
          break;
        case "rs":
          mod = await import("@codemirror/lang-rust");
          cmExtensions = [mod.rust()];
          break;
        case "go":
          mod = await import("@codemirror/lang-go");
          cmExtensions = [mod.go()];
          break;
        case "java":
          mod = await import("@codemirror/lang-java");
          cmExtensions = [mod.java()];
          break;
        case "c":
        case "h":
        case "cc":
        case "cpp":
        case "cxx":
        case "hpp":
        case "hh":
          mod = await import("@codemirror/lang-cpp");
          cmExtensions = [mod.cpp()];
          break;
        case "yml":
        case "yaml":
          mod = await import("@codemirror/lang-yaml");
          cmExtensions = [mod.yaml()];
          break;
        // removed unsupported dynamic imports (toml, shell)
        case "sql":
          mod = await import("@codemirror/lang-sql");
          cmExtensions = [mod.sql()];
          break;
        case "xml":
          mod = await import("@codemirror/lang-xml");
          cmExtensions = [mod.xml()];
          break;
        default:
          cmExtensions = [];
      }
    } catch (e) {
      console.warn("Failed to load language extension", e);
      cmExtensions = [];
    }
    // Ensure line numbers are shown for code files
    try {
      const hasLineNumbers = (cmExtensions || []).some((e: any) =>
        String(e ?? "").includes("lineNumbers")
      );
      if (!hasLineNumbers) {
        cmExtensions = [...cmExtensions, lineNumbers()];
      }
    } catch {}
  }

  function getSelectedContent(source: string) {
    if (!selectedStart) return source;
    const lines = source.split("\n");
    const start = Math.max(1, selectedStart);
    const end = selectedEnd ? Math.max(start, selectedEnd) : start;
    return lines.slice(start - 1, end).join("\n");
  }

  function buildPermalinkEvent(): PermalinkEvent | null {
    try {
      if (!path) return null;
      if (!repo) return null;
      const tags: string[][] = [];
      // Extract current commit and branch
      let commit = "";
      let branch = "";
      try {
        branch = (repo.selectedBranch || repo.mainBranch || "").split("/").pop() || "";
        const hit = (repo.refs || []).find((r) => r.type === "heads" && r.name === branch);
        commit = hit?.commitId || "";
      } catch {}
      if (repo.address) tags.push(["a", repo.address]);
      const repoUrl = (repo.web && repo.web[0]) || (repo.clone && repo.clone[0]) || "";
      if (repoUrl) tags.push(["repo", repoUrl]);
      if (commit) {
        if (branch) tags.push([`refs/heads/${branch}`, commit]);
        tags.push(["commit", commit]);
      }
      tags.push(["file", path]);
      if (selectedStart) {
        if (selectedEnd) tags.push(["lines", String(selectedStart), String(selectedEnd)]);
        else tags.push(["lines", String(selectedStart)]);
      }
      if (fileTypeInfo?.language) tags.push(["l", String(fileTypeInfo.language)]);
      const evt: PermalinkEvent = {
        kind: GIT_PERMALINK,
        content: getSelectedContent(content || ""),
        tags,
        pubkey: "",
        created_at: Math.floor(Date.now() / 1000),
        id: "",
        sig: "",
      };
      return evt;
    } catch (e) {
      console.warn("Failed to build permalink event", e);
      return null;
    }
  }

  async function createPermalink(event?: MouseEvent) {
    event?.stopPropagation();
    refreshSelectionFromEditor();
    showPermalinkMenu = false;
    showGutterMenu = false;

    const evt = buildPermalinkEvent();
    if (!evt) {
      const missing = !repo ? "repo context" : "file path";
      toast.push({
        title: "Cannot create permalink",
        description: `Missing ${missing}`,
        variant: "destructive",
      });
      return;
    }

    // Show immediate feedback
    toast.push({ title: "Creating permalink...", description: "Publishing to relays" });

    try {
      if (publish) {
        await publish(evt);
        toast.push({
          title: "Permalink published",
          description: "Permalink published successfully",
        });
        console.log("Permalink published successfully", evt);
      } else {
        await navigator.clipboard.writeText(JSON.stringify(evt));
        toast.push({ title: "Permalink copied", description: "JSON copied to clipboard" });
        console.log("Permalink copied to clipboard", evt);
      }
    } catch (e: any) {
      console.error("Failed to create permalink", e);
      pushErrorToast("Permalink failed", e, "Failed to create permalink.");
    }
  }

  function copyLinkToLines(event?: MouseEvent) {
    event?.stopPropagation();
    refreshSelectionFromEditor();
    showPermalinkMenu = false;
    showGutterMenu = false;
    shareLink();
  }

  function getFileIcon() {
    if (type === "directory") return Folder;
    if (fileTypeInfo?.icon) {
      const iconMap: Record<string, any> = {
        Image: FileCode,
        FileText: FileCode,
        Settings: FileCode,
        Container: FileCode,
        Hammer: FileCode,
        BookOpen: FileCode,
        Scale: FileCode,
        Braces: FileCode,
        Code2: FileCode,
        Terminal: FileCode,
        Binary: FileCode,
        Archive: FileCode,
        Video: FileCode,
        Music: FileCode,
      };
      return iconMap[fileTypeInfo.icon] || FileCode;
    }
    return FileCode;
  }
</script>

<div class={containerClass} bind:this={fileViewElement}>
  <div
    role={isViewer ? "group" : "button"}
    tabindex={isViewer ? undefined : 0}
    class={headerClass}
    onclick={handleRowActivate}
    onkeydown={(e) => {
      if (isViewer) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleRowActivate();
      }
    }}
    aria-expanded={isInline && type === "file" ? isExpanded : undefined}
  >
    <div class="flex items-center gap-2 min-w-0 flex-1">
      {#if isViewer && onClose}
        <Button variant="ghost" size="sm" class="h-8 w-8 p-0" title="Back" onclick={handleClose}>
          <ChevronLeft class="h-4 w-4" />
        </Button>
      {/if}
      {#if type === "directory"}
        <Folder class="h-4 w-4 flex-shrink-0" style="color: hsl(var(--muted-foreground));" />
      {:else}
        {@const IconComponent = getFileIcon()}
        <IconComponent class="h-4 w-4 flex-shrink-0" style="color: hsl(var(--muted-foreground));" />
      {/if}
      <span class="truncate" title={name}>{name}</span>
      {#if fileTypeInfo && type === "file"}
        <span
          class="ml-2 hidden sm:inline-flex px-2 py-0.5 text-xs bg-muted/50 text-muted-foreground rounded"
        >
          {fileTypeInfo.category}
        </span>
      {/if}
    </div>
    {#if type === "file" && showActions}
      <div class="hidden sm:flex items-center gap-2">
        <Button variant="ghost" size="sm" class="h-8 w-8 p-0" onclick={showMetadata}>
          <Info class="h-4 w-4" />
        </Button>
        <div class="relative" data-permalink-menu>
          <Button
            variant="ghost"
            size="sm"
            class="h-8 w-8 p-0"
            onclick={togglePermalinkMenu}
            title="Permalink actions"
          >
            <Share class="h-4 w-4" />
          </Button>
          {#if showPermalinkMenu}
            <div
              class="permalink-menu-popup absolute right-0 mt-1 z-10 w-44 rounded border bg-popover text-popover-foreground shadow-md"
              style="border-color: hsl(var(--border));"
            >
              <button
                class="w-full text-left px-3 py-2 hover:bg-secondary/50"
                onclick={copyLinkToLines}
                >Copy link to {selectedStart
                  ? selectedEnd
                    ? `lines ${selectedStart}-${selectedEnd}`
                    : `line ${selectedStart}`
                  : "file"}</button
              >
              <button
                class="w-full text-left px-3 py-2 hover:bg-secondary/50"
                onclick={createPermalink}>Create permalink</button
              >
            </div>
          {/if}
        </div>
        <Button variant="ghost" size="sm" class="h-8 w-8 p-0" onclick={downloadFile}>
          <Download class="h-4 w-4" />
        </Button>
        {#if fileTypeInfo?.canEdit !== false}
          <Button variant="ghost" size="sm" class="h-8 w-8 p-0" onclick={copyContent}>
            <Copy class="h-4 w-4" />
          </Button>
        {/if}
      </div>
      <div class="relative sm:hidden">
        <Button
          variant="ghost"
          size="sm"
          class="h-8 w-8 p-0"
          onclick={toggleFileMenu}
          title="File actions"
        >
          <MoreVertical class="h-4 w-4" />
        </Button>
        {#if showFileMenu}
          <div
            class="file-actions-menu absolute right-0 mt-1 z-10 w-48 rounded border bg-popover text-popover-foreground shadow-md"
            style="border-color: hsl(var(--border));"
          >
            <button
              class="w-full text-left px-3 py-2 text-sm hover:bg-secondary/50"
              onclick={(event) => {
                event.stopPropagation();
                showMetadata(event);
                showFileMenu = false;
              }}
            >
              File info
            </button>
            <button
              class="w-full text-left px-3 py-2 text-sm hover:bg-secondary/50"
              onclick={(event) => {
                event.stopPropagation();
                copyLinkToLines(event);
                showFileMenu = false;
              }}
            >
              Copy link
            </button>
            <button
              class="w-full text-left px-3 py-2 text-sm hover:bg-secondary/50"
              onclick={(event) => {
                event.stopPropagation();
                createPermalink(event);
                showFileMenu = false;
              }}
            >
              Create permalink
            </button>
            <button
              class="w-full text-left px-3 py-2 text-sm hover:bg-secondary/50"
              onclick={(event) => {
                event.stopPropagation();
                downloadFile(event);
                showFileMenu = false;
              }}
            >
              Download
            </button>
            {#if fileTypeInfo?.canEdit !== false}
              <button
                class="w-full text-left px-3 py-2 text-sm hover:bg-secondary/50"
                onclick={(event) => {
                  event.stopPropagation();
                  copyContent(event);
                  showFileMenu = false;
                }}
              >
                Copy contents
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if isExpanded && type === "file" && !isList}
    <div class="border-t" style="border-color: hsl(var(--border));">
      {#if isLoading}
        <div class="p-3 sm:p-4">
          <Spinner>Fetching content...</Spinner>
        </div>
      {:else if content}
        {#if fileTypeInfo?.category === "image"}
          <div class="p-3 sm:p-4">
            <ImageViewer content={content} filename={name} mimeType={fileTypeInfo.mimeType} />
          </div>
        {:else if fileTypeInfo?.category === "pdf"}
          <div class="p-3 sm:p-4">
            <PDFViewer content={content} filename={name} />
          </div>
        {:else if fileTypeInfo?.category === "video"}
          <div class="p-3 sm:p-4">
            <VideoViewer content={content} filename={name} mimeType={fileTypeInfo.mimeType} />
          </div>
        {:else if fileTypeInfo?.category === "audio"}
          <div class="p-3 sm:p-4">
            <AudioViewer content={content} filename={name} mimeType={fileTypeInfo.mimeType} />
          </div>
        {:else if fileTypeInfo?.category === "binary" || fileTypeInfo?.category === "archive"}
          <div class="p-3 sm:p-4">
            <BinaryViewer content={content} filename={name} />
          </div>
        {:else}
          <div class="p-3 sm:p-4 border-t" style="border-color: hsl(var(--border));">
            <div
              class="relative bg-background text-foreground rounded border"
              style="border-color: hsl(var(--border));"
              bind:this={editorHost}
              role="group"
              data-permalink-menu
            >
              <CodeMirror
                bind:value={content}
                extensions={cmExtensions.length ? cmExtensions : [lineNumbers()]}
                onready={handleEditorReady}
              />
              {#if showGutterMenu}
                <div
                  class="permalink-menu-popup absolute z-20 w-44 rounded border bg-popover text-popover-foreground shadow-md"
                  style="left: {gutterMenuX}px; top: {gutterMenuY}px; border-color: hsl(var(--border));"
                >
                  <button
                    class="w-full text-left px-3 py-2 hover:bg-secondary/50"
                    onclick={copyLinkToLines}
                  >
                    Copy link to {selectedStart
                      ? selectedEnd
                        ? `lines ${selectedStart}-${selectedEnd}`
                        : `line ${selectedStart}`
                      : "file"}
                  </button>
                  <button
                    class="w-full text-left px-3 py-2 hover:bg-secondary/50"
                    onclick={createPermalink}>Create permalink</button
                  >
                </div>
              {/if}
            </div>
          </div>
        {/if}
      {:else}
        <div class="p-3 sm:p-4">
          <div class="text-center text-muted-foreground py-8">No content available</div>
        </div>
      {/if}
    </div>
  {/if}

  <FileMetadataPanel
    bind:isOpen={isMetadataPanelOpen}
    file={file}
    content={content}
    typeInfo={fileTypeInfo}
    metadata={metadata}
  />
</div>

<style>
  /* Ensure CodeMirror has proper contrast */
  :global(.file-view .cm-editor) {
    background-color: hsl(var(--background)) !important;
    color: hsl(var(--foreground)) !important;
    font-size: 0.875rem;
    line-height: 1.5;
    max-width: 100%;
  }

  :global(.file-view .cm-scroller) {
    overflow-x: auto;
  }

  :global(.file-view .cm-gutters) {
    background-color: hsl(var(--muted)) !important;
    color: hsl(var(--muted-foreground)) !important;
    border-right: 1px solid hsl(var(--border)) !important;
  }

  :global(.file-view .cm-activeLineGutter) {
    background-color: hsl(var(--accent)) !important;
  }

  :global(.file-view .cm-line) {
    color: hsl(var(--foreground)) !important;
  }

  :global(.file-view .cm-content) {
    caret-color: hsl(var(--foreground)) !important;
  }

  @media (min-width: 768px) {
    :global(.file-view .cm-editor) {
      font-size: 0.9rem;
    }
  }
</style>
