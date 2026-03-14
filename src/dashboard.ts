import http from 'node:http';
import { URL } from 'node:url';

import { ASSISTANT_NAME } from './config.js';
import { subscribeAgentEvents } from './agent-events.js';
import {
  AgentEventRecord,
  getAgentEvents,
  getAllChats,
  getAllRegisteredGroups,
  getLatestContextEvent,
  getRecentMessages,
} from './db.js';
import { GroupQueueSnapshot } from './group-queue.js';
import { logger } from './logger.js';

export interface DashboardOptions {
  host: string;
  port: number;
  token?: string;
}

export interface DashboardDeps {
  getQueueSnapshot: () => GroupQueueSnapshot;
}

export interface DashboardServerHandle {
  close: () => Promise<void>;
}

interface ParsedEvent {
  id: number;
  ts: string;
  chatJid: string;
  groupFolder: string;
  sessionId: string | null;
  eventType: string;
  stage: string;
  payload: Record<string, unknown> | null;
}

function parsePayload(payloadJson: string | null): Record<string, unknown> | null {
  if (!payloadJson) return null;
  try {
    return JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return { _raw: payloadJson };
  }
}

function toParsedEvent(row: AgentEventRecord): ParsedEvent {
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

function sendJson(
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

function parseLimit(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(1000, parsed));
}

function checkAuth(req: http.IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${token}`) return true;
  const reqUrl = new URL(req.url || '/', 'http://localhost');
  return reqUrl.searchParams.get('token') === token;
}

function getDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>BioClaw Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      --bg: #f4f6fb;
      --panel: #ffffff;
      --line: #d9e1ee;
      --muted: #607086;
      --error: #b42318;
      --error-bg: #fff3f2;
      --warn: #b54708;
      --warn-bg: #fff8eb;
      --ok: #027a48;
      --accent: #175cd3;
      --accent-soft: #edf4ff;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: #1d2939; }
    .top {
      display: grid;
      grid-template-columns: 1fr auto auto auto auto;
      gap: 8px;
      padding: 10px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 20;
    }
    .badge {
      padding: 6px 10px;
      border: 1px solid #c9d4e4;
      border-radius: 7px;
      background: #f9fbff;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .layout {
      display: grid;
      grid-template-columns: 280px 1fr 360px;
      height: calc(100vh - 56px);
      min-height: 460px;
    }
    .panel {
      overflow: auto;
      border-right: 1px solid var(--line);
      background: var(--panel);
    }
    .panel:last-child {
      border-right: 0;
      border-left: 1px solid var(--line);
    }
    .title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      font-weight: 700;
      padding: 10px 12px;
      border-bottom: 1px solid #e9eef6;
      background: #f8fbff;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .toolbar {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid #edf2f8;
      background: #fcfdff;
      position: sticky;
      top: 40px;
      z-index: 9;
    }
    .section {
      padding: 8px;
      border-bottom: 1px solid #edf2f8;
      background: #fcfdff;
      position: sticky;
      top: 40px;
      z-index: 9;
    }
    input, button {
      font: inherit;
      font-size: 12px;
      border: 1px solid #c9d4e4;
      border-radius: 6px;
      padding: 6px 8px;
      background: #fff;
      color: #1d2939;
    }
    button { cursor: pointer; }
    button.active {
      border-color: #90b4ff;
      background: var(--accent-soft);
      color: #1546a0;
    }
    .groups {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .groups li {
      padding: 9px 12px;
      border-bottom: 1px solid #eef2f8;
      cursor: pointer;
    }
    .groups li:hover { background: #f9fbff; }
    .groups li.active { background: var(--accent-soft); }
    .group-name { font-size: 13px; font-weight: 600; }
    .group-meta {
      font-size: 12px;
      color: var(--muted);
      margin-top: 2px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .warn-text { color: var(--warn); font-weight: 600; }
    .error-text { color: var(--error); font-weight: 600; }
    .ok-text { color: var(--ok); }
    .muted { color: var(--muted); }

    .timeline-wrap {
      height: calc(100% - 95px);
      overflow: auto;
      padding: 14px 12px 20px;
      background: linear-gradient(180deg, #f8fbff 0%, #f4f8ff 40%, #f8fbff 100%);
    }
    .timeline {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg {
      max-width: min(760px, 92%);
      border: 1px solid #dbe4f3;
      border-radius: 10px;
      padding: 8px 10px;
      background: #fff;
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
    }
    .msg.user {
      align-self: flex-end;
      border-color: #9ebdf8;
      background: #eaf2ff;
    }
    .msg.assistant {
      align-self: flex-start;
      border-color: #cfe2ff;
      background: #f8fbff;
    }
    .msg.provider {
      align-self: flex-start;
      border-color: #bfd5ff;
      background: #f4f8ff;
    }
    .msg.tool-call,
    .msg.tool-result {
      align-self: flex-start;
      border-color: #ead9b6;
      background: #fff9ed;
    }
    .msg.error {
      align-self: flex-start;
      border-color: #efb2ac;
      background: var(--error-bg);
    }
    .msg.ops {
      align-self: center;
      border-style: dashed;
      border-color: #c9d4e4;
      background: #f9fbff;
      max-width: 92%;
    }
    .msg-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 4px;
    }
    .msg-role {
      font-size: 12px;
      font-weight: 700;
      color: #113963;
    }
    .msg-time {
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
    }
    .msg-meta {
      font-size: 11px;
      color: #4d6380;
      margin-bottom: 5px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg-body {
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg-body code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: rgba(15, 23, 42, 0.06);
      border-radius: 4px;
      padding: 0 4px;
    }
    .code-block {
      margin: 6px 0;
      border: 1px solid #dce6f4;
      background: #f7faff;
      border-radius: 8px;
      overflow: hidden;
    }
    .code-label {
      font-size: 10px;
      font-weight: 700;
      color: #3e5c84;
      background: #edf4ff;
      border-bottom: 1px solid #dce6f4;
      padding: 3px 7px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .code-content {
      margin: 0;
      padding: 8px 10px;
      max-height: 260px;
      overflow: auto;
      font-size: 11px;
      line-height: 1.5;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
      word-break: break-word;
      color: #21344f;
    }
    .kv-list {
      display: grid;
      gap: 6px;
      margin-top: 4px;
    }
    .kv-item {
      border: 1px dashed #d8e2f2;
      border-radius: 8px;
      background: #fff;
      padding: 6px 8px;
    }
    .kv-item .k {
      font-size: 11px;
      font-weight: 700;
      color: #334e70;
      margin-bottom: 4px;
    }
    .kv-item .v {
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      color: #203b5e;
    }
    details.fold {
      margin-top: 6px;
      border: 1px dashed #d6e2f3;
      border-radius: 8px;
      background: #f9fbff;
      overflow: hidden;
    }
    details.fold > summary {
      cursor: pointer;
      user-select: none;
      font-size: 11px;
      font-weight: 700;
      color: #35547f;
      padding: 6px 8px;
      background: #eef5ff;
      border-bottom: 1px solid #dce8fa;
    }
    details.fold[open] > summary {
      background: #e7f0ff;
    }

    .ctx {
      padding: 10px;
      font-size: 12px;
      line-height: 1.5;
    }
    .card {
      border: 1px solid #dde6f2;
      background: #fbfdff;
      border-radius: 8px;
      padding: 8px;
      margin-bottom: 10px;
    }
    .card-title {
      margin: 0 0 6px;
      font-size: 12px;
      font-weight: 700;
      color: #334e70;
    }
    .kv {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 5px 0;
      border-bottom: 1px dashed #e8edf6;
    }
    .kv:last-child { border-bottom: 0; }
    table.rounds {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }
    .rounds th,
    .rounds td {
      border-bottom: 1px solid #edf2f8;
      text-align: left;
      padding: 4px 3px;
      vertical-align: top;
    }
    .empty {
      padding: 12px;
      color: var(--muted);
      font-size: 12px;
    }
    @media (max-width: 1200px) {
      .layout { grid-template-columns: 260px 1fr; }
      .panel:last-child { display: none; }
      .top { grid-template-columns: 1fr auto auto auto; }
      #metrics { display: none; }
    }
  </style>
</head>
<body>
  <div class="top">
    <div class="badge" id="status">initializing...</div>
    <div class="badge" id="queue">queue</div>
    <div class="badge" id="metrics">usage</div>
    <div class="badge" id="selected">chat: none</div>
    <div class="badge" id="stream">stream: idle</div>
  </div>
  <div class="layout">
    <div class="panel">
      <div class="title">Groups <span class="muted" id="group-count"></span></div>
      <div class="section">
        <input id="group-search" placeholder="Search group..." style="width:100%" />
      </div>
      <ul class="groups" id="groups"></ul>
    </div>

    <div class="panel">
      <div class="title">Conversation <span class="muted" id="timeline-count"></span></div>
      <div class="toolbar">
        <input id="timeline-search" placeholder="Filter text (tool/model/error)..." />
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#475467;padding:0 4px;">
          <input type="checkbox" id="show-ops" /> show ops
        </label>
        <button id="pause-btn">Pause</button>
      </div>
      <div class="timeline-wrap" id="timeline-wrap">
        <ul class="timeline" id="timeline"></ul>
      </div>
    </div>

    <div class="panel">
      <div class="title">Session / Context</div>
      <div class="ctx" id="context"><div class="empty">Select a chat</div></div>
    </div>
  </div>

  <script>
    let currentChat = '';
    let eventSource = null;
    let streamPaused = false;
    let droppedEvents = 0;
    let allEvents = [];
    let allMessages = [];
    let allGroups = [];
    let queueSnapshotByGroup = new Map();
    const token = new URLSearchParams(location.search).get('token');

    const groupsEl = document.getElementById('groups');
    const timelineEl = document.getElementById('timeline');
    const timelineWrapEl = document.getElementById('timeline-wrap');
    const contextEl = document.getElementById('context');
    const selectedEl = document.getElementById('selected');
    const queueEl = document.getElementById('queue');
    const metricsEl = document.getElementById('metrics');
    const statusEl = document.getElementById('status');
    const streamEl = document.getElementById('stream');
    const timelineCountEl = document.getElementById('timeline-count');
    const groupCountEl = document.getElementById('group-count');

    const groupSearchEl = document.getElementById('group-search');
    const timelineSearchEl = document.getElementById('timeline-search');
    const showOpsEl = document.getElementById('show-ops');
    const pauseBtnEl = document.getElementById('pause-btn');

    function esc(s) {
      return String(s).replace(/[&<>\"]/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;'
      })[c]);
    }

    function formatTime(ts) {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return ts;
      return d.toLocaleTimeString();
    }

    function getEventPayload(e) {
      return e && e.payload ? e.payload : {};
    }

    function isNearBottom(el) {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      return gap < 56;
    }

    function scrollToBottom(smooth) {
      timelineWrapEl.scrollTo({
        top: timelineWrapEl.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    }

    function compareByTs(a, b) {
      if (a.ts === b.ts) {
        const order = {
          user: 0,
          provider: 1,
          'tool-call': 2,
          'tool-result': 3,
          assistant: 4,
          error: 5,
          ops: 6,
        };
        return (order[a.kind] || 99) - (order[b.kind] || 99);
      }
      return a.ts < b.ts ? -1 : 1;
    }

    function summarizeTokens(p) {
      const prompt = resolvePromptTokens(p, null);
      const completion = resolveCompletionTokens(p);
      const total = resolveTotalTokens(p, null);
      const parts = [];
      if (prompt != null) parts.push('prompt=' + prompt);
      if (completion != null) parts.push('completion=' + completion);
      if (total != null) parts.push('total=' + total);
      return parts.join(' ');
    }

    function asNumber(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }

    function estimateTokensFromChars(chars) {
      const n = asNumber(chars);
      if (n == null) return null;
      return Math.max(1, Math.ceil(n / 4));
    }

    function resolveHistoryTokens(contextPayload) {
      return asNumber(contextPayload && contextPayload.historyTokenCount)
        ?? estimateTokensFromChars(contextPayload && contextPayload.historyCharCount);
    }

    function resolveTrimmedTokens(contextPayload) {
      return asNumber(contextPayload && contextPayload.trimmedTokenCount)
        ?? estimateTokensFromChars(contextPayload && contextPayload.trimmedCharCount);
    }

    function resolveCompletionTokens(providerPayload) {
      return asNumber(providerPayload && providerPayload.completionTokenCount)
        ?? asNumber(providerPayload && providerPayload.contentTokenCount)
        ?? estimateTokensFromChars(providerPayload && providerPayload.contentChars);
    }

    function resolvePromptTokens(providerPayload, contextPayload) {
      return asNumber(providerPayload && providerPayload.promptTokenCount)
        ?? resolveTrimmedTokens(contextPayload || {});
    }

    function resolveTotalTokens(providerPayload, contextPayload) {
      const direct = asNumber(providerPayload && providerPayload.totalTokenCount);
      if (direct != null) return direct;
      const prompt = resolvePromptTokens(providerPayload || {}, contextPayload || {});
      const completion = resolveCompletionTokens(providerPayload || {});
      if (prompt == null || completion == null) return null;
      return prompt + completion;
    }

    function parseMaybeJson(raw) {
      if (typeof raw !== 'string') return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }

    function stableStringify(obj) {
      try {
        return JSON.stringify(obj, null, 2);
      } catch {
        return String(obj);
      }
    }

    function extractToolOutput(payload) {
      const candidates = [
        payload.output,
        payload.outputPreview,
        payload.result,
        payload.message,
        payload.error,
      ];
      for (const candidate of candidates) {
        if (typeof candidate !== 'string' || !candidate.trim()) continue;
        const parsed = parseMaybeJson(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'ok' in parsed) {
          if (parsed.ok === true) {
            const result = parsed.result;
            if (typeof result === 'string') return result;
            return stableStringify(result);
          }
          if (parsed.ok === false) {
            return String(parsed.error || candidate);
          }
        }
        return candidate;
      }
      return 'No tool output captured. Rebuild agent image to include tool output payload.';
    }

    function looksLikeCode(key, value) {
      if (typeof value !== 'string') return false;
      const k = String(key || '').toLowerCase();
      if (k.includes('command') || k.includes('script') || k.includes('code') || k.includes('query')) return true;
      return /(^|\\n)\\s*(curl|python|bash|node|SELECT|WITH|import\\s|from\\s|def\\s|class\\s|function\\s|#!)/i.test(value);
    }

    function renderCodeBlock(code, label) {
      if (!code) return '';
      return ''
        + '<div class=\"code-block\">'
        + (label ? '<div class=\"code-label\">' + esc(label) + '</div>' : '')
        + '<pre class=\"code-content\">' + esc(code) + '</pre>'
        + '</div>';
    }

    function renderTextWithCodeBlocks(text) {
      const raw = String(text || '');
      const fence = String.fromCharCode(96).repeat(3);
      if (!raw.includes(fence)) {
        return '<div class=\"msg-body\">' + esc(raw || '(empty)') + '</div>';
      }
      let html = '';
      let cursor = 0;
      const re = new RegExp(fence + '([\\\\w-]+)?\\\\n([\\\\s\\\\S]*?)' + fence, 'g');
      let m;
      while ((m = re.exec(raw)) !== null) {
        if (m.index > cursor) {
          html += '<div class=\"msg-body\">' + esc(raw.slice(cursor, m.index)) + '</div>';
        }
        html += renderCodeBlock(m[2], m[1] || 'code');
        cursor = m.index + m[0].length;
      }
      if (cursor < raw.length) {
        html += '<div class=\"msg-body\">' + esc(raw.slice(cursor)) + '</div>';
      }
      return html || '<div class=\"msg-body\">' + esc(raw || '(empty)') + '</div>';
    }

    function renderToolCallBody(payload, fallbackText) {
      const args = payload && payload.toolArgs && typeof payload.toolArgs === 'object'
        ? payload.toolArgs
        : parseMaybeJson(payload && payload.argsSummary);
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        const text = fallbackText || payload.argsSummary || '';
        const firstLine = text.split('\\n').find((line) => line.trim()) || '(empty args)';
        return ''
          + '<div class=\"msg-body\">' + esc(firstLine.length > 220 ? firstLine.slice(0, 220) + '...' : firstLine) + '</div>'
          + '<details class=\"fold\"><summary>view full tool args</summary>'
          + renderTextWithCodeBlocks(text)
          + '</details>';
      }

      const rows = Object.entries(args);
      if (rows.length === 0) {
        return '<div class=\"msg-body muted\">(no args)</div>';
      }

      const summary = rows
        .slice(0, 3)
        .map(([k, v]) => {
          const val = typeof v === 'string' ? v : stableStringify(v);
          const compact = val.replace(/\\s+/g, ' ').trim();
          return k + '=' + (compact.length > 48 ? compact.slice(0, 48) + '...' : compact);
        })
        .join(' | ');

      const htmlRows = rows.map(([k, v]) => {
        if (typeof v === 'string' && looksLikeCode(k, v)) {
          return '<div class=\"kv-item\"><div class=\"k\">' + esc(k) + '</div>' + renderCodeBlock(v, '') + '</div>';
        }
        if (typeof v === 'string' && v.length > 140) {
          return '<div class=\"kv-item\"><div class=\"k\">' + esc(k) + '</div>' + renderCodeBlock(v, '') + '</div>';
        }
        if (v && typeof v === 'object') {
          return '<div class=\"kv-item\"><div class=\"k\">' + esc(k) + '</div>' + renderCodeBlock(stableStringify(v), '') + '</div>';
        }
        return '<div class=\"kv-item\"><div class=\"k\">' + esc(k) + '</div><div class=\"v\">' + esc(v == null ? 'null' : String(v)) + '</div></div>';
      }).join('');
      return ''
        + '<div class=\"msg-body\">' + esc(summary || '(args)') + '</div>'
        + '<details class=\"fold\"><summary>view full tool args</summary>'
        + '<div class=\"kv-list\">' + htmlRows + '</div>'
        + '</details>';
    }

    function renderToolResultBody(payload, fallbackText) {
      const text = extractToolOutput(payload);
      const resolved = text || fallbackText || '';
      const summarySource = resolved.split('\\n').find((line) => line.trim()) || '(empty output)';
      const summary = summarySource.length > 240
        ? summarySource.slice(0, 240) + '...'
        : summarySource;
      return ''
        + '<div class=\"msg-body\">' + esc(summary) + '</div>'
        + '<details class=\"fold\"><summary>view full tool output</summary>'
        + renderTextWithCodeBlocks(resolved)
        + '</details>';
    }

    function renderItemBody(item) {
      if (item.kind === 'tool-call') {
        return renderToolCallBody(item.payload || {}, item.body || '');
      }
      if (item.kind === 'tool-result' || item.kind === 'error') {
        return renderToolResultBody(item.payload || {}, item.body || '');
      }
      return renderTextWithCodeBlocks(item.body || '');
    }

    function buildTimelineItems() {
      const items = [];
      for (const m of allMessages) {
        items.push({
          key: 'm-' + m.id,
          ts: m.timestamp,
          kind: 'user',
          role: m.sender_name || 'user',
          meta: m.sender || '',
          body: m.content || '',
        });
      }

      for (const e of allEvents) {
        const p = getEventPayload(e);

        if (e.eventType === 'provider' && e.stage === 'end') {
          const providerText = (typeof p.contentPreview === 'string' && p.contentPreview.trim())
            ? p.contentPreview
            : (Number(p.toolCalls || 0) > 0
              ? 'model returned tool calls only: ' + (p.toolCallNames || (p.toolCalls + ' call(s)'))
              : (p.message || ''));
          if (!providerText) {
            continue;
          }
          items.push({
            key: 'e-' + e.id,
            ts: e.ts,
            kind: 'provider',
            role: 'provider',
            meta: [
              p.round != null ? 'round=' + p.round : '',
              p.durationMs != null ? 'durationMs=' + p.durationMs : '',
              summarizeTokens(p),
            ].filter(Boolean).join(' · '),
            body: providerText,
            payload: p,
          });
          continue;
        }

        if (e.eventType === 'tool' && e.stage === 'start') {
          items.push({
            key: 'e-' + e.id,
            ts: e.ts,
            kind: 'tool-call',
            role: 'tool call',
            meta: [
              p.round != null ? 'round=' + p.round : '',
              p.toolName ? 'tool=' + p.toolName : '',
            ].filter(Boolean).join(' · '),
            body: p.argsSummary || '',
            payload: p,
          });
          continue;
        }

        if (e.eventType === 'tool' && (e.stage === 'end' || e.stage === 'error')) {
          items.push({
            key: 'e-' + e.id,
            ts: e.ts,
            kind: e.stage === 'error' ? 'error' : 'tool-result',
            role: e.stage === 'error' ? 'tool error' : 'tool result',
            meta: [
              p.round != null ? 'round=' + p.round : '',
              p.toolName ? 'tool=' + p.toolName : '',
              p.durationMs != null ? 'durationMs=' + p.durationMs : '',
            ].filter(Boolean).join(' · '),
            body: extractToolOutput(p),
            payload: p,
          });
          continue;
        }

        if (e.eventType === 'final_output') {
          items.push({
            key: 'e-' + e.id,
            ts: e.ts,
            kind: 'assistant',
            role: 'assistant',
            meta: p.tokenCountEstimate != null ? 'token_est=' + p.tokenCountEstimate : '',
            body: p.text || p.preview || '',
            payload: p,
          });
          continue;
        }

        if (e.eventType === 'error' || e.stage === 'error') {
          items.push({
            key: 'e-' + e.id,
            ts: e.ts,
            kind: 'error',
            role: 'error',
            meta: e.eventType,
            body: p.error || p.message || 'unknown error',
            payload: p,
          });
          continue;
        }

        if (showOpsEl.checked && (e.eventType === 'context' || e.eventType === 'lifecycle')) {
          const summary = e.eventType === 'context'
            ? 'round=' + (p.round ?? '-')
              + ' historyMsgs=' + (p.historyMessageCount ?? '-')
              + ' historyTokens=' + (resolveHistoryTokens(p) ?? '-')
              + ' trimmedMsgs=' + (p.trimmedMessageCount ?? '-')
              + ' trimmedTokens=' + (resolveTrimmedTokens(p) ?? '-')
            : (p.message || e.stage);
          items.push({
            key: 'e-' + e.id,
            ts: e.ts,
            kind: 'ops',
            role: e.eventType,
            meta: e.stage,
            body: summary,
            payload: p,
          });
        }
      }

      items.sort(compareByTs);
      return items;
    }

    function renderTimeline() {
      const shouldStick = isNearBottom(timelineWrapEl);
      const keyword = timelineSearchEl.value.trim().toLowerCase();
      const items = buildTimelineItems().filter((item) => {
        if (!keyword) return true;
        const haystack = (item.role + ' ' + item.meta + ' ' + item.body + ' ' + stableStringify(item.payload || {})).toLowerCase();
        return haystack.includes(keyword);
      });

      timelineCountEl.textContent = items.length + ' items';
      timelineEl.innerHTML = '';

      if (!items.length) {
        timelineEl.innerHTML = '<li class="empty">No timeline data yet</li>';
        return;
      }

      for (const item of items) {
        const li = document.createElement('li');
        li.className = 'msg ' + item.kind;
        li.innerHTML = ''
          + '<div class="msg-head">'
          + '  <span class="msg-role">' + esc(item.role) + '</span>'
          + '  <span class="msg-time">' + esc(formatTime(item.ts)) + '</span>'
          + '</div>'
          + (item.meta ? '<div class="msg-meta">' + esc(item.meta) + '</div>' : '')
          + renderItemBody(item);
        timelineEl.appendChild(li);
      }

      if (shouldStick) {
        scrollToBottom(true);
      }
    }

    function getLatestContextEvent() {
      for (let i = allEvents.length - 1; i >= 0; i -= 1) {
        const e = allEvents[i];
        if (e.eventType === 'context' && e.payload) return e;
      }
      return null;
    }

    function getLatestProviderEvent() {
      for (let i = allEvents.length - 1; i >= 0; i -= 1) {
        const e = allEvents[i];
        if (e.eventType === 'provider' && e.stage === 'end') return e;
      }
      return null;
    }

    function getLatestModelVersion() {
      for (let i = allEvents.length - 1; i >= 0; i -= 1) {
        const e = allEvents[i];
        const p = getEventPayload(e);
        if (typeof p.model === 'string' && p.model.trim()) return p.model.trim();
      }
      return '-';
    }

    function buildRoundRows() {
      const contexts = allEvents.filter((e) => e.eventType === 'context' && e.payload);
      const providers = allEvents.filter((e) => e.eventType === 'provider' && e.stage === 'end' && e.payload);
      const byRound = new Map();

      for (const e of contexts) {
        const p = getEventPayload(e);
        if (p.round == null) continue;
        byRound.set(Number(p.round), { round: Number(p.round), context: p, provider: null });
      }

      for (const e of providers) {
        const p = getEventPayload(e);
        if (p.round == null) continue;
        const round = Number(p.round);
        const existing = byRound.get(round) || { round, context: null, provider: null };
        existing.provider = p;
        byRound.set(round, existing);
      }

      return Array.from(byRound.values())
        .sort((a, b) => a.round - b.round)
        .map((row) => {
          const c = row.context || {};
          const p = row.provider || {};
          const historyTokens = resolveHistoryTokens(c);
          const trimmedTokens = resolveTrimmedTokens(c);
          const promptTokens = resolvePromptTokens(p, c);
          const completionTokens = resolveCompletionTokens(p);
          const totalTokens = resolveTotalTokens(p, c);
          return {
            ...row,
            historyTokens,
            trimmedTokens,
            promptTokens,
            completionTokens,
            totalTokens,
          };
        })
        .slice(-12);
    }

    function renderContextPanel() {
      const latestContext = getLatestContextEvent();
      const latestProvider = getLatestProviderEvent();

      if (!latestContext && !latestProvider) {
        contextEl.innerHTML = '<div class="empty">No context/session data yet</div>';
        return;
      }

      const ctx = latestContext ? getEventPayload(latestContext) : {};
      const provider = latestProvider ? getEventPayload(latestProvider) : {};
      const modelVersion = getLatestModelVersion();
      const historyTokens = resolveHistoryTokens(ctx);
      const trimmedTokens = resolveTrimmedTokens(ctx);
      const promptTokens = resolvePromptTokens(provider, ctx);
      const completionTokens = resolveCompletionTokens(provider);
      const totalTokens = resolveTotalTokens(provider, ctx);
      const roundRows = buildRoundRows();

      let roundsHtml = '<div class="empty">No round metrics yet</div>';
      if (roundRows.length > 0) {
        roundsHtml = ''
          + '<table class="rounds">'
          + '<thead><tr><th>round</th><th>history</th><th>trimmed</th><th>usage</th></tr></thead><tbody>'
          + roundRows.map((row) => {
              const usage = [
                row.promptTokens != null ? 'p:' + row.promptTokens : '',
                row.completionTokens != null ? 'c:' + row.completionTokens : '',
                row.totalTokens != null ? 't:' + row.totalTokens : '',
              ].filter(Boolean).join(' ');
              return '<tr>'
                + '<td>' + esc(row.round) + '</td>'
                + '<td>' + esc(((row.context && row.context.historyMessageCount) ?? '-') + ' / ' + (row.historyTokens ?? '-')) + '</td>'
                + '<td>' + esc(((row.context && row.context.trimmedMessageCount) ?? '-') + ' / ' + (row.trimmedTokens ?? '-')) + '</td>'
                + '<td>' + esc(usage || '-') + '</td>'
                + '</tr>';
            }).join('')
          + '</tbody></table>';
      }

      contextEl.innerHTML = ''
        + '<div class="card">'
        + '  <p class="card-title">Latest Snapshot</p>'
        + '  <div class="kv"><span class="muted">model</span><span>' + esc(modelVersion) + '</span></div>'
        + '  <div class="kv"><span class="muted">round</span><span>' + esc(ctx.round ?? provider.round ?? '-') + '</span></div>'
        + '  <div class="kv"><span class="muted">history tokens</span><span>' + esc(historyTokens ?? '-') + '</span></div>'
        + '  <div class="kv"><span class="muted">trimmed tokens</span><span>' + esc(trimmedTokens ?? '-') + '</span></div>'
        + '  <div class="kv"><span class="muted">prompt / completion / total</span><span>'
        +      esc((promptTokens ?? '-') + ' / ' + (completionTokens ?? '-') + ' / ' + (totalTokens ?? '-'))
        + '  </span></div>'
        + '</div>'
        + '<div class="card">'
        + '  <p class="card-title">Recent Rounds (msg/token)</p>'
        + roundsHtml
        + '</div>';
    }

    function updateTopUsage() {
      const providerEvents = allEvents.filter((e) => e.eventType === 'provider' && e.stage === 'end');
      const contextByRound = new Map();
      for (const e of allEvents) {
        if (e.eventType !== 'context' || !e.payload) continue;
        const p = getEventPayload(e);
        if (p.round == null) continue;
        contextByRound.set(Number(p.round), p);
      }
      let prompt = 0;
      let completion = 0;
      let total = 0;
      let hasAny = false;

      for (const e of providerEvents) {
        const p = getEventPayload(e);
        const ctx = p.round != null ? contextByRound.get(Number(p.round)) : null;
        const pt = resolvePromptTokens(p, ctx);
        const ct = resolveCompletionTokens(p);
        const tt = resolveTotalTokens(p, ctx);
        if (pt != null) {
          prompt += pt;
          hasAny = true;
        }
        if (ct != null) {
          completion += ct;
          hasAny = true;
        }
        if (tt != null) {
          total += tt;
          hasAny = true;
        }
      }

      if (!hasAny) {
        metricsEl.textContent = 'usage: no token stats yet';
        return;
      }

      const totalText = total > 0 ? total : prompt + completion;
      metricsEl.textContent = 'model=' + getLatestModelVersion() + ' p=' + prompt + ' c=' + completion + ' t=' + totalText;
    }

    async function fetchJson(url) {
      const reqUrl = new URL(url, window.location.origin);
      if (token) reqUrl.searchParams.set('token', token);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let res;
      try {
        res = await fetch(reqUrl.toString(), { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    }

    async function loadQueue() {
      const q = await fetchJson('/api/queue');
      queueEl.textContent = 'active=' + q.activeCount + ' waiting=' + q.waitingGroups.length;
      const hot = q.groups.filter((g) => g.active || g.pendingMessages || g.pendingTaskCount > 0);
      if (hot.length) queueEl.textContent += ' hot=' + hot.length;
      queueSnapshotByGroup = new Map((q.groups || []).map((g) => [g.groupJid, g]));
      renderGroups();
    }

    function renderGroups() {
      const keyword = groupSearchEl.value.trim().toLowerCase();
      const groups = allGroups.filter((g) => {
        if (!keyword) return true;
        const s = (g.name + ' ' + g.jid).toLowerCase();
        return s.includes(keyword);
      });

      groupCountEl.textContent = groups.length + ' visible';
      groupsEl.innerHTML = '';

      for (const g of groups) {
        const li = document.createElement('li');
        li.className = g.jid === currentChat ? 'active' : '';
        const reg = g.isRegistered
          ? '<span class="ok-text">registered</span>'
          : '<span class="error-text">unregistered</span>';
        const q = queueSnapshotByGroup.get(g.jid);
        const queueTags = [];
        if (q && q.active) queueTags.push('active');
        if (q && q.pendingMessages) queueTags.push('pending_msg');
        if (q && q.pendingTaskCount > 0) queueTags.push('pending_task=' + q.pendingTaskCount);
        if (q && q.retryCount > 0) queueTags.push('retry=' + q.retryCount);
        const queueStatus = queueTags.length > 0
          ? '<span class="warn-text">' + esc(queueTags.join(' · ')) + '</span>'
          : '<span class="muted">idle</span>';

        li.innerHTML = ''
          + '<div class="group-name">' + esc(g.name || g.jid) + '</div>'
          + '<div class="group-meta"><span>' + esc(g.jid) + '</span><span>' + reg + '</span></div>'
          + '<div class="group-meta"><span>last: ' + esc(formatTime(g.lastActivity)) + '</span>' + queueStatus + '</div>';

        li.onclick = () => selectChat(g.jid);
        groupsEl.appendChild(li);
      }
    }

    async function loadGroups() {
      const data = await fetchJson('/api/groups');
      allGroups = data.groups || [];
      if (!currentChat && allGroups.length > 0) {
        currentChat = allGroups[0].jid;
      }
      renderGroups();
    }

    async function loadMessages() {
      if (!currentChat) return;
      const data = await fetchJson('/api/messages?chat_jid=' + encodeURIComponent(currentChat) + '&limit=200');
      const messages = data.messages || [];
      const changed = messages.length !== allMessages.length
        || (messages.length > 0 && allMessages.length > 0
          && messages[messages.length - 1].id !== allMessages[allMessages.length - 1].id);
      allMessages = messages;
      if (changed) {
        renderTimeline();
      }
    }

    async function loadEvents() {
      if (!currentChat) return;
      const data = await fetchJson('/api/events?chat_jid=' + encodeURIComponent(currentChat) + '&limit=400');
      allEvents = (data.events || []).slice().reverse();
      renderTimeline();
      renderContextPanel();
      updateTopUsage();
    }

    function setStreamStatus(text) {
      streamEl.textContent = text;
    }

    function appendRealtimeEvent(event) {
      if (event.id != null && allEvents.some((existing) => existing.id === event.id)) {
        return;
      }
      allEvents.push(event);
      if (allEvents.length > 1600) {
        allEvents = allEvents.slice(allEvents.length - 1600);
      }
      renderTimeline();
      renderContextPanel();
      updateTopUsage();
    }

    function connectStream() {
      if (eventSource) eventSource.close();
      if (!currentChat) return;

      const streamUrl = new URL('/api/events/stream', window.location.origin);
      streamUrl.searchParams.set('chat_jid', currentChat);
      if (token) streamUrl.searchParams.set('token', token);

      eventSource = new EventSource(streamUrl.toString());
      eventSource.onopen = () => setStreamStatus(streamPaused ? 'stream paused' : 'stream connected');
      eventSource.onerror = () => setStreamStatus('stream reconnecting...');
      eventSource.onmessage = (ev) => {
        if (streamPaused) {
          droppedEvents += 1;
          setStreamStatus('stream paused, dropped=' + droppedEvents);
          return;
        }
        try {
          const event = JSON.parse(ev.data);
          appendRealtimeEvent(event);
        } catch {}
      };
    }

    async function selectChat(jid) {
      currentChat = jid;
      selectedEl.textContent = 'chat: ' + jid;
      droppedEvents = 0;
      await Promise.all([loadGroups(), loadQueue(), loadMessages(), loadEvents()]);
      connectStream();
      requestAnimationFrame(() => scrollToBottom(false));
    }

    function bindUiEvents() {
      groupSearchEl.addEventListener('input', renderGroups);
      timelineSearchEl.addEventListener('input', renderTimeline);
      showOpsEl.addEventListener('change', renderTimeline);
      pauseBtnEl.addEventListener('click', () => {
        streamPaused = !streamPaused;
        pauseBtnEl.classList.toggle('active', streamPaused);
        pauseBtnEl.textContent = streamPaused ? 'Resume' : 'Pause';
        if (!streamPaused) {
          droppedEvents = 0;
          setStreamStatus('stream connected');
        } else {
          setStreamStatus('stream paused');
        }
      });
    }

    async function boot() {
      bindUiEvents();
      await loadGroups();
      await loadQueue();

      const health = await fetchJson('/api/health');
      statusEl.textContent = 'ok @ ' + health.now;

      if (currentChat) {
        selectedEl.textContent = 'chat: ' + currentChat;
        await loadMessages();
        await loadEvents();
        connectStream();
        requestAnimationFrame(() => scrollToBottom(false));
      }

      setInterval(() => {
        loadQueue().catch(() => {});
      }, 5000);

      setInterval(() => {
        loadGroups().catch(() => {});
      }, 15000);

      setInterval(() => {
        loadMessages().catch(() => {});
      }, 3000);
    }

    boot().catch((err) => {
      statusEl.textContent = 'error: ' + (err instanceof Error ? err.message : String(err));
    });
  </script>
</body>
</html>`;
}

export function startDashboardServer(
  options: DashboardOptions,
  deps: DashboardDeps,
): DashboardServerHandle {
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
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  server.listen(options.port, options.host, () => {
    logger.info(
      { host: options.host, port: options.port },
      'Dashboard server started',
    );
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
