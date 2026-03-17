import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeSkillManager } from '../src/skills.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bioclaw-skill-manager-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ClaudeSkillManager', () => {
  it('manages discovery, listing, loading, and tool definition generation', () => {
    const root = createTempDir();
    const reviewDir = path.join(root, 'review');
    const pdfDir = path.join(root, 'pdf');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.mkdirSync(pdfDir, { recursive: true });

    fs.writeFileSync(
      path.join(reviewDir, 'SKILL.md'),
      `---
name: review
description: Review code for bugs and regressions
aliases:
  - code-review
---

Review code carefully.
`,
      'utf-8',
    );

    fs.writeFileSync(
      path.join(pdfDir, 'SKILL.md'),
      `---
name: pdf
description: Extract text from PDFs
---

Extract text from PDFs.
`,
      'utf-8',
    );

    const manager = new ClaudeSkillManager(root);

    expect(manager.listSkills(true)).toHaveLength(2);
    expect(manager.loadSkill('code-review')?.frontmatter.name).toBe('review');
    expect(manager.resolveExplicit('/review src/app.ts')[0]?.skill.frontmatter.name).toBe('review');
    expect(manager.listSkillSummaries()).toHaveLength(2);
    expect(manager.buildToolDefinition()?.function.description).toContain('review');
    expect(manager.getParseErrors()).toHaveLength(0);
  });

  it('tracks cold-hit-refresh cache status across sync calls', () => {
    const root = createTempDir();
    const reviewDir = path.join(root, 'review');
    fs.mkdirSync(reviewDir, { recursive: true });

    fs.writeFileSync(
      path.join(reviewDir, 'SKILL.md'),
      `---
name: review
description: Review code for bugs
---

Review body.
`,
      'utf-8',
    );

    const manager = new ClaudeSkillManager(root);

    const first = manager.sync();
    const second = manager.sync();

    expect(first.runtime.cacheStatus).toBe('cold');
    expect(second.runtime.cacheStatus).toBe('hit');

    fs.writeFileSync(
      path.join(reviewDir, 'SKILL.md'),
      `---
name: review
description: Review code for bugs and regressions
---

Review body updated.
`,
      'utf-8',
    );

    const third = manager.sync();
    expect(third.runtime.cacheStatus).toBe('refresh');
    expect(third.runtime.totalSkills).toBe(1);
    expect(third.registry.all[0]?.frontmatter.description).toContain('regressions');
  });
});
