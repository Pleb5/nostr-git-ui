import { getGitServiceApi } from "@nostr-git/core/git";
import { nip19 } from "nostr-tools";

export interface GraspRepoExistsResult {
  exists: boolean;
  htmlUrl?: string;
}

interface CheckGraspRepoExistsParams {
  relayUrl: string;
  userPubkey: string;
  owner: string;
  repoName: string;
}

function toNpub(pubkeyOrNpub: string): string {
  if (pubkeyOrNpub.startsWith("npub1")) return pubkeyOrNpub;
  return nip19.npubEncode(pubkeyOrNpub.toLowerCase());
}

function toHttpBase(relayUrl: string): string {
  const normalized = relayUrl.trim();
  if (normalized.startsWith("wss://")) return `https://${normalized.slice(6)}`;
  if (normalized.startsWith("ws://")) return `http://${normalized.slice(5)}`;
  return normalized;
}

export function isNotFoundError(error: unknown): boolean {
  const anyError = error as any;
  const message = error instanceof Error ? error.message : String(error || "");
  const normalizedMessage = message.toLowerCase();
  const code = String(anyError?.code || "");
  const statusCode = anyError?.statusCode ?? anyError?.status ?? anyError?.context?.statusCode;

  return (
    statusCode === 404 ||
    code === "REPO_NOT_FOUND" ||
    normalizedMessage.includes("404") ||
    normalizedMessage.includes("not found") ||
    normalizedMessage.includes("repository not found")
  );
}

export async function checkGraspRepoExists({
  relayUrl,
  userPubkey,
  owner,
  repoName,
}: CheckGraspRepoExistsParams): Promise<GraspRepoExistsResult> {
  const ownerNpub = toNpub(owner);
  const httpBase = toHttpBase(relayUrl);
  const api = getGitServiceApi("grasp-rest", userPubkey, httpBase);

  try {
    const repo = await api.getRepo(ownerNpub, repoName);
    return { exists: true, htmlUrl: repo.htmlUrl };
  } catch (error) {
    if (isNotFoundError(error)) return { exists: false };
    throw new Error(
      `Failed to verify GRASP repository availability via Smart HTTP: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
