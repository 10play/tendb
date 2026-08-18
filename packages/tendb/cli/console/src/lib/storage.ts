/** Every localStorage key the console owns, in one place so handoffs between
 *  screens cannot drift out of sync with the components that read them. */
export const storageKeys = {
  /** Also read by the inline no-flash script in index.html — keep them in sync. */
  theme: "tendb.console.theme",
  sqlDraft: "tendb.console.sql",
  branch: "tendb.console.branch",
  sqlHistory: "tendb.console.history",
  fullRefreshUnsupported: "tendb.console.fullRefreshUnsupported",
  gettingStartedDismissed: "tendb.console.gettingStarted",
} as const;

/*
 * Several components can hold the same stored key at once — the sidebar's
 * branch selector and whichever clone-scoped screen is showing both mount
 * useStoredState(branch). localStorage alone cannot carry that: it fires no
 * event in the writing document. This tiny registry does; every write goes
 * through notifyStoredKey so all live hook instances re-read.
 */
const listeners = new Map<string, Set<() => void>>();

export function subscribeStoredKey(key: string, onChange: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(onChange);
  return () => {
    set.delete(onChange);
  };
}

export function notifyStoredKey(key: string): void {
  listeners.get(key)?.forEach((onChange) => onChange());
}

/** Hand a statement to the SQL screen (used by "Open in SQL editor"). */
export function stageSqlQuery(branch: string, sql: string): void {
  try {
    window.localStorage.setItem(storageKeys.branch, JSON.stringify(branch));
    window.localStorage.setItem(storageKeys.sqlDraft, JSON.stringify(sql));
  } catch {
    // Storage blocked — the editor simply opens with whatever it had.
  }
  notifyStoredKey(storageKeys.branch);
  notifyStoredKey(storageKeys.sqlDraft);
}
