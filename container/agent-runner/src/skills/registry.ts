import fs from 'fs';
import path from 'path';

import { parseClaudeSkillContent } from './parser.js';
import type { ClaudeSkillRecord, ClaudeSkillRegistry } from './types.js';

const SKILL_MANIFEST_FILE = 'SKILL.md';

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
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
