const REF_PREFIXES = [
  "ref: refs/heads/",
  "ref: refs/tags/",
  "refs/heads/",
  "refs/tags/",
  "refs/remotes/origin/",
  "origin/",
  "heads/",
  "tags/",
] as const;

export function normalizeGitRefName(input?: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "";

  for (const prefix of REF_PREFIXES) {
    if (raw.startsWith(prefix)) {
      const normalized = raw.slice(prefix.length);
      return normalized.trim();
    }
  }

  return raw;
}
