const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(os.homedir(), '.daytask.json');
let config = {
  odoo: { url: '', db: '', username: '', password: '', project_id: null },
  search_languages: ['en_US', 'de_DE'],
  project_colors: {},
  work_dir: path.join(os.homedir(), 'ai', 'work'),
  done_dir: path.join(os.homedir(), 'ai', 'done'),
};
if (fs.existsSync(CONFIG_PATH)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch {}
}
if (!Array.isArray(config.search_languages) || !config.search_languages.length) {
  config.search_languages = ['en_US', 'de_DE'];
}
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }
function getSearchLanguages() {
  const cleaned = (config.search_languages || []).map(l => String(l || '').trim()).filter(Boolean);
  return cleaned.length ? cleaned : ['en_US', 'de_DE'];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function localNow() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── Database ──────────────────────────────────────────────────────────────────
const DB_PATH = path.join(os.homedir(), '.daytask.db');
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, ticket_ref TEXT, note TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    date TEXT DEFAULT (date('now','localtime')),
    done INTEGER DEFAULT 0, odoo_line_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS odoo_tasks_cache (
    id INTEGER PRIMARY KEY, project_id INTEGER, project_name TEXT,
    task_name TEXT, task_no TEXT, cached_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS timeslots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
    started_at TEXT NOT NULL, stopped_at TEXT, synced INTEGER DEFAULT 0,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  );
`);
function runMigration(name, sql) {
  if (!db.prepare('SELECT 1 FROM _migrations WHERE name=?').get(name)) {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations(name) VALUES(?)').run(name);
  }
}
runMigration('add_odoo_task_link', `ALTER TABLE tasks ADD COLUMN odoo_task_id INTEGER; ALTER TABLE tasks ADD COLUMN odoo_project_id INTEGER; ALTER TABLE tasks ADD COLUMN odoo_task_label TEXT;`);
runMigration('add_vscode_fields', `ALTER TABLE tasks ADD COLUMN vscode_ssh_host TEXT; ALTER TABLE tasks ADD COLUMN vscode_path TEXT; ALTER TABLE tasks ADD COLUMN git_repo TEXT; ALTER TABLE tasks ADD COLUMN git_branch TEXT;`);
runMigration('add_deadline', `ALTER TABLE tasks ADD COLUMN deadline TEXT;`);
runMigration('add_ticket_url', `ALTER TABLE tasks ADD COLUMN ticket_url TEXT;`);
runMigration('add_last_commit', `ALTER TABLE tasks ADD COLUMN last_commit_sha TEXT;`);
runMigration('add_odoo_stage', `ALTER TABLE tasks ADD COLUMN odoo_stage TEXT;`);
runMigration('add_sequence_name', `ALTER TABLE tasks ADD COLUMN sequence_name TEXT;`);
runMigration('add_private_notes', `ALTER TABLE tasks ADD COLUMN private_notes TEXT;`);
runMigration('add_priority', `ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0;`);
runMigration('add_working_dir', `ALTER TABLE tasks ADD COLUMN working_dir TEXT;`);
try {
  const swept = db.prepare(`UPDATE timeslots SET synced=1 WHERE synced=0 AND stopped_at IS NOT NULL AND strftime('%s', stopped_at) - strftime('%s', started_at) < 1`).run();
  if (swept.changes) console.log('[cleanup]', swept.changes, 'zero-duration timeslots');
} catch {}

// Resume open timer on startup
let activeTaskId = null;
let activeSlotId = null;
try {
  const open = db.prepare(`SELECT id, task_id FROM timeslots WHERE stopped_at IS NULL ORDER BY id DESC`).all();
  if (open.length) {
    const [active, ...orphans] = open;
    activeTaskId = active.task_id;
    activeSlotId = active.id;
    console.log('[resume] Timer für Task', activeTaskId);
    const closeStmt = db.prepare('UPDATE timeslots SET stopped_at=started_at, synced=1 WHERE id=?');
    for (const o of orphans) closeStmt.run(o.id);
  }
} catch (e) { console.error('[resume]', e.message); }

// ── Odoo XML-RPC ──────────────────────────────────────────────────────────────
async function odooCall(endpoint, method, params) {
  const xmlrpc = require('xmlrpc');
  const url = new URL(config.odoo.url);
  const isHttps = url.protocol === 'https:';
  const port = url.port ? parseInt(url.port) : (isHttps ? 443 : 80);
  const clientOpts = { host: url.hostname, port, path: endpoint, rejectUnauthorized: false };
  const client = isHttps ? xmlrpc.createSecureClient(clientOpts) : xmlrpc.createClient(clientOpts);
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err, val) => err ? reject(err) : resolve(val));
  });
}
async function odooUID() {
  return odooCall('/xmlrpc/2/common', 'authenticate', [config.odoo.db, config.odoo.username, config.odoo.password, {}]);
}

const STAGE_KEYWORDS = {
  in_progress: ['progress', 'bearbeitung', 'arbeit', 'aktiv', 'in progress'],
  waiting: ['waiting', 'warten', 'pause', 'wartend', 'blocked'],
  done: ['done', 'abgeschlossen', 'fertig', 'erledigt', 'closed'],
};
async function loadStageNames(uid, stageIds) {
  const langs = getSearchLanguages();
  const stageMap = {};
  for (const lang of langs) {
    try {
      const stages = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task.type', 'read', [stageIds], { fields: ['id', 'name'], context: { lang } }]);
      for (const s of stages) {
        if (!stageMap[s.id]) stageMap[s.id] = { id: s.id, name: s.name, names: [] };
        stageMap[s.id].names.push(s.name);
      }
    } catch {}
  }
  if (!Object.keys(stageMap).length) {
    const stages = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task.type', 'read', [stageIds], { fields: ['id', 'name'] }]);
    for (const s of stages) stageMap[s.id] = { id: s.id, name: s.name, names: [s.name] };
  }
  return stageMap;
}
function matchStage(stageIds, stageMap, keywords) {
  for (const sid of stageIds) {
    const s = stageMap[sid];
    if (!s) continue;
    const allNames = (s.names || [s.name]).map(n => n.toLowerCase());
    if (allNames.some(name => keywords.some(kw => name.includes(kw)))) return s;
  }
  return null;
}
function isCollectiveTask(title) {
  const keywords = (config.no_done_keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  return keywords.length && keywords.some(kw => (title || '').toLowerCase().includes(kw));
}
async function setOdooTaskStage(taskId, stageType) {
  try {
    if (!config.odoo.url || !config.odoo.username) return;
    const task = db.prepare('SELECT odoo_task_id, odoo_project_id, title FROM tasks WHERE id=?').get(taskId);
    if (!task?.odoo_task_id) return;
    if (stageType === 'done' && isCollectiveTask(task.title)) return;
    const uid = await odooUID();
    if (!uid) return;
    const odooTask = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'read', [[task.odoo_task_id]], { fields: ['user_ids'] }]);
    if (!odooTask?.[0]) return;
    const userIds = odooTask[0].user_ids || [];
    if (userIds.length !== 1 || userIds[0] !== uid) return;
    const mappings = config.stage_mappings || {};
    const projMapping = mappings[String(task.odoo_project_id)] || mappings['default'];
    if (!projMapping?.[stageType]) return;
    await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'write', [[task.odoo_task_id], { stage_id: projMapping[stageType] }]]);
  } catch (e) { console.error('[stage]', e.message); }
}

async function syncUnsyncedTimeslots(taskId) {
  const slots = db.prepare(`SELECT ts.*, t.title, t.ticket_ref, t.note, t.odoo_task_id, t.odoo_project_id FROM timeslots ts JOIN tasks t ON t.id=ts.task_id WHERE ts.task_id=? AND ts.synced=0 AND ts.stopped_at IS NOT NULL ORDER BY ts.started_at`).all(taskId);
  if (!slots.length) return [];
  let totalHours = 0;
  const validSlotIds = [];
  for (const s of slots) {
    const h = (new Date(s.stopped_at) - new Date(s.started_at)) / 3600000;
    if (h < 0.01) db.prepare('UPDATE timeslots SET synced=1 WHERE id=?').run(s.id);
    else { totalHours += h; validSlotIds.push(s.id); }
  }
  if (!validSlotIds.length) return [{ ok: true, skipped: true }];
  if (!slots[0].odoo_task_id) return [{ ok: false, error: 'no_odoo_task', pending: true }];
  if (!config.odoo.url || !config.odoo.username) return [{ ok: false, error: 'Odoo not configured' }];
  totalHours = Math.ceil(totalHours * 4) / 4;
  try {
    const uid = await odooUID();
    if (!uid) return [{ ok: false, error: 'Odoo auth failed' }];
    const slot = slots[0];
    let desc = slot.ticket_ref ? `[${slot.ticket_ref}] ${slot.title}` : slot.title;
    if (slot.note) { desc += '\n' + slot.note; } else {
      try {
        const t = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'read', [[slot.odoo_task_id]], { fields: ['description'] }]);
        if (t?.[0]?.description) {
          const plain = t[0].description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (plain) desc += '\n' + plain;
        }
      } catch {}
    }
    const vals = { name: desc, date: slot.started_at.split(' ')[0], unit_amount: totalHours, project_id: slot.odoo_project_id, task_id: slot.odoo_task_id };
    const lineId = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'account.analytic.line', 'create', [vals]]);
    for (const id of validSlotIds) db.prepare('UPDATE timeslots SET synced=1 WHERE id=?').run(id);
    return [{ ok: true, lineId, synced: validSlotIds.length }];
  } catch (e) { return [{ ok: false, error: e.message }]; }
}

async function stopTimer({ sync = true } = {}) {
  if (!activeSlotId) return { ok: false };
  const taskId = activeTaskId;
  const now = localNow();
  db.prepare('UPDATE timeslots SET stopped_at=? WHERE id=?').run(now, activeSlotId);
  const slotId = activeSlotId;
  activeTaskId = null;
  activeSlotId = null;
  if (taskId) setOdooTaskStage(taskId, 'waiting').catch(() => {});
  broadcastSSE('refresh', {});
  let syncResult = null;
  if (sync) {
    const taskRow = db.prepare('SELECT task_id FROM timeslots WHERE id=?').get(slotId);
    if (taskRow) {
      const results = await syncUnsyncedTimeslots(taskRow.task_id);
      syncResult = results[0] || null;
    }
  }
  return { ok: true, slotId, odoo: syncResult };
}

// ── SSE ───────────────────────────────────────────────────────────────────────
const sseClients = [];
function broadcastSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try { sseClients[i].write(msg); } catch { sseClients.splice(i, 1); }
  }
}
setInterval(() => {
  if (activeTaskId) broadcastSSE('tick', { activeTaskId, activeSlotId, now: Date.now() });
}, 1000);

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// ── Task Queries ──────────────────────────────────────────────────────────────
function queryTodayTasks(today) {
  return db.prepare(`
    SELECT t.*, t.odoo_task_id, t.odoo_project_id, t.odoo_task_label,
      COALESCE((SELECT SUM((julianday(COALESCE(stopped_at, datetime('now','localtime'))) - julianday(started_at)) * 86400) FROM timeslots WHERE task_id=t.id), 0) AS total_seconds,
      (SELECT started_at FROM timeslots WHERE task_id=t.id AND stopped_at IS NULL LIMIT 1) AS running_since,
      (SELECT COUNT(*) FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL) AS unsynced_count,
      COALESCE((SELECT SUM((julianday(stopped_at) - julianday(started_at)) * 86400) FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL), 0) AS unsynced_seconds
    FROM tasks t WHERE t.date=?
    ORDER BY t.done ASC, COALESCE(t.priority,0) DESC,
      COALESCE((SELECT MAX(started_at) FROM timeslots WHERE task_id=t.id), t.created_at) DESC, t.id DESC
  `).all(today);
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/tasks/today', (req, res) => {
  const today = localNow().split(' ')[0];
  res.json({ tasks: queryTodayTasks(today), activeTaskId, activeSlotId });
});

app.get('/api/tasks/unsynced', (req, res) => {
  const tasks = db.prepare(`
    SELECT t.*, t.odoo_task_id, t.odoo_project_id, t.odoo_task_label,
      COALESCE((SELECT SUM((julianday(COALESCE(stopped_at, datetime('now','localtime'))) - julianday(started_at)) * 86400) FROM timeslots WHERE task_id=t.id), 0) AS total_seconds,
      (SELECT started_at FROM timeslots WHERE task_id=t.id AND stopped_at IS NULL LIMIT 1) AS running_since,
      (SELECT COUNT(*) FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL) AS unsynced_count,
      COALESCE((SELECT SUM((julianday(stopped_at) - julianday(started_at)) * 86400) FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL), 0) AS unsynced_seconds
    FROM tasks t WHERE EXISTS (SELECT 1 FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL)
    ORDER BY t.date DESC, t.id DESC
  `).all();
  res.json({ tasks });
});

app.get('/api/tasks/:id', (req, res) => {
  const task = db.prepare(`
    SELECT t.*, COALESCE((SELECT SUM((julianday(COALESCE(stopped_at, datetime('now','localtime'))) - julianday(started_at)) * 86400) FROM timeslots WHERE task_id=t.id), 0) AS total_seconds,
      (SELECT COUNT(*) FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL) AS unsynced_count,
      COALESCE((SELECT SUM((julianday(stopped_at) - julianday(started_at)) * 86400) FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL), 0) AS unsynced_seconds
    FROM tasks t WHERE t.id=?
  `).get(req.params.id);
  res.json(task);
});

app.post('/api/tasks', async (req, res) => {
  const { title, ticket_ref, note, deadline, odoo_project_id, odoo_project_name, odoo_task_id, odoo_task_name, odoo_task_sequence } = req.body;
  const today = localNow().split(' ')[0];
  let odooTaskId = odoo_task_id || null;
  let odooTaskLabel = null;
  let seqName = odoo_task_sequence || null;
  let odooCreateError = null;
  if (odoo_task_id) {
    odooTaskLabel = `${odoo_project_name || ''} / ${odoo_task_name || title}`;
  } else if (odoo_project_id && config.odoo.url && config.odoo.username) {
    try {
      const uid = await odooUID();
      if (!uid) throw new Error('Odoo-Auth fehlgeschlagen');
      const vals = { name: title, project_id: odoo_project_id };
      if (deadline) vals.date_deadline = deadline.includes('T') ? deadline.split('T')[0] : deadline;
      odooTaskId = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'create', [vals]]);
      odooTaskLabel = `${odoo_project_name || ''} / ${title}`;
    } catch (e) { odooCreateError = e.message; }
  }
  const info = db.prepare('INSERT INTO tasks (title, ticket_ref, note, date, deadline, odoo_task_id, odoo_project_id, odoo_task_label, sequence_name) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(title, ticket_ref || null, note || null, today, deadline || null, odooTaskId, odoo_project_id || null, odooTaskLabel, seqName);
  res.json({ id: info.lastInsertRowid, odooTaskId, odooCreateError });
});

app.post('/api/tasks/:id/done', async (req, res) => {
  const id = parseInt(req.params.id);
  if (activeTaskId === id) await stopTimer({ sync: true });
  db.prepare('UPDATE tasks SET done=1 WHERE id=?').run(id);
  moveWorkingDir(id, config.work_dir || path.join(os.homedir(), 'ai', 'work'),
                     config.done_dir || path.join(os.homedir(), 'ai', 'done'));
  setOdooTaskStage(id, 'done').catch(() => {});
  broadcastSSE('refresh', {});
  res.json(true);
});

app.post('/api/tasks/:id/undone', (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare('UPDATE tasks SET done=0 WHERE id=?').run(id);
  moveWorkingDir(id, config.done_dir || path.join(os.homedir(), 'ai', 'done'),
                     config.work_dir || path.join(os.homedir(), 'ai', 'work'));
  res.json(true);
});

app.post('/api/tasks/:id/delete', (req, res) => {
  const id = parseInt(req.params.id);
  if (activeTaskId === id) stopTimer({ sync: false });
  db.prepare('DELETE FROM timeslots WHERE task_id=?').run(id);
  db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  broadcastSSE('refresh', {});
  res.json(true);
});

app.post('/api/tasks/update', (req, res) => {
  const { id, title, ticket_ref, note, private_notes, working_dir } = req.body;
  db.prepare('UPDATE tasks SET title=?, ticket_ref=?, note=?, private_notes=? WHERE id=?').run(title, ticket_ref || null, note || null, private_notes || null, id);
  if (working_dir !== undefined) {
    db.prepare('UPDATE tasks SET working_dir=? WHERE id=?').run(working_dir || null, id);
  }
  broadcastSSE('refresh', {});
  res.json(true);
});

app.post('/api/tasks/priority', (req, res) => {
  const { id, priority } = req.body;
  db.prepare('UPDATE tasks SET priority=? WHERE id=?').run(priority ? 1 : 0, id);
  res.json(true);
});

app.post('/api/tasks/link-odoo', async (req, res) => {
  const { taskId, odooTaskId, odooProjectId, odooTaskLabel, gitBranch, gitRepo, deadline } = req.body;
  db.prepare('UPDATE tasks SET odoo_task_id=?, odoo_project_id=?, odoo_task_label=? WHERE id=?').run(odooTaskId, odooProjectId, odooTaskLabel, taskId);
  if (gitBranch || gitRepo || deadline) {
    db.prepare('UPDATE tasks SET git_branch=COALESCE(?, git_branch), git_repo=COALESCE(?, git_repo), deadline=COALESCE(?, deadline) WHERE id=?').run(gitBranch || null, gitRepo || null, deadline || null, taskId);
  }
  const syncResults = await syncUnsyncedTimeslots(taskId);
  const synced = syncResults.filter(r => r.ok).length;
  const failed = syncResults.filter(r => !r.ok).length;
  broadcastSSE('refresh', {});
  res.json({ ok: true, synced, failed });
});

app.post('/api/tasks/:id/unlink-odoo', (req, res) => {
  db.prepare('UPDATE tasks SET odoo_task_id=NULL, odoo_project_id=NULL, odoo_task_label=NULL WHERE id=?').run(req.params.id);
  broadcastSSE('refresh', {});
  res.json(true);
});

app.post('/api/tasks/:id/sync', async (req, res) => {
  const results = await syncUnsyncedTimeslots(req.params.id);
  const synced = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  res.json({ ok: failed.length === 0, synced, failed: failed.length, errors: failed.map(f => f.error) });
});

app.post('/api/tasks/merge', (req, res) => {
  const { targetId, sourceId } = req.body;
  const target = db.prepare('SELECT * FROM tasks WHERE id=?').get(targetId);
  const source = db.prepare('SELECT * FROM tasks WHERE id=?').get(sourceId);
  if (!target || !source) return res.json({ ok: false, error: 'Task nicht gefunden' });
  const fields = ['ticket_ref', 'note', 'odoo_task_id', 'odoo_project_id', 'odoo_task_label', 'vscode_ssh_host', 'vscode_path', 'git_repo', 'git_branch', 'deadline', 'ticket_url', 'odoo_stage', 'sequence_name'];
  const updates = [], values = [];
  for (const f of fields) {
    if (target[f] == null && source[f] != null) { updates.push(`${f}=?`); values.push(source[f]); }
  }
  if (updates.length) { values.push(targetId); db.prepare(`UPDATE tasks SET ${updates.join(',')} WHERE id=?`).run(...values); }
  db.prepare('UPDATE timeslots SET task_id=? WHERE task_id=?').run(targetId, sourceId);
  db.prepare('DELETE FROM tasks WHERE id=?').run(sourceId);
  broadcastSSE('refresh', {});
  res.json({ ok: true, merged: updates.length });
});

app.post('/api/tasks/:id/open-ticket', (req, res) => {
  const task = db.prepare('SELECT ticket_url FROM tasks WHERE id=?').get(req.params.id);
  if (task?.ticket_url) res.json({ ok: true, url: task.ticket_url });
  else res.json({ ok: false });
});

app.get('/api/tasks/:id/commits', async (req, res) => {
  const task = db.prepare('SELECT vscode_ssh_host, vscode_path, git_repo, git_branch, last_commit_sha FROM tasks WHERE id=?').get(req.params.id);
  if (!task || (!task.vscode_path && !task.git_repo)) return res.json({ ok: false, error: 'Kein Verzeichnis hinterlegt' });
  const { promisify } = require('util');
  const execAsync = promisify(require('child_process').exec);
  const branch = task.git_branch || 'HEAD';
  const logFmt = '--pretty=format:%H||%h||%an||%ad||%s --date=short';
  function parseCommits(stdout) {
    return stdout.trim().split('\n').filter(Boolean).map(l => {
      const [sha, short, author, date, ...msg] = l.split('||');
      return { sha, short, author, date, message: msg.join('||') };
    });
  }
  if (task.git_repo && !task.vscode_path) {
    try {
      const repoMatch = task.git_repo.match(/(?:github\.com)[:/](.+?)(?:\.git)?$/);
      if (repoMatch) {
        const limit = task.last_commit_sha ? 100 : 20;
        const { stdout } = await execAsync(`gh api repos/${repoMatch[1]}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit} --jq '.[] | .sha + "||" + (.sha[:7]) + "||" + .commit.author.name + "||" + (.commit.author.date[:10]) + "||" + (.commit.message | split("\\n") | .[0])'`, { timeout: 15000 });
        let commits = parseCommits(stdout);
        if (task.last_commit_sha) { const idx = commits.findIndex(c => c.sha === task.last_commit_sha); if (idx >= 0) commits = commits.slice(0, idx); }
        if (commits.length) db.prepare('UPDATE tasks SET last_commit_sha=? WHERE id=?').run(commits[0].sha, req.params.id);
        return res.json({ ok: true, commits, isNew: !task.last_commit_sha });
      }
    } catch {}
  }
  if (task.vscode_path) {
    try {
      const since = task.last_commit_sha ? `${task.last_commit_sha}..${branch}` : `${branch} -20`;
      const cmd = task.vscode_ssh_host ? `ssh ${task.vscode_ssh_host} "cd '${task.vscode_path}' && git log ${since} ${logFmt}"` : `cd '${task.vscode_path}' && git log ${since} ${logFmt}`;
      const { stdout } = await execAsync(cmd, { timeout: 15000 });
      const commits = parseCommits(stdout);
      if (commits.length) db.prepare('UPDATE tasks SET last_commit_sha=? WHERE id=?').run(commits[0].sha, req.params.id);
      return res.json({ ok: true, commits, isNew: !task.last_commit_sha });
    } catch (e) { return res.json({ ok: false, error: e.message }); }
  }
  res.json({ ok: false, error: 'Keine Methode verfügbar' });
});

// ── Timeslots ─────────────────────────────────────────────────────────────────
app.post('/api/timeslots', (req, res) => {
  const { taskId, durationMinutes } = req.body;
  const now = new Date();
  const started = new Date(now.getTime() - durationMinutes * 60000);
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  db.prepare('INSERT INTO timeslots (task_id, started_at, stopped_at) VALUES (?,?,?)').run(taskId, fmt(started), fmt(now));
  res.json(true);
});

app.post('/api/tasks/:id/timeslots/reset', (req, res) => {
  const taskId = parseInt(req.params.id);
  const wasRunning = activeTaskId === taskId;
  if (wasRunning) { activeTaskId = null; activeSlotId = null; }
  db.prepare('DELETE FROM timeslots WHERE task_id=?').run(taskId);
  if (wasRunning) {
    activeTaskId = taskId;
    const now = localNow();
    const info = db.prepare('INSERT INTO timeslots (task_id, started_at) VALUES (?,?)').run(taskId, now);
    activeSlotId = info.lastInsertRowid;
  }
  res.json({ wasRunning });
});

// ── Timer ─────────────────────────────────────────────────────────────────────
app.post('/api/timer/start/:taskId', async (req, res) => {
  const taskId = parseInt(req.params.taskId);
  if (activeTaskId === taskId) return res.json({ ok: false, reason: 'already running' });
  if (activeTaskId) await stopTimer({ sync: false });
  activeTaskId = taskId;
  const now = localNow();
  const info = db.prepare('INSERT INTO timeslots (task_id, started_at) VALUES (?,?)').run(taskId, now);
  activeSlotId = info.lastInsertRowid;
  setOdooTaskStage(taskId, 'in_progress').catch(() => {});
  broadcastSSE('refresh', {});
  res.json({ ok: true, slotId: activeSlotId });
});

app.post('/api/timer/stop', async (req, res) => {
  if (!activeTaskId) return res.json({ ok: false });
  const result = await stopTimer();
  res.json(result);
});

app.get('/api/timer/status', (req, res) => res.json({ activeTaskId, activeSlotId }));

// ── Config ────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  config = { ...config, ...req.body };
  saveConfig();
  res.json(true);
});

// ── Odoo ──────────────────────────────────────────────────────────────────────
app.get('/api/odoo/test', async (req, res) => {
  try {
    if (!config.odoo.url || !config.odoo.username) return res.json({ ok: false, error: 'Odoo nicht konfiguriert' });
    if (!config.odoo.db) return res.json({ ok: false, error: 'Datenbank fehlt' });
    const uid = await odooUID();
    if (!uid) return res.json({ ok: false, error: 'Auth fehlgeschlagen' });
    res.json({ ok: true, uid });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/odoo/search-tasks', async (req, res) => {
  const { query } = req.body;
  try {
    if (!config.odoo.url || !config.odoo.username) return res.json({ ok: false, error: 'Odoo nicht konfiguriert' });
    const uid = await odooUID();
    if (!uid) return res.json({ ok: false, error: 'Auth fehlgeschlagen' });
    const words = (query || '').trim().split(/\s+/).filter(Boolean);
    const buildDomain = () => {
      const d = [];
      for (const w of words) d.push('|', '|', ['name', 'ilike', w], ['project_id.name', 'ilike', w], ['sequence_name', 'ilike', w]);
      return d;
    };
    const langs = getSearchLanguages();
    const idSet = new Set();
    for (const lang of langs) {
      try {
        const ids = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'search', [buildDomain()], { limit: 50, context: { lang } }]);
        (ids || []).forEach(id => idSet.add(id));
      } catch {}
    }
    let taskIds = [...idSet];
    if (!taskIds.length && query) {
      try { taskIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'search', [[['name', 'ilike', query]]], { limit: 50 }]) || []; } catch {}
    }
    if (!taskIds.length) return res.json({ ok: true, tasks: [] });
    const baseFields = ['id', 'name', 'project_id', 'date_deadline', 'stage_id', 'sequence_name'];
    let tasks;
    try { tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'read', [taskIds], { fields: [...baseFields, 'branch_name', 'repo'] }]); }
    catch { tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'read', [taskIds], { fields: baseFields }]); }
    const result = tasks.map(t => ({ id: t.id, name: t.name, project_id: t.project_id?.[0] || null, project_name: t.project_id?.[1] || '', sequence_name: t.sequence_name || '', branch_name: t.branch_name || '', repo: t.repo || '', date_deadline: t.date_deadline || '' }));
    const insertCache = db.prepare('INSERT OR REPLACE INTO odoo_tasks_cache (id, project_id, project_name, task_name, task_no) VALUES (?,?,?,?,?)');
    db.transaction(() => { for (const t of result) insertCache.run(t.id, t.project_id, t.project_name, t.name, t.sequence_name); })();
    res.json({ ok: true, tasks: result });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/odoo/recent-projects', (req, res) => {
  const projects = db.prepare(`SELECT DISTINCT odoo_project_id, odoo_task_label, MAX(created_at) as last_used FROM tasks WHERE odoo_project_id IS NOT NULL GROUP BY odoo_project_id ORDER BY last_used DESC LIMIT 10`).all();
  res.json(projects.map(p => ({ id: p.odoo_project_id, name: (p.odoo_task_label || '').split(' / ')[0].trim(), last_used: p.last_used })).filter(p => p.name));
});

app.post('/api/odoo/search-projects', async (req, res) => {
  const { query } = req.body;
  try {
    if (!config.odoo.url || !config.odoo.username || !query) return res.json([]);
    const uid = await odooUID();
    if (!uid) return res.json([]);
    const langs = getSearchLanguages();
    const idSet = new Set();
    for (const lang of langs) {
      try {
        const ids = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.project', 'search', [[['name', 'ilike', query]]], { limit: 15, context: { lang } }]);
        (ids || []).forEach(id => idSet.add(id));
      } catch {}
    }
    if (!idSet.size) return res.json([]);
    const projects = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.project', 'read', [[...idSet].slice(0, 30)], { fields: ['id', 'name'] }]);
    res.json(projects.map(p => ({ id: p.id, name: p.name })));
  } catch (e) { console.error('[odoo:searchProjects]', e.message); res.json([]); }
});

app.post('/api/odoo/search-stages', async (req, res) => {
  const { projectId } = req.body;
  try {
    if (!config.odoo.url || !config.odoo.username) return res.json([]);
    const uid = await odooUID();
    if (!uid) return res.json([]);
    const domain = projectId ? [['project_ids', 'in', [projectId]]] : [];
    const ids = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task.type', 'search', [domain], { limit: 50 }]);
    if (!ids?.length) return res.json([]);
    const stages = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task.type', 'read', [ids], { fields: ['id', 'name', 'fold'] }]);
    res.json(stages.map(s => ({ id: s.id, name: s.name, fold: s.fold || false })));
  } catch (e) { res.json([]); }
});

app.post('/api/odoo/auto-detect-stages', async (req, res) => {
  try {
    if (!config.odoo.url || !config.odoo.username) return res.json({ ok: false, error: 'Odoo nicht konfiguriert' });
    const uid = await odooUID();
    if (!uid) return res.json({ ok: false, error: 'Auth fehlgeschlagen' });
    const projIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.project', 'search', [[]], { limit: 200 }]);
    if (!projIds?.length) return res.json({ ok: true, mappings: {} });
    const projects = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.project', 'read', [projIds], { fields: ['id', 'name', 'type_ids'] }]);
    const allStageIds = [...new Set(projects.flatMap(p => p.type_ids || []))];
    if (!allStageIds.length) return res.json({ ok: true, mappings: {} });
    const stageMap = await loadStageNames(uid, allStageIds);
    const mappings = {};
    for (const p of projects) {
      const ip = matchStage(p.type_ids || [], stageMap, STAGE_KEYWORDS.in_progress);
      const w = matchStage(p.type_ids || [], stageMap, STAGE_KEYWORDS.waiting);
      const d = matchStage(p.type_ids || [], stageMap, STAGE_KEYWORDS.done);
      if (ip || w || d) mappings[String(p.id)] = { in_progress: ip?.id || null, waiting: w?.id || null, done: d?.id || null, project_name: p.name, in_progress_name: ip?.name || '', waiting_name: w?.name || '', done_name: d?.name || '' };
    }
    res.json({ ok: true, mappings });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/odoo/search-tasks-in-project', async (req, res) => {
  const { projectId, query } = req.body;
  try {
    if (!config.odoo.url || !config.odoo.username) return res.json([]);
    const uid = await odooUID();
    if (!uid) return res.json([]);
    const domain = [['project_id', '=', projectId]];
    (query || '').trim().split(/\s+/).filter(Boolean).forEach(w => domain.push(['name', 'ilike', w]));
    const langs = getSearchLanguages();
    const idSet = new Set();
    for (const lang of langs) {
      try { const ids = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'search', [domain], { limit: 20, context: { lang } }]); (ids || []).forEach(id => idSet.add(id)); } catch {}
    }
    const ids = [...idSet].slice(0, 30);
    if (!ids.length) return res.json([]);
    let tasks;
    try { tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'read', [ids], { fields: ['id', 'name', 'sequence_name', 'date_deadline'] }]); }
    catch { tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'read', [ids], { fields: ['id', 'name', 'date_deadline'] }]); }
    res.json(tasks.map(t => ({ id: t.id, name: t.name, sequence_name: t.sequence_name || '', date_deadline: t.date_deadline || '' })));
  } catch (e) { res.json([]); }
});

app.post('/api/odoo/create-task', async (req, res) => {
  const { projectId, name } = req.body;
  try {
    if (!config.odoo.url || !config.odoo.username) return res.json({ ok: false, error: 'Odoo nicht konfiguriert' });
    const uid = await odooUID();
    if (!uid) return res.json({ ok: false, error: 'Auth fehlgeschlagen' });
    const taskId = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'create', [{ name, project_id: projectId }]]);
    res.json({ ok: true, taskId });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/odoo/timesheet/:days', async (req, res) => {
  try {
    const n = Math.max(1, Math.min(31, parseInt(req.params.days, 10) || 10));
    const today = new Date();
    const result = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      result.push({ date: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`, hours: 0, buckets: [] });
    }
    if (!config.odoo.url || !config.odoo.username) return res.json(result);
    const uid = await odooUID();
    if (!uid) return res.json(result);
    const lines = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'account.analytic.line', 'search_read', [[['user_id', '=', uid], ['date', '>=', result[0].date]]], { fields: ['date', 'unit_amount', 'project_id'], limit: 5000 }]);
    const colors = config.project_colors || {};
    const dayBuckets = Object.fromEntries(result.map(r => [r.date, new Map()]));
    const map = Object.fromEntries(result.map(r => [r.date, r]));
    for (const l of (lines || [])) {
      const d = (l.date || '').slice(0, 10);
      if (!map[d]) continue;
      const h = l.unit_amount || 0;
      const pid = Array.isArray(l.project_id) ? l.project_id[0] : null;
      const cfg = pid != null ? colors[String(pid)] : null;
      if (cfg?.color) {
        const bm = dayBuckets[d];
        const key = cfg.color;
        const cur = bm.get(key) || { color: cfg.color, label: cfg.label || '', hours: 0 };
        cur.hours += h;
        if (!cur.label && cfg.label) cur.label = cfg.label;
        bm.set(key, cur);
      } else { map[d].hours += h; }
    }
    for (const r of result) r.buckets = Array.from(dayBuckets[r.date].values());
    res.json(result);
  } catch (e) { res.json([]); }
});

app.get('/api/odoo/employees', async (req, res) => {
  try {
    if (!config.odoo.url || !config.odoo.username) return res.json([]);
    const uid = await odooUID();
    if (!uid) return res.json([]);
    const userIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'res.users', 'search', [[['share', '=', false]]], { limit: 100 }]);
    if (!userIds?.length) return res.json([]);
    const users = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'res.users', 'read', [userIds], { fields: ['id', 'name'] }]);
    res.json(users.map(u => ({ id: u.id, name: u.name, isSelf: u.id === uid })));
  } catch (e) { res.json([]); }
});

app.get('/api/odoo/employees/:userId/tasks', async (req, res) => {
  try {
    if (!config.odoo.url || !config.odoo.username) return res.json({ tasks: [], totalHours: 0 });
    const uid = await odooUID();
    if (!uid) return res.json({ tasks: [], totalHours: 0 });
    const taskIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'search', [[['user_ids', 'in', [parseInt(req.params.userId)]]]], { limit: 100 }]);
    if (!taskIds?.length) return res.json({ tasks: [], totalHours: 0 });
    let tasks;
    try { tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'read', [taskIds], { fields: ['id', 'name', 'project_id', 'stage_id', 'date_deadline', 'sequence_name', 'allocated_hours', 'effective_hours'] }]); }
    catch { tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'read', [taskIds], { fields: ['id', 'name', 'project_id', 'stage_id', 'date_deadline'] }]); }
    res.json({ tasks: tasks.map(t => ({ id: t.id, name: t.name, project: t.project_id?.[1] || '', stage: t.stage_id?.[1] || '', deadline: t.date_deadline || '', sequence_name: t.sequence_name || '', allocated: t.allocated_hours || 0, effective: t.effective_hours || 0 })), totalAllocated: tasks.reduce((s, t) => s + (t.allocated_hours || 0), 0), totalEffective: tasks.reduce((s, t) => s + (t.effective_hours || 0), 0), taskCount: tasks.length });
  } catch (e) { res.json({ tasks: [], totalHours: 0 }); }
});

app.post('/api/odoo/message', async (req, res) => {
  const { taskId, body, internal } = req.body;
  try {
    if (!config.odoo.url || !config.odoo.username) return res.json({ ok: false, error: 'Odoo nicht konfiguriert' });
    const local = db.prepare('SELECT odoo_task_id FROM tasks WHERE id=?').get(taskId);
    if (!local?.odoo_task_id) return res.json({ ok: false, error: 'Kein verknüpfter Odoo-Task' });
    if (!body?.trim()) return res.json({ ok: false, error: 'Nachricht leer' });
    const uid = await odooUID();
    if (!uid) return res.json({ ok: false, error: 'Auth fehlgeschlagen' });
    const messageId = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'message_post', [[local.odoo_task_id]], { body, message_type: 'comment', subtype_xmlid: internal ? 'mail.mt_note' : 'mail.mt_comment' }]);
    res.json({ ok: true, messageId });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/odoo/messages/:taskId', async (req, res) => {
  try {
    if (!config.odoo.url || !config.odoo.username) return res.json({ ok: false, error: 'Odoo nicht konfiguriert' });
    const local = db.prepare('SELECT odoo_task_id FROM tasks WHERE id=?').get(req.params.taskId);
    if (!local?.odoo_task_id) return res.json({ ok: false, error: 'Kein verknüpfter Odoo-Task' });
    const uid = await odooUID();
    if (!uid) return res.json({ ok: false, error: 'Auth fehlgeschlagen' });
    const ids = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'mail.message', 'search', [[['model', '=', 'project.task'], ['res_id', '=', local.odoo_task_id]]], { limit: 50, order: 'date desc' }]);
    if (!ids?.length) return res.json({ ok: true, messages: [] });
    const msgs = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'mail.message', 'read', [ids], { fields: ['id', 'date', 'author_id', 'body', 'message_type', 'subtype_id'] }]);
    res.json({ ok: true, messages: msgs.map(m => ({ id: m.id, date: m.date, author: m.author_id?.[1] || 'System', body: m.body || '', type: m.message_type, subtype: m.subtype_id?.[1] || '' })) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/odoo/open-task', (req, res) => {
  const { odooTaskId } = req.body;
  if (config.odoo.url && odooTaskId) {
    const url = `${config.odoo.url.replace(/\/$/, '')}/web#id=${odooTaskId}&model=project.task&view_type=form`;
    res.json({ ok: true, url });
  } else res.json({ ok: false });
});

// ── Working Dir ───────────────────────────────────────────────────────────────
function slugForTask(task) {
  // Sprechender Name: <Ticketnr>-<Titel-Slug>, z.B. SO123-rechnung-druck-fix
  const clean = s => String(s || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const ticket = clean(task.sequence_name || task.ticket_ref);
  const titleSlug = clean(String(task.title || '').toLowerCase()).slice(0, 40).replace(/-+$/g, '');
  const slug = [ticket, titleSlug].filter(Boolean).join('-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `task-${task.id}`;
}

function moveWorkingDir(id, fromBase, toBase) {
  const row = db.prepare('SELECT working_dir, vscode_path FROM tasks WHERE id=?').get(id);
  if (!row || !row.working_dir) return;
  const src = row.working_dir;
  if (!fs.existsSync(src)) return;
  const rel = path.relative(fromBase, src);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  const dest = path.join(toBase, path.basename(src));
  try {
    fs.mkdirSync(toBase, { recursive: true });
    if (fs.existsSync(dest)) { console.error('[moveWorkingDir] Ziel existiert bereits:', dest); return; }
    fs.renameSync(src, dest);
    if (row.vscode_path === src) db.prepare('UPDATE tasks SET working_dir=?, vscode_path=? WHERE id=?').run(dest, dest, id);
    else db.prepare('UPDATE tasks SET working_dir=? WHERE id=?').run(dest, id);
    console.log('[moveWorkingDir]', src, '→', dest);
  } catch (e) { console.error('[moveWorkingDir] failed:', e.message); }
}

app.post('/api/tasks/:id/working-dir', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.json({ ok: false, error: 'Task nicht gefunden' });
  const base = config.work_dir || path.join(os.homedir(), 'ai', 'work');
  const dir = path.join(base, slugForTask(task));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const taskMd = path.join(dir, 'TASK.md');
    if (!fs.existsSync(taskMd)) {
      const odooUrl = (task.odoo_task_id && config.odoo.url)
        ? `${config.odoo.url.replace(/\/$/, '')}/web#id=${task.odoo_task_id}&model=project.task&view_type=form` : '';
      const lines = [
        `# ${task.title || 'Ohne Titel'}`, '',
        task.sequence_name ? `- Ticket: ${task.sequence_name}` : (task.ticket_ref ? `- Ticket: ${task.ticket_ref}` : ''),
        odooUrl ? `- Odoo: ${odooUrl}` : '',
        task.deadline ? `- Deadline: ${task.deadline}` : '',
        task.git_repo ? `- Repo: ${task.git_repo}` : '',
        task.git_branch ? `- Branch: ${task.git_branch}` : '',
        '', '## Aufgabe', '', (task.note || '').trim(),
        '', '## Kunde informieren (Discord/Teams/Mail)', '', '- [ ] ',
        '', '## Notizen', '', (task.private_notes || '').trim(), '',
      ];
      fs.writeFileSync(taskMd, lines.join('\n'), 'utf8');
    }
    if (task.vscode_path) db.prepare('UPDATE tasks SET working_dir=? WHERE id=?').run(dir, task.id);
    else db.prepare('UPDATE tasks SET working_dir=?, vscode_path=? WHERE id=?').run(dir, dir, task.id);
    broadcastSSE('refresh', {});
    res.json({ ok: true, dir });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/tasks/:id/open-working-dir', (req, res) => {
  const task = db.prepare('SELECT working_dir FROM tasks WHERE id=?').get(req.params.id);
  if (!task?.working_dir) return res.json({ ok: false, error: 'Kein Working Dir hinterlegt' });
  if (!fs.existsSync(task.working_dir)) return res.json({ ok: false, error: 'Working Dir existiert nicht (mehr)' });
  // In VS Code (Desktop-App) öffnen statt im Finder; Fallback auf Finder, falls `code` nicht verfügbar
  require('child_process').exec(`code "${task.working_dir}"`, (err) => {
    if (err) require('child_process').exec(`open "${task.working_dir}"`);
  });
  res.json({ ok: true, dir: task.working_dir });
});

// ── VSCode ────────────────────────────────────────────────────────────────────
app.post('/api/vscode/save', (req, res) => {
  const { taskId, vscode_ssh_host, vscode_path, git_repo, git_branch, ticket_url } = req.body;
  db.prepare('UPDATE tasks SET vscode_ssh_host=?, vscode_path=?, git_repo=?, git_branch=?, ticket_url=? WHERE id=?').run(vscode_ssh_host || null, vscode_path || null, git_repo || null, git_branch || null, ticket_url || null, taskId);
  if (ticket_url) {
    const match = ticket_url.match(/([A-Z][A-Z0-9]+-\d+)/);
    if (match) db.prepare('UPDATE tasks SET ticket_ref=COALESCE(ticket_ref, ?) WHERE id=?').run(match[1], taskId);
  }
  res.json(true);
});

app.post('/api/vscode/open/:taskId', async (req, res) => {
  const task = db.prepare('SELECT vscode_ssh_host, vscode_path, git_branch FROM tasks WHERE id=?').get(req.params.taskId);
  if (!task?.vscode_path) return res.json({ ok: false, error: 'Kein Pfad hinterlegt' });
  const { exec: execCb } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(execCb);
  let branchMsg = '';
  if (task.git_branch) {
    try {
      const gitDir = task.vscode_path;
      const cmd = task.vscode_ssh_host ? `ssh ${task.vscode_ssh_host} "cd '${gitDir}' && git diff --quiet && git checkout '${task.git_branch}' 2>&1 || echo DIRTY"` : `cd '${gitDir}' && git diff --quiet && git checkout '${task.git_branch}' 2>&1 || echo DIRTY`;
      const { stdout } = await execAsync(cmd, { timeout: 10000 });
      branchMsg = stdout.includes('DIRTY') ? 'Branch nicht gewechselt (dirty)' : `Branch: ${task.git_branch}`;
    } catch (e) { branchMsg = 'Branch-Checkout fehlgeschlagen: ' + e.message; }
  }
  const uri = task.vscode_ssh_host ? `vscode://vscode-remote/ssh-remote+${task.vscode_ssh_host}${task.vscode_path}` : task.vscode_path;
  execCb(`code --folder-uri "${uri}"`, (err) => { if (err) execCb(`open "${uri}"`); });
  res.json({ ok: true, branchMsg });
});

// ── Page routes ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));
app.get('/task', (req, res) => res.sendFile(path.join(__dirname, 'task.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nDayTask Web läuft auf http://localhost:${PORT}`);
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        console.log(`iPad/Netzwerk: http://${addr.address}:${PORT}`);
      }
    }
  }
  console.log('\nAuf dem iPad: Safari öffnen → URL oben eingeben → Share → "Zum Home-Bildschirm"\n');
});
