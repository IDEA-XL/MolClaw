import fs from 'fs';
import path from 'path';

import { resolveExplicitClaudeSkillCandidates, selectRelevantClaudeSkills } from './invocation.js';
import { buildClaudeSkillToolDefinition } from './render.js';
import { discoverClaudeSkills, findClaudeSkill } from './registry.js';
import type {
  ClaudeSkillCandidate,
  ClaudeSkillRecord,
  ClaudeSkillRegistry,
  ClaudeSkillSelectionInput,
  ClaudeSkillSummary,
  ToolDefinition,
} from './types.js';

export interface ClaudeSkillManagerRuntimeState {
  skillsBaseDir: string;
  cacheStatus: 'cold' | 'hit' | 'refresh';
  snapshotKey: string;
  totalSkills: number;
  parseErrorCount: number;
  lastRefreshAt: string;
}

export interface ClaudeSkillManagerSyncResult {
  registry: ClaudeSkillRegistry;
  runtime: ClaudeSkillManagerRuntimeState;
}

function toSkillSummary(skill: ClaudeSkillRecord): ClaudeSkillSummary {
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

export class ClaudeSkillManager {
  private registry: ClaudeSkillRegistry | null = null;
  private snapshotKey = '';
  private lastRefreshAt = '';
  private lastCacheStatus: ClaudeSkillManagerRuntimeState['cacheStatus'] = 'cold';

  constructor(private readonly skillsBaseDir: string) {}

  private computeSnapshotKey(): string {
    if (!fs.existsSync(this.skillsBaseDir)) {
      return 'missing';
    }

    const records: string[] = [];
    for (const entry of fs.readdirSync(this.skillsBaseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(this.skillsBaseDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const stat = fs.statSync(manifestPath);
        records.push(`${entry.name}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
      } catch {
        records.push(`${entry.name}:unstatable`);
      }
    }

    records.sort((left, right) => left.localeCompare(right));
    return records.join('|') || 'empty';
  }

  private buildRuntimeState(): ClaudeSkillManagerRuntimeState {
    const registry = this.registry || discoverClaudeSkills(this.skillsBaseDir);
    return {
      skillsBaseDir: this.skillsBaseDir,
      cacheStatus: this.lastCacheStatus,
      snapshotKey: this.snapshotKey || this.computeSnapshotKey(),
      totalSkills: registry.all.length,
      parseErrorCount: registry.parseErrors.length,
      lastRefreshAt: this.lastRefreshAt,
    };
  }

  private refreshWithStatus(
    cacheStatus: ClaudeSkillManagerRuntimeState['cacheStatus'],
  ): ClaudeSkillRegistry {
    this.registry = discoverClaudeSkills(this.skillsBaseDir);
    this.snapshotKey = this.computeSnapshotKey();
    this.lastRefreshAt = new Date().toISOString();
    this.lastCacheStatus = cacheStatus;
    return this.registry;
  }

  refresh(): ClaudeSkillRegistry {
    return this.refreshWithStatus('refresh');
  }

  getRegistry(forceRefresh = false): ClaudeSkillRegistry {
    const nextSnapshotKey = this.computeSnapshotKey();
    if (!this.registry) {
      this.snapshotKey = nextSnapshotKey;
      return this.refreshWithStatus('cold');
    }
    if (forceRefresh || nextSnapshotKey !== this.snapshotKey) {
      this.snapshotKey = nextSnapshotKey;
      return this.refreshWithStatus('refresh');
    }
    this.lastCacheStatus = 'hit';
    return this.registry;
  }

  sync(forceRefresh = false): ClaudeSkillManagerSyncResult {
    const registry = this.getRegistry(forceRefresh);
    return {
      registry,
      runtime: this.buildRuntimeState(),
    };
  }

  listSkills(forceRefresh = false): ClaudeSkillRecord[] {
    return this.getRegistry(forceRefresh).all;
  }

  listSkillSummaries(forceRefresh = false): ClaudeSkillSummary[] {
    return this.listSkills(forceRefresh).map((skill) => toSkillSummary(skill));
  }

  loadSkill(skillName: string, forceRefresh = false): ClaudeSkillRecord | null {
    return findClaudeSkill(this.getRegistry(forceRefresh), skillName);
  }

  resolveExplicit(prompt: string, forceRefresh = false): ClaudeSkillCandidate[] {
    return resolveExplicitClaudeSkillCandidates(this.getRegistry(forceRefresh), prompt);
  }

  selectRelevant(input: ClaudeSkillSelectionInput, forceRefresh = false): ClaudeSkillSummary[] {
    return selectRelevantClaudeSkills(this.getRegistry(forceRefresh), input);
  }

  buildToolDefinition(forceRefresh = false): ToolDefinition | null {
    return buildClaudeSkillToolDefinition(this.listSkillSummaries(forceRefresh));
  }

  getParseErrors(forceRefresh = false): ClaudeSkillRegistry['parseErrors'] {
    return this.getRegistry(forceRefresh).parseErrors;
  }

  getRuntimeState(): ClaudeSkillManagerRuntimeState {
    return this.buildRuntimeState();
  }
}
