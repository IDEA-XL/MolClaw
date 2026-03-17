import fs from 'fs';
import path from 'path';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export interface ChatMessageLike {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
}

export interface ClaudeSkillFrontmatter {
  name: string;
  description: string;
  aliases?: string[];
  whenToUse?: string;
  allowedTools?: string[];
  paths?: string[];
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  model?: string;
  displayName?: string;
  arguments?: string | string[];
  hooks?: string | string[];
}

export interface ClaudeSkillRecord {
  frontmatter: ClaudeSkillFrontmatter;
  filePath: string;
  baseDir: string;
  body: string;
}

export interface ClaudeSkillRegistry {
  all: ClaudeSkillRecord[];
  byName: Map<string, ClaudeSkillRecord>;
  byLookupKey: Map<string, ClaudeSkillRecord>;
  parseErrors: Array<{
    filePath: string;
    message: string;
  }>;
}

export interface ClaudeSkillSummary {
  name: string;
  description: string;
  whenToUse?: string;
  aliases?: string[];
  paths?: string[];
  model?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
}

export interface ClaudeSkillSelectionInput {
  prompt: string;
  sessionMessages: ChatMessageLike[];
  maxSkills?: number;
  runtimeModel?: string;
}

export interface ClaudeSkillCandidate {
  skill: ClaudeSkillRecord;
  score: number;
  reasons: string[];
  explicitlyRequested: boolean;
  invocationHint?: ClaudeSkillInvocationHint;
}

export interface ClaudeSkillInvocationHint {
  trigger: string;
  args?: string;
  explicit: boolean;
}

const SKILL_MANIFEST_FILE = 'SKILL.md';
const DEFAULT_MAX_SKILLS = 8;

function normalizeContent(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeFrontmatterKey(rawKey: string): string {
  const compact = rawKey.trim().replace(/[_\s]+/g, '-').toLowerCase();
  switch (compact) {
    case 'allowed-tools':
    case 'allowedtools':
      return 'allowedTools';
    case 'when-to-use':
    case 'whentouse':
      return 'whenToUse';
    case 'user-invocable':
    case 'userinvocable':
      return 'userInvocable';
    case 'disable-model-invocation':
    case 'disablemodelinvocation':
      return 'disableModelInvocation';
    case 'display-name':
    case 'displayname':
      return 'displayName';
    default:
      return rawKey.trim();
  }
}

function parseScalar(rawValue: string): string | boolean {
  const trimmed = rawValue.trim();
  if (!trimmed) return '';

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1);
  }

  const lowered = trimmed.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;

  return trimmed;
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => String(item).trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized ? [normalized] : undefined;
  }

  return [String(value)];
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  return undefined;
}

function parseFrontmatter(frontmatterYaml: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  let currentKey: string | null = null;

  for (const rawLine of frontmatterYaml.split('\n')) {
    const line = rawLine.replace(/\t/g, '  ');
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const listMatch = line.match(/^\s*-\s*(.+?)\s*$/);
    if (listMatch && currentKey) {
      const existing = parsed[currentKey];
      const item = parseScalar(listMatch[1]);
      if (Array.isArray(existing)) {
        existing.push(item);
      } else if (existing === undefined || existing === '') {
        parsed[currentKey] = [item];
      } else {
        parsed[currentKey] = [existing, item];
      }
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_.\-_]+):(?:\s*(.*))?$/);
    if (!keyMatch) {
      currentKey = null;
      continue;
    }

    const normalizedKey = normalizeFrontmatterKey(keyMatch[1]);
    const rawValue = keyMatch[2] ?? '';
    currentKey = normalizedKey;

    if (!rawValue.trim()) {
      parsed[normalizedKey] = '';
      continue;
    }

    parsed[normalizedKey] = parseScalar(rawValue);
  }

  return parsed;
}

function asStringList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : value.split(',').map((item) => item.trim()).filter(Boolean);
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

function buildLookupKeys(skill: ClaudeSkillRecord): string[] {
  const keys = new Set<string>();
  keys.add(normalizeLookupKey(skill.frontmatter.name));
  if (skill.frontmatter.displayName) {
    keys.add(normalizeLookupKey(skill.frontmatter.displayName));
  }
  for (const alias of skill.frontmatter.aliases || []) {
    keys.add(normalizeLookupKey(alias));
  }
  return Array.from(keys);
}

function inferSkillNameFromPath(filePath: string): string {
  const baseDir = path.basename(path.dirname(filePath)).trim();
  return baseDir || 'unnamed-skill';
}

function extractMarkdownTitle(content: string): string {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^#\s+(.+?)\s*$/);
    if (heading) {
      return heading[1].trim();
    }
  }
  return '';
}

function extractDescriptionFallback(content: string): string {
  const blocks = content
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const block of blocks) {
    if (/^#/.test(block)) continue;
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^#/.test(line));
    if (lines.length === 0) continue;
    const description = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (description) {
      return description.length > 240
        ? `${description.slice(0, 237).trimEnd()}...`
        : description;
    }
  }

  const title = extractMarkdownTitle(content);
  return title || 'Skill loaded from SKILL.md';
}

export function parseClaudeSkillContent(
  content: string,
  filePath: string,
): ClaudeSkillRecord {
  const normalizedContent = normalizeContent(content);
  const frontmatterMatch = normalizedContent.match(
    /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/,
  );
  const parsed = frontmatterMatch
    ? parseFrontmatter(frontmatterMatch[1])
    : {};
  const body = frontmatterMatch ? frontmatterMatch[2] : normalizedContent;

  const inferredName = inferSkillNameFromPath(filePath);
  const inferredDescription = extractDescriptionFallback(body);
  const name = String(parsed.name || inferredName).trim();
  const description = String(parsed.description || inferredDescription).trim();

  if (!name) {
    throw new Error('Missing skill name');
  }
  if (!description) {
    throw new Error('Missing skill description');
  }

  const record: ClaudeSkillRecord = {
    frontmatter: {
      name,
      description,
      aliases: asStringArray(parsed.aliases),
      whenToUse:
        typeof parsed.whenToUse === 'string' && parsed.whenToUse.trim()
          ? parsed.whenToUse.trim()
          : undefined,
      allowedTools: asStringArray(parsed.allowedTools),
      paths: asStringArray(parsed.paths),
      userInvocable: asBoolean(parsed.userInvocable),
      disableModelInvocation: asBoolean(parsed.disableModelInvocation),
      model:
        typeof parsed.model === 'string' && parsed.model.trim()
          ? parsed.model.trim()
          : undefined,
      displayName:
        typeof parsed.displayName === 'string' && parsed.displayName.trim()
          ? parsed.displayName.trim()
          : (extractMarkdownTitle(body) || undefined),
      arguments:
        typeof parsed.arguments === 'string' || Array.isArray(parsed.arguments)
          ? (parsed.arguments as string | string[])
          : undefined,
      hooks:
        typeof parsed.hooks === 'string' || Array.isArray(parsed.hooks)
          ? (parsed.hooks as string | string[])
          : undefined,
    },
    filePath,
    baseDir: path.dirname(filePath),
    body: body.trim(),
  };

  return record;
}

export function discoverClaudeSkills(skillsBaseDir: string): ClaudeSkillRegistry {
  const registry: ClaudeSkillRegistry = {
    all: [],
    byName: new Map(),
    byLookupKey: new Map(),
    parseErrors: [],
  };

  if (!fs.existsSync(skillsBaseDir)) {
    return registry;
  }

  for (const entry of fs.readdirSync(skillsBaseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = path.join(skillsBaseDir, entry.name, SKILL_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    try {
      const record = parseClaudeSkillContent(
        fs.readFileSync(manifestPath, 'utf-8'),
        manifestPath,
      );
      registry.all.push(record);

      if (!registry.byName.has(record.frontmatter.name)) {
        registry.byName.set(record.frontmatter.name, record);
      }

      for (const lookupKey of buildLookupKeys(record)) {
        if (!registry.byLookupKey.has(lookupKey)) {
          registry.byLookupKey.set(lookupKey, record);
        }
      }
    } catch (error) {
      registry.parseErrors.push({
        filePath: manifestPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  registry.all.sort((left, right) =>
    left.frontmatter.name.localeCompare(right.frontmatter.name),
  );

  return registry;
}

export function findClaudeSkill(
  registry: ClaudeSkillRegistry,
  skillName: string,
): ClaudeSkillRecord | null {
  if (!skillName.trim()) return null;
  return registry.byLookupKey.get(normalizeLookupKey(skillName)) || null;
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
    .map((entry) => ({
      name: entry.skill.frontmatter.name,
      description: entry.skill.frontmatter.description,
      whenToUse: entry.skill.frontmatter.whenToUse,
      aliases: entry.skill.frontmatter.aliases,
      paths: entry.skill.frontmatter.paths,
      model: entry.skill.frontmatter.model,
      userInvocable: entry.skill.frontmatter.userInvocable,
      disableModelInvocation: entry.skill.frontmatter.disableModelInvocation,
    }));
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
