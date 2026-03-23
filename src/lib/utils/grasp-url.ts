import { nip19 } from "nostr-tools";

function isValidNpub(value: string): boolean {
  try {
    const decoded = nip19.decode(value);
    return decoded.type === "npub" && typeof decoded.data === "string";
  } catch {
    return false;
  }
}

export function isGraspRepoHttpUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false;
  }

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  if (segments.length < 2) return false;

  const repoSegment = segments[segments.length - 1];
  const ownerSegment = segments[segments.length - 2];

  if (!repoSegment.endsWith(".git")) return false;

  const identifier = repoSegment.slice(0, -4);
  if (!identifier) return false;

  return isValidNpub(ownerSegment);
}
