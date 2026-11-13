import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { foldSearchQuery, rankSearchItems, scoreSearchTerms } from "@t3tools/shared/paletteSearch";

const COMPOSER_PROJECT_RESULT_LIMIT = 5;

export interface ComposerProjectItem {
  readonly id: string;
  readonly type: "project";
  readonly project: EnvironmentProject;
  /** The linked machine's name, or undefined for the composer's own environment. */
  readonly machine: string | undefined;
  readonly label: string;
  readonly description: string;
}

function folderName(workspaceRoot: string): string {
  return (
    workspaceRoot
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .pop() ?? workspaceRoot
  );
}

/**
 * Projects to name from the `@` picker. Like threads, candidates stay on machines the agent
 * can reach (its own and linked ones), and a bare `@` matches none.
 */
export function matchComposerProjectItems(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId;
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly query: string;
}): ComposerProjectItem[] {
  const query = foldSearchQuery(input.query);
  if (query.length === 0) return [];
  const candidates = input.projects.filter(
    (project) =>
      (project.environmentId === input.environmentId ||
        input.linkedEnvironments.has(project.environmentId)) &&
      project.isScratch !== true &&
      !project.archivedAt,
  );
  return rankSearchItems(candidates, (project, options) =>
    scoreSearchTerms(
      query,
      [foldSearchQuery(project.title), foldSearchQuery(folderName(project.workspaceRoot))],
      options,
    ),
  )
    .slice(0, COMPOSER_PROJECT_RESULT_LIMIT)
    .map(({ item: project }) => {
      const machine =
        project.environmentId === input.environmentId
          ? undefined
          : input.linkedEnvironments.get(project.environmentId);
      return {
        id: `project:${project.environmentId}:${project.id}`,
        type: "project",
        project,
        machine,
        label: project.title,
        description: machine === undefined ? "Project" : `Project on ${machine}`,
      };
    });
}

/** Plain text, so official servers pass it through: the folder lets the agent find the project. */
export function formatComposerProjectMention(item: ComposerProjectItem): string {
  const where = item.machine === undefined ? "" : ` on ${item.machine}`;
  return `${item.label} (project at ${item.project.workspaceRoot}${where})`;
}
