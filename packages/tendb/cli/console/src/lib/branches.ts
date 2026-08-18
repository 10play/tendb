import type { BranchInfo, Clone } from "./api";

export interface BranchNode {
  branch: BranchInfo;
  clone: Clone | undefined;
  depth: number;
  /** True for a clone the engine reports against a branch we never listed. */
  orphan: boolean;
}

export const ROOT_BRANCH = "main";

/**
 * Branches form a tree through `parent`. Flattening it depth-first (rather than
 * sorting names alphabetically) is what lets the table show lineage: every row
 * sits under the branch it was cut from.
 */
export function buildBranchTree(branches: BranchInfo[], clones: Clone[]): BranchNode[] {
  const clonesByBranch = new Map<string, Clone>();
  for (const clone of clones) {
    if (clone.branch) clonesByBranch.set(clone.branch, clone);
  }

  const known = new Set(branches.map((branch) => branch.name));
  const children = new Map<string, BranchInfo[]>();
  const roots: BranchInfo[] = [];

  for (const branch of branches) {
    const parent = branch.parent;
    if (parent && parent !== branch.name && known.has(parent)) {
      const siblings = children.get(parent) ?? [];
      siblings.push(branch);
      children.set(parent, siblings);
    } else {
      roots.push(branch);
    }
  }

  const byName = (a: BranchInfo, b: BranchInfo) => a.name.localeCompare(b.name);
  for (const siblings of children.values()) siblings.sort(byName);
  roots.sort((a, b) => {
    if (a.name === ROOT_BRANCH) return -1;
    if (b.name === ROOT_BRANCH) return 1;
    return byName(a, b);
  });

  const nodes: BranchNode[] = [];
  const visited = new Set<string>();

  const walk = (branch: BranchInfo, depth: number) => {
    if (visited.has(branch.name)) return; // a parent cycle must not hang the UI
    visited.add(branch.name);
    nodes.push({
      branch,
      clone: clonesByBranch.get(branch.name),
      depth,
      orphan: false,
    });
    for (const child of children.get(branch.name) ?? []) walk(child, depth + 1);
  };

  for (const root of roots) walk(root, 0);

  // A running clone whose branch never showed up in the listing still gets a
  // row — hiding it would hide something that is holding disk.
  for (const clone of clones) {
    if (clone.branch && !known.has(clone.branch) && !visited.has(clone.branch)) {
      visited.add(clone.branch);
      nodes.push({ branch: { name: clone.branch }, clone, depth: 0, orphan: true });
    }
  }

  return nodes;
}

/** Branch names that can host a SQL session right now. */
export function readyBranches(clones: Clone[]): string[] {
  return clones
    .filter((clone) => clone.branch && clone.status.code.toUpperCase() === "OK")
    .map((clone) => clone.branch as string)
    .sort((a, b) => (a === ROOT_BRANCH ? -1 : b === ROOT_BRANCH ? 1 : a.localeCompare(b)));
}
