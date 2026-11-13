import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { formatComposerProjectMention, matchComposerProjectItems } from "./composerProjectMentions";

const environmentId = EnvironmentId.make("env-composer");
const linkedId = EnvironmentId.make("env-linked");

function project(
  id: string,
  title: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

it("matches reachable projects by title or folder and formats them as plain text", () => {
  const items = matchComposerProjectItems({
    projects: [
      project("title", "Customer billing portal", "/src/portal"),
      project("folder", "Docs", "/src/billing-docs"),
      project("archived", "Billing archive", "/src/old", {
        archivedAt: "2026-10-02T00:00:00.000Z",
      }),
      project("scratch", "Billing scratch", "/tmp/scratch", { isScratch: true }),
      project("unlinked", "Billing elsewhere", "/src/x", {
        environmentId: EnvironmentId.make("env-unlinked"),
      }),
      project("linked", "Billing on mac", "/Users/me/billing", { environmentId: linkedId }),
    ],
    environmentId,
    linkedEnvironments: new Map([[linkedId, "macbook"]]),
    query: "bill",
  });

  expect(items.map((item) => item.project.id).toSorted()).toEqual(["folder", "linked", "title"]);
  const linked = items.find((item) => item.project.id === "linked")!;
  expect(linked.description).toBe("Project on macbook");
  expect(formatComposerProjectMention(linked)).toBe(
    "Billing on mac (project at /Users/me/billing on macbook)",
  );
  expect(
    matchComposerProjectItems({
      projects: [project("bare", "Billing", "/src/b")],
      environmentId,
      linkedEnvironments: new Map(),
      query: " ",
    }),
  ).toEqual([]);
});
