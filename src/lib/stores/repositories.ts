import type { BookmarkAddress } from "@nostr-git/core/events";

// Singleton store for bookmarked repositories
function createBookmarksStore() {
  const subscribers = new Set<(v: BookmarkAddress[]) => void>();
  let value: BookmarkAddress[] = [];

  function notify() {
    for (const run of subscribers) run(value);
  }

  function subscribe(run: (v: BookmarkAddress[]) => void) {
    run(value);
    subscribers.add(run);
    return () => subscribers.delete(run);
  }

  function set(next: BookmarkAddress[]) {
    value = Array.isArray(next) ? next : [];
    notify();
  }

  function update(fn: (v: BookmarkAddress[]) => BookmarkAddress[]) {
    value = fn(value);
    notify();
  }

  return {
    subscribe,
    set,
    update,
    add: (repo: BookmarkAddress) =>
      update((repos) => (repos.some((r) => r.address === repo.address) ? repos : [...repos, repo])),
    remove: (address: string) => update((repos) => repos.filter((r) => r.address !== address)),
    clear: () => set([]),
  };
}

// Export singleton instance
export const bookmarksStore = createBookmarksStore();

export type RepoCard = {
  euc: string;
  web: string[];
  clone: string[];
  maintainers: string[];
  effectiveMaintainers: string[];
  taggedMaintainers: string[];
  refs: any;
  rootsCount: number;
  revisionsCount: number;
  title: string;
  description: string;
  first: any;
  principal: string;
  repoNaddr: string;
};

export type LoadedBookmarkedRepo = {
  address: string;
  event: any;
  relayHint: string;
};

export type ComputeCardsOptions = {
  deriveMaintainersForEuc: (euc: string) => { get: () => Set<string> | null };
  deriveRepoRefState: (euc: string) => { get: () => any };
  derivePatchGraph: (address: string) => { get: () => any };
  parseRepoAnnouncementEvent: (event: any) => any;
  Router: any;
  nip19: any;
  Address: any;
  repoAnnouncements?: any[];
};

// Minimal singleton repositories store that holds RepoCard[]
function createRepositoriesStore() {
  const subscribers = new Set<(v: RepoCard[]) => void>();
  let value: RepoCard[] = [];

  // Caches for derived stores (same as in the page component)
  const refStateStoreByEuc = new Map<string, any>();
  const patchDagStoreByAddr = new Map<string, any>();

  function notify() {
    for (const run of subscribers) run(value);
  }

  function subscribe(run: (v: RepoCard[]) => void) {
    run(value);
    subscribers.add(run);
    return () => subscribers.delete(run);
  }

  function set(next: RepoCard[]) {
    value = Array.isArray(next) ? next : [];
    notify();
  }

  function update(fn: (v: RepoCard[]) => RepoCard[]) {
    value = fn(value);
    notify();
  }

  // Helper to create composite key for proper fork/duplicate distinction
  function createRepoKey(event: any): string {
    const euc = (event.tags || []).find((t: string[]) => t[0] === "r" && t[2] === "euc")?.[1] || "";
    const d = (event.tags || []).find((t: string[]) => t[0] === "d")?.[1] || "";
    const name = (event.tags || []).find((t: string[]) => t[0] === "name")?.[1] || d || "";

    // Normalize clone URLs by:
    // 1. Remove .git suffix
    // 2. Remove trailing slashes
    // 3. Replace npub-specific paths with placeholder (for gitnostr.com, relay.ngit.dev, etc.)
    // 4. Lowercase and sort
    const cloneUrls = (event.tags || [])
      .filter((t: string[]) => t[0] === "clone")
      .flatMap((t: string[]) => t.slice(1))
      .map((url: string) => {
        let normalized = url
          .trim()
          .toLowerCase()
          .replace(/\.git$/, "")
          .replace(/\/$/, "");
        // Replace npub paths with generic placeholder to group by repo name only
        normalized = normalized.replace(/\/npub1[a-z0-9]+\//g, "/{npub}/");
        return normalized;
      })
      .sort()
      .join("|");
    return `${euc}:${name}:${cloneUrls}`;
  }

  function computeCards(
    loadedBookmarkedRepos: LoadedBookmarkedRepo[],
    options: ComputeCardsOptions
  ): RepoCard[] {
    const {
      deriveRepoRefState,
      derivePatchGraph,
      parseRepoAnnouncementEvent,
      Router,
      nip19,
      Address,
    } = options;

    // Validate that a string is a valid hex pubkey (exactly 64 hex characters)
    const isValidPubkey = (pubkey: string | undefined | null): boolean => {
      if (!pubkey || typeof pubkey !== "string") return false;
      return /^[0-9a-f]{64}$/i.test(pubkey);
    };

    const getTagValue = (event: any, name: string): string =>
      (event?.tags || []).find((t: string[]) => t[0] === name)?.[1] || "";

    const getEucTag = (event: any): string =>
      (event?.tags || []).find((t: string[]) => t[0] === "r" && t[2] === "euc")?.[1] || "";

    const isSameRepoIdentity = (baseEvent: any, candidateEvent: any): boolean => {
      const baseD = getTagValue(baseEvent, "d");
      const candidateD = getTagValue(candidateEvent, "d");
      if (!baseD || !candidateD || baseD !== candidateD) return false;

      const baseEuc = getEucTag(baseEvent);
      const candidateEuc = getEucTag(candidateEvent);

      if (baseEuc && candidateEuc) return baseEuc === candidateEuc;
      if (baseEuc || candidateEuc) return false;
      return true;
    };

    const getTaggedMaintainers = (event: any): string[] => {
      const raw = (event?.tags || [])
        .filter((t: string[]) => t[0] === "maintainers")
        .flatMap((t: string[]) => t.slice(1));
      return Array.from(new Set(raw.filter((pk: string) => isValidPubkey(pk))));
    };

    const getAnnouncingMaintainers = (event: any): Set<string> => {
      const announcers = new Set<string>();
      if (isValidPubkey(event?.pubkey)) announcers.add(event.pubkey);

      for (const announcement of options.repoAnnouncements || []) {
        if (!announcement?.pubkey || !isValidPubkey(announcement.pubkey)) continue;
        if (!isSameRepoIdentity(event, announcement)) continue;
        announcers.add(announcement.pubkey);
      }

      return announcers;
    };

    const getEffectiveMaintainers = (event: any, tagged: string[]): string[] => {
      const announcers = getAnnouncingMaintainers(event);
      const effective = new Set<string>();

      if (isValidPubkey(event?.pubkey)) effective.add(event.pubkey);
      for (const pk of tagged) {
        if (announcers.has(pk)) effective.add(pk);
      }

      return Array.from(effective);
    };

    const bookmarked = loadedBookmarkedRepos || [];
    const byCompositeKey = new Map<string, RepoCard>();

    for (const { event, relayHint } of bookmarked) {
      // Try to find EUC tag, fall back to any r tag, or use event ID as last resort
      const eucTag = (event.tags || []).find((t: string[]) => t[0] === "r" && t[2] === "euc");
      const anyRTag = (event.tags || []).find((t: string[]) => t[0] === "r");
      const euc = eucTag?.[1] || anyRTag?.[1] || event.id || "";

      if (!euc) {
        continue;
      }

      // Use composite key to distinguish forks from duplicates
      const compositeKey = createRepoKey(event);
      const d = (event.tags || []).find((t: string[]) => t[0] === "d")?.[1] || "";
      const name = (event.tags || []).find((t: string[]) => t[0] === "name")?.[1] || "";
      const cloneUrls = (event.tags || [])
        .filter((t: string[]) => t[0] === "clone")
        .map((t: string[]) => t[1]);

      // Extract event data
      const web = (event.tags || [])
        .filter((t: string[]) => t[0] === "web")
        .flatMap((t: string[]) => t.slice(1));
      const clone = (event.tags || [])
        .filter((t: string[]) => t[0] === "clone")
        .flatMap((t: string[]) => t.slice(1));

      // If we already have this repo, merge maintainers (duplicate announcement)
      if (byCompositeKey.has(compositeKey)) {
        const existing = byCompositeKey.get(compositeKey)!;
        // Merge web/clone URLs
        existing.web = Array.from(new Set([...existing.web, ...web]));
        existing.clone = Array.from(new Set([...existing.clone, ...clone]));
        continue;
      }
      let rStore = refStateStoreByEuc.get(euc);
      if (!rStore) {
        rStore = deriveRepoRefState(euc);
        refStateStoreByEuc.set(euc, rStore);
      }
      const refs = rStore.get() || {};
      const first = event;
      let title = euc;
      let description = "";
      const taggedMaintainers = getTaggedMaintainers(first);
      try {
        if (first) {
          const parsed = parseRepoAnnouncementEvent(first);
          if (parsed?.name) title = parsed.name;
          if (parsed?.description) description = parsed.description;
        }
      } catch {}
      const effectiveMaintainers = getEffectiveMaintainers(first, taggedMaintainers);
      // Compute principal maintainer and naddr for navigation
      // Use first valid maintainer, or fall back to event pubkey if valid
      const principal =
        effectiveMaintainers.length > 0 && isValidPubkey(effectiveMaintainers[0] as string)
          ? effectiveMaintainers[0]
          : isValidPubkey((first as any)?.pubkey)
            ? (first as any)?.pubkey
            : "";
      const repoNaddr = (() => {
        try {
          if (!principal || !title) return "";
          const relays = Router.get().FromPubkeys([principal]).getUrls();
          return nip19.naddrEncode({ pubkey: principal, kind: 30617, identifier: title, relays });
        } catch {
          return "";
        }
      })();

      let rootsCount = 0;
      let revisionsCount = 0;
      try {
        if (first) {
          const addrA = Address.fromEvent(first).toString();
          let dStore = patchDagStoreByAddr.get(addrA);
          if (!dStore) {
            dStore = derivePatchGraph(addrA);
            patchDagStoreByAddr.set(addrA, dStore);
          }
          const dag: any = dStore.get();
          rootsCount = Array.isArray(dag?.roots)
            ? dag.roots.length
            : typeof dag?.nodeCount === "number"
              ? Math.min(1, dag.nodeCount)
              : 0;
          revisionsCount = Array.isArray(dag?.rootRevisions)
            ? dag.rootRevisions.length
            : typeof dag?.edgesCount === "number"
              ? dag.edgesCount
              : 0;
        }
      } catch {}
      const card: RepoCard = {
        euc,
        web: Array.from(new Set(web)) as string[],
        clone: Array.from(new Set(clone)) as string[],
        // Ensure maintainers are filtered to only valid pubkeys
        maintainers: effectiveMaintainers.filter((pk: any) => isValidPubkey(pk)) as string[],
        effectiveMaintainers: effectiveMaintainers.filter((pk: any) =>
          isValidPubkey(pk)
        ) as string[],
        taggedMaintainers,
        refs,
        rootsCount,
        revisionsCount,
        title,
        description,
        first,
        principal,
        repoNaddr,
      };
      byCompositeKey.set(compositeKey, card);
    }

    return Array.from(byCompositeKey.values());
  }

  return {
    subscribe,
    set,
    update,
    clear: () => set([]),
    computeCards,
  };
}

export const repositoriesStore = createRepositoriesStore();
