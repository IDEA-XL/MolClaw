import type {
  ClaudeSkillCandidate,
  ClaudeSkillInvocationHint,
  ClaudeSkillRegistry,
  ClaudeSkillSelectionInput,
  ClaudeSkillSummary,
} from './types.js';

const DEFAULT_MAX_SKILLS = 8;

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function extractExplicitInvocations(
  prompt: string,
): Map<string, ClaudeSkillInvocationHint> {
  const invocations = new Map<string, ClaudeSkillInvocationHint>();
  const patterns = [
    { regex: /(?:^|[\s(])\/([a-z0-9][a-z0-9._-]*)(?:\s+([^\n]+))?/gi, triggerPrefix: '/' },
    { regex: /(?:^|\s)\$([a-z0-9][a-z0-9._-]*)(?:\s+([^\n]+))?/gi, triggerPrefix: '$' },
    { regex: /skill\s*:\s*["']?([a-z0-9][a-z0-9._-]*)["']?(?:\s+([^\n]+))?/gi, triggerPrefix: 'skill:' },
    { regex: /use skill\s+["']?([a-z0-9][a-z0-9._-]*)["']?(?:\s+([^\n]+))?/gi, triggerPrefix: 'use skill ' },
  ];

  for (const { regex, triggerPrefix } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(prompt)) !== null) {
      const key = normalizeLookupKey(match[1]);
      const args = typeof match[2] === 'string' ? match[2].trim() : '';
      invocations.set(key, {
        trigger: `${triggerPrefix}${match[1]}`,
        args: args || undefined,
        explicit: true,
      });
    }
  }

  return invocations;
}

function toSkillSummary(skill: ClaudeSkillCandidate['skill']): ClaudeSkillSummary {
  return {
    name: skill.frontmatter.name,
    description: skill.frontmatter.description,
    whenToUse: skill.frontmatter.whenToUse,
    aliases: skill.frontmatter.aliases,
    paths: skill.frontmatter.paths,
    model: skill.frontmatter.model,
    userInvocable: skill.frontmatter.userInvocable,
    disableModelInvocation: skill.frontmatter.disableModelInvocation,
  };
}

export function resolveExplicitClaudeSkillCandidates(
  registry: ClaudeSkillRegistry,
  prompt: string,
): ClaudeSkillCandidate[] {
  const explicitInvocations = extractExplicitInvocations(prompt);
  const seen = new Set<string>();
  const matches: ClaudeSkillCandidate[] = [];

  for (const [lookupKey, invocationHint] of explicitInvocations) {
    const skill = registry.byLookupKey.get(lookupKey);
    if (!skill) continue;
    if (seen.has(skill.filePath)) continue;
    seen.add(skill.filePath);
    matches.push({
      skill,
      score: 0,
      reasons: [`explicit:${invocationHint.trigger}`],
      explicitlyRequested: true,
      invocationHint,
    });
  }

  return matches;
}

export function selectRelevantClaudeSkillCandidates(
  registry: ClaudeSkillRegistry,
  input: ClaudeSkillSelectionInput,
): ClaudeSkillCandidate[] {
  const maxSkills = input.maxSkills ?? DEFAULT_MAX_SKILLS;
  return resolveExplicitClaudeSkillCandidates(registry, input.prompt)
    .slice(0, maxSkills > 0 ? maxSkills : DEFAULT_MAX_SKILLS);
}

export function selectRelevantClaudeSkills(
  registry: ClaudeSkillRegistry,
  input: ClaudeSkillSelectionInput,
): ClaudeSkillSummary[] {
  const maxSkills = input.maxSkills ?? DEFAULT_MAX_SKILLS;
  return resolveExplicitClaudeSkillCandidates(
    registry,
    input.prompt,
  )
    .slice(0, maxSkills > 0 ? maxSkills : DEFAULT_MAX_SKILLS)
    .map((entry) => toSkillSummary(entry.skill));
}
