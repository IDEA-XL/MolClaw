import type {
  ClaudeSkillInvocationHint,
  ClaudeSkillRecord,
  ClaudeSkillSummary,
  ToolDefinition,
} from './types.js';

function asStringList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function buildClaudeSkillToolDefinition(
  skills: ClaudeSkillSummary[],
): ToolDefinition | null {
  if (skills.length === 0) {
    return null;
  }

  const skillDescriptions = skills
    .map((skill) => {
      const parts = [
        `- ${skill.name}: ${skill.description.trim()}`,
      ];
      if (skill.whenToUse) {
        parts.push(`  when_to_use: ${skill.whenToUse.trim()}`);
      }
      if (skill.aliases && skill.aliases.length > 0) {
        parts.push(`  aliases: ${skill.aliases.join(', ')}`);
      }
      if (skill.paths && skill.paths.length > 0) {
        parts.push(`  paths: ${skill.paths.join(', ')}`);
      }
      if (skill.model) {
        parts.push(`  model: ${skill.model}`);
      }
      if (typeof skill.userInvocable === 'boolean') {
        parts.push(`  user_invocable: ${String(skill.userInvocable)}`);
      }
      if (typeof skill.disableModelInvocation === 'boolean') {
        parts.push(`  disable_model_invocation: ${String(skill.disableModelInvocation)}`);
      }
      return parts.join('\n');
    })
    .join('\n');

  return {
    type: 'function',
    function: {
      name: 'skill',
      description: [
        'Execute a skill within the main conversation.',
        '',
        '<skills_instructions>',
        'When users ask you to perform tasks, check whether any available skill can help complete the task more effectively.',
        'Use this tool with the skill name only. Do not pass extra arguments.',
        'When a skill is relevant, invoke this tool immediately as your first action before using normal tools.',
        'Never merely mention a skill in text without actually calling this tool.',
        'This is a blocking requirement: invoke the relevant skill tool before generating any other response about the task.',
        'Only use skills listed in <available_claude_skills> below.',
        'When a loaded skill references scripts, assets, templates, or documents, always resolve absolute paths from that skill base directory.',
        '</skills_instructions>',
        '',
        '<available_claude_skills>',
        skillDescriptions,
        '</available_claude_skills>',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'Exact skill name to load from /home/node/.claude/skills.',
          },
        },
        required: ['skill'],
      },
    },
  };
}

export function renderClaudeSkillForContext(skill: ClaudeSkillRecord): string {
  const allowedToolsNote = skill.frontmatter.allowedTools && skill.frontmatter.allowedTools.length > 0
    ? `Allowed tools: ${skill.frontmatter.allowedTools.join(', ')}`
    : '';
  const whenToUseNote = skill.frontmatter.whenToUse
    ? `When to use: ${skill.frontmatter.whenToUse}`
    : '';
  const argumentsNote = asStringList(skill.frontmatter.arguments).length > 0
    ? `Declared arguments: ${asStringList(skill.frontmatter.arguments).join(', ')}`
    : '';
  const hooksNote = asStringList(skill.frontmatter.hooks).length > 0
    ? `Declared hooks: ${asStringList(skill.frontmatter.hooks).join(', ')}`
    : '';

  return [
    `Skill name: ${skill.frontmatter.name}`,
    `Skill file: ${skill.filePath}`,
    `Base directory for this skill: ${skill.baseDir}`,
    'Important: resolve any referenced scripts, assets, templates, or documents from this base directory.',
    allowedToolsNote,
    whenToUseNote,
    argumentsNote,
    hooksNote,
    '',
    skill.body,
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderClaudeSkillInvocationHint(
  hint: ClaudeSkillInvocationHint | undefined,
): string {
  if (!hint) return '';
  return [
    `Invocation trigger: ${hint.trigger}`,
    hint.args ? `Invocation args: ${hint.args}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderClaudeSkillLoadedReminder(skill: ClaudeSkillRecord): string {
  return [
    '<system-reminder>',
    `Skill "${skill.frontmatter.name}" is now loaded for the current task.`,
    'Treat the loaded skill content as workflow instructions.',
    'Follow that workflow unless it is blocked, clearly inapplicable, or the user explicitly requests a different approach.',
    'If you must deviate, explain why before using an alternative workflow.',
    '</system-reminder>',
  ].join('\n');
}
