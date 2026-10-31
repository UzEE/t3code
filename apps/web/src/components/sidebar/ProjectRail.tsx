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
import { useAtomValue } from "@effect/atom-react";
import type { KeybindingCommand } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  matchesKeybindingShortcutModifiers,
  PROJECT_RAIL_COMMANDS,
} from "@t3tools/shared/keybindings";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { memo, useEffect, useEffectEvent, useRef, type MouseEvent, type ReactNode } from "react";

import { isCommandPaletteOpen, openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import {
  updateClientSettings,
  useBoringSidebarEnabled,
  useClientSettings,
} from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useTerminalFocus } from "../../hooks/useTerminalFocus";
import {
  findEffectiveShortcutForCommand,
  formatShortcutKeyLabel,
  resolveShortcutCommand,
} from "../../keybindings";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { useServerConfigs } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { projectFaviconUrlAtom } from "../../state/assets";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ProjectRailCardContext, ProjectRailHoverCard } from "./ProjectRailHoverCard";
import { resolveThreadLastVisitedAt, useThreadJumpHintsVisible } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  countProjectRailAttention,
  formatProjectRailBadgeCount,
  isProjectRailEntrySelected,
  NO_PROJECT_SCOPE_KEY,
  orderProjectRailEntries,
  pickRailIconTint,
  PROJECT_RAIL_WIDTH,
  projectRailEntryOrderKeys,
  resolveProjectRailShortcut,
  resolveRailNewThreadProjectRef,
  toggleProjectRailEntryScope,
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

// Shown in the badge's place while the jump modifiers are held, styled like
// the thread list's jump hints.
function RailJumpHint({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -right-1 -bottom-1 z-10 inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
    >
      {label}
    </span>
  );
}

function attentionLabel(label: string, count: number): string {
  if (count === 0) return label;
  return `${label}, ${count} ${count === 1 ? "thread needs" : "threads need"} attention`;
}

const RAIL_TINT_SAMPLE_SIZE = 16;

// Favicons are cached as same-origin data URLs, so the canvas can read them.
const railIconTintAtom = Atom.family((src: string) =>
  Atom.make(
    Effect.promise(async () => {
      try {
        const image = new Image();
        image.src = src;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = RAIL_TINT_SAMPLE_SIZE;
        canvas.height = RAIL_TINT_SAMPLE_SIZE;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(image, 0, 0, RAIL_TINT_SAMPLE_SIZE, RAIL_TINT_SAMPLE_SIZE);
        return pickRailIconTint(
          context.getImageData(0, 0, RAIL_TINT_SAMPLE_SIZE, RAIL_TINT_SAMPLE_SIZE).data,
        );
      } catch {
        return null;
      }
    }),
  ).pipe(Atom.withLabel("project-rail-icon-tint")),
);

const NO_FAVICON_URL_ATOM = Atom.make<string | null>(null).pipe(
  Atom.withLabel("project-rail-favicon-url:none"),
);

const NO_RAIL_ICON_TINT_ATOM = Atom.make(AsyncResult.success(null)).pipe(
  Atom.withLabel("project-rail-icon-tint:none"),
);

/** The colour a project's rail tile is tinted with, or null for a neutral tile. */
function useRailIconTint(project: ProjectFaviconProject | null): string | null {
  const src = useAtomValue(
    project
      ? projectFaviconUrlAtom({
          environmentId: project.environmentId,
          cwd: project.workspaceRoot,
          faviconPath: project.faviconPath,
        })
      : NO_FAVICON_URL_ATOM,
  );
  const icon = project?.projectIcon;
  const sampled = !icon && src && !isProjectFaviconFallbackUrl(src);
  const imageTint = useAtomValue(sampled ? railIconTintAtom(src) : NO_RAIL_ICON_TINT_ATOM);
  if (icon?.kind === "monogram" || icon?.kind === "lucide") {
    return icon.color === "gray" ? null : `var(--color-${icon.color}-500)`;
  }
  return AsyncResult.getOrElse(imageTint, () => null);
}

// One rail slot: the left pill marks the selected scope (tall) and hover
// (short), like Discord's server list. The tile itself never animates.
function RailButton(props: {
  label: string;
  selected?: boolean;
  attentionCount?: number;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined;
  /** Keyboard shortcut shown instead of the badge while its modifiers are held. */
  jumpLabel?: string | null | undefined;
  /** Replaces the plain label tooltip, e.g. with a hover card popup. */
  popup?: ReactNode;
  tooltipDisabled?: boolean;
  /** Colour washed over the tile while selected, e.g. a project icon's dominant colour. */
  tint?: string | null;
  children: ReactNode;
}) {
  const attentionCount = props.attentionCount ?? 0;
  const tintLayer =
    props.tint && props.selected ? `color-mix(in oklab, ${props.tint} 26%, transparent)` : null;
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
                "relative flex size-9 cursor-pointer items-center justify-center rounded-xl text-sidebar-foreground/80 outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
                props.selected
                  ? "bg-sidebar-row-active text-sidebar-foreground shadow-xs/5"
                  : "bg-sidebar/70 hover:bg-sidebar-row-hover hover:text-sidebar-foreground dark:bg-sidebar-row-hover/60 dark:hover:bg-sidebar-row-hover",
              )}
              // A translucent layer over the selected background, not a replacement for it.
              style={
                tintLayer
                  ? { backgroundImage: `linear-gradient(${tintLayer}, ${tintLayer})` }
                  : undefined
              }
            >
              {props.children}
              {props.jumpLabel ? (
                <RailJumpHint label={props.jumpLabel} />
              ) : (
                <RailBadge count={attentionCount} />
              )}
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
  jumpLabel: string | null;
  onSelectEntry: (entryKey: string, additive: boolean) => void;
  onOpenProjectSettings: ProjectRailProps["onOpenProjectSettings"];
}) {
  const { onOpenProjectSettings, onSelectEntry, project, scopeKey } = props;
  const { setNodeRef, transform, transition, listeners, isDragging } = useSortable({
    id: scopeKey,
  });
  const tint = useRailIconTint(project);
  const handleClick = (event: MouseEvent<HTMLButtonElement>) =>
    onSelectEntry(scopeKey, event.metaKey || event.ctrlKey);
  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    if (project) onOpenProjectSettings(event, project);
  };
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
        tint={tint}
        selected={props.selected}
        attentionCount={props.attentionCount}
        jumpLabel={props.jumpLabel}
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
  /** The sidebar filter's project keys; empty means All projects. */
  selectedScopeKeys: readonly string[];
  threads: readonly SidebarThreadSummary[];
  /** Maps `environmentId:projectId` to the rail scope key the thread counts toward. */
  scopeKeyByProjectRef: ReadonlyMap<string, string>;
  /** Changes when a snooze wakes, so woken threads reach the counts. */
  now: string;
  /** Scratch projects behind the "No project" entry, for its hover card. */
  noProjectMembers: readonly SidebarProjectGroupMember[];
  /** Plain click filters to this icon alone; Cmd/Ctrl-click adds or removes it. */
  onSelectEntry: (entryKey: string, additive: boolean) => void;
  onShowAll: () => void;
  onAddProject: () => void;
  onOpenProjectSettings: (
    event: MouseEvent<HTMLButtonElement>,
    project: SidebarProjectSnapshot,
  ) => void;
  /** Shortcut labels while the jump modifiers are held, else null. */
  jumpLabels: {
    readonly all: string | null;
    readonly byScopeKey: ReadonlyMap<string, string>;
  } | null;
}

/**
 * The leftmost column of the thread sidebar: add a project, see every
 * project, or filter the thread list to one or more projects. Each icon
 * carries a count of its threads that need the user.
 */
const ProjectRail = memo(function ProjectRail(props: ProjectRailProps) {
  const {
    entries,
    jumpLabels,
    noProjectMembers,
    now,
    onAddProject,
    onOpenProjectSettings,
    onSelectEntry,
    onShowAll,
    scopeKeyByProjectRef,
    selectedScopeKeys,
    threads,
  } = props;
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  // Visits change this map often; subscribing here keeps those updates from
  // re-rendering the whole thread list.
  const localLastVisitedAtByKey = useUiStateStore((store) => store.threadLastVisitedAtById);
  const attention = countProjectRailAttention({
    threads,
    scopeKeyByProjectRef,
    now,
    resolveLastVisitedAt: (thread) =>
      resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        localLastVisitedAtByKey[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
      ),
  });

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: RAIL_DRAG_DISTANCE } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: RAIL_TOUCH_DRAG_DELAY_MS, tolerance: RAIL_DRAG_DISTANCE },
    }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const orderKeysOf = (key: unknown) => {
      const entry = entries.find((candidate) => candidate.key === key);
      return entry ? projectRailEntryOrderKeys(entry) : [];
    };
    reorderProjects(
      entries.flatMap(projectRailEntryOrderKeys),
      orderKeysOf(active.id),
      orderKeysOf(over.id),
    );
  };
  const entryKeys = entries.map((entry) => entry.key);
  const cardData = { threads, scopeKeyByProjectRef, now, noProjectMembers };

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
          selected={selectedScopeKeys.length === 0}
          attentionCount={attention.total}
          jumpLabel={jumpLabels?.all}
          onClick={onShowAll}
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
                    selected={isProjectRailEntrySelected(entry, selectedScopeKeys)}
                    attentionCount={attention.byScopeKey.get(entry.key) ?? 0}
                    jumpLabel={jumpLabels?.byScopeKey.get(entry.key) ?? null}
                    onSelectEntry={onSelectEntry}
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
 * Selects a newly added project on the rail. Adding a project opens a new
 * draft in it, so a project that appeared after the snapshots loaded and is
 * the route draft's project gets selected once. Projects added elsewhere,
 * such as by an agent or another device, leave the selection alone.
 */
function useSelectAddedRailProject(input: {
  enabled: boolean;
  snapshotsReady: boolean;
  scopeKeyByProjectRef: ReadonlyMap<string, string>;
  /** `environmentId:projectId` of the draft the route shows, else null. */
  routeDraftProjectRef: string | null;
  onSelectScope: (scopeKey: string) => void;
}) {
  const { enabled, onSelectScope, routeDraftProjectRef, scopeKeyByProjectRef, snapshotsReady } =
    input;
  const seenRef = useRef<Set<string> | null>(null);
  const addedRef = useRef(new Set<string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records projects as environment snapshots deliver them, so a project added after load selects its scope when its draft route opens
  useEffect(() => {
    if (!snapshotsReady) return;
    if (seenRef.current === null) {
      seenRef.current = new Set(scopeKeyByProjectRef.keys());
    } else {
      for (const projectRef of scopeKeyByProjectRef.keys()) {
        if (seenRef.current.has(projectRef)) continue;
        seenRef.current.add(projectRef);
        addedRef.current.add(projectRef);
      }
    }
    if (!enabled || routeDraftProjectRef === null) return;
    const scopeKey = scopeKeyByProjectRef.get(routeDraftProjectRef);
    if (scopeKey && addedRef.current.delete(routeDraftProjectRef)) onSelectScope(scopeKey);
  }, [enabled, onSelectScope, routeDraftProjectRef, scopeKeyByProjectRef, snapshotsReady]);
}

/**
 * Shows the rail over the sidebar's left edge, moving the thread list and footer
 * (its later siblings) aside, so upstream's sidebar markup stays untouched. Both
 * animate with the sidebar's own width transition, so toggling never jumps the
 * thread list. A closing rail stays mounted until the transition ends.
 */
function ProjectRailReveal(props: { open: boolean; children: ReactNode }) {
  const { active, durationMs } = usePanelAnimationSettings();
  const { present } = usePanelPresence(props.open, true, active, null, durationMs);
  if (!present) return null;
  return (
    <div
      inert={!props.open}
      className={cn(
        "absolute top-(--workspace-topbar-height) bottom-0 left-0 overflow-clip",
        // The max-width cap keeps full-width siblings like the thread list's scroll area inside the sidebar.
        props.open ? "[&~*]:ml-14 [&~*]:max-w-[calc(100%-3.5rem)]" : "[&~*]:ml-0 [&~*]:max-w-full",
        "[[data-panel-animations=true]_&]:transition-[width] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out",
        "[[data-panel-animations=true]_&~*]:transition-[margin-left,max-width] [[data-panel-animations=true]_&~*]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&~*]:ease-out",
        props.open && "[[data-panel-animations=true]_&]:starting:w-0!",
      )}
      style={{ width: props.open ? PROJECT_RAIL_WIDTH : 0 }}
    >
      {props.children}
    </div>
  );
}

/** On unless the user turned it off; the boring sidebar's folders replace it. */
export function useProjectRailVisible(): boolean {
  const enabled = useClientSettings((settings) => settings.sidebarProjectRailEnabled);
  const boringSidebarEnabled = useBoringSidebarEnabled();
  return enabled && !boringSidebarEnabled;
}

function useScratchScopeKeys(projectGroups: readonly SidebarProjectSnapshot[]): string[] {
  const serverConfigs = useServerConfigs();
  return projectGroups
    .filter((group) =>
      group.memberProjects.some((member) =>
        isScratchProject(member, serverConfigs.get(member.environmentId)?.scratchWorkspaceRoot),
      ),
    )
    .map((group) => group.projectKey);
}

/**
 * Starts new threads in the rail's filtered project. The returned function is
 * for the new-thread button and returns false to leave the default in place.
 */
export function useRailScopedNewThread(input: {
  projectGroups: readonly SidebarProjectSnapshot[];
  selectedScopeKeys: readonly string[];
  newThreadContext: ReturnType<typeof useHandleNewThread>;
  terminalOpen: boolean;
}): () => boolean {
  const { newThreadContext, projectGroups, selectedScopeKeys, terminalOpen } = input;
  const visible = useProjectRailVisible();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const scratchScopeKeys = useScratchScopeKeys(projectGroups);
  const start = () => {
    if (!visible) return false;
    const projectRef = resolveRailNewThreadProjectRef({
      // A new project thread never belongs in a scratch project.
      scopedGroups: projectGroups.filter(
        (group) =>
          selectedScopeKeys.includes(group.projectKey) &&
          !scratchScopeKeys.includes(group.projectKey),
      ),
      activeProjectRef: resolveThreadActionProjectRef({
        activeThread: newThreadContext.activeThread ?? undefined,
        activeDraftThread: newThreadContext.activeDraftThread,
        defaultProjectRef: null,
        handleNewThread: newThreadContext.handleNewThread,
      }),
    });
    if (!projectRef) return false;
    void newThreadContext.handleNewThread(projectRef);
    return true;
  };
  // Capture phase, so the filtered project wins over the chat route's own
  // chat.newLocal handler, which opens the thread in the open thread's project.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) return;
    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: {
        terminalFocus: isTerminalFocused(),
        terminalOpen,
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    });
    if (command !== "chat.newLocal" || !start()) return;
    event.preventDefault();
    event.stopPropagation();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener so the new-thread shortcut starts in the filtered project while mounted
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
  return start;
}

/**
 * The rail, its shortcuts and its link to upstream's sidebar project filter.
 * Stays mounted while the rail is hidden so its shortcuts keep working.
 */
export function ProjectRailColumn(props: {
  projectGroups: readonly SidebarProjectSnapshot[];
  selectedScopeKeys: readonly string[];
  onSelectedScopeKeysChange: (keys: readonly string[]) => void;
  threads: readonly SidebarThreadSummary[];
  now: string;
  snapshotsReady: boolean;
  routeDraftProjectRef: string | null;
  terminalOpen: boolean;
  onOpenProjectSettings: (project: SidebarProjectSnapshot) => void;
}) {
  const { onSelectedScopeKeysChange, projectGroups, selectedScopeKeys, terminalOpen } = props;
  const visible = useProjectRailVisible();
  const enabled = useClientSettings((settings) => settings.sidebarProjectRailEnabled);
  const boringSidebarEnabled = useBoringSidebarEnabled();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();

  const scratchScopeKeys = useScratchScopeKeys(projectGroups);
  const entries = orderProjectRailEntries(
    projectGroups.filter((group) => !scratchScopeKeys.includes(group.projectKey)),
    projectOrder,
    scratchScopeKeys,
  );
  const entryKeys = entries.map((entry) => entry.key);
  // Thread counts on the rail, keyed like the icon they count toward.
  const scopeKeyByProjectRef = new Map(
    projectGroups.flatMap((group) =>
      group.memberProjectRefs.map(
        (projectRef) =>
          [
            `${projectRef.environmentId}:${projectRef.projectId}`,
            scratchScopeKeys.includes(group.projectKey) ? NO_PROJECT_SCOPE_KEY : group.projectKey,
          ] as const,
      ),
    ),
  );
  const noProjectMembers = projectGroups
    .filter((group) => scratchScopeKeys.includes(group.projectKey))
    .flatMap((group) => group.memberProjects);

  const selectEntry = useStableCallback((entryKey: string, additive: boolean) => {
    const entry = entries.find((candidate) => candidate.key === entryKey);
    if (!entry) return;
    onSelectedScopeKeysChange(
      additive ? toggleProjectRailEntryScope(entry, selectedScopeKeys) : entry.scopeKeys,
    );
  });
  const showAll = useStableCallback(() => onSelectedScopeKeysChange([]));
  const selectAddedEntry = useStableCallback((entryKey: string) => selectEntry(entryKey, false));
  const openAddProject = useStableCallback(() => openCommandPalette({ open: "add-project" }));
  const openProjectSettings = useStableCallback(
    (event: MouseEvent<HTMLButtonElement>, project: SidebarProjectSnapshot) => {
      event.preventDefault();
      props.onOpenProjectSettings(project);
    },
  );

  useSelectAddedRailProject({
    enabled: visible,
    snapshotsReady: props.snapshotsReady,
    scopeKeyByProjectRef,
    routeDraftProjectRef: props.routeDraftProjectRef,
    onSelectScope: selectAddedEntry,
  });

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
      return;
    }
    if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]")) {
      return;
    }
    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: {
        terminalFocus: isTerminalFocused(),
        terminalOpen,
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    });
    if (command === PROJECT_RAIL_COMMANDS.toggle) {
      event.preventDefault();
      event.stopPropagation();
      if (!boringSidebarEnabled) void updateClientSettings({ sidebarProjectRailEnabled: !enabled });
      return;
    }
    const target = resolveProjectRailShortcut({
      command,
      entryKeys,
      selectedEntryKey:
        entries.find((entry) => isProjectRailEntrySelected(entry, selectedScopeKeys))?.key ?? null,
    });
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    if (target.entryKey === null) showAll();
    else selectEntry(target.entryKey, false);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for the rail's shortcuts while mounted, ahead of the chat route's script commands
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);

  // Same delay and modifier rule as the thread hints, shown in place of badges.
  const showJumpHints = useThreadJumpHintsVisible(
    visible &&
      !terminalFocused &&
      [PROJECT_RAIL_COMMANDS.showAll, ...PROJECT_RAIL_COMMANDS.jump].some((command) => {
        const shortcut = findEffectiveShortcutForCommand(keybindings, command);
        return (
          shortcut !== null &&
          shortcut !== undefined &&
          matchesKeybindingShortcutModifiers(shortcutModifiers, shortcut, navigator.platform)
        );
      }),
  );
  const keyLabelFor = (command: KeybindingCommand) => {
    const shortcut = findEffectiveShortcutForCommand(keybindings, command);
    return shortcut ? formatShortcutKeyLabel(shortcut.key) : null;
  };
  const jumpLabels = showJumpHints
    ? {
        all: keyLabelFor(PROJECT_RAIL_COMMANDS.showAll),
        byScopeKey: new Map(
          entryKeys.flatMap((entryKey, index) => {
            const command = PROJECT_RAIL_COMMANDS.jump[index];
            const label = command ? keyLabelFor(command) : null;
            return label ? [[entryKey, label] as const] : [];
          }),
        ),
      }
    : null;

  return (
    <ProjectRailReveal open={visible}>
      <ProjectRail
        entries={entries}
        selectedScopeKeys={selectedScopeKeys}
        threads={props.threads}
        scopeKeyByProjectRef={scopeKeyByProjectRef}
        now={props.now}
        noProjectMembers={noProjectMembers}
        onSelectEntry={selectEntry}
        onShowAll={showAll}
        onAddProject={openAddProject}
        onOpenProjectSettings={openProjectSettings}
        jumpLabels={jumpLabels}
      />
    </ProjectRailReveal>
  );
}
