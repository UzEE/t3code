import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { PROJECT_RAIL_COMMANDS } from "@t3tools/shared/keybindings";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import {
  hasUnseenCompletion,
  isSidebarHiddenThread,
  orderItemsByPreferredIds,
  sortThreadsForSidebar,
} from "../Sidebar.logic";

/** Rail column width in px; the layout adds it to the thread list's width. */
export const PROJECT_RAIL_WIDTH = 56;

/**
 * Rail key of the "No project" icon. It selects every scratch project through
 * the sidebar's project filter. Real rail keys are logical project keys, which
 * never take this form.
 */
export const NO_PROJECT_SCOPE_KEY = "t3:no-project";

/**
 * Where a new thread opens while the filter holds projects: the first of them,
 * preferring its copy in the open thread's environment. Null keeps the default,
 * the open thread's project, which already belongs to the filter.
 */
export function resolveRailNewThreadProjectRef(input: {
  scopedGroups: ReadonlyArray<
    Pick<SidebarProjectSnapshot, "environmentId" | "id" | "memberProjectRefs">
  >;
  activeProjectRef: ScopedProjectRef | null;
}): ScopedProjectRef | null {
  const { activeProjectRef, scopedGroups } = input;
  const target = scopedGroups[0];
  if (!target) return null;
  if (
    activeProjectRef &&
    scopedGroups.some((group) =>
      group.memberProjectRefs.some(
        (member) =>
          member.environmentId === activeProjectRef.environmentId &&
          member.projectId === activeProjectRef.projectId,
      ),
    )
  ) {
    return null;
  }
  return (
    target.memberProjectRefs.find(
      (member) => member.environmentId === activeProjectRef?.environmentId,
    ) ?? {
      environmentId: target.environmentId,
      projectId: target.id,
    }
  );
}

export type RailIconTint = `rgb(${number} ${number} ${number})`;

const RAIL_TINT_HUE_BUCKETS = 12;
const RAIL_TINT_MIN_SHARE = 0.1;

/**
 * The dominant colour of an icon's RGBA pixels: the average of the most common
 * hue among opaque, saturated pixels. Null for icons without a clear colour,
 * such as black, white or grey logos, so their rail tile stays neutral.
 */
export function pickRailIconTint(pixels: Uint8ClampedArray): RailIconTint | null {
  const buckets = Array.from({ length: RAIL_TINT_HUE_BUCKETS }, () => ({
    count: 0,
    r: 0,
    g: 0,
    b: 0,
  }));
  let opaque = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const r = pixels[index] ?? 0;
    const g = pixels[index + 1] ?? 0;
    const b = pixels[index + 2] ?? 0;
    if ((pixels[index + 3] ?? 0) < 128) continue;
    opaque += 1;
    const max = Math.max(r, g, b);
    const chroma = max - Math.min(r, g, b);
    if (chroma < 48 || max < 64) continue;
    // Hue in sixths of the colour wheel, 0 to 6.
    const hue =
      max === r
        ? ((g - b) / chroma + 6) % 6
        : max === g
          ? (b - r) / chroma + 2
          : (r - g) / chroma + 4;
    const bucket = buckets[Math.floor((hue / 6) * RAIL_TINT_HUE_BUCKETS) % RAIL_TINT_HUE_BUCKETS];
    if (!bucket) continue;
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
  }
  const best = buckets.reduce((top, bucket) => (bucket.count > top.count ? bucket : top));
  if (best.count === 0 || best.count < opaque * RAIL_TINT_MIN_SHARE) return null;
  return `rgb(${Math.round(best.r / best.count)} ${Math.round(best.g / best.count)} ${Math.round(best.b / best.count)})`;
}

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
  | {
      readonly kind: "no-project";
      readonly key: typeof NO_PROJECT_SCOPE_KEY;
      readonly scopeKeys: readonly string[];
    }
  | {
      readonly kind: "project";
      readonly key: string;
      readonly scopeKeys: readonly string[];
      readonly group: TGroup;
    };

export function projectRailEntryOrderKeys(entry: ProjectRailEntry<RailProjectGroup>): string[] {
  return entry.kind === "no-project"
    ? [NO_PROJECT_SCOPE_KEY]
    : entry.group.memberProjects.map((member) => member.physicalProjectKey);
}

/**
 * Rail order below the separator: "No project" first when scratch projects
 * exist, then projects in the order they were added. Once the user drags, the
 * saved order wins; a project added after that is missing from it, so it lands
 * at the bottom.
 */
export function orderProjectRailEntries<TGroup extends RailProjectGroup>(
  groups: readonly TGroup[],
  projectOrder: readonly string[],
  scratchScopeKeys: readonly string[],
): ProjectRailEntry<TGroup>[] {
  const projects = groups
    .toSorted(
      (left, right) =>
        earliestMemberCreatedAt(left) - earliestMemberCreatedAt(right) ||
        left.projectKey.localeCompare(right.projectKey),
    )
    .map((group): ProjectRailEntry<TGroup> => ({
      kind: "project",
      key: group.projectKey,
      scopeKeys: [group.projectKey],
      group,
    }));
  const byPreference = (items: readonly ProjectRailEntry<TGroup>[]) =>
    orderItemsByPreferredIds({
      items,
      preferredIds: projectOrder,
      getId: (entry) => entry.key,
      getPreferenceIds: projectRailEntryOrderKeys,
    });
  if (scratchScopeKeys.length === 0) return byPreference(projects);
  const noProject: ProjectRailEntry<TGroup> = {
    kind: "no-project",
    key: NO_PROJECT_SCOPE_KEY,
    scopeKeys: scratchScopeKeys,
  };
  // A saved order from before the rail has no "No project" key, so that icon
  // keeps its default slot until the user drags it.
  return projectOrder.includes(NO_PROJECT_SCOPE_KEY)
    ? byPreference([noProject, ...projects])
    : [noProject, ...byPreference(projects)];
}

/** A rail icon is lit while the filter holds everything it stands for. */
export function isProjectRailEntrySelected(
  entry: Pick<ProjectRailEntry<unknown>, "scopeKeys">,
  selectedScopeKeys: readonly string[],
): boolean {
  return entry.scopeKeys.every((key) => selectedScopeKeys.includes(key));
}

/** The filter after Cmd/Ctrl-clicking an icon: adds it, or removes it if lit. */
export function toggleProjectRailEntryScope(
  entry: Pick<ProjectRailEntry<unknown>, "scopeKeys">,
  selectedScopeKeys: readonly string[],
): string[] {
  return isProjectRailEntrySelected(entry, selectedScopeKeys)
    ? selectedScopeKeys.filter((key) => !entry.scopeKeys.includes(key))
    : [...new Set([...selectedScopeKeys, ...entry.scopeKeys])];
}

/**
 * Where a project shortcut goes, exactly as if its rail icon were clicked:
 * `entryKey` null is All projects. Null when there is nowhere to go: no icon at
 * that position, or already at the top or bottom of the rail. Stepping starts
 * from the highest lit icon.
 */
export function resolveProjectRailShortcut(input: {
  command: string | null;
  /** Rail keys below the separator, in rail order. */
  entryKeys: readonly string[];
  selectedEntryKey: string | null;
}): { entryKey: string | null } | null {
  const { command, entryKeys } = input;
  if (command === PROJECT_RAIL_COMMANDS.showAll) return { entryKey: null };
  const jumpIndex = (PROJECT_RAIL_COMMANDS.jump as readonly string[]).indexOf(command ?? "");
  if (jumpIndex !== -1) {
    const target = entryKeys[jumpIndex];
    return target === undefined ? null : { entryKey: target };
  }
  if (command !== PROJECT_RAIL_COMMANDS.previous && command !== PROJECT_RAIL_COMMANDS.next) {
    return null;
  }
  // All projects sits above the list; a key missing from the rail reads as All.
  const position =
    input.selectedEntryKey === null ? 0 : entryKeys.indexOf(input.selectedEntryKey) + 1;
  const next = position + (command === PROJECT_RAIL_COMMANDS.next ? 1 : -1);
  if (next < 0 || next > entryKeys.length) return null;
  return { entryKey: next === 0 ? null : entryKeys[next - 1]! };
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
  | "pendingGuestMessageCount"
  | "unsettledAt"
>;

/**
 * A thread needs the user when it is blocked on them (approval, input or a
 * guest's message request) or finished a run they have not opened yet.
 * Settled, snoozed, archived and subagent threads never count: the sidebar
 * does not surface them either.
 */
function threadNeedsAttention(
  thread: RailThread,
  lastVisitedAt: string | undefined,
  now: string,
): boolean {
  if (thread.archivedAt !== null || isSidebarHiddenThread(thread)) return false;
  if (thread.settledOverride === "settled") return false;
  if (effectiveSnoozed(thread, { now })) return false;
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    (thread.pendingGuestMessageCount ?? 0) > 0
  ) {
    return true;
  }
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
      !isSidebarHiddenThread(thread) &&
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
