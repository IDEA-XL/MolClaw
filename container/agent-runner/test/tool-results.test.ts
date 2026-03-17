import { describe, expect, it } from 'vitest';

import {
  isSkillToolName,
  serializeToolExecutionResult,
} from '../src/tool-results.js';

describe('tool result serialization', () => {
  it('treats skill tools as raw llm content like qwen skill tool', () => {
    const result = serializeToolExecutionResult(
      'skill',
      'Base directory for this skill: /home/node/.claude/skills/review\n\nReview body.',
      true,
      48_000,
    );

    expect(isSkillToolName('skill')).toBe(true);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Base directory for this skill');
    expect(result.output.startsWith('{')).toBe(false);
    expect(result.modelContent).toBe(result.output);
  });

  it('keeps non-skill tools wrapped in the legacy json envelope', () => {
    const result = serializeToolExecutionResult(
      'bash',
      'exit_code: 0\nstdout:\nhello\nstderr:\n(empty)',
      true,
      16_000,
    );

    expect(isSkillToolName('bash')).toBe(false);
    expect(result.success).toBe(true);
    expect(result.output).toContain('"ok": true');
    expect(result.output).toContain('"result": "exit_code: 0');
    expect(result.modelContent).toBe(result.output);
  });

  it('renders skill errors as plain text instead of json envelopes', () => {
    const result = serializeToolExecutionResult(
      'load_claude_skill',
      'Skill "query-alphafold" not found.',
      false,
      48_000,
    );

    expect(result.success).toBe(false);
    expect(result.output).toBe('Skill "query-alphafold" not found.');
    expect(result.output.startsWith('{')).toBe(false);
    expect(result.modelContent).toBe(result.output);
  });
});
