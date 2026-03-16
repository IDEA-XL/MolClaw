export function getDashboardHtml(): string {
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
      grid-template-columns: 1fr auto auto auto auto auto;
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
    .msg.round {
      align-self: flex-start;
      border-color: #b8c9e8;
      background: #f8fbff;
      max-width: min(780px, 96%);
    }
    .msg.round.round-focus {
      box-shadow: 0 0 0 2px #6aa0ff inset, 0 2px 12px rgba(23, 92, 211, 0.18);
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
    .round-summary {
      display: grid;
      gap: 4px;
      margin-top: 4px;
      margin-bottom: 4px;
    }
    .round-step {
      border: 1px solid #d8e3f3;
      border-radius: 8px;
      background: #fff;
      padding: 6px 8px;
      margin-bottom: 6px;
    }
    .round-step:last-child {
      margin-bottom: 0;
    }
    .round-step-title {
      font-size: 11px;
      font-weight: 700;
      color: #334e70;
      margin-bottom: 5px;
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
    .round-jump {
      border: 1px solid #bdd2f2;
      background: #eef5ff;
      color: #184f9d;
      border-radius: 6px;
      padding: 2px 7px;
      font-size: 11px;
      cursor: pointer;
    }
    .round-jump:hover {
      background: #e4efff;
    }
    .file-path {
      font-size: 11px;
      color: #456084;
      margin-bottom: 6px;
      word-break: break-all;
    }
    .file-actions {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
    }
    .file-list {
      border: 1px solid #dbe5f3;
      border-radius: 8px;
      background: #fff;
      max-height: 240px;
      overflow: auto;
      margin-bottom: 8px;
    }
    .file-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      width: 100%;
      border: 0;
      border-bottom: 1px solid #edf2f8;
      background: #fff;
      padding: 6px 8px;
      text-align: left;
      cursor: pointer;
      font-size: 12px;
      color: #2b4567;
    }
    .file-row:last-child {
      border-bottom: 0;
    }
    .file-row:hover {
      background: #f7faff;
    }
    .file-row.selected {
      background: #eaf2ff;
      border-left: 3px solid #5d8fe4;
      padding-left: 5px;
    }
    .file-tree-prefix {
      font-size: 11px;
      color: #5b7393;
      width: 14px;
      display: inline-block;
      text-align: center;
      flex: 0 0 14px;
    }
    .file-tree-indent {
      display: inline-block;
      width: 12px;
      flex: 0 0 12px;
    }
    .file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .file-meta {
      font-size: 10px;
      color: #6a7f99;
      white-space: nowrap;
    }
    .file-preview {
      border: 1px solid #dbe5f3;
      border-radius: 8px;
      background: #f8fbff;
      padding: 6px;
    }
    .file-preview-title {
      font-size: 11px;
      font-weight: 700;
      color: #34547b;
      margin-bottom: 4px;
      word-break: break-all;
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
        <select id="session-filter" title="Filter by session"></select>
        <button id="session-more-btn">More</button>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#475467;padding:0 4px;">
          <input type="checkbox" id="show-ops" /> show ops
        </label>
        <button id="new-session-btn">New Session</button>
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
    let currentSessionFilter = '__latest__';
    let sessionFilterInitialized = false;
    let showAllSessionOptions = false;
    let roundFocusTimer = null;
    let fileBrowserPath = '';
    let fileBrowserEntries = [];
    let fileBrowserError = '';
    let fileBrowserLoading = false;
    let fileTreeEntries = new Map();
    let fileTreeExpanded = new Set();
    let fileTreeLoading = new Set();
    let fileTreeSelected = '';
    let filePreviewPath = '';
    let filePreviewContent = '';
    let filePreviewError = '';
    let filePreviewLoading = false;
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
    const sessionFilterEl = document.getElementById('session-filter');
    const sessionMoreBtnEl = document.getElementById('session-more-btn');
    const showOpsEl = document.getElementById('show-ops');
    const newSessionBtnEl = document.getElementById('new-session-btn');
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

    function getEventSessionId(e) {
      if (!e || typeof e.sessionId !== 'string') return '';
      return e.sessionId.trim();
    }

    function getSessionSummaries(events) {
      const bySession = new Map();
      for (const e of events) {
        const sessionId = getEventSessionId(e);
        if (!sessionId) continue;
        const existing = bySession.get(sessionId) || {
          id: sessionId,
          firstTs: e.ts,
          lastTs: e.ts,
          count: 0,
        };
        existing.count += 1;
        if (e.ts < existing.firstTs) existing.firstTs = e.ts;
        if (e.ts > existing.lastTs) existing.lastTs = e.ts;
        bySession.set(sessionId, existing);
      }
      return Array.from(bySession.values())
        .sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0));
    }

    function getLatestSessionIdFromEvents(events) {
      const summaries = getSessionSummaries(events);
      return summaries.length > 0 ? summaries[0].id : '';
    }

    function getEffectiveSessionFilter() {
      if (currentSessionFilter === '__all__') {
        return '__all__';
      }
      if (currentSessionFilter === '__latest__') {
        const latest = getLatestSessionIdFromEvents(allEvents);
        return latest || '__all__';
      }
      return currentSessionFilter;
    }

    function sessionLabel(sessionId) {
      if (!sessionId) return 'unknown';
      if (sessionId.length <= 18) return sessionId;
      return sessionId.slice(0, 8) + '...' + sessionId.slice(-8);
    }

    function refreshSessionFilterOptions() {
      const summaries = getSessionSummaries(allEvents);
      const existing = new Set(summaries.map((s) => s.id));

      if (!sessionFilterInitialized) {
        currentSessionFilter = '__latest__';
        sessionFilterInitialized = true;
      } else if (
        currentSessionFilter !== '__all__'
        && currentSessionFilter !== '__latest__'
        && !existing.has(currentSessionFilter)
      ) {
        currentSessionFilter = '__latest__';
      }

      const MAX_VISIBLE_SESSIONS = 20;
      let visibleSummaries = showAllSessionOptions
        ? summaries
        : summaries.slice(0, MAX_VISIBLE_SESSIONS);
      if (
        currentSessionFilter !== '__all__'
        && currentSessionFilter !== '__latest__'
        && summaries.some((s) => s.id === currentSessionFilter)
        && !visibleSummaries.some((s) => s.id === currentSessionFilter)
      ) {
        const selected = summaries.find((s) => s.id === currentSessionFilter);
        if (selected) {
          visibleSummaries = [selected, ...visibleSummaries];
        }
      }

      let html = '<option value=\"__latest__\">latest session</option>';
      html += '<option value=\"__all__\">all sessions</option>';
      html += visibleSummaries.map((s) => {
        const selected = s.id === currentSessionFilter ? ' selected' : '';
        return '<option value=\"' + esc(s.id) + '\"' + selected + '>'
          + esc(sessionLabel(s.id) + ' · events=' + s.count)
          + '</option>';
      }).join('');
      sessionFilterEl.innerHTML = html;
      sessionFilterEl.value = currentSessionFilter;

      if (summaries.length > MAX_VISIBLE_SESSIONS) {
        sessionMoreBtnEl.disabled = false;
        sessionMoreBtnEl.textContent = showAllSessionOptions
          ? 'Recent 20'
          : 'More (' + (summaries.length - MAX_VISIBLE_SESSIONS) + ')';
      } else {
        sessionMoreBtnEl.disabled = true;
        sessionMoreBtnEl.textContent = 'More';
      }
    }

    function getFilteredEvents() {
      const effective = getEffectiveSessionFilter();
      if (effective === '__all__') {
        return allEvents;
      }
      return allEvents.filter((e) => getEventSessionId(e) === effective);
    }

    function getSessionMessageRangeMs(sessionId) {
      const events = allEvents.filter((e) => getEventSessionId(e) === sessionId);
      if (!events.length) return null;
      let minMs = Infinity;
      let maxMs = -Infinity;
      for (const e of events) {
        const t = Date.parse(e.ts);
        if (!Number.isFinite(t)) continue;
        if (t < minMs) minMs = t;
        if (t > maxMs) maxMs = t;
      }
      if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return null;
      // Include nearby user messages around the session event window.
      return {
        minMs: minMs - 5 * 60 * 1000,
        maxMs: maxMs + 60 * 1000,
      };
    }

    function getFilteredMessages() {
      const effective = getEffectiveSessionFilter();
      if (effective === '__all__') {
        return allMessages;
      }
      const range = getSessionMessageRangeMs(effective);
      if (!range) return [];
      return allMessages.filter((m) => {
        const t = Date.parse(m.timestamp);
        if (!Number.isFinite(t)) return false;
        return t >= range.minMs && t <= range.maxMs;
      });
    }

    function updateSelectedBadge() {
      const effective = getEffectiveSessionFilter();
      const sessionPart = currentSessionFilter === '__all__'
        ? 'all sessions'
        : currentSessionFilter === '__latest__'
          ? ('latest(' + (effective === '__all__' ? 'n/a' : sessionLabel(effective)) + ')')
          : sessionLabel(currentSessionFilter);
      selectedEl.textContent = 'chat: ' + (currentChat || 'none') + ' · session: ' + sessionPart;
    }

    function formatBytes(n) {
      const value = Number(n);
      if (!Number.isFinite(value) || value < 0) return '-';
      if (value < 1024) return value + 'B';
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + 'KB';
      return (value / (1024 * 1024)).toFixed(1) + 'MB';
    }

    async function loadFileBrowser(targetPath) {
      if (!currentChat) return;
      fileBrowserLoading = true;
      fileBrowserError = '';
      renderContextPanel();
      try {
        const data = await fetchJson(
          '/api/files/list?chat_jid=' + encodeURIComponent(currentChat)
          + '&path=' + encodeURIComponent(targetPath || ''),
        );
        fileBrowserPath = data.currentPath || '';
        fileBrowserEntries = Array.isArray(data.entries) ? data.entries : [];
        fileTreeEntries = new Map();
        fileTreeEntries.set(fileBrowserPath, fileBrowserEntries);
        fileTreeExpanded = new Set([fileBrowserPath]);
        fileTreeLoading = new Set();
        fileTreeSelected = '';
        filePreviewPath = '';
        filePreviewContent = '';
        filePreviewError = '';
      } catch (err) {
        fileBrowserError = err instanceof Error ? err.message : String(err);
      } finally {
        fileBrowserLoading = false;
        renderContextPanel();
      }
    }

    async function loadFileTreeNode(targetPath) {
      if (!currentChat || !targetPath) return;
      fileTreeLoading.add(targetPath);
      renderContextPanel();
      try {
        const data = await fetchJson(
          '/api/files/list?chat_jid=' + encodeURIComponent(currentChat)
          + '&path=' + encodeURIComponent(targetPath),
        );
        fileTreeEntries.set(targetPath, Array.isArray(data.entries) ? data.entries : []);
      } catch {
        // keep silent in tree node loading; user can still navigate by entering dir
      } finally {
        fileTreeLoading.delete(targetPath);
        renderContextPanel();
      }
    }

    function toggleTreeDir(targetPath) {
      if (!targetPath) return;
      if (fileTreeExpanded.has(targetPath)) {
        fileTreeExpanded.delete(targetPath);
        renderContextPanel();
        return;
      }
      fileTreeExpanded.add(targetPath);
      if (!fileTreeEntries.has(targetPath)) {
        loadFileTreeNode(targetPath).catch(() => {});
      } else {
        renderContextPanel();
      }
    }

    async function loadFilePreview(targetPath) {
      if (!currentChat) return;
      filePreviewLoading = true;
      filePreviewError = '';
      filePreviewPath = targetPath || '';
      renderContextPanel();
      try {
        const data = await fetchJson(
          '/api/files/read?chat_jid=' + encodeURIComponent(currentChat)
          + '&path=' + encodeURIComponent(targetPath || ''),
        );
        filePreviewPath = data.path || targetPath || '';
        filePreviewContent = data.content || '';
      } catch (err) {
        filePreviewError = err instanceof Error ? err.message : String(err);
        filePreviewContent = '';
      } finally {
        filePreviewLoading = false;
        renderContextPanel();
      }
    }

    function renderFileTreeRows(parentPath, depth) {
      const entries = fileTreeEntries.get(parentPath) || [];
      if (!entries.length) {
        return depth === 0
          ? '<div class=\"empty\">No entries</div>'
          : '';
      }

      let html = '';
      for (const entry of entries) {
        const isDir = entry.type === 'dir';
        const targetPath = parentPath
          ? (parentPath + '/' + entry.name)
          : entry.name;
        const isExpanded = isDir && fileTreeExpanded.has(targetPath);
        const isSelected = fileTreeSelected === targetPath;
        const prefix = isDir ? (isExpanded ? '▾' : '▸') : '·';
        const meta = isDir ? 'folder' : formatBytes(entry.size);

        html += '<button class=\"file-row' + (isSelected ? ' selected' : '') + '\"'
          + ' data-file-path=\"' + esc(targetPath) + '\"'
          + ' data-file-kind=\"' + esc(entry.type || '') + '\">';
        for (let i = 0; i < depth; i += 1) {
          html += '<span class=\"file-tree-indent\"></span>';
        }
        html += '<span class=\"file-tree-prefix\">' + esc(prefix) + '</span>'
          + '<span class=\"file-name\">' + esc(entry.name) + '</span>'
          + '<span class=\"file-meta\">' + esc(meta) + '</span>'
          + '</button>';

        if (isDir && isExpanded) {
          if (fileTreeLoading.has(targetPath)) {
            html += '<div class=\"empty\">Loading ' + esc(entry.name) + '...</div>';
          } else {
            html += renderFileTreeRows(targetPath, depth + 1);
          }
        }
      }
      return html;
    }

    function renderFileBrowserCard() {
      const pathText = fileBrowserPath ? ('/workspace/group/' + fileBrowserPath) : '/workspace/group';
      const parentPath = fileBrowserPath
        ? fileBrowserPath.split('/').slice(0, -1).join('/')
        : '';

      let listHtml = '<div class=\"empty\">No entries</div>';
      if (fileBrowserLoading) {
        listHtml = '<div class=\"empty\">Loading files...</div>';
      } else if (fileBrowserError) {
        listHtml = '<div class=\"empty error-text\">' + esc(fileBrowserError) + '</div>';
      } else {
        listHtml = renderFileTreeRows(fileBrowserPath, 0);
      }

      const previewHtml = filePreviewPath
        ? (filePreviewLoading
          ? '<div class=\"file-preview\"><div class=\"empty\">Loading preview...</div></div>'
          : filePreviewError
            ? '<div class=\"file-preview\"><div class=\"empty error-text\">'
              + esc(filePreviewError)
              + '</div></div>'
            : '<div class=\"file-preview\">'
              + '<div class=\"file-preview-title\">' + esc('/workspace/group/' + filePreviewPath) + '</div>'
              + renderCodeBlock(filePreviewContent || '(empty file)', 'text preview')
              + '</div>')
        : '<div class=\"empty\">Click a file to preview text content</div>';

      return ''
        + '<div class=\"card\">'
        + '  <p class=\"card-title\">Workspace Browser</p>'
        + '  <div class=\"file-path\">' + esc(pathText) + '</div>'
        + '  <div class=\"file-actions\">'
        + '    <button data-file-action=\"refresh\">Refresh Tree</button>'
        + '    <button data-file-action=\"up\"' + (fileBrowserPath ? '' : ' disabled') + '>Up</button>'
        + '    <button data-file-action=\"root\">Root</button>'
        + '  </div>'
        + '  <div class=\"file-list\">' + listHtml + '</div>'
        + previewHtml
        + '</div>';
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
          round: 1,
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

    function renderFoldSummary(summary, innerHtml, foldKey) {
      const keyAttr = foldKey ? (' data-fold-key=\"' + esc(foldKey) + '\"') : '';
      return '<details class=\"fold\"' + keyAttr + '><summary>' + esc(summary) + '</summary>' + innerHtml + '</details>';
    }

    function renderToolCallBody(payload, fallbackText, foldKeyPrefix) {
      const args = payload && payload.toolArgs && typeof payload.toolArgs === 'object'
        ? payload.toolArgs
        : parseMaybeJson(payload && payload.argsSummary);
      const keyPrefix = foldKeyPrefix || 'tool';
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        const text = fallbackText || payload.argsSummary || '';
        const firstLine = text.split('\\n').find((line) => line.trim()) || '(empty args)';
        return ''
          + '<div class=\"msg-body\">' + esc(firstLine.length > 220 ? firstLine.slice(0, 220) + '...' : firstLine) + '</div>'
          + renderFoldSummary('view full tool args', renderTextWithCodeBlocks(text), keyPrefix + ':tool-args');
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
        + renderFoldSummary('view full tool args', '<div class=\"kv-list\">' + htmlRows + '</div>', keyPrefix + ':tool-args');
    }

    function renderToolResultBody(payload, fallbackText, foldKeyPrefix) {
      const text = extractToolOutput(payload);
      const resolved = text || fallbackText || '';
      const summarySource = resolved.split('\\n').find((line) => line.trim()) || '(empty output)';
      const summary = summarySource.length > 240
        ? summarySource.slice(0, 240) + '...'
        : summarySource;
      const keyPrefix = foldKeyPrefix || 'tool';
      return ''
        + '<div class=\"msg-body\">' + esc(summary) + '</div>'
        + renderFoldSummary('view full tool output', renderTextWithCodeBlocks(resolved), keyPrefix + ':tool-output');
    }

    function providerVisibleText(payload) {
      const content = typeof payload.contentPreview === 'string' ? payload.contentPreview.trim() : '';
      const reasoning = typeof payload.reasoningPreview === 'string' ? payload.reasoningPreview.trim() : '';
      if (content) return { text: content, reasoning, note: '' };
      if (reasoning) {
        return {
          text: '',
          reasoning,
          note: 'provider exposed only reasoning/analysis text in this round',
        };
      }
      if (Number(payload.toolCalls || 0) > 0) {
        return {
          text: '',
          reasoning: '',
          note: 'provider returned tool calls only (no non-tool text exposed by API)',
        };
      }
      return {
        text: '',
        reasoning: '',
        note: typeof payload.message === 'string' ? payload.message : 'provider returned no visible text',
      };
    }

    function normalizeRound(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      if (n <= 0) return null;
      return Math.trunc(n);
    }

    function buildRoundBody(payload, foldKeyPrefix) {
      const provider = payload.provider || {};
      const context = payload.context || {};
      const toolStarts = Array.isArray(payload.toolStarts) ? payload.toolStarts : [];
      const toolResults = Array.isArray(payload.toolResults) ? payload.toolResults : [];
      const round = payload.round;

      const providerView = providerVisibleText(provider);
      const toolNames = Array.from(new Set(toolStarts.map((s) => s && s.payload && s.payload.toolName).filter(Boolean)));
      const tokenSummary = summarizeTokens(provider);
      const historyTokens = resolveHistoryTokens(context);
      const trimmedTokens = resolveTrimmedTokens(context);

      const providerHtml = ''
        + '<div class=\"round-step\">'
        + '  <div class=\"round-step-title\">Provider</div>'
        + (provider.model ? '<div class=\"msg-meta\">model=' + esc(provider.model) + '</div>' : '')
        + (tokenSummary ? '<div class=\"msg-meta\">' + esc(tokenSummary) + '</div>' : '')
        + (providerView.note ? '<div class=\"msg-body muted\">' + esc(providerView.note) + '</div>' : '')
        + (providerView.text ? renderTextWithCodeBlocks(providerView.text) : '')
        + (providerView.reasoning
          ? renderFoldSummary(
            'reasoning / analysis',
            renderTextWithCodeBlocks(providerView.reasoning),
            (foldKeyPrefix || 'round') + ':provider-reasoning',
          )
          : '')
        + '</div>';

      const usedResult = new Set();
      const pairedSteps = [];
      for (const start of toolStarts) {
        const startPayload = start && start.payload ? start.payload : {};
        const toolCallId = startPayload.toolCallId;
        let matched = null;
        for (let i = 0; i < toolResults.length; i += 1) {
          if (usedResult.has(i)) continue;
          const candidate = toolResults[i];
          const candidatePayload = candidate && candidate.payload ? candidate.payload : {};
          if (toolCallId && candidatePayload.toolCallId === toolCallId) {
            matched = { index: i, event: candidate };
            break;
          }
          if (!toolCallId && candidatePayload.toolName === startPayload.toolName) {
            matched = { index: i, event: candidate };
            break;
          }
        }
        if (matched) {
          usedResult.add(matched.index);
        }
        pairedSteps.push({
          start,
          result: matched ? matched.event : null,
        });
      }

      for (let i = 0; i < toolResults.length; i += 1) {
        if (usedResult.has(i)) continue;
        pairedSteps.push({
          start: null,
          result: toolResults[i],
        });
      }

      const toolHtml = pairedSteps.length > 0
        ? pairedSteps.map((step, idx) => {
            const startPayload = step.start && step.start.payload ? step.start.payload : {};
            const resultPayload = step.result && step.result.payload ? step.result.payload : {};
            const toolName = startPayload.toolName || resultPayload.toolName || ('tool #' + (idx + 1));
            const resultStage = step.result && step.result.stage ? step.result.stage : '';
            const title = resultStage === 'error' ? 'Tool error' : 'Tool';
            return ''
              + '<div class=\"round-step\">'
              + '  <div class=\"round-step-title\">' + esc(title + ': ' + toolName) + '</div>'
              + (step.start
                ? renderToolCallBody(startPayload, startPayload.argsSummary || '', (foldKeyPrefix || 'round') + ':tool-' + idx)
                : '<div class=\"msg-body muted\">tool call event missing</div>')
              + (step.result
                ? renderFoldSummary(
                  (resultStage === 'error' ? 'error' : 'result') + ' output',
                  renderToolResultBody(resultPayload, '', (foldKeyPrefix || 'round') + ':tool-' + idx + ':result'),
                  (foldKeyPrefix || 'round') + ':tool-' + idx + ':result-wrap',
                )
                : '<div class=\"msg-body muted\">tool result not received</div>')
              + '</div>';
          }).join('')
        : '<div class=\"round-step\"><div class=\"msg-body muted\">No tool events in this round.</div></div>';

      const roundSummary = [
        'round=' + round,
        provider.model ? ('model=' + provider.model) : '',
        toolNames.length > 0 ? ('tools=' + toolNames.join(', ')) : 'tools=none',
        tokenSummary || '',
        historyTokens != null ? ('historyTokens=' + historyTokens) : '',
        trimmedTokens != null ? ('trimmedTokens=' + trimmedTokens) : '',
      ].filter(Boolean).join(' · ');

      return ''
        + '<div class=\"round-summary\"><div class=\"msg-body\">' + esc(roundSummary) + '</div></div>'
        + renderFoldSummary(
          'expand round details',
          providerHtml + toolHtml,
          (foldKeyPrefix || 'round') + ':expand',
        );
    }

    function renderItemBody(item) {
      if (item.kind === 'round') {
        return buildRoundBody(item.payload || {}, item.key || 'round');
      }
      if (item.kind === 'tool-call') {
        return renderToolCallBody(item.payload || {}, item.body || '', item.key || 'tool-call');
      }
      if (item.kind === 'tool-result' || item.kind === 'error') {
        return renderToolResultBody(item.payload || {}, item.body || '', item.key || item.kind);
      }
      return renderTextWithCodeBlocks(item.body || '');
    }

    function buildTimelineItems() {
      const items = [];
      const events = getFilteredEvents();
      const messages = getFilteredMessages();

      for (const m of messages) {
        items.push({
          key: 'm-' + m.id,
          ts: m.timestamp,
          kind: 'user',
          role: m.sender_name || 'user',
          meta: m.sender || '',
          body: m.content || '',
        });
      }

      const sessionQueryIndex = new Map();
      let globalQueryIndex = 0;
      const queryKeyByEventId = new Map();

      for (const e of events) {
        const p = getEventPayload(e);
        const sessionId = (typeof e.sessionId === 'string' && e.sessionId.trim())
          ? e.sessionId.trim()
          : '__no_session__';

        if (e.eventType === 'lifecycle' && p.message === 'query_started') {
          const next = (sessionQueryIndex.get(sessionId) || 0) + 1;
          sessionQueryIndex.set(sessionId, next);
          globalQueryIndex += 1;
          queryKeyByEventId.set(e.id, sessionId + ':q' + next + ':g' + globalQueryIndex);
          continue;
        }

        const current = sessionQueryIndex.get(sessionId) || 0;
        queryKeyByEventId.set(
          e.id,
          sessionId + ':q' + current + ':g' + globalQueryIndex,
        );
      }

      const roundBuckets = new Map();
      for (const e of events) {
        const p = getEventPayload(e);
        const round = normalizeRound(p.round);
        const isRoundEvent = round != null && (
          (e.eventType === 'provider' && e.stage === 'end')
          || (e.eventType === 'tool' && (e.stage === 'start' || e.stage === 'end' || e.stage === 'error'))
          || (showOpsEl.checked && e.eventType === 'context')
        );

        if (isRoundEvent) {
          const queryKey = queryKeyByEventId.get(e.id) || '__unknown__:q0:g0';
          const roundKey = queryKey + ':r' + round;
          const existing = roundBuckets.get(roundKey) || {
            key: roundKey,
            round,
            queryKey,
            sessionId: e.sessionId || null,
            tsStart: e.ts,
            tsEnd: e.ts,
            provider: null,
            context: null,
            toolStarts: [],
            toolResults: [],
          };
          if (e.ts < existing.tsStart) existing.tsStart = e.ts;
          if (e.ts > existing.tsEnd) existing.tsEnd = e.ts;

          if (e.eventType === 'provider' && e.stage === 'end') {
            existing.provider = p;
          } else if (e.eventType === 'context') {
            existing.context = p;
          } else if (e.eventType === 'tool' && e.stage === 'start') {
            existing.toolStarts.push({ ts: e.ts, stage: e.stage, payload: p });
          } else if (e.eventType === 'tool' && (e.stage === 'end' || e.stage === 'error')) {
            existing.toolResults.push({ ts: e.ts, stage: e.stage, payload: p });
          }
          roundBuckets.set(roundKey, existing);
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

        if (showOpsEl.checked && e.eventType === 'lifecycle') {
          const summary = p.message || e.stage;
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

      const roundItems = Array.from(roundBuckets.values())
        .sort((a, b) => (a.tsStart < b.tsStart ? -1 : a.tsStart > b.tsStart ? 1 : 0))
        .map((roundEvent) => {
          const anchorId = 'round-' + String(roundEvent.key).replace(/[^a-zA-Z0-9_-]/g, '_');
          return {
            key: 'r-' + roundEvent.key,
            ts: roundEvent.tsStart,
            kind: 'round',
            role: 'round ' + roundEvent.round,
            meta: [
              roundEvent.provider && roundEvent.provider.durationMs != null
                ? ('durationMs=' + roundEvent.provider.durationMs)
                : '',
              roundEvent.provider ? summarizeTokens(roundEvent.provider) : '',
            ].filter(Boolean).join(' · '),
            body: '',
            anchorId,
            payload: { ...roundEvent, anchorId },
          };
        });

      items.push(...roundItems);
      items.sort(compareByTs);
      return items;
    }

    function renderTimeline() {
      const shouldStick = isNearBottom(timelineWrapEl);
      const openFoldKeys = new Set(
        Array.from(timelineEl.querySelectorAll('details.fold[open][data-fold-key]'))
          .map((el) => el.getAttribute('data-fold-key'))
          .filter(Boolean),
      );
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
        if (item.kind === 'round' && item.anchorId) {
          li.id = item.anchorId;
        }
        li.innerHTML = ''
          + '<div class="msg-head">'
          + '  <span class="msg-role">' + esc(item.role) + '</span>'
          + '  <span class="msg-time">' + esc(formatTime(item.ts)) + '</span>'
          + '</div>'
          + (item.meta ? '<div class="msg-meta">' + esc(item.meta) + '</div>' : '')
          + renderItemBody(item);
        timelineEl.appendChild(li);
      }

      if (openFoldKeys.size > 0) {
        for (const el of timelineEl.querySelectorAll('details.fold[data-fold-key]')) {
          const key = el.getAttribute('data-fold-key');
          if (key && openFoldKeys.has(key)) {
            el.open = true;
          }
        }
      }

      if (shouldStick) {
        scrollToBottom(true);
      }
    }

    function jumpToRound(anchorId) {
      if (!anchorId) return;
      const target = document.getElementById(anchorId);
      if (!target) {
        setStreamStatus('round not found in current session filter');
        return;
      }
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('round-focus');
      if (roundFocusTimer) {
        clearTimeout(roundFocusTimer);
      }
      roundFocusTimer = setTimeout(() => {
        target.classList.remove('round-focus');
        roundFocusTimer = null;
      }, 1500);
    }

    function getLatestContextEvent() {
      const events = getFilteredEvents();
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (e.eventType === 'context' && e.payload) return e;
      }
      return null;
    }

    function getLatestProviderEvent() {
      const events = getFilteredEvents();
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (e.eventType === 'provider' && e.stage === 'end') return e;
      }
      return null;
    }

    function getLatestModelVersion() {
      const events = getFilteredEvents();
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        const p = getEventPayload(e);
        if (typeof p.model === 'string' && p.model.trim()) return p.model.trim();
      }
      return 'n/a';
    }

    function getLatestSessionId() {
      if (currentSessionFilter === '__latest__') {
        const effective = getEffectiveSessionFilter();
        return effective === '__all__' ? 'n/a' : effective;
      }
      if (currentSessionFilter !== '__all__') {
        return currentSessionFilter || 'n/a';
      }
      const events = getFilteredEvents();
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (typeof e.sessionId === 'string' && e.sessionId.trim()) {
          return e.sessionId.trim();
        }
      }
      return 'n/a';
    }

    function buildRoundRows() {
      const events = getFilteredEvents();
      const sessionQueryIndex = new Map();
      let globalQueryIndex = 0;
      const queryKeyByEventId = new Map();

      for (const e of events) {
        const p = getEventPayload(e);
        const sessionId = getEventSessionId(e) || '__no_session__';
        if (e.eventType === 'lifecycle' && p.message === 'query_started') {
          const next = (sessionQueryIndex.get(sessionId) || 0) + 1;
          sessionQueryIndex.set(sessionId, next);
          globalQueryIndex += 1;
          queryKeyByEventId.set(e.id, sessionId + ':q' + next + ':g' + globalQueryIndex);
          continue;
        }
        const current = sessionQueryIndex.get(sessionId) || 0;
        queryKeyByEventId.set(e.id, sessionId + ':q' + current + ':g' + globalQueryIndex);
      }

      const byRound = new Map();
      for (const e of events) {
        const p = getEventPayload(e);
        const round = normalizeRound(p.round);
        if (round == null) continue;
        if (e.eventType !== 'context' && !(e.eventType === 'provider' && e.stage === 'end')) {
          continue;
        }

        const queryKey = queryKeyByEventId.get(e.id) || '__unknown__:q0:g0';
        const key = queryKey + ':r' + round;
        const existing = byRound.get(key) || {
          key,
          round,
          ts: e.ts,
          context: null,
          provider: null,
        };
        if (e.ts < existing.ts) existing.ts = e.ts;
        if (e.eventType === 'context') {
          existing.context = p;
        } else if (e.eventType === 'provider' && e.stage === 'end') {
          existing.provider = p;
        }
        byRound.set(key, existing);
      }

      return Array.from(byRound.values())
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
        .map((row) => {
          const c = row.context || {};
          const p = row.provider || {};
          const historyTokens = resolveHistoryTokens(c);
          const trimmedTokens = resolveTrimmedTokens(c);
          const promptTokens = resolvePromptTokens(p, c);
          const completionTokens = resolveCompletionTokens(p);
          const totalTokens = resolveTotalTokens(p, c);
          const anchorId = 'round-' + String(row.key).replace(/[^a-zA-Z0-9_-]/g, '_');
          return {
            ...row,
            anchorId,
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

      const ctx = latestContext ? getEventPayload(latestContext) : {};
      const provider = latestProvider ? getEventPayload(latestProvider) : {};
      const modelVersion = getLatestModelVersion();
      const latestSessionId = getLatestSessionId();
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
                + '<td><button class=\"round-jump\" data-anchor-id=\"' + esc(row.anchorId) + '\">' + esc(row.round) + '</button></td>'
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
        + '  <div class="kv"><span class="muted">session</span><span>' + esc(latestSessionId) + '</span></div>'
        + '  <div class="kv"><span class="muted">model</span><span>' + esc(modelVersion) + '</span></div>'
        + '  <div class="kv"><span class="muted">round</span><span>' + esc(ctx.round ?? provider.round ?? 'n/a') + '</span></div>'
        + '  <div class="kv"><span class="muted">history tokens</span><span>' + esc(historyTokens ?? 'n/a') + '</span></div>'
        + '  <div class="kv"><span class="muted">trimmed tokens</span><span>' + esc(trimmedTokens ?? 'n/a') + '</span></div>'
        + '  <div class="kv"><span class="muted">prompt / completion / total</span><span>'
        +      esc((promptTokens ?? 'n/a') + ' / ' + (completionTokens ?? 'n/a') + ' / ' + (totalTokens ?? 'n/a'))
        + '  </span></div>'
        + '</div>'
        + '<div class="card">'
        + '  <p class="card-title">Recent Rounds (msg/token)</p>'
        + roundsHtml
        + '</div>'
        + renderFileBrowserCard();
    }

    function updateTopUsage() {
      const events = getFilteredEvents();
      const providerEvents = events.filter((e) => e.eventType === 'provider' && e.stage === 'end');
      let prompt = 0;
      let completion = 0;
      let total = 0;
      let hasAny = false;

      for (const e of providerEvents) {
        const p = getEventPayload(e);
        const pt = asNumber(p.promptTokenCount);
        const ct = resolveCompletionTokens(p);
        const tt = asNumber(p.totalTokenCount);
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

    async function postJson(url) {
      const reqUrl = new URL(url, window.location.origin);
      if (token) reqUrl.searchParams.set('token', token);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let res;
      try {
        res = await fetch(reqUrl.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error('HTTP ' + res.status + ': ' + text);
      }
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
      refreshSessionFilterOptions();
      updateSelectedBadge();
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
      const payload = getEventPayload(event);
      if (
        event.eventType === 'lifecycle'
        && payload.message === 'session_reset'
      ) {
        currentSessionFilter = '__latest__';
        sessionFilterInitialized = true;
        setStreamStatus('session reset, waiting for next query...');
      }
      if (allEvents.length > 1600) {
        allEvents = allEvents.slice(allEvents.length - 1600);
      }
      refreshSessionFilterOptions();
      updateSelectedBadge();
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
      currentSessionFilter = '__latest__';
      sessionFilterInitialized = false;
      showAllSessionOptions = false;
      fileBrowserPath = '';
      fileBrowserEntries = [];
      fileBrowserError = '';
      filePreviewPath = '';
      filePreviewContent = '';
      filePreviewError = '';
      fileBrowserLoading = false;
      filePreviewLoading = false;
      updateSelectedBadge();
      droppedEvents = 0;
      await Promise.all([loadGroups(), loadQueue(), loadMessages(), loadEvents()]);
      await loadFileBrowser('');
      connectStream();
      requestAnimationFrame(() => scrollToBottom(false));
    }

    function bindUiEvents() {
      groupSearchEl.addEventListener('input', renderGroups);
      timelineSearchEl.addEventListener('input', renderTimeline);
      sessionFilterEl.addEventListener('change', () => {
        currentSessionFilter = sessionFilterEl.value || '__all__';
        sessionFilterInitialized = true;
        updateSelectedBadge();
        renderTimeline();
        renderContextPanel();
        updateTopUsage();
      });
      sessionMoreBtnEl.addEventListener('click', () => {
        if (sessionMoreBtnEl.disabled) return;
        showAllSessionOptions = !showAllSessionOptions;
        refreshSessionFilterOptions();
      });
      showOpsEl.addEventListener('change', renderTimeline);
      contextEl.addEventListener('click', (ev) => {
        const target = ev.target;
        if (!target || !target.closest) return;
        const btn = target.closest('.round-jump');
        if (btn) {
          const anchorId = btn.getAttribute('data-anchor-id');
          jumpToRound(anchorId);
          return;
        }

        const actionBtn = target.closest('[data-file-action]');
        if (actionBtn) {
          const action = actionBtn.getAttribute('data-file-action');
          if (action === 'refresh') {
            loadFileBrowser(fileBrowserPath).catch(() => {});
            return;
          }
          if (action === 'up') {
            const parentPath = fileBrowserPath
              ? fileBrowserPath.split('/').slice(0, -1).join('/')
              : '';
            loadFileBrowser(parentPath).catch(() => {});
            return;
          }
          if (action === 'root') {
            loadFileBrowser('').catch(() => {});
            return;
          }
        }

        const fileRow = target.closest('.file-row');
        if (fileRow) {
          const filePath = fileRow.getAttribute('data-file-path') || '';
          const fileKind = fileRow.getAttribute('data-file-kind') || '';
          fileTreeSelected = filePath;
          if (fileKind === 'dir') {
            if (ev.detail === 1) {
              toggleTreeDir(filePath);
            }
          } else if (fileKind === 'file') {
            loadFilePreview(filePath).catch(() => {});
          } else {
            renderContextPanel();
          }
        }
      });
      contextEl.addEventListener('dblclick', (ev) => {
        const target = ev.target;
        if (!target || !target.closest) return;
        const fileRow = target.closest('.file-row');
        if (!fileRow) return;
        const filePath = fileRow.getAttribute('data-file-path') || '';
        const fileKind = fileRow.getAttribute('data-file-kind') || '';
        if (fileKind === 'dir') {
          fileTreeSelected = filePath;
          loadFileBrowser(filePath).catch(() => {});
        }
      });
      newSessionBtnEl.addEventListener('click', async () => {
        if (!currentChat) return;
        try {
          newSessionBtnEl.disabled = true;
          currentSessionFilter = '__latest__';
          sessionFilterInitialized = true;
          const result = await postJson('/api/session/reset?chat_jid=' + encodeURIComponent(currentChat));
          setStreamStatus(result && result.message ? result.message : 'session reset');
          await loadEvents();
        } catch (err) {
          setStreamStatus('session reset failed');
          statusEl.textContent = 'error: ' + (err instanceof Error ? err.message : String(err));
        } finally {
          newSessionBtnEl.disabled = false;
        }
      });
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
        updateSelectedBadge();
        await loadMessages();
        await loadEvents();
        await loadFileBrowser('');
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

