import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import type { SidebarThreadStatus } from "../Sidebar.logic";

export type SidebarThreadStatusIconKind =
  | "working"
  | "input"
  | "approval"
  | "failed"
  | "done"
  | "woke";

export interface SidebarThreadStatusBadge {
  readonly label: string;
  readonly icon: SidebarThreadStatusIconKind | null;
  readonly className: string;
}

/**
 * The status a sidebar thread shows beside its title, shared by thread rows
 * and the project rail's hover card so a thread reads the same everywhere.
 * Hues follow the system-wide convention set by sidebar v1 and the mobile
 * Live Activity/widgets (amber approval, indigo input, sky working).
 */
export function resolveSidebarThreadStatusBadge(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
  /** A native /goal keeps the agent going across turns until it is met. */
  readonly goalActive: boolean;
}): SidebarThreadStatusBadge | null {
  switch (input.status) {
    case "working":
      // No shimmer: a label that animates forever is noise in a sidebar
      // full of them (and repaints every vsync on high-refresh displays).
      return {
        label: input.goalActive ? "Goal" : "Working",
        icon: "working",
        className: "text-info",
      };
    case "waiting":
      // Waiting is calm background presence (post-settle background
      // roster), not active progress, so the label keeps full strength.
      return { label: "Waiting", icon: null, className: "text-muted-foreground" };
    case "approval":
      return { label: "Approval", icon: "approval", className: "text-warning-foreground" };
    case "input":
      return { label: "Input", icon: "input", className: "text-indigo-600 dark:text-indigo-300" };
    case "limited":
      return { label: "Limited", icon: "failed", className: "text-warning" };
    case "failed":
      return { label: "Failed", icon: "failed", className: "text-error" };
    case "ready":
      if (input.isWoke) return { label: "Woke", icon: "woke", className: "text-warning" };
      return input.isUnread ? { label: "Done", icon: "done", className: "text-success" } : null;
  }
}

const ICON_BY_KIND = {
  working: CircleDashedIcon,
  input: MessageCircleQuestionIcon,
  approval: ShieldQuestionIcon,
  failed: CircleAlertIcon,
  done: CircleCheckIcon,
  woke: AlarmClockIcon,
} satisfies Record<SidebarThreadStatusIconKind, unknown>;

export function SidebarThreadStatusIcon(props: {
  icon: SidebarThreadStatusIconKind;
  className?: string | undefined;
}) {
  const Icon = ICON_BY_KIND[props.icon];
  return <Icon aria-hidden className={cn("size-4 shrink-0", props.className)} />;
}
