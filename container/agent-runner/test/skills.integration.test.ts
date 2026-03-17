import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildClaudeSkillToolDefinition,
  discoverClaudeSkills,
  findClaudeSkill,
  resolveExplicitClaudeSkillCandidates,
  renderClaudeSkillForContext,
  renderClaudeSkillInvocationHint,
  renderClaudeSkillLoadedReminder,
} from '../src/skills.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bioclaw-skill-int-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('claude skill runtime integration', () => {
  it('runs discover -> shortlist -> dynamic tool -> materialize flow', () => {
    const root = createTempDir();
    const reviewDir = path.join(root, 'review');
    const pdfDir = path.join(root, 'pdf');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.mkdirSync(pdfDir, { recursive: true });

    fs.writeFileSync(
      path.join(reviewDir, 'SKILL.md'),
      `---
name: review
description: Review code for bugs, regressions, and missing tests
aliases:
  - code-review
when_to_use: Use for code review requests
allowed-tools:
  - read_file
  - grep_files
---

Review code with emphasis on regressions and test gaps.
`,
      'utf-8',
    );

    fs.writeFileSync(
      path.join(pdfDir, 'SKILL.md'),
      `---
name: pdf
description: Extract text from PDF files
---

Extract text from PDFs.
`,
      'utf-8',
    );

    const registry = discoverClaudeSkills(root);
    const candidates = resolveExplicitClaudeSkillCandidates(
      registry,
      '/review src/api.ts for regressions',
    );

    const tool = buildClaudeSkillToolDefinition(
      registry.all.map((skill) => ({
        name: skill.frontmatter.name,
        description: skill.frontmatter.description,
        whenToUse: skill.frontmatter.whenToUse,
        aliases: skill.frontmatter.aliases,
        paths: skill.frontmatter.paths,
        model: skill.frontmatter.model,
        userInvocable: skill.frontmatter.userInvocable,
        disableModelInvocation: skill.frontmatter.disableModelInvocation,
      })),
    );
    const selected = findClaudeSkill(registry, candidates[0]!.skill.frontmatter.name)!;
    const rendered = [
      renderClaudeSkillInvocationHint(candidates[0]!.invocationHint),
      renderClaudeSkillLoadedReminder(selected),
      renderClaudeSkillForContext(selected),
    ].filter(Boolean).join('\n');

    expect(candidates[0]!.skill.frontmatter.name).toBe('review');
    expect(candidates[0]!.reasons.some((reason) => reason.startsWith('explicit:'))).toBe(true);
    expect(tool).not.toBeNull();
    expect(tool!.function.name).toBe('skill');
    expect(tool!.function.description).toContain('review');
    expect(tool!.function.description).toContain('pdf');
    expect(rendered).toContain('Invocation trigger: /review');
    expect(rendered).toContain('Invocation args: src/api.ts for regressions');
    expect(rendered).toContain('<system-reminder>');
    expect(rendered).toContain(`Base directory for this skill: ${reviewDir}`);
    expect(rendered).toContain('Allowed tools: read_file, grep_files');
    expect(rendered).toContain('Review code with emphasis on regressions and test gaps.');
  });
});
