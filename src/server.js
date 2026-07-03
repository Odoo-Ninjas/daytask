const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { makeWorkingDir, sq, sshHostOk } = require('./workingdir');

const app = express();
app.use(express.json());
// Server-seitige Quelldateien NICHT ausliefern (sonst Quellcode-Leak über
// express.static). Whitelist statt Blacklist: nur diese .js-Dateien sind
// Client-Assets — alle anderen .js (server/main/workingdir/preload/cli …)
// werden geblockt. Pfad wird dekodiert + lowercased, damit Case- (APFS ist
// case-insensitiv) und %2e-Bypässe nicht greifen.
const PUBLIC_JS = new Set(['web-dt.js', 'sw.js']);
app.use((req, res, next) => {
  let decoded;
  try { decoded = decodeURIComponent(req.path); } catch { return res.status(400).end(); }
  const base = path.basename(decoded).toLowerCase();
  if (base.endsWith('.js') && !PUBLIC_JS.has(base)) return res.status(404).end();
  next();
});
// Manifest dynamisch ausliefern: Token in die start_url backen, damit die als
// PWA installierte iOS-App (eigener Storage, kein Adressfeld zum Nachtragen)
// gleich authentifiziert startet. Muss vor express.static stehen.
app.get('/manifest.json', (req, res) => {
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')); }
  catch { return res.status(500).end(); }
  if (config.web_token) {
    m.start_url = '/?token=' + encodeURIComponent(config.web_token);
    m.id = '/';
  }
  res.type('application/manifest+json').json(m);
});
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
  // Tagesansicht-Scan: Basisordner für die Suche nach am Tag bearbeiteten
  // Work-Ordnern (aus den Claude-Session-Logs). Default = work_dir.
  scan_dir: path.join(os.homedir(), 'ai', 'work'),
  claude_bin: 'claude',
  claude_scan_args: ['--dangerously-skip-permissions'],
  claude_scan_timeout_ms: 240000,
  scan_max_dirs: 25,
  // Netze, die (wie loopback) ohne web_token auf /api dürfen — z.B. das
  // authentifizierte VPN-Subnetz, über das iPad/PWA reinkommen. CIDR-Notation.
  web_trusted_cidrs: [],
  // Vorlage für die automatische Kunden-Antwort, wenn ein per comm angelegter
  // Task ("Kunden informieren") eine Odoo-Verknüpfung mit Ticketnummer bekommt.
  // Platzhalter: {ticket} = Ticketnummer (ZO-XXXXX), {title} = Task-Titel.
  comm_feedback_template:
    'Vielen Dank für Ihre Nachricht! Wir bearbeiten Ihr Anliegen unter Ticket No. {ticket} und melden uns dort.',
  // Basis-URL des comm-Servers (~/ai/comm). Wird für die Kanal-Auswahl gebraucht
  // (Verbindungen listen + neues Antwort-Ziel binden), wenn ein Task noch kein
  // comm_meta hat. Muss von isAllowedCommUrl erlaubt sein (Default: Loopback).
  comm_url: 'http://localhost:8765',
};
if (fs.existsSync(CONFIG_PATH)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch {}
}
if (!Array.isArray(config.search_languages) || !config.search_languages.length) {
  config.search_languages = ['en_US', 'de_DE'];
}
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
}
function getSearchLanguages() {
  const cleaned = (config.search_languages || []).map(l => String(l || '').trim()).filter(Boolean);
  return cleaned.length ? cleaned : ['en_US', 'de_DE'];
}

// Optionales Auth-Token für die (potenziell im LAN exponierte) Web-Variante.
// Aktiv, sobald config.web_token gesetzt ist. Erwartet das Token im Header
// `X-DT-Token` ODER als ?token=… (für den iPad-Zugriff per URL). Loopback
// (127.0.0.1/::1) bleibt immer frei, damit die lokale UI ohne Token läuft.
function ipInCidr(ip, cidr) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const [range, bitsStr] = String(cidr).split('/');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(range)) return false;
  const bits = bitsStr === undefined ? 32 : parseInt(bitsStr, 10);
  if (!(bits >= 0 && bits <= 32)) return false;
  const toInt = a => a.split('.').reduce((acc, o) => ((acc << 8) >>> 0) + (parseInt(o, 10) || 0), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return ((toInt(ip) & mask) >>> 0) === ((toInt(range) & mask) >>> 0);
}
// CSRF-Schutz für mutierende Requests: Eine bösartige Webseite, die der User im
// Browser offen hat, kann zwar POSTs an http://localhost:3000/api/… absetzen
// (Side-Effects laufen, auch wenn die Antwort per CORS geblockt wird) — aber der
// Browser setzt dabei einen `Origin`-Header. curl/Server-zu-Server setzen keinen.
// Daher: bei nicht-GET-Requests mit fremdem Origin (≠ eigener Host) abweisen.
// Same-Origin (die DayTask-Web-UI) und header-lose Clients (curl) bleiben erlaubt.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('Origin');
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).host; } catch { return res.status(403).json({ ok: false, error: 'bad origin' }); }
    if (originHost !== req.get('Host')) return res.status(403).json({ ok: false, error: 'cross-origin blocked' });
  }
  next();
});
app.use('/api', (req, res, next) => {
  const token = config.web_token;
  if (!token) return next();
  const ip = req.ip || req.socket.remoteAddress || '';
  const loopback = (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
  const trustedNet = (config.web_trusted_cidrs || []).some(c => ipInCidr(ip, c));
  const given = req.get('X-DT-Token') || req.query.token;
  if (loopback || trustedNet || given === token) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
});

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
// WAL + busy_timeout: gleiche DB wie main.js/cli.js, paralleler Zugriff. Verhindert
// SQLITE_BUSY-Exceptions wenn Electron-App und Web-Server gleichzeitig schreiben.
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
// Gemeinsame Working-Dir-Logik (geteilt mit main.js).
const wd = makeWorkingDir(db, config);
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
runMigration('add_archived', `ALTER TABLE tasks ADD COLUMN archived INTEGER DEFAULT 0;`);
runMigration('add_done_at', `ALTER TABLE tasks ADD COLUMN done_at TEXT;`);
runMigration('add_working_dir', `ALTER TABLE tasks ADD COLUMN working_dir TEXT;`);
runMigration('add_comm_meta', `ALTER TABLE tasks ADD COLUMN comm_meta TEXT;`);
runMigration('add_comm_feedback_pending', `ALTER TABLE tasks ADD COLUMN comm_feedback_pending INTEGER DEFAULT 0;`);
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
    const [active] = open;
    activeTaskId = active.task_id;
    activeSlotId = active.id;
    console.log('[resume] Timer für Task', activeTaskId);
    // Code-Review C2: übrige offene Slots NICHT pauschal nullen — ein offener Slot
    // kann zu einem parallel laufenden Timer in der Electron-App (gleiche DB) gehören.
    // Nur eindeutig verwaiste, >18h offene Crash-Reste schließen.
    const stale = db.prepare(`SELECT id FROM timeslots WHERE stopped_at IS NULL AND id<>? AND (julianday('now','localtime') - julianday(started_at)) * 24 > 18`).all(active.id);
    if (stale.length) {
      const closeStmt = db.prepare('UPDATE timeslots SET stopped_at=started_at, synced=1 WHERE id=?');
      db.transaction(() => { for (const o of stale) closeStmt.run(o.id); })();
      console.log('[resume]', stale.length, 'verwaiste (>18h) Slots geschlossen');
    }
  }
} catch (e) { console.error('[resume]', e.message); }

// ── Odoo XML-RPC ──────────────────────────────────────────────────────────────
async function odooCall(endpoint, method, params) {
  const xmlrpc = require('xmlrpc');
  const url = new URL(config.odoo.url);
  const isHttps = url.protocol === 'https:';
  const port = url.port ? parseInt(url.port) : (isHttps ? 443 : 80);
  // TLS per Default prüfen (MITM-Schutz); nur bei config.odoo.insecure_tls abschalten.
  const rejectUnauthorized = !(config.odoo && config.odoo.insecure_tls);
  const clientOpts = { host: url.hostname, port, path: endpoint, rejectUnauthorized };
  const client = isHttps ? xmlrpc.createSecureClient(clientOpts) : xmlrpc.createClient(clientOpts);
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err, val) => err ? reject(err) : resolve(val));
  });
}
async function odooUID() {
  return odooCall('/xmlrpc/2/common', 'authenticate', [config.odoo.db, config.odoo.username, config.odoo.password, {}]);
}

// Deferred-Kunden-Feedback (geteilt mit main.js): schickt einmalig "Wir
// bearbeiten Ihr Anliegen unter Ticket No. …", sobald ein per comm angelegter
// Task mit aktivierter Option "Kunden informieren" eine Odoo-Verknüpfung mit
// Ticketnummer bekommt.
const { makeCommFeedback, isAllowedCommUrl } = require('./commfeedback');
const commFeedback = makeCommFeedback({ getDb: () => db, config, odooCall, odooUID });
// Geteilte, idempotente Timeslot->Odoo-Sync-Logik (identisch in main.js).
const { makeTimeSync } = require('./timesync');
const timeSync = makeTimeSync({ getDb: () => db, config, odooCall, odooUID });
timeSync.recoverInFlight(); // hängengebliebene In-Flight-Slots (synced=2) zurücksetzen
// Tagesansicht (lesen/inline-editieren/Claude-Scan), identisch in main.js.
const { makeDayView } = require('./dayview');
const dayView = makeDayView({ getDb: () => db, config, odooCall, odooUID });

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

// Auflösung eines DayTask-Tasks aus verschiedenen Referenzen — geteilt von
// /api/odoo/comment, /api/odoo/set-done und /api/tasks/move-done. Reihenfolge:
//   1. taskId        (lokale DayTask-Task-ID)
//   2. odoo_task_id  (direkt, aus der Odoo-URL #id=… in TASK.md)
//   3. cwd           (Working-Dir oder ein Unterordner davon → längster Treffer)
//   4. ticket        (sequence_name / ticket_ref, z.B. "ZO-05125")
// Liefert { localId, odooTaskId } (beide ggf. null). Endpoints prüfen selbst,
// welches der beiden Felder sie zwingend brauchen.
function resolveTaskRef({ taskId, odoo_task_id, cwd, ticket } = {}) {
  let localId = null, odooTaskId = null;
  if (taskId) {
    const row = db.prepare('SELECT id, odoo_task_id FROM tasks WHERE id=?').get(parseInt(taskId));
    if (row) { localId = row.id; odooTaskId = row.odoo_task_id || null; }
  }
  if (!odooTaskId && odoo_task_id) {
    odooTaskId = parseInt(odoo_task_id) || null;
    if (odooTaskId && !localId) {
      const row = db.prepare('SELECT id FROM tasks WHERE odoo_task_id=? ORDER BY id DESC').get(odooTaskId);
      if (row) localId = row.id;
    }
  }
  if ((!localId || !odooTaskId) && cwd) {
    const norm = p => String(p).replace(/\/+$/, '');
    const c = norm(cwd);
    const rows = db.prepare('SELECT id, working_dir, odoo_task_id FROM tasks WHERE working_dir IS NOT NULL').all();
    let best = null;
    for (const r of rows) {
      const w = norm(r.working_dir);
      if ((c === w || c.startsWith(w + '/')) && (!best || w.length > best.len)) best = { id: r.id, odoo: r.odoo_task_id || null, len: w.length };
    }
    if (best) { if (!localId) localId = best.id; if (!odooTaskId) odooTaskId = best.odoo; }
  }
  if ((!localId || !odooTaskId) && ticket) {
    const row = db.prepare('SELECT id, odoo_task_id FROM tasks WHERE (sequence_name=? OR ticket_ref=?) AND odoo_task_id IS NOT NULL').get(ticket, ticket);
    if (row) { if (!localId) localId = row.id; if (!odooTaskId) odooTaskId = row.odoo_task_id || null; }
  }
  return { localId, odooTaskId };
}

// Done-Stage eines Tasks aus dem (ggf. projektspezifischen) Stage-Mapping
// ermitteln und explizit setzen. Anders als setOdooTaskStage() ohne die
// Auto-Guards (Einzel-Assignee/Collective) — das hier ist eine bewusste,
// ausdrückliche Aktion. projectId optional; fehlt sie, wird sie aus dem Task
// gelesen. Liefert { ok, stage_id } oder { ok:false, error }.
async function odooSetDone(uid, odooTaskId, projectId) {
  if (!projectId) {
    const ot = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'read', [[odooTaskId]], { fields: ['project_id'] }]);
    projectId = ot?.[0]?.project_id?.[0] || null;
  }
  const mappings = config.stage_mappings || {};
  const projMapping = mappings[String(projectId)] || mappings['default'];
  if (!projMapping?.done) return { ok: false, error: 'Keine Done-Stage gemappt (Settings → Stage-Mappings, ggf. Auto-Detect)' };
  await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'write', [[odooTaskId], { stage_id: projMapping.done }]]);
  return { ok: true, stage_id: projMapping.done };
}

// Delegiert an das geteilte, idempotente Sync-Modul (src/timesync.js) — identische
// Logik wie in der Electron-App, atomar geclaimt + per (Task,Tag) genau eine Zeile.
async function syncUnsyncedTimeslots(taskId) {
  return timeSync.syncUnsyncedTimeslots(taskId);
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
      // results now holds one entry per day; surface a failure if any day
      // failed so a partial multi-day sync isn't reported as full success.
      syncResult = results.find(r => r && r.ok === false) || results[0] || null;
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
  const { title, ticket_ref, note, deadline, odoo_project_id, odoo_project_name, odoo_task_id, odoo_task_name, odoo_task_sequence, comm, feedback, create_working_dir, group_project_id, group_project_name } = req.body;
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
  // Grouping-Projekt (nur Work-Dir-Gruppierung, KEIN Odoo-Task anlegen): wird vom
  // comm-Popup mitgegeben, damit der Task nicht flach in ~/ai/work landet, sondern
  // unter ~/ai/work/<Projekt>/…. projectNameFor() liest den Namen später aus dem
  // Label ("Projekt / Task") — daher hier project_id + Label setzen, falls weder ein
  // Odoo-Task verknüpft noch (oben) angelegt wurde.
  let projId = odoo_project_id || null;
  if (!odooTaskId && group_project_name) {
    projId = group_project_id || projId;
    odooTaskLabel = odooTaskLabel || `${group_project_name} / ${title}`;
  }
  // "Kunden informieren" nur sinnvoll mit comm-Ziel — Flag sonst ignorieren.
  const feedbackPending = (feedback && comm) ? 1 : 0;
  const info = db.prepare('INSERT INTO tasks (title, ticket_ref, note, date, deadline, odoo_task_id, odoo_project_id, odoo_task_label, sequence_name, comm_meta, comm_feedback_pending) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(title, ticket_ref || null, note || null, today, deadline || null, odooTaskId, projId, odooTaskLabel, seqName, comm ? JSON.stringify(comm) : null, feedbackPending);
  const id = info.lastInsertRowid;
  // Arbeitsverzeichnis direkt anlegen (Default an; abschaltbar im comm-Popup).
  // Regel: NUR anlegen, wenn ein Projekt bekannt ist (Odoo-Projekt/-Task verknüpft
  // oder Grouping-Projekt gewählt) — sonst landet das Dir "herrenlos" flach unter
  // ~/ai/work. Ohne Projekt wird die Anlage übersprungen und das dem Aufrufer
  // (comm-Popup) zurückgemeldet.
  let workingDir = null;
  let workingDirSkipped = null;
  if (create_working_dir) {
    const created = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (wd.projectNameFor(created)) {
      const wdRes = wd.createWorkingDir(id);
      if (wdRes && wdRes.ok) workingDir = wdRes.dir;
    } else {
      workingDirSkipped = 'kein Projekt bekannt';
    }
  }
  // Falls der Task schon bei Anlage mit Odoo verknüpft ist (Ticketnummer da),
  // sofort Kunden-Feedback senden; sonst greift der Trigger beim späteren Linken.
  if (feedbackPending) commFeedback.maybeSend(id).catch(() => {});
  res.json({ id, odooTaskId, odooCreateError, workingDir, workingDirSkipped });
});

// Antwort an den Kunden über comm senden (Token bleibt server-seitig).
app.post('/api/tasks/:id/comm-reply', async (req, res) => {
  const id = parseInt(req.params.id);
  const { text, kind } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Leerer Text' });
  const row = db.prepare('SELECT comm_meta FROM tasks WHERE id=?').get(id);
  if (!row || !row.comm_meta) return res.status(400).json({ error: 'Kein comm-Ziel für diesen Task' });
  let comm;
  try { comm = JSON.parse(row.comm_meta); } catch (e) { return res.status(400).json({ error: 'comm_meta ungültig' }); }
  if (!comm || !comm.url || !isAllowedCommUrl(comm.url, config)) return res.status(400).json({ error: 'comm-Ziel nicht erlaubt' });
  try {
    const r = await fetch(`${comm.url}/api/task-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: comm.token, text, kind: kind || 'update' }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: data.detail || 'comm-Fehler' });
    res.json({ ok: true, channel: comm.channel });
  } catch (e) { res.status(502).json({ error: 'comm nicht erreichbar: ' + e.message }); }
});

// Basis-URL des comm-Servers für einen Task ermitteln: bevorzugt die im
// comm_meta hinterlegte (der Ursprungskanal), sonst die konfigurierte Default-URL.
// Immer gegen isAllowedCommUrl prüfen (SSRF/Token-Leak-Schutz wie in commfeedback).
function commBaseForTask(taskRow) {
  let base = config.comm_url;
  if (taskRow && taskRow.comm_meta) {
    try { const m = JSON.parse(taskRow.comm_meta); if (m && m.url) base = m.url; } catch {}
  }
  return isAllowedCommUrl(base, config) ? base : null;
}

// Bestehende comm-Verbindungen (Konversationen) für die Kanal-Auswahl im Task.
// Optional ?taskId=<id>, um die comm-Basis aus dem comm_meta des Tasks zu nehmen.
app.get('/api/comm/connections', async (req, res) => {
  let taskRow = null;
  if (req.query.taskId) taskRow = db.prepare('SELECT comm_meta FROM tasks WHERE id=?').get(parseInt(req.query.taskId));
  const base = commBaseForTask(taskRow);
  if (!base) return res.status(400).json({ error: 'comm-URL nicht erlaubt' });
  try {
    const r = await fetch(`${base}/api/connections?limit=80`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: data.detail || 'comm-Fehler' });
    res.json({ ok: true, connections: data.connections || [] });
  } catch (e) { res.status(502).json({ error: 'comm nicht erreichbar: ' + e.message }); }
});

// Verknüpften Kommunikationskanal eines Tasks ändern: bindet in comm ein neues
// Antwort-Ziel (Token) an die gewählte bestehende Verbindung und speichert das
// resultierende comm_meta am Task. Body: {source, conversation, channel?, fingerprint?}.
app.post('/api/tasks/:id/comm-target', async (req, res) => {
  const id = parseInt(req.params.id);
  const { source, conversation, channel, fingerprint } = req.body || {};
  if (!source || !conversation) return res.status(400).json({ error: 'source und conversation erforderlich' });
  const row = db.prepare('SELECT comm_meta FROM tasks WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'Task nicht gefunden' });
  const base = commBaseForTask(row);
  if (!base) return res.status(400).json({ error: 'comm-URL nicht erlaubt' });
  try {
    const r = await fetch(`${base}/api/task-target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, conversation, channel, fingerprint }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: data.detail || 'comm-Fehler' });
    const commMeta = { url: data.url || base, token: data.token, channel: data.channel, source: data.source, conversation: data.conversation, thread: data.thread };
    db.prepare('UPDATE tasks SET comm_meta=? WHERE id=?').run(JSON.stringify(commMeta), id);
    res.json({ ok: true, channel: commMeta.channel, source: commMeta.source });
  } catch (e) { res.status(502).json({ error: 'comm nicht erreichbar: ' + e.message }); }
});

app.post('/api/tasks/:id/done', async (req, res) => {
  const id = parseInt(req.params.id);
  if (activeTaskId === id) await stopTimer({ sync: true });
  db.prepare('UPDATE tasks SET done=1 WHERE id=?').run(id);
  wd.moveToDone(id);
  setOdooTaskStage(id, 'done').catch(() => {});
  broadcastSSE('refresh', {});
  res.json(true);
});

app.post('/api/tasks/:id/undone', (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare('UPDATE tasks SET done=0 WHERE id=?').run(id);
  wd.moveToWork(id);
  res.json(true);
});

app.post('/api/tasks/:id/delete', (req, res) => {
  const id = parseInt(req.params.id);
  if (activeTaskId === id) stopTimer({ sync: false });
  // Code-Review H4: Soft-Delete wie in der Electron-App (tasks:delete) statt eines
  // unwiederbringlichen Hard-Deletes. archived=1 hält den Odoo-Poll davon ab, den
  // Task neu anzulegen; Zeitbuchungen (timeslots) bleiben erhalten und syncbar.
  db.prepare('UPDATE tasks SET archived=1, done=1 WHERE id=?').run(id);
  broadcastSSE('refresh', {});
  res.json(true);
});

app.post('/api/tasks/update', (req, res) => {
  // working_dir wird bewusst NICHT hier geschrieben (nur über create/move) —
  // verhindert, dass ein veralteter Feldwert einen verschobenen Pfad überschreibt.
  const { id, title, ticket_ref, note, private_notes } = req.body;
  db.prepare('UPDATE tasks SET title=?, ticket_ref=?, note=?, private_notes=? WHERE id=?').run(title, ticket_ref || null, note || null, private_notes || null, id);
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
  // Jetzt ist der Task mit Odoo verknüpft → ggf. ausstehendes Kunden-Feedback
  // ("Wir bearbeiten Ihr Anliegen unter Ticket No. …") senden.
  const commRes = await commFeedback.maybeSend(taskId);
  broadcastSSE('refresh', {});
  res.json({ ok: true, synced, failed, commFeedback: commRes });
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
        const jq = '.[] | .sha + "||" + (.sha[:7]) + "||" + .commit.author.name + "||" + (.commit.author.date[:10]) + "||" + (.commit.message | split("\\n") | .[0])';
        const { stdout } = await promisify(execFile)('gh',
          ['api', `repos/${repoMatch[1]}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`, '--jq', jq],
          { timeout: 15000 });
        let commits = parseCommits(stdout);
        if (task.last_commit_sha) { const idx = commits.findIndex(c => c.sha === task.last_commit_sha); if (idx >= 0) commits = commits.slice(0, idx); }
        if (commits.length) db.prepare('UPDATE tasks SET last_commit_sha=? WHERE id=?').run(commits[0].sha, req.params.id);
        return res.json({ ok: true, commits, isNew: !task.last_commit_sha });
      }
    } catch {}
  }
  if (task.vscode_path) {
    try {
      const range = task.last_commit_sha ? `${sq(`${task.last_commit_sha}..${branch}`)}` : `${sq(branch)} -20`;
      const local = `cd ${sq(task.vscode_path)} && git log ${range} ${logFmt}`;
      if (task.vscode_ssh_host && !sshHostOk(task.vscode_ssh_host)) return res.json({ ok: false, error: 'Ungültiger SSH-Host' });
      const cmd = task.vscode_ssh_host ? `ssh ${sq(task.vscode_ssh_host)} ${sq(local)}` : local;
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
app.get('/api/config', (req, res) => {
  // web_token nicht ausliefern — sonst könnte ein authentifizierter LAN-Client
  // das Auth-Geheimnis auslesen und den Token-Schutz aushebeln.
  const { web_token, ...safe } = config;
  // Odoo-Passwort ebenfalls NICHT ausliefern (LAN/Loopback-Client soll es nicht
  // abgreifen können). has_password signalisiert dem Settings-UI nur, dass eins
  // gesetzt ist; ein leeres Passwort-Feld beim Speichern lässt es unverändert.
  if (safe.odoo) {
    const { password, ...odooSafe } = safe.odoo;
    safe.odoo = { ...odooSafe, has_password: !!password };
  }
  res.json(safe);
});
app.post('/api/config', (req, res) => {
  // Sicherheitskritische Keys nicht über die (LAN-)API überschreibbar machen —
  // sonst könnte ein Client das Auth-Token leeren oder sich aussperren.
  const body = { ...req.body };
  delete body.web_token;
  delete body.web_host;
  // Das Odoo-Passwort wird per GET nie ausgeliefert (s.o.), daher schickt das
  // Web-Settings-Formular ein leeres Feld. Leeres/fehlendes Passwort NICHT
  // übernehmen, sondern das bestehende beibehalten — sonst würde Speichern aus
  // dem Web das Passwort löschen. has_password ist nur ein Lese-Flag.
  if (body.odoo) {
    delete body.odoo.has_password;
    if (body.odoo.password === '' || body.odoo.password == null) {
      delete body.odoo.password;
      if (config.odoo && config.odoo.password) body.odoo.password = config.odoo.password;
    }
  }
  // In-place mutieren (siehe workingdir.js — gecapturte config-Referenz).
  Object.assign(config, body);
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
    (query || '').trim().split(/\s+/).filter(Boolean).forEach(w => domain.push('|', ['name', 'ilike', w], ['sequence_name', 'ilike', w]));
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

// ── Tagesansicht ──────────────────────────────────────────────────────────────
app.get('/api/dayview/:date', async (req, res) => {
  try { res.json(await dayView.getDayView(req.params.date)); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/dayview/line', async (req, res) => {
  try { res.json(await dayView.upsertLine(req.body || {})); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/dayview/line/delete', async (req, res) => {
  try { res.json(await dayView.deleteLine(req.body && req.body.id)); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/dayview/scan', async (req, res) => {
  try { res.json(await dayView.scanDay(req.body && req.body.date, { extraPrompt: req.body && req.body.extraPrompt })); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// Kommentar / Statusreport ins verknüpfte Odoo-Ticket schreiben. Gedacht für
// Tools/Agents (z.B. Claude), die in einem Work-Ordner sitzen und das Ticket
// nur aus der TASK.md kennen. Das Ziel wird in dieser Reihenfolge aufgelöst:
//   1. odoo_task_id  (direkt, aus der Odoo-URL #id=… in TASK.md)
//   2. taskId        (lokale DayTask-Task-ID)
//   3. cwd           (Working-Dir oder ein Unterordner davon → längster Treffer)
//   4. ticket        (sequence_name / ticket_ref, z.B. "ZO-05125")
// Default ist eine INTERNE Log-Notiz (mail.mt_note); internal:false postet einen
// für den Kunden sichtbaren Kommentar.
// WICHTIG: body als PLAINTEXT senden. Odoo behandelt einen über XML-RPC
// übergebenen String als Klartext (HTML-Tags würden escaped/sichtbar) und
// wandelt Zeilenumbrüche automatisch in <br> um — also einfach mit \n
// gliedern, keine HTML-Tags.
app.post('/api/odoo/comment', async (req, res) => {
  try {
    if (!config.odoo.url || !config.odoo.username) return res.json({ ok: false, error: 'Odoo nicht konfiguriert' });
    const { body } = req.body;
    const internal = req.body.internal === undefined ? true : !!req.body.internal;
    if (!body || !String(body).trim()) return res.json({ ok: false, error: 'Nachricht leer' });

    const { odooTaskId } = resolveTaskRef(req.body);
    if (!odooTaskId) return res.json({ ok: false, error: 'Kein verknüpftes Odoo-Ticket gefunden (odoo_task_id/taskId/cwd/ticket)' });

    const uid = await odooUID();
    if (!uid) return res.json({ ok: false, error: 'Auth fehlgeschlagen' });
    const messageId = await odooCall('/xmlrpc/2/object', 'execute_kw', [config.odoo.db, uid, config.odoo.password, 'project.task', 'message_post', [[odooTaskId]], { body, message_type: 'comment', subtype_xmlid: internal ? 'mail.mt_note' : 'mail.mt_comment' }]);
    res.json({ ok: true, odoo_task_id: odooTaskId, messageId });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Verknüpftes Odoo-Ticket auf die Done-Stage setzen ("erledigt"). Auflösung des
// Tickets wie bei /api/odoo/comment (odoo_task_id / taskId / cwd / ticket).
// Bewusste, ausdrückliche Aktion — ohne die Auto-Guards von setOdooTaskStage.
app.post('/api/odoo/set-done', async (req, res) => {
  try {
    if (!config.odoo.url || !config.odoo.username) return res.json({ ok: false, error: 'Odoo nicht konfiguriert' });
    const { localId, odooTaskId } = resolveTaskRef(req.body);
    if (!odooTaskId) return res.json({ ok: false, error: 'Kein verknüpftes Odoo-Ticket gefunden (odoo_task_id/taskId/cwd/ticket)' });
    const uid = await odooUID();
    if (!uid) return res.json({ ok: false, error: 'Auth fehlgeschlagen' });
    const projectId = localId ? (db.prepare('SELECT odoo_project_id FROM tasks WHERE id=?').get(localId)?.odoo_project_id || null) : null;
    const r = await odooSetDone(uid, odooTaskId, projectId);
    if (!r.ok) return res.json(r);
    res.json({ ok: true, odoo_task_id: odooTaskId, stage_id: r.stage_id });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Working-Dir eines Tasks als erledigt markieren (legt eine ".done"-Datei darin
// an — der Ordner wird NICHT mehr nach ~/ai/done verschoben). Auflösung wie oben,
// braucht aber einen LOKALEN DayTask-Task (localId). Markiert den Task zusätzlich
// als erledigt (done=1) und stoppt einen laufenden Timer mit Odoo-Sync — analog
// zum "Done"-Button der App, nur referenz-basiert.
app.post('/api/tasks/move-done', async (req, res) => {
  try {
    const { localId } = resolveTaskRef(req.body);
    if (!localId) return res.json({ ok: false, error: 'Kein DayTask-Task gefunden (taskId/odoo_task_id/cwd/ticket)' });
    if (activeTaskId === localId) await stopTimer({ sync: true });
    db.prepare('UPDATE tasks SET done=1 WHERE id=?').run(localId);
    wd.moveToDone(localId);
    const dir = db.prepare('SELECT working_dir FROM tasks WHERE id=?').get(localId)?.working_dir || null;
    broadcastSSE('refresh', {});
    res.json({ ok: true, id: localId, done: true, dir });
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
// slugForTask/moveWorkingDir/createWorkingDir/openWorkingDir leben jetzt in
// src/workingdir.js und werden über `wd` (oben instanziiert) geteilt.

app.post('/api/tasks/:id/working-dir', (req, res) => {
  const res2 = wd.createWorkingDir(parseInt(req.params.id));
  if (res2.ok) broadcastSSE('refresh', {});
  res.json(res2);
});

app.post('/api/tasks/:id/open-working-dir', (req, res) => {
  res.json(wd.openWorkingDir(parseInt(req.params.id)));
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
  const { promisify } = require('util');
  const execAsync = promisify(require('child_process').exec);
  let branchMsg = '';
  if (task.git_branch) {
    try {
      const gitDir = task.vscode_path;
      if (task.vscode_ssh_host && !sshHostOk(task.vscode_ssh_host)) return res.json({ ok: false, error: 'Ungültiger SSH-Host' });
      // sq() escaped alle User-Werte → keine Command-Injection.
      const remote = `cd ${sq(gitDir)} && git diff --quiet && git checkout ${sq(task.git_branch)} 2>&1 || echo DIRTY`;
      const cmd = task.vscode_ssh_host ? `ssh ${sq(task.vscode_ssh_host)} ${sq(remote)}` : remote;
      const { stdout } = await execAsync(cmd, { timeout: 10000 });
      branchMsg = stdout.includes('DIRTY') ? 'Branch nicht gewechselt (dirty)' : `Branch: ${task.git_branch}`;
    } catch (e) { branchMsg = 'Branch-Checkout fehlgeschlagen: ' + e.message; }
  }
  const uri = task.vscode_ssh_host ? `vscode://vscode-remote/ssh-remote+${task.vscode_ssh_host}${task.vscode_path}` : task.vscode_path;
  execFile('code', ['--new-window', '--folder-uri', uri], (err) => { if (err) execFile('open', [uri]); });
  res.json({ ok: true, branchMsg });
});

// ── Page routes ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));
app.get('/task', (req, res) => res.sendFile(path.join(__dirname, 'task.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
// Secure by default: nur Loopback. LAN/iPad-Zugriff explizit per Opt-in
// (config.web_host="0.0.0.0") — idealerweise zusammen mit config.web_token.
const HOST = config.web_host || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`\nDayTask Web läuft auf http://localhost:${PORT}`);
  const exposed = HOST === '0.0.0.0' || HOST === '::';
  if (exposed) {
    const ifaces = os.networkInterfaces();
    for (const iface of Object.values(ifaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          console.log(`iPad/Netzwerk: http://${addr.address}:${PORT}`);
        }
      }
    }
    if (!config.web_token) {
      console.warn('\n⚠️  WARNUNG: Web-Server lauscht im LAN OHNE Auth-Token.');
      console.warn('   Jeder im Netzwerk kann Tasks lesen/ändern. Setze config.web_token in ~/.daytask.json.\n');
    }
  } else {
    console.log('(nur lokal — für iPad/LAN: web_host="0.0.0.0" + web_token in ~/.daytask.json setzen)');
  }
  console.log('\nAuf dem iPad: Safari öffnen → URL oben eingeben → Share → "Zum Home-Bildschirm"\n');
});
