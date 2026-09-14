import type { HistoryState, RouterHistory } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface HistoryState {
    __T3_settingsReturnIndex?: number;
  }
}

const decoratedHistories = new WeakSet<RouterHistory>();
const SETTINGS_PATH = /^\/settings(?:[/?#]|$)/;
const LEGACY_PROJECT_SETTINGS_PATH = /^\/projects\/[^/?#]+(?:[?#].*)?$/;

function isSettingsPath(path: string): boolean {
  return SETTINGS_PATH.test(path);
}

function isSettingsEntryPath(path: string): boolean {
  return isSettingsPath(path) || LEGACY_PROJECT_SETTINGS_PATH.test(path);
}

function getReturnIndex(state: HistoryState): number | undefined {
  const index = state.__T3_settingsReturnIndex;
  return typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}

function carryReturnIndex(
  history: RouterHistory,
  state: HistoryState | undefined,
  action: "push" | "replace",
): HistoryState | undefined {
  const returnIndex = isSettingsEntryPath(history.location.pathname)
    ? getReturnIndex(history.location.state)
    : action === "push"
      ? history.location.state.__TSR_index
      : undefined;

  return returnIndex === undefined ? state : { ...state, __T3_settingsReturnIndex: returnIndex };
}

export function withSettingsHistory(history: RouterHistory): RouterHistory {
  if (decoratedHistories.has(history)) return history;

  const push = history.push;
  const replace = history.replace;
  // Keep the originating entry on every Settings entry so redirects and section changes
  // can replace or push freely while Back still behaves like ordinary browser history.
  history.push = (path, state, navigateOptions) =>
    push(
      path,
      isSettingsEntryPath(path) ? carryReturnIndex(history, state, "push") : state,
      navigateOptions,
    );
  history.replace = (path, state, navigateOptions) =>
    replace(
      path,
      isSettingsEntryPath(path) ? carryReturnIndex(history, state, "replace") : state,
      navigateOptions,
    );
  decoratedHistories.add(history);
  return history;
}

export function leaveSettings(history: RouterHistory): void {
  if (!isSettingsPath(history.location.pathname)) return;

  const currentIndex = history.location.state.__TSR_index;
  const returnIndex = getReturnIndex(history.location.state);
  if (returnIndex !== undefined && returnIndex < currentIndex) {
    history.go(returnIndex - currentIndex);
    return;
  }

  history.replace("/");
}
