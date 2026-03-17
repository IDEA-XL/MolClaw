import path from 'path';

import type { ClaudeSkillRecord } from './types.js';

function normalizeContent(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
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
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
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

  return {
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
}
