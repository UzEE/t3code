import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import {
  hasUnseenCompletion,
  isSidebarSubagentThread,
  orderItemsByPreferredIds,
  sortThreadsForSidebar,
} from "../Sidebar.logic";

/** Rail column width in px; the layout adds it to the thread list's width. */
export const PROJECT_RAIL_WIDTH = 56;

/**
 * Scope key for threads in an environment's scratch project ("No project").
 * Real scope keys are logical project keys, which never take this form.
 */
export const NO_PROJECT_SCOPE_KEY = "t3:no-project";

type RailProjectGroup = Pick<SidebarProjectSnapshot, "projectKey" | "createdAt"> & {
  readonly memberProjects: ReadonlyArray<
    Pick<SidebarProjectSnapshot["memberProjects"][number], "physicalProjectKey" | "createdAt">
  >;
};

function earliestMemberCreatedAt(group: RailProjectGroup): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const member of group.memberProjects) {
    const createdAt = Date.parse(member.createdAt);
    if (Number.isFinite(createdAt) && createdAt < earliest) earliest = createdAt;
  }
  return earliest;
}

export type ProjectRailEntry<TGroup> =
  | { readonly kind: "no-project"; readonly key: typeof NO_PROJECT_SCOPE_KEY }
  | { readonly kind: "project"; readonly key: string; readonly group: TGroup };

function entryOrderKeys(entry: ProjectRailEntry<RailProjectGroup>): string[] {
  return entry.kind === "no-project"
    ? [NO_PROJECT_SCOPE_KEY]
    : entry.group.memberProjects.map((member) => member.physicalProjectKey);
}

/**
 * Rail order below the separator: "No project" first, then projects in the
 * order they were added. Once the user drags, the saved order wins; a project
 * added after that is missing from it, so it lands at the bottom.
 */
export function orderProjectRailEntries<TGroup extends RailProjectGroup>(
  groups: readonly TGroup[],
  projectOrder: readonly string[],
): ProjectRailEntry<TGroup>[] {
  const projects = groups
    .toSorted(
      (left, right) =>
        earliestMemberCreatedAt(left) - earliestMemberCreatedAt(right) ||
        left.projectKey.localeCompare(right.projectKey),
    )
    .map((group): ProjectRailEntry<TGroup> => ({ kind: "project", key: group.projectKey, group }));
  const noProject: ProjectRailEntry<TGroup> = { kind: "no-project", key: NO_PROJECT_SCOPE_KEY };
  const byPreference = (items: readonly ProjectRailEntry<TGroup>[]) =>
    orderItemsByPreferredIds({
      items,
      preferredIds: projectOrder,
      getId: (entry) => entry.key,
      getPreferenceIds: entryOrderKeys,
    });
  // The saved order is shared with the legacy sidebar, whose drags drop the
  // "No project" key; without it, "No project" keeps its default slot.
  return projectOrder.includes(NO_PROJECT_SCOPE_KEY)
    ? byPreference([noProject, ...projects])
    : [noProject, ...byPreference(projects)];
}

/** Saved order after moving one rail entry onto another's slot. */
export function moveProjectRailEntry(
  entries: readonly ProjectRailEntry<RailProjectGroup>[],
  activeKey: string,
  overKey: string,
): string[] | null {
  const from = entries.findIndex((entry) => entry.key === activeKey);
  const to = entries.findIndex((entry) => entry.key === overKey);
  if (from < 0 || to < 0 || from === to) return null;
  const next = [...entries];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next.flatMap(entryOrderKeys);
}

type RailThread = Pick<
  SidebarThreadSummary,
  | "activeOrderKey"
  | "archivedAt"
  | "createdAt"
  | "environmentId"
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "id"
  | "interactionMode"
  | "lastVisitedAt"
  | "latestRun"
  | "latestUserMessageAt"
  | "lineage"
  | "projectId"
  | "runtime"
  | "settledOverride"
  | "snoozedUntil"
  | "snoozedAt"
  | "pendingBackgroundTasks"
  | "unsettledAt"
>;

/**
 * A thread needs the user when it is blocked on them (approval or input) or
 * finished a run they have not opened yet. Settled, snoozed, archived and
 * subagent threads never count: the sidebar does not surface them either.
 */
export function threadNeedsAttention(
  thread: RailThread,
  lastVisitedAt: string | undefined,
  now: string,
): boolean {
  if (thread.archivedAt !== null || isSidebarSubagentThread(thread)) return false;
  if (thread.settledOverride === "settled") return false;
  if (effectiveSnoozed(thread, { now })) return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return true;
  return hasUnseenCompletion({ ...thread, lastVisitedAt });
}

/**
 * Counts threads needing attention per project scope key. Physical project
 * keys (`environmentId:projectId`) map to a scope key; threads outside the
 * map are counted only in the total.
 */
export function countProjectRailAttention(input: {
  readonly threads: readonly RailThread[];
  readonly scopeKeyByProjectRef: ReadonlyMap<string, string>;
  readonly resolveLastVisitedAt: (thread: RailThread) => string | undefined;
  readonly now: string;
}): { readonly total: number; readonly byScopeKey: ReadonlyMap<string, number> } {
  const byScopeKey = new Map<string, number>();
  let total = 0;
  for (const thread of input.threads) {
    if (!threadNeedsAttention(thread, input.resolveLastVisitedAt(thread), input.now)) continue;
    total += 1;
    const scopeKey = input.scopeKeyByProjectRef.get(`${thread.environmentId}:${thread.projectId}`);
    if (scopeKey !== undefined) byScopeKey.set(scopeKey, (byScopeKey.get(scopeKey) ?? 0) + 1);
  }
  return { total, byScopeKey };
}

/** Badge text: Discord-style cap so a busy project never widens the pill. */
export function formatProjectRailBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** Unsettled threads one rail icon covers, for its hover card. */
export function selectProjectRailPreviewThreads<TThread extends RailThread>(input: {
  readonly threads: readonly TThread[];
  readonly scopeKey: string;
  readonly scopeKeyByProjectRef: ReadonlyMap<string, string>;
  readonly resolveLastVisitedAt: (thread: TThread) => string | undefined;
  readonly now: string;
  readonly limit: number;
}): {
  readonly threads: ReadonlyArray<{ readonly thread: TThread; readonly isUnread: boolean }>;
  readonly total: number;
} {
  const unsettled = input.threads.filter(
    (thread) =>
      input.scopeKeyByProjectRef.get(`${thread.environmentId}:${thread.projectId}`) ===
        input.scopeKey &&
      thread.archivedAt === null &&
      !isSidebarSubagentThread(thread) &&
      thread.settledOverride !== "settled" &&
      !effectiveSnoozed(thread, { now: input.now }),
  );
  // Threads that need the user lead; the rest keep the inbox's own order.
  const ranked = sortThreadsForSidebar(unsettled)
    .map((thread) => ({
      thread,
      isUnread: hasUnseenCompletion({
        ...thread,
        lastVisitedAt: input.resolveLastVisitedAt(thread),
      }),
      needsAttention: threadNeedsAttention(thread, input.resolveLastVisitedAt(thread), input.now),
    }))
    .toSorted((left, right) => Number(right.needsAttention) - Number(left.needsAttention));
  return {
    threads: ranked.slice(0, input.limit).map(({ thread, isUnread }) => ({ thread, isUnread })),
    total: ranked.length,
  };
}
