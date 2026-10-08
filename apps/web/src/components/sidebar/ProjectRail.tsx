import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LayersIcon, MessageSquareDashedIcon, PlusIcon } from "lucide-react";
import { memo, useCallback, useMemo, type MouseEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ProjectRailCardContext, ProjectRailHoverCard } from "./ProjectRailHoverCard";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  countProjectRailAttention,
  formatProjectRailBadgeCount,
  moveProjectRailEntry,
  PROJECT_RAIL_WIDTH,
  type ProjectRailEntry,
} from "./projectRail.logic";

const RAIL_DRAG_DISTANCE = 6;
// Touch drags start on a long press so a swipe still scrolls the rail.
const RAIL_TOUCH_DRAG_DELAY_MS = 250;

function RailBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -right-1 -bottom-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-3xs leading-none font-semibold text-white tabular-nums ring-2 ring-sidebar"
    >
      {formatProjectRailBadgeCount(count)}
    </span>
  );
}

function attentionLabel(label: string, count: number): string {
  if (count === 0) return label;
  return `${label}, ${count} ${count === 1 ? "thread needs" : "threads need"} attention`;
}

// One rail slot: the left pill marks the selected scope (tall) and hover
// (short), like Discord's server list. The tile itself never animates.
function RailButton(props: {
  label: string;
  selected?: boolean;
  attentionCount?: number;
  onClick: () => void;
  onContextMenu?: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined;
  /** Replaces the plain label tooltip, e.g. with a hover card popup. */
  popup?: ReactNode;
  tooltipDisabled?: boolean;
  children: ReactNode;
}) {
  const attentionCount = props.attentionCount ?? 0;
  return (
    <div className="group/rail-item relative flex w-full justify-center">
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full bg-sidebar-foreground transition-[height,opacity] duration-150",
          props.selected
            ? "h-6 opacity-100"
            : "h-2 opacity-0 group-hover/rail-item:h-3 group-hover/rail-item:opacity-70",
        )}
      />
      <Tooltip disabled={props.tooltipDisabled}>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={attentionLabel(props.label, attentionCount)}
              aria-pressed={props.selected}
              onClick={props.onClick}
              onContextMenu={props.onContextMenu}
              className={cn(
                "relative flex size-9 cursor-pointer items-center justify-center rounded-xl text-sidebar-foreground/80 outline-hidden ring-ring transition-colors focus-visible:ring-2",
                props.selected
                  ? "bg-sidebar-row-active text-sidebar-foreground shadow-xs/5"
                  : "bg-sidebar/70 hover:bg-sidebar-row-hover hover:text-sidebar-foreground dark:bg-sidebar-row-hover/60 dark:hover:bg-sidebar-row-hover",
              )}
            >
              {props.children}
              <RailBadge count={attentionCount} />
            </button>
          }
        />
        {props.popup ?? (
          <TooltipPopup side="right">{attentionLabel(props.label, attentionCount)}</TooltipPopup>
        )}
      </Tooltip>
    </div>
  );
}

// Thread updates re-render the rail for its counts. Each entry takes only
// primitives and stable references, so only entries whose count or selection
// changed re-render.
const RailEntry = memo(function RailEntry(props: {
  scopeKey: string;
  /** Null for the "No project" entry. */
  project: SidebarProjectSnapshot | null;
  selected: boolean;
  attentionCount: number;
  onSelectScope: (scopeKey: string | null) => void;
  onOpenProjectSettings: ProjectRailProps["onOpenProjectSettings"];
}) {
  const { onOpenProjectSettings, onSelectScope, project, scopeKey } = props;
  const { setNodeRef, transform, transition, listeners, isDragging } = useSortable({
    id: scopeKey,
  });
  const handleClick = useCallback(() => onSelectScope(scopeKey), [onSelectScope, scopeKey]);
  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (project) onOpenProjectSettings(event, project);
    },
    [onOpenProjectSettings, project],
  );
  return (
    <div
      ref={setNodeRef}
      // Drag listeners only, without dnd-kit's attributes: the rail buttons stay
      // ordinary buttons for keyboard users, and a short press still clicks.
      {...listeners}
      className={cn("w-full", isDragging && "relative z-10 opacity-80")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <RailButton
        label={project ? project.displayName : "No project"}
        selected={props.selected}
        attentionCount={props.attentionCount}
        onClick={handleClick}
        onContextMenu={project ? handleContextMenu : undefined}
        tooltipDisabled={isDragging}
        popup={
          <ThreadHoverCardPopup side="right" align="start" sideOffset={8}>
            <ProjectRailHoverCard scopeKey={scopeKey} project={project} />
          </ThreadHoverCardPopup>
        }
      >
        {project ? (
          // Wrapped so the button's svg color cannot override a project's own icon color.
          <span className="flex">
            <ProjectFavicon project={project} className="size-5" />
          </span>
        ) : (
          <MessageSquareDashedIcon className="size-4.5" />
        )}
      </RailButton>
    </div>
  );
});

export interface ProjectRailProps {
  entries: readonly ProjectRailEntry<SidebarProjectSnapshot>[];
  scopeKey: string | null;
  threads: readonly SidebarThreadSummary[];
  /** Maps `environmentId:projectId` to the rail scope key the thread counts toward. */
  scopeKeyByProjectRef: ReadonlyMap<string, string>;
  /** Changes when a snooze wakes, so woken threads reach the counts. */
  now: string;
  /** Scratch projects behind the "No project" entry, for its hover card. */
  noProjectMembers: readonly SidebarProjectGroupMember[];
  onSelectScope: (scopeKey: string | null) => void;
  onAddProject: () => void;
  onOpenProjectSettings: (
    event: MouseEvent<HTMLButtonElement>,
    project: SidebarProjectSnapshot,
  ) => void;
}

/**
 * The leftmost column of the thread sidebar: add a project, see every
 * project, or scope the thread list to one project. Each icon carries a
 * count of its threads that need the user.
 */
export const ProjectRail = memo(function ProjectRail(props: ProjectRailProps) {
  const {
    entries,
    noProjectMembers,
    now,
    onAddProject,
    onOpenProjectSettings,
    onSelectScope,
    scopeKey,
    scopeKeyByProjectRef,
    threads,
  } = props;
  const setProjectOrder = useUiStateStore((store) => store.setProjectOrder);
  // Visits change this map often; subscribing here keeps those updates from
  // re-rendering the whole thread list.
  const localLastVisitedAtByKey = useUiStateStore((store) => store.threadLastVisitedAtById);
  const attention = useMemo(
    () =>
      countProjectRailAttention({
        threads,
        scopeKeyByProjectRef,
        now,
        resolveLastVisitedAt: (thread) =>
          resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtByKey[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
      }),
    [localLastVisitedAtByKey, now, scopeKeyByProjectRef, threads],
  );

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: RAIL_DRAG_DISTANCE } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: RAIL_TOUCH_DRAG_DELAY_MS, tolerance: RAIL_DRAG_DISTANCE },
    }),
  );
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;
      const nextOrder = moveProjectRailEntry(entries, String(active.id), String(over.id));
      if (nextOrder) setProjectOrder(nextOrder);
    },
    [entries, setProjectOrder],
  );
  const entryKeys = useMemo(() => entries.map((entry) => entry.key), [entries]);
  const cardData = useMemo(
    () => ({ threads, scopeKeyByProjectRef, now, noProjectMembers }),
    [noProjectMembers, now, scopeKeyByProjectRef, threads],
  );

  return (
    // Same timing as the thread list's hover cards: once one card is open,
    // moving to a neighbouring icon opens its card at once.
    <TooltipProvider delay={150} closeDelay={0} timeout={400}>
      <nav
        aria-label="Projects"
        data-project-rail=""
        className="flex h-full shrink-0 flex-col items-center gap-2 border-r border-sidebar-border/70 bg-black/[0.035] pt-2 pb-3 dark:bg-black/25"
        style={{ width: PROJECT_RAIL_WIDTH }}
      >
        <RailButton
          label="All projects"
          selected={scopeKey === null}
          attentionCount={attention.total}
          onClick={() => onSelectScope(null)}
        >
          <LayersIcon className="size-4.5" />
        </RailButton>
        <RailButton label="Add project" onClick={onAddProject}>
          <PlusIcon className="size-4.5" />
        </RailButton>
        <div aria-hidden="true" className="h-px w-8 shrink-0 rounded-full bg-sidebar-border" />
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto overscroll-contain py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ProjectRailCardContext value={cardData}>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={entryKeys} strategy={verticalListSortingStrategy}>
                {entries.map((entry) => (
                  <RailEntry
                    key={entry.key}
                    scopeKey={entry.key}
                    project={entry.kind === "project" ? entry.group : null}
                    selected={scopeKey === entry.key}
                    attentionCount={attention.byScopeKey.get(entry.key) ?? 0}
                    onSelectScope={onSelectScope}
                    onOpenProjectSettings={onOpenProjectSettings}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </ProjectRailCardContext>
        </div>
      </nav>
    </TooltipProvider>
  );
});

/**
 * Shows the rail by growing its column in step with the sidebar's own width
 * transition, so toggling it never jumps the thread list. A closing rail stays
 * mounted until the transition ends.
 */
export function ProjectRailReveal(props: { open: boolean; children: ReactNode }) {
  const { active, durationMs } = usePanelAnimationSettings();
  const { present } = usePanelPresence(props.open, true, active, null, durationMs);
  if (!present) return null;
  return (
    <div
      inert={!props.open}
      className={cn(
        "h-full shrink-0 overflow-clip",
        "[[data-panel-animations=true]_&]:transition-[width] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out",
        props.open && "[[data-panel-animations=true]_&]:starting:w-0!",
      )}
      style={{ width: props.open ? PROJECT_RAIL_WIDTH : 0 }}
    >
      {props.children}
    </div>
  );
}
