<script lang="ts">
  import type { NostrEvent } from "nostr-tools";
  import { nip19 } from "nostr-tools";
  import { ArrowUpRight, FileCode, GitCommit } from "@lucide/svelte";
  import { githubPermalinkDiffId } from "@nostr-git/core/git";
  import { useRegistry } from "../../useRegistry";
  import { toast } from "../../stores/toast";
  import markdownit from "markdown-it";
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

  const { Card, Button } = useRegistry();

  interface Props {
    event: NostrEvent;
    relay?: string;
  }

  let { event, relay }: Props = $props();

  let diffHash = $state("");
  const maxPreviewChars = 1200;
  let isOpening = $state(false);
  let copyState = $state<"idle" | "copied" | "error">("idle");
  let copyTimeout: ReturnType<typeof setTimeout> | null = null;
  let shareState = $state<"idle" | "copied" | "error">("idle");
  let shareTimeout: ReturnType<typeof setTimeout> | null = null;

  const tags = $derived(event.tags || []);
  const getTagValue = (name: string) => tags.find((tag) => tag[0] === name)?.[1] || "";
  const getTag = (name: string) => tags.find((tag) => tag[0] === name);

  const repoAddress = $derived.by(() => getTagValue("a"));
  const repoUrl = $derived.by(() => getTagValue("repo"));
  const commit = $derived.by(() => getTagValue("commit"));
  const parentCommit = $derived.by(() => getTagValue("parent-commit"));
  const filePath = $derived.by(
    () => getTagValue("file") || getTagValue("path") || getTagValue("f")
  );
  const patchId = $derived.by(() => getTagValue("e"));
  const lineStart = $derived.by(() => {
    const tag = getTag("lines");
    const start = Number.parseInt(tag?.[1] || "", 10);
    return Number.isNaN(start) ? null : start;
  });
  const lineEnd = $derived.by(() => {
    const tag = getTag("lines");
    const end = Number.parseInt(tag?.[2] || "", 10);
    return Number.isNaN(end) ? null : end;
  });
  const relayValue = $derived.by(() => {
    if (relay) return relay;
    if (typeof window === "undefined") return null;
    return deriveRelayFromLocation();
  });

  const shareLink = $derived.by(() => {
    if (!event?.id) return "";
    try {
      return nip19.neventEncode({
        id: event.id,
        relays: relayValue ? [relayValue] : [],
        author: event.pubkey,
        kind: event.kind,
      });
    } catch {
      return "";
    }
  });

  const shareTitle = $derived(
    shareState === "copied" ? "Copied" : shareState === "error" ? "Copy failed" : "Share"
  );

  const isDiff = $derived(!!parentCommit);
  // Derive the icon component to use instead of svelte:component
  const IconComponent = $derived(isDiff ? GitCommit : FileCode);
  const kindLabel = $derived(isDiff ? "Diff" : "Code");
  const kindTitle = $derived(isDiff ? "Diff permalink" : "Code permalink");
  const kindIconClass = $derived(isDiff ? "text-amber-500" : "text-blue-500");
  const kindBadgeClass = $derived(
    isDiff
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/20"
      : "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/20"
  );
  const lineLabel = $derived(
    lineStart
      ? lineEnd && lineEnd !== lineStart
        ? `L${lineStart}-L${lineEnd}`
        : `L${lineStart}`
      : ""
  );
  const commitShort = $derived(commit ? commit.slice(0, 8) : "");

  const parseRepoAddress = (address: string) => {
    const parts = address.split(":");
    if (parts.length < 3) return null;
    const [kindStr, pubkey, ...identifierParts] = parts;
    const kind = Number.parseInt(kindStr, 10);
    const identifier = identifierParts.join(":");
    if (!kind || !pubkey || !identifier) return null;
    return { kind, pubkey, identifier };
  };

  const deriveRelayFromLocation = () => {
    if (typeof window === "undefined") return null;
    const match = window.location.pathname.match(/\/spaces\/([^/]+)\//);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  };

  const encodeRelayPath = (value: string) =>
    encodeURIComponent(
      value
        .replace(/^wss:\/\//, "")
        .replace(/^ws:\/\//, "")
        .replace(/\/$/, "")
    );

  $effect(() => {
    if (!isDiff || !filePath || !repoAddress || typeof window === "undefined") {
      diffHash = "";
      return;
    }
    let cancelled = false;
    githubPermalinkDiffId(filePath)
      .then((hash) => {
        if (!cancelled) diffHash = hash;
      })
      .catch(() => {
        if (!cancelled) diffHash = "";
      });
    return () => {
      cancelled = true;
    };
  });

  const repoNaddr = $derived.by(() => {
    if (!repoAddress) return "";
    const parsed = parseRepoAddress(repoAddress);
    if (!parsed) return "";
    try {
      return nip19.naddrEncode({
        kind: parsed.kind,
        pubkey: parsed.pubkey,
        identifier: parsed.identifier,
        relays: [],
      });
    } catch {
      return "";
    }
  });

  const basePath = $derived.by(() => {
    if (!repoNaddr || !relayValue) return "";
    return `/spaces/${encodeRelayPath(relayValue)}/git/${repoNaddr}`;
  });

  const diffAnchor = $derived.by(() => {
    if (!diffHash) return "";
    if (!lineStart) return `#diff-${diffHash}`;
    const range = lineEnd && lineEnd !== lineStart ? `-R${lineEnd}` : "";
    return `#diff-${diffHash}R${lineStart}${range}`;
  });

  const targetHref = $derived.by(() => {
    if (!basePath) return "";
    if (isDiff && filePath && !diffHash) return "";
    const lineAnchor = lineStart ? `#L${lineStart}${lineEnd ? `-L${lineEnd}` : ""}` : "";
    if (isDiff) {
      if (commit) return `${basePath}/commits/${commit}${diffAnchor}`;
      if (patchId) return `${basePath}/patches/${patchId}${diffAnchor}`;
      return `${basePath}${diffAnchor}`;
    }
    if (filePath) {
      return `${basePath}/code?path=${encodeURIComponent(filePath)}${lineAnchor}`;
    }
    if (commit) return `${basePath}/commits/${commit}`;
    if (patchId) return `${basePath}/patches/${patchId}`;
    return basePath;
  });

  const hasLink = $derived(!!targetHref);
  const displayRepo = $derived.by(() => {
    if (repoAddress) return repoAddress.split(":").slice(-1)[0] || repoAddress;
    if (repoUrl) {
      const last = repoUrl.split("/").pop() || repoUrl;
      return last.replace(/\.git$/, "");
    }
    return "";
  });

  const contentPreview = $derived.by(() => {
    const text = event.content || "";
    if (!text) return "";
    if (text.length <= maxPreviewChars) return text;
    const head = text.slice(0, maxPreviewChars);
    const lastNewline = head.lastIndexOf("\n");
    const trimmed = lastNewline > 200 ? head.slice(0, lastNewline) : head;
    return `${trimmed}\n…`;
  });

  const isTruncated = $derived(!!event.content && event.content.length > maxPreviewChars);

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
      svelte: "html",
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
      sql: "sql",
    };
    return langMap[ext || ""] || "plaintext";
  };

  const highlightCode = (content: string, language: string): string => {
    if (!content) return "";
    try {
      if (hljs.getLanguage(language)) {
        return hljs.highlight(content, { language, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(content).value;
    } catch {
      return content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
  };

  const language = $derived(filePath ? getFileLanguage(filePath) : "plaintext");
  const isMarkdown = $derived(language === "markdown");
  const md = markdownit({ html: true, linkify: true, typographer: true });

  type DiffLine = { type: "+" | "-" | " "; content: string; lineNum: number | null };

  const parseDiffLines = (text: string, startLine: number | null): DiffLine[] => {
    const raw = text.split("\n").map((line) => {
      if (line === "…") return { type: " " as const, content: line };
      if (line.startsWith("+")) return { type: "+" as const, content: line.slice(1) };
      if (line.startsWith("-")) return { type: "-" as const, content: line.slice(1) };
      if (line.startsWith(" ")) return { type: " " as const, content: line.slice(1) };
      return { type: " " as const, content: line };
    });
    let oldNum = startLine ?? 1;
    let newNum = startLine ?? 1;
    return raw.map((r) => {
      if (r.content === "…") return { ...r, lineNum: null };
      if (r.type === "+") return { ...r, lineNum: newNum++ };
      if (r.type === "-") return { ...r, lineNum: oldNum++ };
      oldNum++;
      return { ...r, lineNum: newNum++ };
    });
  };

  const diffLines = $derived.by(() => {
    if (!isDiff || !contentPreview) return [];
    return parseDiffLines(contentPreview, lineStart);
  });

  const codeLines = $derived.by(() => {
    if (isDiff || !contentPreview || isMarkdown) return [];
    return contentPreview.split("\n").map((line, i) => ({
      num: (lineStart ?? 1) + i,
      content: line,
    }));
  });

  const getDiffLineClass = (type: "+" | "-" | " ") => {
    switch (type) {
      case "+":
        return "permalink-diff-add";
      case "-":
        return "permalink-diff-del";
      default:
        return "";
    }
  };

  const onOpen = () => {
    isOpening = true;
  };

  const setCopyState = (state: "idle" | "copied" | "error") => {
    copyState = state;
    if (copyTimeout) clearTimeout(copyTimeout);
    if (state !== "idle") {
      copyTimeout = setTimeout(() => {
        copyState = "idle";
      }, 1500);
    }
  };

  const setShareState = (state: "idle" | "copied" | "error") => {
    shareState = state;
    if (shareTimeout) clearTimeout(shareTimeout);
    if (state !== "idle") {
      shareTimeout = setTimeout(() => {
        shareState = "idle";
      }, 1500);
    }
  };

  const copyContent = async () => {
    const text = event.content || "";
    if (!text) return;
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setCopyState("error");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  const copyShareLink = async (event?: MouseEvent) => {
    event?.stopPropagation();
    const link = shareLink;
    if (!link) return;
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setShareState("error");
      toast.push({ message: "Failed to copy to clipboard", timeout: 3000, theme: "error" });
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      setShareState("copied");
      toast.push({ message: "Event Link Copied!", timeout: 2000 });
    } catch {
      setShareState("error");
      toast.push({ message: "Failed to copy to clipboard", timeout: 3000, theme: "error" });
    }
  };
</script>

<Card class="git-card git-permalink-card">
  <div class="flex items-start gap-3">
    <IconComponent
      class={`h-6 w-6 mt-1 ${kindIconClass}`}
    />

    <div class="flex-1 min-w-0">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="text-base font-semibold leading-tight">{kindTitle}</h3>
                <span
                  class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${kindBadgeClass}`}
                >
                  {kindLabel}
                </span>
              </div>
              <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {#if displayRepo}
                  <span class="font-mono">{displayRepo}</span>
                {/if}
                {#if filePath}
                  <span class="font-mono truncate" title={filePath}>{filePath}</span>
                {/if}
                {#if lineLabel}
                  <span class="font-mono">{lineLabel}</span>
                {/if}
                {#if commitShort}
                  <span class="font-mono">{commitShort}</span>
                {/if}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              class="git-share-button shrink-0 w-9 p-0 sm:hidden"
              onclick={(event) => copyShareLink(event)}
              disabled={!shareLink}
              data-stop-tap
              aria-label="Share"
              title={shareTitle}
            >
              <svg
                class="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M12 9C10.3431 9 9 7.65685 9 6C9 4.34315 10.3431 3 12 3C13.6569 3 15 4.34315 15 6C15 7.65685 13.6569 9 12 9Z"
                  stroke="currentColor"
                  stroke-width="1.5"
                ></path>
                <path
                  d="M5.5 21C3.84315 21 2.5 19.6569 2.5 18C2.5 16.3431 3.84315 15 5.5 15C7.15685 15 8.5 16.3431 8.5 18C8.5 19.6569 7.15685 21 5.5 21Z"
                  stroke="currentColor"
                  stroke-width="1.5"
                ></path>
                <path
                  d="M18.5 21C16.8431 21 15.5 19.6569 15.5 18C15.5 16.3431 16.8431 15 18.5 15C20.1569 15 21.5 16.3431 21.5 18C21.5 19.6569 20.1569 21 18.5 21Z"
                  stroke="currentColor"
                  stroke-width="1.5"
                ></path>
                <path
                  d="M20 13C20 10.6106 18.9525 8.46589 17.2916 7M4 13C4 10.6106 5.04752 8.46589 6.70838 7M10 20.748C10.6392 20.9125 11.3094 21 12 21C12.6906 21 13.3608 20.9125 14 20.748"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                ></path>
              </svg>
            </Button>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2 sm:ml-auto">
          {#if hasLink}
            <Button
              variant="outline"
              size="sm"
              class="shrink-0 w-full sm:w-auto"
              href={targetHref}
              onclick={onOpen}
              aria-busy={isOpening}
            >
              {#if isOpening}
                <span class="loading loading-spinner loading-xs" aria-hidden="true"></span>
              {/if}
              Open
              <ArrowUpRight class="h-4 w-4" />
            </Button>
          {/if}
          <Button
            variant="outline"
            size="sm"
            class="git-copy-button shrink-0 w-full sm:w-auto"
            onclick={copyContent}
            disabled={!event.content}
            aria-live="polite"
          >
            {#if copyState === "copied"}
              Copied
            {:else if copyState === "error"}
              Copy failed
            {:else}
              Copy
            {/if}
          </Button>
          <Button
            variant="outline"
            size="sm"
            class="git-share-button hidden shrink-0 w-9 p-0 sm:inline-flex"
            onclick={(event) => copyShareLink(event)}
            disabled={!shareLink}
            data-stop-tap
            aria-label="Share"
            title={shareTitle}
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M12 9C10.3431 9 9 7.65685 9 6C9 4.34315 10.3431 3 12 3C13.6569 3 15 4.34315 15 6C15 7.65685 13.6569 9 12 9Z"
                stroke="currentColor"
                stroke-width="1.5"
              ></path>
              <path
                d="M5.5 21C3.84315 21 2.5 19.6569 2.5 18C2.5 16.3431 3.84315 15 5.5 15C7.15685 15 8.5 16.3431 8.5 18C8.5 19.6569 7.15685 21 5.5 21Z"
                stroke="currentColor"
                stroke-width="1.5"
              ></path>
              <path
                d="M18.5 21C16.8431 21 15.5 19.6569 15.5 18C15.5 16.3431 16.8431 15 18.5 15C20.1569 15 21.5 16.3431 21.5 18C21.5 19.6569 20.1569 21 18.5 21Z"
                stroke="currentColor"
                stroke-width="1.5"
              ></path>
              <path
                d="M20 13C20 10.6106 18.9525 8.46589 17.2916 7M4 13C4 10.6106 5.04752 8.46589 6.70838 7M10 20.748C10.6392 20.9125 11.3094 21 12 21C12.6906 21 13.3608 20.9125 14 20.748"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              ></path>
            </svg>
          </Button>
        </div>
      </div>

      {#if contentPreview}
        <div class="mt-3 rounded border border-border/40 bg-muted/30 overflow-hidden permalink-snippet">
          {#if isDiff && diffLines.length > 0}
            <div class="snippet-lines">
              {#each diffLines as line}<div class="snippet-line {getDiffLineClass(line.type)}"><span class="snippet-num">{line.lineNum ?? ""}</span><span class="snippet-diff-ind">{line.type === " " ? "\u00a0" : line.type}</span><pre class="snippet-code">{@html highlightCode(line.content, language)}</pre></div>{/each}
            </div>
          {:else if isMarkdown}
            <div class="p-3 prose prose-sm dark:prose-invert max-w-none permalink-markdown">
              {@html md.render(contentPreview)}
            </div>
          {:else if codeLines.length > 0}
            <div class="snippet-lines">
              {#each codeLines as line}<div class="snippet-line"><span class="snippet-num">{line.num}</span><pre class="snippet-code">{@html highlightCode(line.content, language)}</pre></div>{/each}
            </div>
          {/if}
          {#if isTruncated}
            <div class="px-3 pb-2 pt-1 text-[11px] text-muted-foreground">Excerpt truncated</div>
          {/if}
        </div>
      {/if}

      {#if !hasLink}
        <div class="mt-2 text-xs text-muted-foreground">
          Missing repository context to build a Budabit link.
        </div>
      {/if}
    </div>
  </div>
</Card>

<style>
  @media (hover: none) {
    :global(.git-share-button:hover) {
      background-color: hsl(var(--background));
      color: inherit;
    }

    :global(.git-copy-button:hover) {
      background-color: hsl(var(--background));
      color: inherit;
    }
  }

  /* oneDark-matched syntax highlighting for snippets */
  :global(.permalink-snippet .hljs) {
    background: transparent !important;
    color: #abb2bf !important;
  }

  :global(.permalink-snippet .hljs-keyword),
  :global(.permalink-snippet .hljs-selector-tag),
  :global(.permalink-snippet .hljs-literal),
  :global(.permalink-snippet .hljs-selector-attr) {
    color: #c678dd;
  }

  :global(.permalink-snippet .hljs-title),
  :global(.permalink-snippet .hljs-title.function_),
  :global(.permalink-snippet .hljs-selector-id) {
    color: #61afef;
  }

  :global(.permalink-snippet .hljs-title.class_),
  :global(.permalink-snippet .hljs-type),
  :global(.permalink-snippet .hljs-built_in),
  :global(.permalink-snippet .hljs-selector-class) {
    color: #e5c07b;
  }

  :global(.permalink-snippet .hljs-string),
  :global(.permalink-snippet .hljs-template-tag) {
    color: #98c379;
  }

  :global(.permalink-snippet .hljs-number),
  :global(.permalink-snippet .hljs-symbol),
  :global(.permalink-snippet .hljs-bullet),
  :global(.permalink-snippet .hljs-attr),
  :global(.permalink-snippet .hljs-attribute),
  :global(.permalink-snippet .hljs-meta) {
    color: #d19a66;
  }

  :global(.permalink-snippet .hljs-variable),
  :global(.permalink-snippet .hljs-template-variable),
  :global(.permalink-snippet .hljs-name),
  :global(.permalink-snippet .hljs-tag),
  :global(.permalink-snippet .hljs-property) {
    color: #e06c75;
  }

  :global(.permalink-snippet .hljs-regexp),
  :global(.permalink-snippet .hljs-selector-pseudo),
  :global(.permalink-snippet .hljs-link) {
    color: #56b6c2;
  }

  :global(.permalink-snippet .hljs-comment),
  :global(.permalink-snippet .hljs-quote) {
    color: #7d8799;
    font-style: italic;
  }

  :global(.permalink-snippet .hljs-section) {
    color: #61afef;
  }

  :global(.permalink-snippet .hljs-meta .hljs-keyword) {
    color: #c678dd;
  }

  :global(.permalink-snippet .hljs-meta .hljs-string) {
    color: #98c379;
  }

  /* Snippet line layout */
  .snippet-lines {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.6875rem;
    padding: 3px 0;
  }

  .snippet-line {
    display: flex;
    align-items: baseline;
    line-height: 1.4;
  }

  .snippet-num {
    flex-shrink: 0;
    min-width: 2.5ch;
    padding: 0 0.5ch;
    text-align: right;
    color: hsl(var(--muted-foreground) / 0.45);
    user-select: none;
  }

  .snippet-diff-ind {
    flex-shrink: 0;
    width: 1.5ch;
    text-align: center;
    user-select: none;
    opacity: 0.5;
  }

  :global(.snippet-code) {
    flex: 1;
    margin: 0 !important;
    padding: 0 0.5ch !important;
    white-space: pre-wrap;
    word-break: break-all;
    font: inherit;
    line-height: inherit;
  }

  :global(.permalink-diff-add) {
    background-color: rgba(34, 197, 94, 0.12);
    border-left: 2px solid rgb(22, 163, 74);
  }

  :global(.permalink-diff-del) {
    background-color: rgba(239, 68, 68, 0.12);
    border-left: 2px solid rgb(220, 38, 38);
  }

  :global(.dark .permalink-diff-add) {
    background-color: rgba(34, 197, 94, 0.15);
    border-left-color: rgb(34, 197, 94);
  }

  :global(.dark .permalink-diff-del) {
    background-color: rgba(239, 68, 68, 0.15);
    border-left-color: rgb(239, 68, 68);
  }
</style>
