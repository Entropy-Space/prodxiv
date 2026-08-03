import paperBenchmarks from "../../../skills/paperbot/references/paper-benchmarks.md" with { type: "text" };
import paperFigures from "../../../skills/paperbot/references/paper-figures.md" with { type: "text" };
import paperReferences from "../../../skills/paperbot/references/paper-references.md" with { type: "text" };
import paperSkill from "../../../skills/paperbot/references/paper-skill.md" with { type: "text" };
import paperStructure from "../../../skills/paperbot/references/paper-structure.md" with { type: "text" };
import projectArchitecture from "../../../skills/paperbot/references/project-architecture.md" with { type: "text" };
import projectDiscovery from "../../../skills/paperbot/references/project-discovery.md" with { type: "text" };
import projectIntent from "../../../skills/paperbot/references/project-intent.md" with { type: "text" };
import projectSkill from "../../../skills/paperbot/references/project-skill.md" with { type: "text" };
import publicationReadiness from "../../../skills/paperbot/references/publication-readiness.md" with { type: "text" };
import publicationSkill from "../../../skills/paperbot/references/publication-skill.md" with { type: "text" };
import publicationSubmission from "../../../skills/paperbot/references/publication-submission.md" with { type: "text" };

export type SkillScope = "project" | "paper" | "publication";
export const SKILL_SCHEMA_VERSION = "1" as const;

export interface SkillComponent {
  component: string;
  description: string;
  instructions: string;
}

export interface SkillScopeDefinition {
  scope: SkillScope;
  description: string;
  instructions: string;
  components: readonly SkillComponent[];
}

export const skillCatalog: readonly SkillScopeDefinition[] = [
  {
    scope: "project",
    description: "Understand repository evidence and product intent.",
    instructions: projectSkill,
    components: [
      {
        component: "discovery",
        description: "Map the product and its inspectable evidence.",
        instructions: projectDiscovery,
      },
      {
        component: "architecture",
        description: "Explain implementation boundaries and flows.",
        instructions: projectArchitecture,
      },
      {
        component: "intent",
        description: "Interview the author about knowledge code cannot prove.",
        instructions: projectIntent,
      },
    ],
  },
  {
    scope: "paper",
    description: "Author evidence-backed product paper content.",
    instructions: paperSkill,
    components: [
      {
        component: "structure",
        description: "Assemble and revise the complete paper.",
        instructions: paperStructure,
      },
      {
        component: "references",
        description: "Research related work and cite public sources.",
        instructions: paperReferences,
      },
      {
        component: "benchmarks",
        description: "Include only reproducible measured results.",
        instructions: paperBenchmarks,
      },
      {
        component: "figures",
        description: "Create safe, accessible, evidence-aware SVG figures.",
        instructions: paperFigures,
      },
    ],
  },
  {
    scope: "publication",
    description: "Prepare and explicitly submit an immutable version.",
    instructions: publicationSkill,
    components: [
      {
        component: "readiness",
        description: "Perform the final evidence, privacy, and format review.",
        instructions: publicationReadiness,
      },
      {
        component: "submission",
        description: "Submit the exact approved Markdown safely.",
        instructions: publicationSubmission,
      },
    ],
  },
] as const;

export function findSkillScope(
  scope: string,
): SkillScopeDefinition | undefined {
  return skillCatalog.find((entry) => entry.scope === scope);
}

export function findSkillComponent(
  scope: string,
  component: string,
): SkillComponent | undefined {
  return findSkillScope(scope)?.components.find(
    (entry) => entry.component === component,
  );
}

export function formatSkillCatalog(): string {
  return [
    "Paperbot skill scopes",
    "",
    ...skillCatalog.map(
      ({ scope, description }) => `${scope} — ${description}`,
    ),
    "",
    "Run paperbot skills <scope> to load its guidance.",
  ].join("\n");
}

export function getSkillCatalog(): Record<string, unknown> {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    scopes: skillCatalog.map(({ scope, description }) => ({
      scope,
      description,
    })),
  };
}

export function getSkillRead(
  scopeName: string,
  componentName?: string,
): Record<string, unknown> {
  const scope = findSkillScope(scopeName);
  if (scope === undefined) {
    throw new Error(`unknown skill scope: ${scopeName}`);
  }
  if (componentName === undefined) {
    return {
      schema_version: SKILL_SCHEMA_VERSION,
      scope: scope.scope,
      description: scope.description,
      instructions: scope.instructions.trim(),
      components: scope.components.map(({ component, description }) => ({
        component,
        description,
      })),
    };
  }
  const component = findSkillComponent(scope.scope, componentName);
  if (component === undefined) {
    throw new Error(`unknown ${scope.scope} skill component: ${componentName}`);
  }
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    scope: scope.scope,
    component: component.component,
    description: component.description,
    instructions: component.instructions.trim(),
  };
}
