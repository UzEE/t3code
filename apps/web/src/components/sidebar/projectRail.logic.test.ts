import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { KeybindingRule } from "@t3tools/contracts";
import { PROJECT_RAIL_COMMANDS } from "@t3tools/shared/keybindings";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  countProjectRailAttention,
  isProjectRailEntrySelected,
  NO_PROJECT_SCOPE_KEY,
  orderProjectRailEntries,
  pickRailIconTint,
  resolveProjectRailShortcut,
  resolveRailNewThreadProjectRef,
  selectProjectRailPreviewThreads,
  toggleProjectRailEntryScope,
} from "./projectRail.logic";

const environmentId = EnvironmentId.make("environment-local");

function makeGroup(key: string, createdAt: string, memberKeys: readonly string[] = [key]) {
  return {
    projectKey: key,
    createdAt,
    memberProjects: memberKeys.map((physicalProjectKey) => ({ physicalProjectKey, createdAt })),
  };
}

const alpha = makeGroup("alpha", "2026-01-01T00:00:00.000Z");
const beta = makeGroup("beta", "2026-02-01T00:00:00.000Z", ["beta-local", "beta-remote"]);
const gamma = makeGroup("gamma", "2026-03-01T00:00:00.000Z");

describe("orderProjectRailEntries", () => {
  const scratch = ["scratch-local", "scratch-remote"];

  it("puts No project first, then projects in the order they were added", () => {
    const keys = orderProjectRailEntries([gamma, alpha, beta], [], scratch).map(
      (entry) => entry.key,
    );
    expect(keys).toEqual([NO_PROJECT_SCOPE_KEY, "alpha", "beta", "gamma"]);
  });

  it("leaves out No project when there are no scratch projects", () => {
    const keys = orderProjectRailEntries([beta, alpha], [], []).map((entry) => entry.key);
    expect(keys).toEqual(["alpha", "beta"]);
  });

  it("keeps a saved order and appends projects added after it", () => {
    const savedOrder = ["alpha", "beta-local", NO_PROJECT_SCOPE_KEY, "beta-remote"];
    const keys = orderProjectRailEntries([gamma, beta, alpha], savedOrder, scratch).map(
      (entry) => entry.key,
    );
    expect(keys).toEqual(["alpha", "beta", NO_PROJECT_SCOPE_KEY, "gamma"]);
  });
});

describe("project rail selection", () => {
  const noProject = { scopeKeys: ["scratch-local", "scratch-remote"] };
  const project = { scopeKeys: ["alpha"] };

  it("lights every icon the filter fully holds", () => {
    const selected = ["alpha", "scratch-local", "scratch-remote"];
    expect(isProjectRailEntrySelected(project, selected)).toBe(true);
    expect(isProjectRailEntrySelected(noProject, selected)).toBe(true);
    expect(isProjectRailEntrySelected(noProject, ["scratch-local"])).toBe(false);
  });

  it("adds an unlit icon to the filter and removes a lit one", () => {
    expect(toggleProjectRailEntryScope(noProject, ["alpha"])).toEqual([
      "alpha",
      "scratch-local",
      "scratch-remote",
    ]);
    expect(
      toggleProjectRailEntryScope(noProject, ["alpha", "scratch-local", "scratch-remote"]),
    ).toEqual(["alpha"]);
    expect(toggleProjectRailEntryScope(project, ["alpha"])).toEqual([]);
  });
});

describe("resolveProjectRailShortcut", () => {
  const entryKeys = [NO_PROJECT_SCOPE_KEY, "alpha", "beta"];
  const { jump, next, previous, showAll } = PROJECT_RAIL_COMMANDS;
  const go = (command: string, selectedEntryKey: string | null) =>
    resolveProjectRailShortcut({ command, entryKeys, selectedEntryKey })?.entryKey;

  it("jumps to rail positions as shown, and to All projects", () => {
    expect(go(jump[0], "beta")).toBe(NO_PROJECT_SCOPE_KEY);
    expect(go(jump[2], null)).toBe("beta");
    expect(go(jump[3], null)).toBeUndefined();
    expect(go(showAll, "alpha")).toBeNull();
  });

  it("steps through All projects and the rail, stopping at the ends", () => {
    expect(go(next, null)).toBe(NO_PROJECT_SCOPE_KEY);
    expect(go(next, "alpha")).toBe("beta");
    expect(go(next, "beta")).toBeUndefined();
    expect(go(previous, NO_PROJECT_SCOPE_KEY)).toBeNull();
    expect(go(previous, null)).toBeUndefined();
    expect(go("thread.next", "alpha")).toBeUndefined();
  });

  it("uses command ids that a server without rail code can save", () => {
    const decode = Schema.decodeUnknownSync(KeybindingRule);
    for (const command of [PROJECT_RAIL_COMMANDS.toggle, showAll, previous, next, ...jump]) {
      expect(decode({ key: "mod+shift+y", command }).command).toBe(command);
    }
  });
});

describe("countProjectRailAttention", () => {
  const thread = (id: string, projectId: string, overrides = {}) =>
    makeThreadFixture({
      id: ThreadId.make(id),
      environmentId,
      projectId: ProjectId.make(projectId),
      ...overrides,
    });
  const completedRun = {
    runId: "run-1" as never,
    status: "completed" as const,
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: "2026-03-09T10:05:00.000Z",
  };

  it("counts blocked threads and unseen completions per scope", () => {
    const threads = [
      thread("approval", "p1", { hasPendingApprovals: true }),
      thread("guest-request", "p1", { pendingGuestMessageCount: 1 }),
      thread("unseen", "p1", {
        latestRun: completedRun,
        lastVisitedAt: "2026-03-09T10:01:00.000Z",
      }),
      thread("seen", "p1", { latestRun: completedRun, lastVisitedAt: "2026-03-09T10:06:00.000Z" }),
      thread("settled", "p1", { hasPendingUserInput: true, settledOverride: "settled" }),
      thread("archived", "p1", {
        hasPendingUserInput: true,
        archivedAt: "2026-03-09T10:00:00.000Z",
      }),
      thread("scratch-input", "scratch", { hasPendingUserInput: true }),
      thread("unscoped", "elsewhere", { hasPendingApprovals: true }),
    ];
    const result = countProjectRailAttention({
      threads,
      scopeKeyByProjectRef: new Map([
        [`${environmentId}:p1`, "project-1"],
        [`${environmentId}:scratch`, NO_PROJECT_SCOPE_KEY],
      ]),
      resolveLastVisitedAt: (entry) => entry.lastVisitedAt ?? undefined,
      now: "2026-03-09T11:00:00.000Z",
    });

    expect(result.total).toBe(5);
    expect(result.byScopeKey.get("project-1")).toBe(3);
    expect(result.byScopeKey.get(NO_PROJECT_SCOPE_KEY)).toBe(1);
  });

  it("previews unsettled threads in scope, ones needing the user first", () => {
    const threads = [
      thread("quiet", "p1"),
      thread("other-project", "p2", { hasPendingApprovals: true }),
      thread("settled", "p1", { settledOverride: "settled" }),
      thread("blocked", "p1", { hasPendingUserInput: true }),
      thread("unseen", "p1", {
        latestRun: completedRun,
        lastVisitedAt: "2026-03-09T10:01:00.000Z",
      }),
    ];
    const preview = selectProjectRailPreviewThreads({
      threads,
      scopeKey: "project-1",
      scopeKeyByProjectRef: new Map([
        [`${environmentId}:p1`, "project-1"],
        [`${environmentId}:p2`, "project-2"],
      ]),
      resolveLastVisitedAt: (entry) => entry.lastVisitedAt ?? undefined,
      now: "2026-03-09T11:00:00.000Z",
      limit: 2,
    });

    expect(preview.total).toBe(3);
    expect(preview.threads.map((entry) => [entry.thread.id, entry.isUnread])).toEqual(
      expect.arrayContaining([
        ["blocked", false],
        ["unseen", true],
      ]),
    );
  });
});

describe("resolveRailNewThreadProjectRef", () => {
  const remoteId = EnvironmentId.make("environment-remote");
  const local = { environmentId, projectId: ProjectId.make("pageship-local") };
  const remote = { environmentId: remoteId, projectId: ProjectId.make("pageship-remote") };
  const pageship = {
    environmentId,
    id: local.projectId,
    memberProjectRefs: [local, remote],
  };

  it("opens new threads in the scoped project, not the open thread's", () => {
    const other = { environmentId, projectId: ProjectId.make("t3code") };
    expect(
      resolveRailNewThreadProjectRef({ scopedGroups: [pageship], activeProjectRef: other }),
    ).toEqual(local);
    expect(
      resolveRailNewThreadProjectRef({ scopedGroups: [pageship], activeProjectRef: null }),
    ).toEqual(local);
  });

  it("prefers the scoped project's copy in the open thread's environment", () => {
    const otherRemote = { environmentId: remoteId, projectId: ProjectId.make("t3code-remote") };
    expect(
      resolveRailNewThreadProjectRef({ scopedGroups: [pageship], activeProjectRef: otherRemote }),
    ).toEqual(remote);
  });

  it("keeps the default when unscoped or the open thread is in scope", () => {
    expect(resolveRailNewThreadProjectRef({ scopedGroups: [], activeProjectRef: local })).toBe(
      null,
    );
    expect(
      resolveRailNewThreadProjectRef({ scopedGroups: [pageship], activeProjectRef: remote }),
    ).toBe(null);
  });
});

describe("pickRailIconTint", () => {
  const pixels = (...runs: ReadonlyArray<[count: number, rgba: readonly number[]]>) =>
    new Uint8ClampedArray(
      runs.flatMap(([count, rgba]) => Array.from({ length: count }, () => rgba).flat()),
    );

  it("averages the most common hue and ignores transparent, white and grey pixels", () => {
    expect(
      pickRailIconTint(
        pixels(
          [6, [0, 100, 240, 255]],
          [2, [20, 120, 220, 255]],
          [3, [230, 30, 30, 255]],
          [10, [0, 0, 0, 0]],
          [5, [255, 255, 255, 255]],
          [4, [128, 128, 128, 255]],
        ),
      ),
    ).toBe("rgb(5 105 235)");
  });

  it("returns null for monochrome icons and minor accents", () => {
    expect(pickRailIconTint(pixels([8, [0, 0, 0, 255]], [8, [250, 250, 250, 255]]))).toBe(null);
    expect(pickRailIconTint(pixels([1, [230, 30, 30, 255]], [19, [20, 20, 20, 255]]))).toBe(null);
    expect(pickRailIconTint(new Uint8ClampedArray())).toBe(null);
  });
});
