import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildClaudeSkillToolDefinition,
  discoverClaudeSkills,
  findClaudeSkill,
  parseClaudeSkillContent,
  resolveExplicitClaudeSkillCandidates,
  renderClaudeSkillForContext,
  renderClaudeSkillInvocationHint,
  renderClaudeSkillLoadedReminder,
  selectRelevantClaudeSkillCandidates,
  selectRelevantClaudeSkills,
} from '../src/skills.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molclaw-skills-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseClaudeSkillContent', () => {
  it('parses Claude-style frontmatter and body', () => {
    const parsed = parseClaudeSkillContent(
      `---
name: review
description: Review code for bugs
aliases:
  - code-review
when_to_use: Use for bug hunting
allowed-tools: bash
disable-model-invocation: false
---

Review the code carefully.
`,
      '/tmp/review/SKILL.md',
    );

    expect(parsed.frontmatter.name).toBe('review');
    expect(parsed.frontmatter.description).toBe('Review code for bugs');
    expect(parsed.frontmatter.aliases).toEqual(['code-review']);
    expect(parsed.frontmatter.whenToUse).toBe('Use for bug hunting');
    expect(parsed.frontmatter.allowedTools).toEqual(['bash']);
    expect(parsed.frontmatter.disableModelInvocation).toBe(false);
    expect(parsed.body).toBe('Review the code carefully.');
  });

  it('accepts markdown-only skills and infers metadata from path and body', () => {
    const parsed = parseClaudeSkillContent(
      `# Add Parallel AI Integration

Adds Parallel AI MCP integration to MolClaw for advanced web research capabilities.

## Implementation Steps

Do the work.
`,
      '/tmp/add-parallel/SKILL.md',
    );

    expect(parsed.frontmatter.name).toBe('add-parallel');
    expect(parsed.frontmatter.displayName).toBe('Add Parallel AI Integration');
    expect(parsed.frontmatter.description).toBe(
      'Adds Parallel AI MCP integration to MolClaw for advanced web research capabilities.',
    );
    expect(parsed.body).toContain('## Implementation Steps');
  });

  it('fills missing description from the body when frontmatter is partial', () => {
    const parsed = parseClaudeSkillContent(
      `---
name: query-pdb
---

# Query PDB

Look up experimental protein structures from the Protein Data Bank.
`,
      '/tmp/query-pdb/SKILL.md',
    );

    expect(parsed.frontmatter.name).toBe('query-pdb');
    expect(parsed.frontmatter.description).toBe(
      'Look up experimental protein structures from the Protein Data Bank.',
    );
    expect(parsed.frontmatter.displayName).toBe('Query PDB');
  });
});

describe('discoverClaudeSkills', () => {
  it('discovers skill directories and builds lookup keys', () => {
    const root = createTempDir();
    const reviewDir = path.join(root, 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(
      path.join(reviewDir, 'SKILL.md'),
      `---
name: review
description: Review code for bugs and regressions
aliases:
  - code-review
---

Review body.
`,
      'utf-8',
    );

    const registry = discoverClaudeSkills(root);
    expect(registry.all).toHaveLength(1);
    expect(findClaudeSkill(registry, 'review')?.frontmatter.name).toBe('review');
    expect(findClaudeSkill(registry, 'code-review')?.frontmatter.name).toBe('review');
  });

  it('keeps markdown-only skills discoverable without parse errors', () => {
    const root = createTempDir();
    const brokenDir = path.join(root, 'broken');
    const validDir = path.join(root, 'valid');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.mkdirSync(validDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'SKILL.md'), '# no frontmatter', 'utf-8');
    fs.writeFileSync(
      path.join(validDir, 'SKILL.md'),
      `---
name: valid
description: Valid skill
---

Body.
`,
      'utf-8',
    );

    const registry = discoverClaudeSkills(root);
    expect(registry.all).toHaveLength(2);
    expect(registry.parseErrors).toHaveLength(0);
    expect(findClaudeSkill(registry, 'broken')?.frontmatter.name).toBe('broken');
  });
});

describe('selectRelevantClaudeSkills', () => {
  it('returns explicitly invoked skills from the prompt', () => {
    const root = createTempDir();
    const reviewDir = path.join(root, 'review');
    const pdfDir = path.join(root, 'pdf');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.mkdirSync(pdfDir, { recursive: true });
    fs.writeFileSync(
      path.join(reviewDir, 'SKILL.md'),
      `---
name: review
description: Review code for bugs and missing tests
---

Review body.
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(pdfDir, 'SKILL.md'),
      `---
name: pdf
description: Extract text from PDF files
---

PDF body.
`,
      'utf-8',
    );

    const registry = discoverClaudeSkills(root);
    const selected = selectRelevantClaudeSkills(registry, {
      prompt: 'Please /review this patch and look for regressions',
      sessionMessages: [],
      maxSkills: 2,
    });

    expect(selected[0]?.name).toBe('review');
  });

  it('resolves explicit invocations even when model gating exists', () => {
    const root = createTempDir();
    const visionDir = path.join(root, 'vision');
    fs.mkdirSync(visionDir, { recursive: true });
    fs.writeFileSync(
      path.join(visionDir, 'SKILL.md'),
      `---
name: vision
description: Analyze images
model: gpt-4o*
---

Vision body.
`,
      'utf-8',
    );

    const registry = discoverClaudeSkills(root);
    const forced = resolveExplicitClaudeSkillCandidates(
      registry,
      '/vision classify this image',
    );

    expect(forced[0]?.skill.frontmatter.name).toBe('vision');
    expect(forced[0]?.reasons.some((reason) => reason.startsWith('explicit:'))).toBe(true);
  });

  it('does not auto-select skills without explicit invocation', () => {
    const root = createTempDir();
    const alphaFoldDir = path.join(root, 'query-alphafold');
    const browserDir = path.join(root, 'agent-browser');
    const bioToolsDir = path.join(root, 'bio-tools');
    fs.mkdirSync(alphaFoldDir, { recursive: true });
    fs.mkdirSync(browserDir, { recursive: true });
    fs.mkdirSync(bioToolsDir, { recursive: true });

    fs.writeFileSync(
      path.join(alphaFoldDir, 'SKILL.md'),
      `---
name: query-alphafold
description: Query AlphaFold protein structure predictions. Use when user asks about protein structure, 3D structure, protein folding, or structure prediction.
---

# AlphaFold Structure Database Query

Use AlphaFold, ColabFold, or related structure-prediction APIs to return protein structures.
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(browserDir, 'SKILL.md'),
      `---
name: agent-browser
description: Use a browser for web tasks and generic browsing.
---

Browse the web and interact with pages.
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(bioToolsDir, 'SKILL.md'),
      `---
name: bio-tools
description: Use general biology command-line tools for sequence analysis.
---

Run BLAST, samtools, bedtools, and sequence-analysis workflows.
`,
      'utf-8',
    );

    const registry = discoverClaudeSkills(root);
    const candidates = resolveExplicitClaudeSkillCandidates(
      registry,
      [
        'Please use AlphaFold to predict this protein structure.',
        'Return the resulting structure file.',
      ].join('\n'),
    );

    expect(candidates).toHaveLength(0);
  });
});

describe('buildClaudeSkillToolDefinition', () => {
  it('creates a dynamic tool description from the full skill inventory', () => {
    const tool = buildClaudeSkillToolDefinition([
      {
        name: 'review',
        description: 'Review code for bugs',
        whenToUse: 'Use for code review requests',
        aliases: ['code-review'],
      },
    ]);

    expect(tool?.function.name).toBe('skill');
    expect(tool?.function.description).toContain('review');
    expect(tool?.function.description).toContain('code-review');
    expect(tool?.function.description).toContain('<skills_instructions>');
    expect(tool?.function.description).toContain('invoke this tool immediately as your first action');
    expect(tool?.function.description).toContain('blocking requirement');
  });
});

describe('Claude skill runtime smoke flow', () => {
  it('supports discover -> explicit invocation -> build tool -> materialize', () => {
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
when_to_use: Use for review requests
allowed-tools:
  - read_file
  - grep_files
arguments:
  - target
hooks:
  - pre-tool-use
---

Review changed code. Focus on correctness, regressions, and missing tests.
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
    const candidates = selectRelevantClaudeSkillCandidates(registry, {
      prompt: '/review on this patch',
      sessionMessages: [],
      maxSkills: 4,
    });
    const tool = buildClaudeSkillToolDefinition(
      registry.all.map((skill) => ({
        name: skill.frontmatter.name,
        description: skill.frontmatter.description,
        whenToUse: skill.frontmatter.whenToUse,
        aliases: skill.frontmatter.aliases,
        paths: skill.frontmatter.paths,
      })),
    );
    const skill = findClaudeSkill(registry, 'review');
    const rendered = renderClaudeSkillForContext(skill!);
    const invocationText = renderClaudeSkillInvocationHint(candidates[0]?.invocationHint);
    const reminderText = renderClaudeSkillLoadedReminder(skill!);

    expect(candidates[0]?.skill.frontmatter.name).toBe('review');
    expect(tool?.function.name).toBe('skill');
    expect(tool?.function.description).toContain('pdf');
    expect(rendered).toContain(`Base directory for this skill: ${reviewDir}`);
    expect(rendered).toContain('Allowed tools: read_file, grep_files');
    expect(rendered).toContain('Declared arguments: target');
    expect(rendered).toContain('Declared hooks: pre-tool-use');
    expect(rendered).toContain('Review changed code.');
    expect(invocationText).toContain('Invocation trigger: /review');
    expect(invocationText).toContain('Invocation args: on this patch');
    expect(reminderText).toContain('<system-reminder>');
    expect(reminderText).toContain('Skill "review" is now loaded');
  });
});
