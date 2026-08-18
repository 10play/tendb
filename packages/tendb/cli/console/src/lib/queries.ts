import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { api } from "./api";
import { readyBranches } from "./branches";
import { useStoredState } from "./hooks";
import { previewQuery } from "./sql";
import { storageKeys } from "./storage";

const POLL_MS = 5_000;

export const queryKeys = {
  context: ["context"] as const,
  status: ["dblab", "status"] as const,
  branches: ["dblab", "branches"] as const,
  snapshots: ["dblab", "snapshots"] as const,
  replication: ["replication"] as const,
  checkup: ["checkup"] as const,
  branchUri: (name: string) => ["branch-uri", name] as const,
  tables: (name: string) => ["branch-tables", name] as const,
  perf: (name: string) => ["branch-perf", name] as const,
  preview: (name: string, schema: string, table: string) =>
    ["table-preview", name, schema, table] as const,
};

export function useAppContext() {
  return useQuery({
    queryKey: queryKeys.context,
    queryFn: api.context,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useEngineStatus() {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: api.status,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
  });
}

export function useBranches() {
  return useQuery({
    queryKey: queryKeys.branches,
    queryFn: api.branches,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
  });
}

export function useSnapshots() {
  return useQuery({
    queryKey: queryKeys.snapshots,
    queryFn: api.snapshots,
    refetchInterval: POLL_MS * 3,
    staleTime: POLL_MS,
  });
}

/**
 * Upstream replication (e.g. Aurora → Neon). Each call opens short-lived
 * connections to both databases, so it polls at a gentler cadence than the
 * engine status. `{configured: false}` deployments pay one request and the
 * panel stays hidden.
 */
/** Current findings + event feed + slack config for the Alerts screen. */
export function useAlerts() {
  return useQuery({
    queryKey: ["alerts"],
    queryFn: api.alerts,
    refetchInterval: POLL_MS * 6,
    staleTime: POLL_MS * 3,
  });
}

/** Health findings for the top-bar chip; each poll probes both databases. */
export function useCheckup() {
  return useQuery({
    queryKey: queryKeys.checkup,
    queryFn: api.checkup,
    refetchInterval: POLL_MS * 6,
    staleTime: POLL_MS * 3,
  });
}

export function useReplication() {
  return useQuery({
    queryKey: queryKeys.replication,
    queryFn: api.replication,
    refetchInterval: (query) => (query.state.data?.configured === false ? false : POLL_MS * 2),
    staleTime: POLL_MS,
  });
}

export function useBranchUri(name: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.branchUri(name),
    queryFn: () => api.branchUri(name),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Catalog listing for one clone. Not polled — the schema does not move on its
 * own, and the first call may have to spawn a tunnel.
 */
export function useTables(branch: string) {
  return useQuery({
    queryKey: queryKeys.tables(branch),
    queryFn: () => api.tables(branch),
    enabled: Boolean(branch),
    staleTime: 30_000,
  });
}

/**
 * Performance snapshot. Deliberately manual: the endpoint runs half a dozen
 * queries per call, so polling it would distort the very counters it reports.
 */
export function usePerf(branch: string) {
  return useQuery({
    queryKey: queryKeys.perf(branch),
    queryFn: () => api.perf(branch),
    enabled: Boolean(branch),
    staleTime: 15_000,
  });
}

export function useTablePreview(branch: string, schema: string, table: string) {
  return useQuery({
    queryKey: queryKeys.preview(branch, schema, table),
    queryFn: () => api.query(branch, previewQuery(schema, table)),
    enabled: Boolean(branch && schema && table),
    staleTime: 30_000,
  });
}

/**
 * The branch in play, shared by every screen that queries a clone and kept in
 * localStorage so it survives a reload. Only clones in state OK are offered;
 * a stored branch that has gone away is dropped rather than queried.
 */
export function useSelectedBranch() {
  const status = useEngineStatus();
  const context = useAppContext();
  const [stored, setBranch] = useStoredState<string>(storageKeys.branch, "");

  const branches = useMemo(() => {
    const list = readyBranches(status.data?.cloning?.clones ?? []);
    // Live main has no clone — it is served from the sync target.
    const live = context.data?.liveBranch;
    if (live && !list.includes(live)) return [live, ...list];
    return list;
  }, [status.data, context.data]);

  useEffect(() => {
    if (branches.length === 0) return;
    if (!stored || !branches.includes(stored)) setBranch(branches[0] as string);
  }, [branches, stored, setBranch]);

  return {
    branch: branches.includes(stored) ? stored : "",
    branches,
    setBranch,
    loading: status.isLoading,
  };
}

/** Re-read everything a branch mutation can change. */
export function useRefreshBranchViews() {
  const client = useQueryClient();
  return useCallback(() => {
    void client.invalidateQueries({ queryKey: queryKeys.branches });
    void client.invalidateQueries({ queryKey: queryKeys.status });
    void client.invalidateQueries({ queryKey: queryKeys.snapshots });
  }, [client]);
}
