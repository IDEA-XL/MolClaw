import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Socket } from 'node:net';
import { URL } from 'node:url';

import { ASSISTANT_NAME } from '../config.js';
import { subscribeAgentEvents } from '../agent-events.js';
import {
  getAgentEvents,
  getAllChats,
  getAllRegisteredGroups,
  getLatestContextEvent,
  getRecentMessages,
} from '../db.js';
import { logger } from '../logger.js';
import { getDashboardHtml } from './html.js';
import {
  checkAuth,
  isProbablyText,
  parseLimit,
  resolveGroupWorkspace,
  resolveWorkspacePath,
  sendJson,
  toParsedEvent,
} from './helpers.js';
import { DashboardDeps, DashboardOptions, DashboardServerHandle } from './types.js';

export function startDashboardServer(
  options: DashboardOptions,
  deps: DashboardDeps,
): DashboardServerHandle {
  const sseClients = new Set<http.ServerResponse>();
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://localhost');

    if (!checkAuth(req, options.token)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (reqUrl.pathname === '/') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(getDashboardHtml());
      return;
    }

    if (reqUrl.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, now: new Date().toISOString() });
      return;
    }

    if (reqUrl.pathname === '/api/session/reset') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      const chatJid = reqUrl.searchParams.get('chat_jid');
      if (!chatJid) {
        sendJson(res, 400, { error: 'chat_jid is required' });
        return;
      }
      const result = deps.resetSession(chatJid);
      sendJson(res, result.ok ? 200 : 404, result);
      return;
    }

    if (reqUrl.pathname === '/api/groups') {
      const chats = getAllChats();
      const registered = getAllRegisteredGroups();
      const groups = chats
        .filter((c) => c.jid.startsWith('dc:') || c.jid.endsWith('@g.us'))
        .map((c) => ({
          jid: c.jid,
          name: c.name,
          lastActivity: c.last_message_time,
          isRegistered: !!registered[c.jid],
        }));
      sendJson(res, 200, { groups });
      return;
    }

    if (reqUrl.pathname === '/api/events') {
      const chatJid = reqUrl.searchParams.get('chat_jid') || undefined;
      const limit = parseLimit(reqUrl.searchParams.get('limit'), 200);
      const rows = getAgentEvents(chatJid, limit);
      sendJson(res, 200, {
        events: rows.map(toParsedEvent),
      });
      return;
    }

    if (reqUrl.pathname === '/api/messages') {
      const chatJid = reqUrl.searchParams.get('chat_jid');
      if (!chatJid) {
        sendJson(res, 400, { error: 'chat_jid is required' });
        return;
      }
      const limit = parseLimit(reqUrl.searchParams.get('limit'), 120);
      const messages = getRecentMessages(chatJid, limit, ASSISTANT_NAME);
      sendJson(res, 200, { messages });
      return;
    }

    if (reqUrl.pathname === '/api/context/latest') {
      const chatJid = reqUrl.searchParams.get('chat_jid');
      if (!chatJid) {
        sendJson(res, 400, { error: 'chat_jid is required' });
        return;
      }
      const event = getLatestContextEvent(chatJid);
      sendJson(res, 200, { event: event ? toParsedEvent(event) : null });
      return;
    }

    if (reqUrl.pathname === '/api/context/history') {
      const chatJid = reqUrl.searchParams.get('chat_jid');
      if (!chatJid) {
        sendJson(res, 400, { error: 'chat_jid is required' });
        return;
      }
      const limit = parseLimit(reqUrl.searchParams.get('limit'), 120);
      const rows = getAgentEvents(chatJid, limit * 5)
        .filter((row) => row.event_type === 'context')
        .slice(0, limit);
      sendJson(res, 200, { events: rows.map(toParsedEvent) });
      return;
    }

    if (reqUrl.pathname === '/api/files/list') {
      const chatJid = reqUrl.searchParams.get('chat_jid');
      if (!chatJid) {
        sendJson(res, 400, { error: 'chat_jid is required' });
        return;
      }
      try {
        const workspace = resolveGroupWorkspace(chatJid);
        const resolved = resolveWorkspacePath(
          workspace.baseDir,
          reqUrl.searchParams.get('path'),
        );
        const stat = fs.statSync(resolved.absPath);
        if (!stat.isDirectory()) {
          sendJson(res, 400, { error: 'path is not a directory' });
          return;
        }

        const entries = fs
          .readdirSync(resolved.absPath, { withFileTypes: true })
          .slice(0, 500)
          .map((entry) => {
            const absEntryPath = path.join(resolved.absPath, entry.name);
            const entryStat = fs.statSync(absEntryPath);
            return {
              name: entry.name,
              type: entry.isDirectory() ? 'dir' : 'file',
              size: entry.isDirectory() ? null : entryStat.size,
              mtimeMs: entryStat.mtimeMs,
            };
          })
          .sort((a, b) => {
            if (a.type !== b.type) {
              return a.type === 'dir' ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
          });

        sendJson(res, 200, {
          groupFolder: workspace.groupFolder,
          currentPath: resolved.relPath,
          parentPath: resolved.relPath
            ? path.dirname(resolved.relPath).replace(/\\/g, '/').replace(/^\.$/, '')
            : '',
          entries,
        });
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (reqUrl.pathname === '/api/files/read') {
      const chatJid = reqUrl.searchParams.get('chat_jid');
      if (!chatJid) {
        sendJson(res, 400, { error: 'chat_jid is required' });
        return;
      }
      try {
        const workspace = resolveGroupWorkspace(chatJid);
        const resolved = resolveWorkspacePath(
          workspace.baseDir,
          reqUrl.searchParams.get('path'),
        );
        const stat = fs.statSync(resolved.absPath);
        if (!stat.isFile()) {
          sendJson(res, 400, { error: 'path is not a file' });
          return;
        }
        if (stat.size > 2 * 1024 * 1024) {
          sendJson(res, 400, { error: 'file too large for preview (>2MB)' });
          return;
        }
        const buffer = fs.readFileSync(resolved.absPath);
        if (!isProbablyText(buffer)) {
          sendJson(res, 400, { error: 'binary file preview is not supported' });
          return;
        }
        const raw = buffer.toString('utf-8');
        const truncated = raw.length > 30_000
          ? `${raw.slice(0, 30_000)}\n...[truncated ${raw.length - 30_000} chars]`
          : raw;
        sendJson(res, 200, {
          path: resolved.relPath,
          size: stat.size,
          content: truncated,
        });
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (reqUrl.pathname === '/api/queue') {
      sendJson(res, 200, deps.getQueueSnapshot());
      return;
    }

    if (reqUrl.pathname === '/api/events/stream') {
      const chatJid = reqUrl.searchParams.get('chat_jid') || undefined;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);

      const unsubscribe = subscribeAgentEvents((event) => {
        if (chatJid && event.chatJid !== chatJid) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      const heartbeat = setInterval(() => {
        res.write(': ping\n\n');
      }, 20_000);

      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        sseClients.delete(res);
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.listen(options.port, options.host, () => {
    logger.info(
      { host: options.host, port: options.port },
      'Dashboard server started',
    );
  });

  return {
    close: async () => {
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          // no-op
        }
      }
      sseClients.clear();
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // no-op
        }
      }
      sockets.clear();

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
