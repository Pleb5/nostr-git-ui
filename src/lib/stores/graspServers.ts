import { writable } from "svelte/store";

export const DEFAULT_GRASP_SERVER_URL = "wss://grasp.budabit.club";
export const DEFAULT_RECOMMENDED_GRASP_SERVER_URLS = [
  DEFAULT_GRASP_SERVER_URL,
  "wss://relay.ngit.dev",
  "wss://gitnostr.com",
];

export function normalizeGraspServerUrl(url: string): string {
  return (url || "").trim().replace(/\/+$/, "");
}

export function normalizeGraspServerUrls(urls: string[] = []): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const url of urls) {
    const normalized = normalizeGraspServerUrl(url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

export function getRecommendedGraspServerUrls(urls: string[] = []): string[] {
  return normalizeGraspServerUrls([...DEFAULT_RECOMMENDED_GRASP_SERVER_URLS, ...urls]);
}

// Singleton store for GRASP servers (urls only), mirroring bookmarksStore simplicity
function createGraspServersStore() {
  const store = writable<string[]>([]);
  const { subscribe } = store;

  return {
    subscribe,
    set: (urls: string[]) => store.set(normalizeGraspServerUrls(urls)),
    update: (updater: (urls: string[]) => string[]) =>
      store.update((urls) => normalizeGraspServerUrls(updater(urls))),
    push: (url: string) =>
      store.update((urls) => {
        const normalized = normalizeGraspServerUrl(url);
        if (!normalized) return urls;
        return urls.includes(normalized) ? urls : [...urls, normalized];
      }),
    remove: (url: string) => {
      const normalized = normalizeGraspServerUrl(url);
      store.update((urls) =>
        urls.filter((existingUrl) => normalizeGraspServerUrl(existingUrl) !== normalized)
      );
    },
    clear: () => store.set([]),
  };
}

export const graspServersStore = createGraspServersStore();
