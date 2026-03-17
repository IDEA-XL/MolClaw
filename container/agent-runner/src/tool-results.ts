export interface SerializedToolExecutionResult {
  success: boolean;
  output: string;
  modelContent: string;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function formatToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  return JSON.stringify(result, null, 2);
}

export function isSkillToolName(toolName: string): boolean {
  return toolName === 'skill' || toolName === 'load_claude_skill';
}

export function serializeToolExecutionResult(
  toolName: string,
  payload: unknown,
  success: boolean,
  outputLimit: number,
): SerializedToolExecutionResult {
  if (isSkillToolName(toolName)) {
    const text = truncate(formatToolResult(payload), outputLimit);
    return {
      success,
      output: text,
      modelContent: text,
    };
  }

  const wrapped = truncate(
    JSON.stringify(
      success
        ? { ok: true, result: formatToolResult(payload) }
        : { ok: false, error: String(payload) },
      null,
      2,
    ),
    outputLimit,
  );

  return {
    success,
    output: wrapped,
    modelContent: wrapped,
  };
}
