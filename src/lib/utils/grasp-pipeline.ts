import {
  createRepoAnnouncementEvent,
  createRepoStateEvent,
  type RepoAnnouncementEvent,
  type RepoStateEvent,
} from "@nostr-git/core/events";
import { sanitizeRelays } from "@nostr-git/core/utils";
import { nip19 } from "nostr-tools";
import { checkGraspRepoExists, checkGraspReceivePackReady } from "./grasp-availability.js";

export interface GraspPublishRelayAck {
  ackedRelays: string[];
  failedRelays: string[];
  successCount: number;
  hasRelayOutcomes: boolean;
}

function normalizeRelayForCompare(relay: string): string {
  const trimmed = String(relay || "").trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`.replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export function extractPublishRelayAck(result: unknown): GraspPublishRelayAck {
  const ackedRelays = new Set<string>();
  const failedRelays = new Set<string>();

  if (result && typeof result === "object") {
    const value = result as any;

    if (Array.isArray(value.ackedRelays)) {
      for (const relay of value.ackedRelays) {
        const normalized = normalizeRelayForCompare(String(relay || ""));
        if (normalized) ackedRelays.add(normalized);
      }
    }

    if (Array.isArray(value.failedRelays)) {
      for (const relay of value.failedRelays) {
        const normalized = normalizeRelayForCompare(String(relay || ""));
        if (normalized) failedRelays.add(normalized);
      }
    }
  }

  for (const relay of ackedRelays) {
    failedRelays.delete(relay);
  }

  return {
    ackedRelays: Array.from(ackedRelays),
    failedRelays: Array.from(failedRelays),
    successCount: ackedRelays.size,
    hasRelayOutcomes: ackedRelays.size + failedRelays.size > 0,
  };
}

function intersectRelays(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return a.filter((relay) => setB.has(relay));
}

export function didRelayAckGraspEvents(ack: GraspPublishRelayAck, relayUrl: string): boolean {
  const { wsOrigin, httpOrigin } = normalizeGraspOrigins(relayUrl);
  const targetVariants = new Set([
    normalizeRelayForCompare(relayUrl),
    normalizeRelayForCompare(wsOrigin),
    normalizeRelayForCompare(httpOrigin),
  ]);

  return ack.ackedRelays.some((relay) => targetVariants.has(normalizeRelayForCompare(relay)));
}

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
  onPublishEvent:
    | ((event: RepoAnnouncementEvent | RepoStateEvent) => Promise<unknown> | unknown)
    | undefined,
  announcementEvent: RepoAnnouncementEvent,
  stateEvent: RepoStateEvent,
  onStage?: (stage: "announcement" | "state") => void
): Promise<GraspPublishRelayAck> {
  if (!onPublishEvent) {
    throw new Error("GRASP operation requires onPublishEvent callback");
  }

  onStage?.("announcement");
  const announcementResult = await onPublishEvent(announcementEvent);
  onStage?.("state");
  const stateResult = await onPublishEvent(stateEvent);

  const announcementAck = extractPublishRelayAck(announcementResult);
  const stateAck = extractPublishRelayAck(stateResult);

  const ackedRelays = intersectRelays(announcementAck.ackedRelays, stateAck.ackedRelays);
  const failedRelays = Array.from(
    new Set([
      ...announcementAck.failedRelays,
      ...stateAck.failedRelays,
      ...announcementAck.ackedRelays.filter((relay) => !ackedRelays.includes(relay)),
      ...stateAck.ackedRelays.filter((relay) => !ackedRelays.includes(relay)),
    ])
  );

  return {
    ackedRelays,
    failedRelays,
    successCount: ackedRelays.length,
    hasRelayOutcomes:
      announcementAck.hasRelayOutcomes || stateAck.hasRelayOutcomes || failedRelays.length > 0,
  };
}

export async function waitForGraspProvisioning(params: {
  relayUrl: string;
  userPubkey: string;
  owner: string;
  repoName: string;
  maxAttempts?: number;
  delayMs?: number;
  onAttempt?: (info: {
    attempt: number;
    maxAttempts: number;
    repoExists: boolean;
    receivePackReady: boolean;
  }) => void;
}): Promise<void> {
  const {
    relayUrl,
    userPubkey,
    owner,
    repoName,
    maxAttempts = 15,
    delayMs = 3000,
    onAttempt,
  } = params;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const [probe, receivePackReady] = await Promise.all([
        checkGraspRepoExists({
          relayUrl,
          userPubkey,
          owner,
          repoName,
        }),
        checkGraspReceivePackReady({
          relayUrl,
          owner,
          repoName,
        }),
      ]);

      onAttempt?.({
        attempt,
        maxAttempts,
        repoExists: Boolean(probe.exists),
        receivePackReady,
      });

      if (probe.exists || receivePackReady) {
        return;
      }
    } catch {
      // Retry until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("GRASP relay did not provision read/write git endpoints in time");
}
