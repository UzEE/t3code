import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { createContext, use, useMemo } from "react";

import { cn } from "../../lib/utils";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironmentMachines } from "../../state/environments";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { GitHubIcon, GitIcon } from "../Icons";
import { resolveSidebarThreadStatus, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { ThreadHoverCard } from "../ThreadHoverCard";
import { selectProjectRailPreviewThreads } from "./projectRail.logic";
import {
  resolveSidebarThreadStatusBadge,
  SidebarThreadStatusIcon,
} from "./SidebarThreadStatusIcon";

const PREVIEW_THREAD_LIMIT = 5;

export interface ProjectRailCardData {
  readonly threads: readonly SidebarThreadSummary[];
  readonly scopeKeyByProjectRef: ReadonlyMap<string, string>;
  readonly now: string;
  /** Scratch projects behind the "No project" entry. */
  readonly noProjectMembers: readonly SidebarProjectGroupMember[];
}

// Read only by an open hover card, so thread updates re-render the card being
// looked at and nothing else on the rail.
export const ProjectRailCardContext = createContext<ProjectRailCardData | null>(null);

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function repositoryLabel(project: SidebarProjectSnapshot): string | null {
  const identity = project.repositoryIdentity;
  if (!identity) return null;
  if (identity.owner && identity.name) return `${identity.owner}/${identity.name}`;
  return identity.displayName ?? null;
}

function EnvironmentChip(props: {
  environment: readonly [SidebarProjectGroupMember["environmentId"], string | null];
  machineByEnvironmentId: ReturnType<typeof useEnvironmentMachines>;
}) {
  const [environmentId, label] = props.environment;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <EnvironmentMachineIcon
        kind={props.machineByEnvironmentId.get(environmentId) ?? "server"}
        className="size-3 shrink-0 stroke-muted-foreground"
      />
      <div className="min-w-0 truncate text-foreground/75">{label ?? environmentId}</div>
    </div>
  );
}

/** Hover card for one rail icon: where the project lives and what is open in it. */
export function ProjectRailHoverCard(props: {
  scopeKey: string;
  project: SidebarProjectSnapshot | null;
}) {
  const data = use(ProjectRailCardContext);
  const localLastVisitedAtByKey = useUiStateStore((store) => store.threadLastVisitedAtById);
  const machineByEnvironmentId = useEnvironmentMachines();
  const { project, scopeKey } = props;

  const members = project?.memberProjects ?? data?.noProjectMembers ?? [];
  const environments = [
    ...new Map(members.map((member) => [member.environmentId, member.environmentLabel] as const)),
  ];
  const repository = project ? repositoryLabel(project) : null;

  const preview = useMemo(() => {
    if (!data) return null;
    const lastVisitedAt = (thread: SidebarThreadSummary) =>
      resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        localLastVisitedAtByKey[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
      );
    const selected = selectProjectRailPreviewThreads({
      threads: data.threads,
      scopeKey,
      scopeKeyByProjectRef: data.scopeKeyByProjectRef,
      resolveLastVisitedAt: lastVisitedAt,
      now: data.now,
      limit: PREVIEW_THREAD_LIMIT,
    });
    return {
      total: selected.total,
      rows: selected.threads.map(({ thread, isUnread }) => {
        // Same rule as the thread row: a timer wake stays lit until the user visits.
        const wokeAtMs = parseTimestampMs(threadWokeAt(thread, { now: data.now }));
        const visitedMs = parseTimestampMs(lastVisitedAt(thread));
        const isWoke = wokeAtMs !== null && (visitedMs === null || visitedMs < wokeAtMs);
        return {
          thread,
          isUnread,
          badge: resolveSidebarThreadStatusBadge({
            status: resolveSidebarThreadStatus(thread),
            isUnread,
            isWoke,
            goalActive: thread.goal?.status === "active",
          }),
        };
      }),
    };
  }, [data, localLastVisitedAtByKey, scopeKey]);

  return (
    <ThreadHoverCard
      title={project?.displayName ?? "No project"}
      footer={
        preview && preview.total > 0 ? (
          <div className="grid gap-1 border-t border-border/60 pt-2 pl-0.5 text-xs">
            {preview.rows.map(({ thread, isUnread, badge }) => (
              <div
                key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
                className="flex min-w-0 items-center gap-2"
              >
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    isUnread ? "font-semibold text-foreground" : "text-foreground/75",
                  )}
                >
                  {thread.title}
                </span>
                {badge?.icon ? (
                  <span className={cn("inline-flex", badge.className)}>
                    <SidebarThreadStatusIcon icon={badge.icon} className="size-3.5" />
                    <span className="sr-only">{badge.label}</span>
                  </span>
                ) : null}
              </div>
            ))}
            {preview.total > preview.rows.length ? (
              <div className="text-muted-foreground">
                {preview.total - preview.rows.length} more
              </div>
            ) : null}
          </div>
        ) : null
      }
    >
      {environments.length > 2 ? (
        // Three or more machines collapse to one line: the first and a count.
        <div className="flex min-w-0 items-center gap-1.5">
          <EnvironmentChip
            environment={environments[0]!}
            machineByEnvironmentId={machineByEnvironmentId}
          />
          <span className="shrink-0">
            and <span className="text-foreground/75">+{environments.length - 1} more</span>
          </span>
        </div>
      ) : (
        environments.map((environment) => (
          <EnvironmentChip
            key={environment[0]}
            environment={environment}
            machineByEnvironmentId={machineByEnvironmentId}
          />
        ))
      )}
      {repository ? (
        <div className="flex min-w-0 items-center gap-2">
          {project?.repositoryIdentity?.provider === "github" ? (
            <GitHubIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <GitIcon className="size-3 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 truncate text-foreground/75">{repository}</div>
        </div>
      ) : null}
    </ThreadHoverCard>
  );
}
