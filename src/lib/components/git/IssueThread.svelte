<script lang="ts">
  import TimeAgo from "../../TimeAgo.svelte";
  import { MessageSquare } from "@lucide/svelte";
  import { nip19 } from "nostr-tools";
  import { createCommentEvent, parseCommentEvent } from "@nostr-git/core/events";
  import type { CommentEvent, CommentTag, Profile } from "@nostr-git/core/events";
  import { useRegistry } from "../../useRegistry";
  import { tick } from "svelte";
  import { slide } from "svelte/transition";
  import RichText from "../RichText.svelte";
  import { toast } from "../../stores/toast";
  const { Button, Textarea, Card, ProfileComponent, Markdown } = useRegistry();

  interface Props {
    issueId: string;
    issueKind: "1621" | "1617" | "1618";
    currentCommenter: string;
    currentCommenterProfile?: Profile;
    comments?: CommentEvent[] | undefined;
    commenterProfiles?: Profile[] | undefined;
    onCommentCreated: (comment: CommentEvent) => Promise<void>;
    relays?: string[];
    repoAddress?: string;
  }

  const {
    issueId,
    issueKind = "1621",
    comments = [],
    currentCommenter,
    onCommentCreated,
    relays = [],
    repoAddress = "",
  }: Props = $props();

  let newComment = $state("");

  const commentsParsed = $derived.by(() => {
    return comments
      .filter((c) => c.tags.some((t) => t[0] === "E" && t[1] === issueId))
      .map((c) => parseCommentEvent(c));
  });

  const getEventLink = (event: CommentEvent) => {
    try {
      const relayHints = (relays || []).filter(Boolean);
      return nip19.neventEncode({
        id: event.id,
        relays: relayHints,
        author: event.pubkey,
        kind: event.kind,
      });
    } catch (error) {
      console.warn("Failed to encode event link:", error);
      return "";
    }
  };

  const copyEventLink = async (event: CommentEvent) => {
    if (!event?.id) return;
    const link = getEventLink(event);

    if (!link) {
      toast.push({
        message: "Failed to copy to clipboard",
        timeout: 3000,
        theme: "error",
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(link);
      toast.push({
        message: "Copied to clipboard!",
        timeout: 2000,
      });
    } catch (error) {
      console.error("Failed to copy event link:", error);
      toast.push({
        message: "Failed to copy to clipboard",
        timeout: 3000,
        theme: "error",
      });
    }
  };

  const scrollToCommentHash = async () => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash || "";
    if (!hash.startsWith("#comment-")) return;
    const targetId = hash.slice(1);
    await tick();
    const el = document.getElementById(targetId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  $effect(() => {
    commentsParsed.length;
    void scrollToCommentHash();
  });

  $effect(() => {
    if (typeof window === "undefined") return;
    const handler = () => void scrollToCommentHash();
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  });

  function submit(event: Event) {
    event.preventDefault();
    if (!newComment.trim()) return;

    const extraTags: CommentTag[] = [];
    if (repoAddress) {
      extraTags.push(["repo", repoAddress] as unknown as CommentTag);
    }

    const commentEvent = createCommentEvent({
      content: newComment,
      root: {
        type: "E",
        value: issueId,
        kind: issueKind,
      },
      extraTags,
    });

    newComment = "";

    onCommentCreated(commentEvent);
  }
</script>

<div transition:slide>
  <Card class="p-2 border-none shadow-none">
    <div class="space-y-4">
      {#each commentsParsed as c (c.id)}
        {@const origTag = c.raw.tags.find((t) => t[0] === "original_date")}
        {@const origSec = origTag?.[1] != null ? parseInt(origTag[1], 10) : NaN}
        {@const dateToShow = !Number.isNaN(origSec)
          ? new Date(origSec * 1000).toISOString()
          : c.createdAt}
        <div
          id={`comment-${c.id}`}
          data-event={c.id}
          class="w-full mt-4 flex-col gap-3 group animate-fade-in"
        >
          <div class="w-full grid grid-cols-[1fr_auto] items-start gap-2">
            <ProfileComponent pubkey={c.author.pubkey} hideDetails={false}></ProfileComponent>
            <div class="flex items-center gap-2 text-sm text-muted-foreground">
              <TimeAgo date={dateToShow} />
              <Button
                variant="ghost"
                size="icon"
                class="h-7 w-7 text-muted-foreground hover:text-foreground"
                onclick={() => copyEventLink(c.raw)}
                aria-label="Share comment"
                title="Share"
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
          <div class="w-full flex flex-col gap-y-2 mt-2">
            <div class="text-muted-foreground">
              {#if Markdown}
                <Markdown content={c.content} />
              {:else}
                <RichText content={c.content} prose={false} />
              {/if}
            </div>
          </div>
        </div>
      {/each}

      <form onsubmit={submit} class="flex flex-col gap-3 pt-4 border-t">
        <div class="flex gap-3">
          <div class="flex-shrink-0">
            <ProfileComponent pubkey={currentCommenter} hideDetails={true} />
          </div>
          <div class="flex-1">
            <Textarea
              bind:value={newComment}
              placeholder="Write a comment..."
              class="min-h-[80px] resize-none w-full"
            />
          </div>
        </div>
        <div class="flex justify-end">
          <Button type="submit" class="gap-2" disabled={!newComment.trim()}>
            <MessageSquare class="h-4 w-4" /> Comment
          </Button>
        </div>
      </form>
    </div>
  </Card>
</div>
