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

export interface ClaudeSkillInvocationHint {
  trigger: string;
  args?: string;
  explicit: boolean;
}

export interface ClaudeSkillCandidate {
  skill: ClaudeSkillRecord;
  score: number;
  reasons: string[];
  explicitlyRequested: boolean;
  invocationHint?: ClaudeSkillInvocationHint;
}
