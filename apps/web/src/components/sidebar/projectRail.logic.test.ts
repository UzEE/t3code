import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  countProjectRailAttention,
  moveProjectRailEntry,
  NO_PROJECT_SCOPE_KEY,
  orderProjectRailEntries,
  selectProjectRailPreviewThreads,
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
  it("puts No project first, then projects in the order they were added", () => {
    const keys = orderProjectRailEntries([gamma, alpha, beta], []).map((entry) => entry.key);
    expect(keys).toEqual([NO_PROJECT_SCOPE_KEY, "alpha", "beta", "gamma"]);
  });

  it("keeps a dragged order and appends projects added after it", () => {
    const savedOrder = moveProjectRailEntry(
      orderProjectRailEntries([alpha, beta], []),
      NO_PROJECT_SCOPE_KEY,
      "beta",
    );
    expect(savedOrder).toEqual(["alpha", "beta-local", "beta-remote", NO_PROJECT_SCOPE_KEY]);

    const keys = orderProjectRailEntries([gamma, beta, alpha], savedOrder!).map(
      (entry) => entry.key,
    );
    expect(keys).toEqual(["alpha", "beta", NO_PROJECT_SCOPE_KEY, "gamma"]);
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

    expect(result.total).toBe(4);
    expect(result.byScopeKey.get("project-1")).toBe(2);
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
