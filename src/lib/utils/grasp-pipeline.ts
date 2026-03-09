import {
  createRepoAnnouncementEvent,
  createRepoStateEvent,
  type RepoAnnouncementEvent,
  type RepoStateEvent,
} from "@nostr-git/core/events";
import { sanitizeRelays } from "@nostr-git/core/utils";
import { nip19 } from "nostr-tools";
import { checkGraspRepoExists } from "./grasp-availability.js";

export interface GraspRef {
  type: "heads" | "tags";
  name: string;
  commit: string;
}

export function normalizeGraspOrigins(input: string): { wsOrigin: string; httpOrigin: string } {
  try {
    const url = new URL(input);
    const host = url.host;
    const isSecure = url.protocol === "wss:" || url.protocol === "https:";
    return {
      wsOrigin: isSecure ? `wss://${host}` : `ws://${host}`,
      httpOrigin: isSecure ? `https://${host}` : `http://${host}`,
    };
  } catch {
    const hostMatch = input.match(/(?:ws|wss|http|https):\/\/([^/]+)/);
    if (hostMatch) {
      const host = hostMatch[1];
      const isSecure = input.startsWith("wss://") || input.startsWith("https://");
      return {
        wsOrigin: isSecure ? `wss://${host}` : `ws://${host}`,
        httpOrigin: isSecure ? `https://${host}` : `http://${host}`,
      };
    }

    const host = input.replace(/^\/\//, "");
    return {
      wsOrigin: `wss://${host}`,
      httpOrigin: `https://${host}`,
    };
  }
}

export function toNpubOrSelf(value: string): string {
  if (value.startsWith("npub1")) return value;
  return nip19.npubEncode(value);
}

export interface CreateGraspEventsParams {
  relayUrl: string;
  ownerPubkey: string;
  repoName: string;
  description?: string;
  relays?: string[];
  cloneUrls?: string[];
  webUrls?: string[];
  maintainers?: string[];
  hashtags?: string[];
  earliestUniqueCommit?: string;
  refs?: GraspRef[];
  head?: string;
}

export function createGraspAnnouncementAndState({
  relayUrl,
  ownerPubkey,
  repoName,
  description,
  relays = [],
  cloneUrls,
  webUrls,
  maintainers,
  hashtags,
  earliestUniqueCommit,
  refs,
  head,
}: CreateGraspEventsParams): {
  ownerNpub: string;
  wsOrigin: string;
  httpOrigin: string;
  cloneUrl: string;
  webUrl: string;
  relays: string[];
  announcementEvent: RepoAnnouncementEvent;
  stateEvent: RepoStateEvent;
} {
  const { wsOrigin, httpOrigin } = normalizeGraspOrigins(relayUrl);
  const ownerNpub = toNpubOrSelf(ownerPubkey);
  const webUrl = `${httpOrigin}/${ownerNpub}/${repoName}`;
  const cloneUrl = `${webUrl}.git`;

  const normalizedRelays = sanitizeRelays(relays);
  const finalCloneUrls = cloneUrls && cloneUrls.length > 0 ? cloneUrls : [cloneUrl];
  const finalWebUrls = webUrls && webUrls.length > 0 ? webUrls : [webUrl];

  const announcementEvent = createRepoAnnouncementEvent({
    repoId: `${ownerNpub}:${repoName}`,
    name: repoName,
    description: description || "",
    clone: finalCloneUrls,
    web: finalWebUrls,
    relays: normalizedRelays,
    maintainers,
    hashtags,
    earliestUniqueCommit,
  });

  const stateEvent = createRepoStateEvent({
    repoId: repoName,
    refs,
    head,
  });

  if (normalizedRelays.length > 0 && !(stateEvent.tags as any[])?.some((t) => t[0] === "relays")) {
    stateEvent.tags = [...(stateEvent.tags || []), ["relays", ...normalizedRelays] as any];
  }

  return {
    ownerNpub,
    wsOrigin,
    httpOrigin,
    cloneUrl,
    webUrl,
    relays: normalizedRelays,
    announcementEvent,
    stateEvent,
  };
}

export async function publishGraspRepoEvents(
  onPublishEvent: ((event: RepoAnnouncementEvent | RepoStateEvent) => Promise<void>) | undefined,
  announcementEvent: RepoAnnouncementEvent,
  stateEvent: RepoStateEvent
): Promise<void> {
  if (!onPublishEvent) {
    throw new Error("GRASP operation requires onPublishEvent callback");
  }

  await onPublishEvent(announcementEvent);
  await onPublishEvent(stateEvent);
}

export async function waitForGraspProvisioning(params: {
  relayUrl: string;
  userPubkey: string;
  owner: string;
  repoName: string;
  maxAttempts?: number;
  delayMs?: number;
}): Promise<void> {
  const { relayUrl, userPubkey, owner, repoName, maxAttempts = 12, delayMs = 1500 } = params;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const probe = await checkGraspRepoExists({
        relayUrl,
        userPubkey,
        owner,
        repoName,
      });
      if (probe.exists) return;
    } catch {
      // Retry until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("GRASP relay did not provision the repository endpoint in time");
}
