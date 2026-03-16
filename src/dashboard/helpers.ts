import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';

import { AgentEventRecord, getAllRegisteredGroups } from '../db.js';
import { ParsedEvent } from './types.js';

function parsePayload(payloadJson: string | null): Record<string, unknown> | null {
  if (!payloadJson) return null;
  try {
    return JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return { _raw: payloadJson };
  }
}

export function toParsedEvent(row: AgentEventRecord): ParsedEvent {
  return {
    id: row.id,
    ts: row.ts,
    chatJid: row.chat_jid,
    groupFolder: row.group_folder,
    sessionId: row.session_id,
    eventType: row.event_type,
    stage: row.stage,
    payload: parsePayload(row.payload_json),
  };
}

export function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

export function parseLimit(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(1000, parsed));
}

export function checkAuth(req: http.IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${token}`) return true;
  const reqUrl = new URL(req.url || '/', 'http://localhost');
  return reqUrl.searchParams.get('token') === token;
}

export function resolveGroupWorkspace(chatJid: string): {
  groupFolder: string;
  baseDir: string;
} {
  const registered = getAllRegisteredGroups();
  const group = registered[chatJid];
  if (!group) {
    throw new Error('chat_jid is not registered');
  }
  return {
    groupFolder: group.folder,
    baseDir: path.resolve(process.cwd(), 'groups', group.folder),
  };
}

export function resolveWorkspacePath(
  baseDir: string,
  requestedPath: string | null,
): { absPath: string; relPath: string } {
  const raw = (requestedPath || '').trim();
  const sanitized = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const absPath = path.resolve(baseDir, sanitized || '.');
  const withinBase = absPath === baseDir || absPath.startsWith(`${baseDir}${path.sep}`);
  if (!withinBase) {
    throw new Error('path escapes group workspace');
  }
  const relPath = path.relative(baseDir, absPath).replace(/\\/g, '/');
  return { absPath, relPath: relPath === '.' ? '' : relPath };
}

export function isProbablyText(content: Buffer): boolean {
  return !content.includes(0);
}
