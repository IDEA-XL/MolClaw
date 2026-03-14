export interface RealtimeAgentEvent {
  id?: number;
  ts: string;
  chatJid: string;
  groupFolder: string;
  sessionId?: string;
  eventType: string;
  stage: string;
  payload?: Record<string, unknown>;
}

type AgentEventListener = (event: RealtimeAgentEvent) => void;

const listeners = new Set<AgentEventListener>();

export function publishAgentEvent(event: RealtimeAgentEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Listeners must not break producer flow.
    }
  }
}

export function subscribeAgentEvents(
  listener: AgentEventListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
