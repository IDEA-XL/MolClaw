import { GroupQueueSnapshot } from '../group-queue.js';

export interface DashboardOptions {
  host: string;
  port: number;
  token?: string;
}

export interface DashboardDeps {
  getQueueSnapshot: () => GroupQueueSnapshot;
  resetSession: (chatJid: string) => {
    ok: boolean;
    message: string;
    previousSessionId?: string;
    groupFolder?: string;
  };
}

export interface DashboardServerHandle {
  close: () => Promise<void>;
}

export interface ParsedEvent {
  id: number;
  ts: string;
  chatJid: string;
  groupFolder: string;
  sessionId: string | null;
  eventType: string;
  stage: string;
  payload: Record<string, unknown> | null;
}
