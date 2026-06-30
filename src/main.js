const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, globalShortcut, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { makeWorkingDir, sq, sshHostOk } = require('./workingdir');

// Prevent EIO crashes when stdout/stderr are closed in packaged builds
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// ── Helpers ───────────────────────────────────────────────────────────────────
function localNow() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(os.homedir(), '.daytask.json');
let config = {
  odoo: {
    url: '',
    db: '',
    username: '',
    password: '',
    project_id: null,
  },
  search_languages: ['en_US', 'de_DE'],
  project_colors: {},
  work_dir: path.join(os.homedir(), 'ai', 'work'),
  done_dir: path.join(os.homedir(), 'ai', 'done'),
  // Tagesansicht-Scan: Basisordner, in dem nach am Tag bearbeiteten Work-Ordnern
  // gesucht wird (aus den Claude-Session-Logs). Default = work_dir.
  scan_dir: path.join(os.homedir(), 'ai', 'work'),
  claude_bin: 'claude',
  claude_scan_args: ['--dangerously-skip-permissions'],
  claude_scan_timeout_ms: 240000,
  scan_max_dirs: 25,
};
if (fs.existsSync(CONFIG_PATH)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch {}
}
// Ensure sane defaults for multi-language search
if (!Array.isArray(config.search_languages) || config.search_languages.length === 0) {
  config.search_languages = ['en_US', 'de_DE'];
}

// Helper: normalise search languages list for outbound Odoo calls
function getSearchLanguages() {
  const langs = Array.isArray(config.search_languages) ? config.search_languages : [];
  const cleaned = langs.map(l => String(l || '').trim()).filter(Boolean);
  return cleaned.length ? cleaned : ['en_US', 'de_DE'];
}
function saveConfig() {
  // mode 0600: ~/.daytask.json enthält Odoo-Passwort und web_token im Klartext —
  // nicht world-readable schreiben.
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
}

// Gemeinsame Working-Dir-Logik (geteilt mit server.js). db wird lazy geholt,
// da sie erst in initDB() angelegt wird.
const wd = makeWorkingDir(() => db, config);

// ── Database ──────────────────────────────────────────────────────────────────
const DB_PATH = path.join(os.homedir(), '.daytask.db');
let db;
function initDB() {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  // WAL + busy_timeout: Electron-App, Web-Server (server.js) und CLI (cli.js) greifen
  // gleichzeitig auf dieselbe ~/.daytask.db zu. Ohne WAL/busy_timeout wirft der zweite
  // Schreiber sofort SQLITE_BUSY (unhandled). WAL erlaubt parallele Leser neben einem
  // Schreiber; busy_timeout lässt konkurrierende Schreiber warten statt zu werfen.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      ticket_ref TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      date TEXT DEFAULT (date('now','localtime')),
      done INTEGER DEFAULT 0,
      odoo_line_id INTEGER
    );
    -- migrations
    CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS odoo_tasks_cache (
      id INTEGER PRIMARY KEY,
      project_id INTEGER,
      project_name TEXT,
      task_name TEXT,
      task_no TEXT,
      cached_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS timeslots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      stopped_at TEXT,
      synced INTEGER DEFAULT 0,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );
  `);
  // Migrations
  function runMigration(name, sql) {
    const exists = db.prepare('SELECT 1 FROM _migrations WHERE name=?').get(name);
    if (!exists) { db.exec(sql); db.prepare('INSERT INTO _migrations(name) VALUES(?)').run(name); }
  }
  runMigration('add_odoo_task_link', `
    ALTER TABLE tasks ADD COLUMN odoo_task_id INTEGER;
    ALTER TABLE tasks ADD COLUMN odoo_project_id INTEGER;
    ALTER TABLE tasks ADD COLUMN odoo_task_label TEXT;
  `);
  runMigration('add_vscode_fields', `
    ALTER TABLE tasks ADD COLUMN vscode_ssh_host TEXT;
    ALTER TABLE tasks ADD COLUMN vscode_path TEXT;
    ALTER TABLE tasks ADD COLUMN git_repo TEXT;
    ALTER TABLE tasks ADD COLUMN git_branch TEXT;
  `);
  runMigration('add_deadline', `
    ALTER TABLE tasks ADD COLUMN deadline TEXT;
  `);
  runMigration('add_ticket_url', `
    ALTER TABLE tasks ADD COLUMN ticket_url TEXT;
  `);
  runMigration('add_last_commit', `
    ALTER TABLE tasks ADD COLUMN last_commit_sha TEXT;
  `);
  runMigration('add_odoo_stage', `
    ALTER TABLE tasks ADD COLUMN odoo_stage TEXT;
  `);
  runMigration('add_sequence_name', `
    ALTER TABLE tasks ADD COLUMN sequence_name TEXT;
  `);
  runMigration('add_private_notes', `
    ALTER TABLE tasks ADD COLUMN private_notes TEXT;
  `);
  runMigration('add_priority', `
    ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0;
  `);
  runMigration('add_archived', `
    ALTER TABLE tasks ADD COLUMN archived INTEGER DEFAULT 0;
  `);
  runMigration('add_done_at', `
    ALTER TABLE tasks ADD COLUMN done_at TEXT;
  `);
  runMigration('add_working_dir', `
    ALTER TABLE tasks ADD COLUMN working_dir TEXT;
  `);
  // comm-Integration: gleiche Migrationsnamen wie in server.js → wer zuerst
  // startet, legt die Spalten an, der andere überspringt sie (gemeinsame
  // _migrations-Tabelle). So funktioniert auch der Electron-only-Pfad.
  runMigration('add_comm_meta', `
    ALTER TABLE tasks ADD COLUMN comm_meta TEXT;
  `);
  runMigration('add_comm_feedback_pending', `
    ALTER TABLE tasks ADD COLUMN comm_feedback_pending INTEGER DEFAULT 0;
  `);
  // One-shot cleanup: rows whose Odoo stage name says "done/abgeschlossen/…"
  // but which still have done=0 locally — flip them to done=1 + archived=1
  // so they leave the active list. Older builds set is_closed-only logic so
  // these accumulated when Odoo had is_closed=False on those stages.
  runMigration('backfill_done_by_stage_name', `
    UPDATE tasks
      SET done=1,
          archived=1,
          done_at=COALESCE(done_at, datetime('now','localtime'))
      WHERE done=0
        AND (
          LOWER(COALESCE(odoo_stage,'')) LIKE '%abgeschlossen%'
          OR LOWER(COALESCE(odoo_stage,'')) LIKE '%erledigt%'
          OR LOWER(COALESCE(odoo_stage,'')) LIKE '%done%'
          OR LOWER(COALESCE(odoo_stage,'')) LIKE '%cancel%'
        );
  `);

  // Cleanup: zero-duration slots can never be uploaded — mark them synced
  // so they don't pile up in the "to upload" badge. Happens unconditionally,
  // independent of odoo_task_id, since these slots have nothing to upload.
  try {
    const swept = db.prepare(`
      UPDATE timeslots SET synced=1
      WHERE synced=0
        AND stopped_at IS NOT NULL
        AND strftime('%s', stopped_at) - strftime('%s', started_at) < 1
    `).run();
    if (swept.changes) console.log('[cleanup] swept', swept.changes, 'zero-duration timeslots');
  } catch (e) {
    console.error('[cleanup] failed:', e.message);
  }
}

// ── Odoo XML-RPC ──────────────────────────────────────────────────────────────
async function odooCall(endpoint, method, params) {
  const xmlrpc = require('xmlrpc');
  const url = new URL(config.odoo.url);
  const isHttps = url.protocol === 'https:';
  const port = url.port ? parseInt(url.port) : (isHttps ? 443 : 80);
  // TLS-Zertifikat per Default prüfen (sonst MITM → Odoo-Passwort abgreifbar).
  // Nur abschalten, wenn config.odoo.insecure_tls===true (z.B. self-signed Dev-Server).
  const rejectUnauthorized = !(config.odoo && config.odoo.insecure_tls);
  const clientOpts = { host: url.hostname, port, path: endpoint, rejectUnauthorized };
  const client = isHttps ? xmlrpc.createSecureClient(clientOpts) : xmlrpc.createClient(clientOpts);
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err, val) => err ? reject(err) : resolve(val));
  });
}

async function odooUID() {
  return odooCall('/xmlrpc/2/common', 'authenticate', [
    config.odoo.db, config.odoo.username, config.odoo.password, {}
  ]);
}

// Deferred-Kunden-Feedback (geteilt mit server.js): sendet einmalig "Wir
// bearbeiten Ihr Anliegen unter Ticket No. …" über comm, sobald ein per comm
// angelegter Task mit Option "Kunden informieren" mit Odoo verknüpft wird.
const { makeCommFeedback } = require('./commfeedback');
const commFeedback = makeCommFeedback({ getDb: () => db, config, odooCall, odooUID });
// Geteilte, idempotente Timeslot->Odoo-Sync-Logik (identisch in server.js).
const { makeTimeSync } = require('./timesync');
const timeSync = makeTimeSync({ getDb: () => db, config, odooCall, odooUID });
// Tagesansicht (lesen/inline-editieren/Claude-Scan), identisch in server.js.
const { makeDayView } = require('./dayview');
const dayView = makeDayView({ getDb: () => db, config, odooCall, odooUID });

// Keyword sets for auto-detection (shared between settings auto-detect and on-the-fly)
const STAGE_KEYWORDS = {
  in_progress: ['progress', 'bearbeitung', 'arbeit', 'aktiv', 'in progress'],
  waiting: ['waiting', 'warten', 'pause', 'wartend', 'blocked'],
  done: ['done', 'abgeschlossen', 'fertig', 'erledigt', 'closed'],
};

// Load stage names for a set of stage IDs in all configured languages.
// Returns { id: { id, name, names: [translated names] } }
async function loadStageNames(uid, stageIds) {
  const langs = getSearchLanguages();
  const stageMap = {};
  for (const lang of langs) {
    try {
      const stages = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.task.type', 'read', [stageIds],
        { fields: ['id', 'name'], context: { lang } }
      ]);
      for (const s of stages) {
        if (!stageMap[s.id]) stageMap[s.id] = { id: s.id, name: s.name, names: [] };
        stageMap[s.id].names.push(s.name);
      }
    } catch (_) { /* lang not installed — ignore */ }
  }
  if (!Object.keys(stageMap).length) {
    const stages = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      config.odoo.db, uid, config.odoo.password,
      'project.task.type', 'read', [stageIds], { fields: ['id', 'name'] }
    ]);
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

// Auto-detect stage mapping for a single project (used on-the-fly when a new
// project shows up in poll and has no mapping yet).
async function detectMappingForProject(uid, projectId) {
  try {
    const projects = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      config.odoo.db, uid, config.odoo.password,
      'project.project', 'read', [[projectId]], { fields: ['id', 'name', 'type_ids'] }
    ]);
    if (!projects || !projects[0]) return null;
    const p = projects[0];
    const stageIds = p.type_ids || [];
    if (!stageIds.length) return null;
    const stageMap = await loadStageNames(uid, stageIds);
    const ip = matchStage(stageIds, stageMap, STAGE_KEYWORDS.in_progress);
    const w = matchStage(stageIds, stageMap, STAGE_KEYWORDS.waiting);
    const d = matchStage(stageIds, stageMap, STAGE_KEYWORDS.done);
    if (!ip && !w && !d) return null;
    return {
      in_progress: ip?.id || null,
      waiting: w?.id || null,
      done: d?.id || null,
      project_name: p.name,
      in_progress_name: ip?.name || '',
      waiting_name: w?.name || '',
      done_name: d?.name || '',
    };
  } catch (e) {
    console.warn('[detectMappingForProject]', projectId, e.message);
    return null;
  }
}

function isCollectiveTask(taskTitle) {
  const keywords = (config.no_done_keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  if (!keywords.length) return false;
  const lower = (taskTitle || '').toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

// Mark a local task as done. Without timeslots: soft-archive (hidden from
// today's list) so the Odoo poll can't recreate it. With timeslots: keep
// the row visible-ish but flag done=1 + done_at for Done History.
// Returns { deleted, snapshot? } — snapshot is the row state BEFORE the
// change, so the renderer can offer a short Undo window.
function markTaskDone(id) {
  const exists = db.prepare('SELECT done FROM tasks WHERE id=?').get(id);
  if (!exists) return { deleted: false };
  const hasSlots = db.prepare('SELECT 1 FROM timeslots WHERE task_id=? LIMIT 1').get(id);
  const now = localNow();
  // Working-Dir als erledigt markieren (legt eine ".done"-Datei an, verschiebt
  // NICHT mehr nach ~/ai/done) — der working_dir bleibt damit stabil.
  wd.moveToDone(id);
  if (!hasSlots) {
    // Soft-archive so the poll's auto-create / "still in Odoo" check sees
    // an existing row and won't bring it back.
    db.prepare('UPDATE tasks SET archived=1, done=1, done_at=COALESCE(done_at, ?) WHERE id=?').run(now, id);
    // Snapshot NACH dem Move neu lesen → korrekter working_dir für restore.
    const snapshot = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    return { deleted: true, snapshot };
  }
  if (!exists.done) {
    db.prepare('UPDATE tasks SET done=1, done_at=COALESCE(done_at, ?) WHERE id=?').run(now, id);
  } else {
    db.prepare('UPDATE tasks SET done_at=COALESCE(done_at, ?) WHERE id=?').run(now, id);
  }
  return { deleted: false };
}

async function setOdooTaskStage(taskId, stageType, opts = {}) {
  // stageType: 'in_progress', 'waiting', or 'done'
  // opts.force: skip the "exclusively-mine" guard (manual user action)
  try {
    if (!config.odoo.url || !config.odoo.username) return;
    const task = db.prepare('SELECT odoo_task_id, odoo_project_id, title FROM tasks WHERE id=?').get(taskId);
    if (!task || !task.odoo_task_id) return;

    // Don't set done on collective tasks
    if (stageType === 'done' && isCollectiveTask(task.title)) return;

    const uid = await odooUID();
    if (!uid) return;

    if (!opts.force) {
      // Auto path: only flip stage if the task is exclusively assigned to me
      const odooTask = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.task', 'read', [[task.odoo_task_id]],
        { fields: ['user_ids'] }
      ]);
      if (!odooTask || !odooTask[0]) return;
      const userIds = odooTask[0].user_ids || [];
      if (userIds.length !== 1 || userIds[0] !== uid) return;
    }

    // Find stage ID from config mappings
    const mappings = config.stage_mappings || {};
    const projMapping = mappings[String(task.odoo_project_id)] || mappings['default'];
    if (!projMapping || !projMapping[stageType]) return;

    const stageId = projMapping[stageType];
    await odooCall('/xmlrpc/2/object', 'execute_kw', [
      config.odoo.db, uid, config.odoo.password,
      'project.task', 'write', [[task.odoo_task_id], { stage_id: stageId }]
    ]);
    console.log(`[stage] Task ${task.odoo_task_id} → stage ${stageType} (${stageId})`);
  } catch (e) {
    console.error('[stage] Fehler:', e.message);
  }
}

async function odooTestConnection() {
  try {
    if (!config.odoo.url || !config.odoo.username) return { ok: false, error: 'Odoo nicht konfiguriert (URL oder Username leer)' };
    if (!config.odoo.db) return { ok: false, error: 'Datenbank nicht angegeben' };
    if (!config.odoo.password) return { ok: false, error: 'Passwort nicht angegeben' };
    console.log('[odoo-test] Versuche Verbindung zu:', config.odoo.url, 'db:', config.odoo.db, 'user:', config.odoo.username);
    const uid = await odooUID();
    console.log('[odoo-test] Ergebnis uid:', uid);
    if (!uid) return { ok: false, error: 'Authentifizierung fehlgeschlagen (uid=false) – Zugangsdaten prüfen' };
    return { ok: true, uid };
  } catch (e) {
    console.error('[odoo-test] Fehler:', e);
    return { ok: false, error: e.message || String(e) };
  }
}

async function odooSearchTasks(query) {
  try {
    if (!config.odoo.url || !config.odoo.username) return { ok: false, error: 'Odoo nicht konfiguriert' };
    const uid = await odooUID();
    if (!uid) return { ok: false, error: 'Auth fehlgeschlagen' };

    // Search project.task: each word must match in task name, project name or ticket number (sequence_name)
    const words = (query || '').trim().split(/\s+/).filter(Boolean);
    const buildDomain = () => {
      const d = [];
      for (const w of words) {
        d.push('|', '|',
          ['name', 'ilike', w],
          ['project_id.name', 'ilike', w],
          ['sequence_name', 'ilike', w]);
      }
      return d;
    };

    const langs = getSearchLanguages();
    console.log('[odoo-search] Query:', query, 'Words:', words, 'Langs:', langs);
    const idSet = new Set();
    let lastErr = null;
    for (const lang of langs) {
      try {
        const ids = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, uid, config.odoo.password,
          'project.task', 'search', [buildDomain()],
          { limit: 50, context: { lang } }
        ]);
        (ids || []).forEach(id => idSet.add(id));
      } catch (searchErr) {
        lastErr = searchErr;
        console.log('[odoo-search] Search error (lang ' + lang + '):', searchErr.message);
      }
    }
    let taskIds = [...idSet];
    if (taskIds.length === 0 && lastErr && query) {
      // Final fallback without lang context
      try {
        taskIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, uid, config.odoo.password,
          'project.task', 'search', [[['name', 'ilike', query]]],
          { limit: 50 }
        ]) || [];
      } catch (e) {
        console.log('[odoo-search] Final fallback failed:', e.message);
      }
    }
    console.log('[odoo-search] Gefunden:', taskIds.length);

    if (!taskIds || taskIds.length === 0) return { ok: true, tasks: [] };

    const baseFields = ['id', 'name', 'project_id', 'date_deadline', 'stage_id', 'sequence_name'];
    let tasks;
    try {
      tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.task', 'read', [taskIds],
        { fields: [...baseFields, 'branch_name', 'repo'] }
      ]);
    } catch (_) {
      tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.task', 'read', [taskIds],
        { fields: baseFields }
      ]);
    }

    const result = tasks.map(t => ({
      id: t.id,
      name: t.name,
      project_id: t.project_id ? t.project_id[0] : null,
      project_name: t.project_id ? t.project_id[1] : '',
      sequence_name: t.sequence_name || '',
      branch_name: t.branch_name || '',
      repo: t.repo || '',
      date_deadline: t.date_deadline || '',
    }));

    // Update cache
    const insertCache = db.prepare('INSERT OR REPLACE INTO odoo_tasks_cache (id, project_id, project_name, task_name, task_no) VALUES (?,?,?,?,?)');
    const tx = db.transaction(() => {
      for (const t of result) insertCache.run(t.id, t.project_id, t.project_name, t.name, t.sequence_name);
    });
    tx();

    return { ok: true, tasks: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Delegiert an das geteilte, idempotente Sync-Modul (src/timesync.js) — identische
// Logik wie im Web-Server, atomar geclaimt + per (Task,Tag) genau eine Odoo-Zeile.
async function syncUnsyncedTimeslots(taskId) {
  return timeSync.syncUnsyncedTimeslots(taskId);
}

// ── Windows ───────────────────────────────────────────────────────────────────
let mainWin = null;
let settingsWin = null;
let taskWin = null;
let tray = null;
let activeTaskId = null;
let activeSlotId = null;
let tickInterval = null;

const MAIN_WIN_FULL = { width: 720, height: 560 };
const MAIN_WIN_MINI = { width: 380, height: 46 };
const MAIN_WIN_MIN_HEIGHT = 200;

function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const isWin = process.platform === 'win32';
  const savedHeight = Number.isFinite(config.window_height) && config.window_height >= MAIN_WIN_MIN_HEIGHT
    ? Math.min(config.window_height, height - 80)
    : MAIN_WIN_FULL.height;
  mainWin = new BrowserWindow({
    width: MAIN_WIN_FULL.width,
    height: savedHeight,
    minWidth: MAIN_WIN_FULL.width,
    maxWidth: MAIN_WIN_FULL.width,
    minHeight: MAIN_WIN_MIN_HEIGHT,
    x: width - MAIN_WIN_FULL.width - 20,
    y: 40,
    show: false, // hidden until user clicks tray icon
    frame: false,
    transparent: !isWin,
    backgroundColor: isWin ? '#0f1117' : undefined,
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    resizable: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    }
  });
  let userFullHeight = savedHeight;
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  // Electron ≥37: console-message liefert ein Event-Objekt mit String-`level`
  // ('info'|'warning'|'error') + `message`. Älter: (event, levelInt, message).
  mainWin.webContents.on('console-message', function (e, level, msg) {
    if (e && typeof e.level === 'string') { if (e.level !== 'info') console.log('[renderer]', e.message); }
    else if (typeof level === 'number') { if (level > 0) console.log('[renderer]', msg); }
  });
  mainWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWin.setAlwaysOnTop(true, 'floating', 1);
  let isMini = false;
  let isPinned = false;
  // expose for tray-click drop-down
  mainWin.__dropDown = (anchorBounds) => {
    if (!mainWin || mainWin.isDestroyed()) return;
    // Resolve display via tray-anchor coordinates. Fall back to the primary
    // display if anchor is unusable (eg. monitor unplugged during sleep).
    let display = screen.getDisplayNearestPoint({ x: anchorBounds.x, y: anchorBounds.y });
    if (!display || !display.workArea) display = screen.getPrimaryDisplay();
    const winW = MAIN_WIN_FULL.width;
    const winH = Math.max(MAIN_WIN_MIN_HEIGHT, Math.min(userFullHeight || MAIN_WIN_FULL.height, display.workArea.height - 40));
    const centerX = anchorBounds.x + Math.floor(anchorBounds.width / 2);
    let x = Math.round(centerX - winW / 2);
    const screenLeft = display.workArea.x;
    const screenRight = display.workArea.x + display.workArea.width;
    if (x < screenLeft + 4) x = screenLeft + 4;
    if (x + winW > screenRight - 4) x = screenRight - winW - 4;
    let y = Math.round(anchorBounds.y + anchorBounds.height + 4);
    // Anchor sometimes reports y=0 with no height on macOS — fall back to menu-bar height
    if (!anchorBounds.height || anchorBounds.y < display.workArea.y) y = display.workArea.y + 4;
    console.log('[dropDown] anchor=', anchorBounds, 'display=', display.workArea, '→ bounds', { x, y, width: winW, height: winH });
    isMini = false;
    mainWin.setResizable(true);
    mainWin.setMinimumSize(winW, MAIN_WIN_MIN_HEIGHT);
    mainWin.setBounds({ x, y, width: winW, height: winH });
    // Re-assert always-on-top after sleep wake — macOS sometimes drops the level
    mainWin.setAlwaysOnTop(true, 'floating', 1);
    mainWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (!mainWin.isVisible()) mainWin.showInactive();
    mainWin.moveTop();
    mainWin.focus();
    mainWin.webContents.send('window:mini', false);
  };
  function setMini(mini) {
    if (mini && isPinned) return; // pinned — don't collapse
    console.log('[setMini → hide?]', mini);
    isMini = mini;
    if (mini) {
      mainWin.hide();
    } else {
      mainWin.setResizable(true);
      mainWin.setMinimumSize(MAIN_WIN_FULL.width, MAIN_WIN_MIN_HEIGHT);
      mainWin.setSize(MAIN_WIN_FULL.width, userFullHeight);
      if (!mainWin.isVisible()) mainWin.show();
    }
    mainWin.webContents.send('window:mini', mini);
  }

  // Persist user-driven height changes while in full mode
  let saveHeightTimer = null;
  mainWin.on('resize', () => {
    if (isMini || mainWin.isDestroyed()) return;
    const [, h] = mainWin.getSize();
    userFullHeight = h;
    clearTimeout(saveHeightTimer);
    saveHeightTimer = setTimeout(() => {
      config.window_height = userFullHeight;
      try { saveConfig(); } catch (e) { console.error('[window-resize] saveConfig failed:', e.message); }
    }, 400);
  });
  let miniDragActive = false;
  mainWin.__lastBlurAt = 0;
  if (process.platform !== 'win32') {
    // macOS: blur hides window (presence remains in menu-bar tray)
    mainWin.on('blur', () => { mainWin.__lastBlurAt = Date.now(); setMini(true); });
    mainWin.on('focus', () => {
      if (miniDragActive) return;
      if (!isMini) setMini(false);
    });
  } else {
    // Windows: blur event + poll as fallback
    mainWin.on('blur', () => { mainWin.__lastBlurAt = Date.now(); setMini(true); });
    setInterval(() => {
      if (!isMini && !isPinned && !mainWin.isFocused() && !mainWin.isDestroyed()) {
        console.log('[win-poll] not focused, collapsing');
        setMini(true);
      }
    }, 500);
  }
  ipcMain.handle('window:expand', () => {
    setMini(false);
    mainWin.focus();
  });
  ipcMain.handle('window:collapse', () => {
    setMini(true);
  });
  ipcMain.handle('window:setPinned', (_, pinned) => {
    isPinned = !!pinned;
    console.log('[pinned]', isPinned);
    if (isPinned && isMini) {
      setMini(false);
    }
  });
  ipcMain.handle('window:getPos', () => mainWin.getPosition());
  ipcMain.handle('window:setPos', (_, { x, y }) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.setPosition(Math.round(x), Math.round(y));
  });
  ipcMain.handle('window:miniDragStart', () => { miniDragActive = true; });
  ipcMain.handle('window:miniDragEnd', () => { miniDragActive = false; });
  ipcMain.handle('window:kioskStatus', () => {
    if (!mainWin || mainWin.isDestroyed()) return false;
    return mainWin.isKiosk();
  });
  ipcMain.handle('window:kioskToggle', () => {
    if (!mainWin || mainWin.isDestroyed()) return false;
    const next = !mainWin.isKiosk();
    mainWin.setKiosk(next);
    if (next) {
      // Make sure window is visible & focused when entering kiosk
      if (!mainWin.isVisible()) mainWin.show();
      mainWin.focus();
    } else {
      // Restore floating/always-on-top after leaving kiosk
      mainWin.setAlwaysOnTop(true, 'floating', 1);
      mainWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    return next;
  });
}

function createSettingsWindow() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 1960,
    height: 1440,
    minWidth: 760,
    minHeight: 560,
    title: 'DayTask – Einstellungen',
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    }
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

function createTaskWindow(taskId) {
  if (taskWin && !taskWin.isDestroyed()) {
    taskWin.focus();
    taskWin.webContents.send('task:load', taskId);
    return;
  }
  taskWin = new BrowserWindow({
    width: 1400,
    height: 1000,
    minWidth: 760,
    minHeight: 560,
    title: 'DayTask – Task',
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--task-id=${taskId}`],
    }
  });
  taskWin.loadFile(path.join(__dirname, 'task.html'));
  taskWin.on('closed', () => {
    taskWin = null;
    if (mainWin && !mainWin.isDestroyed()) {
      if (tray && mainWin.__dropDown) mainWin.__dropDown(tray.getBounds());
      else { mainWin.show(); mainWin.focus(); }
    }
  });
}

let trayContextMenu = null;
function buildTrayMenu() {
  const activeTask = activeTaskId ? db.prepare('SELECT id, title, sequence_name FROM tasks WHERE id=?').get(activeTaskId) : null;
  const taskRef = activeTask ? (activeTask.sequence_name || '') : '';
  const label = activeTask ? `⏱ ${taskRef ? taskRef + ' ' : ''}${activeTask.title}` : 'DayTask';
  tray.setTitle(label);
  // Built for right-click access (Settings / Quit). Left-click triggers
  // tray.on('click') directly and opens the window — no menu pops up.
  trayContextMenu = Menu.buildFromTemplate([
    { label: activeTask ? `Läuft: ${taskRef ? taskRef + ' ' : ''}${activeTask.title}` : 'Kein aktiver Task', enabled: false },
    { type: 'separator' },
    { label: 'Fenster anzeigen', click: () => { mainWin.show(); mainWin.focus(); } },
    { label: 'Einstellungen', click: createSettingsWindow },
    { type: 'separator' },
    { label: 'Beenden', click: () => app.quit() },
  ]);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
function setupIPC() {
  // Tasks
  ipcMain.handle('tasks:today', (_, opts) => {
    const includeArchived = !!(opts && opts.includeArchived);
    const today = localNow().split(' ')[0];
    console.log('[tasks:today] Abfrage für:', today, 'incl. archiv:', includeArchived);
    const archivedClause = includeArchived ? '' : 'AND COALESCE(t.archived,0)=0';
    const tasks = db.prepare(`
      SELECT t.*, t.odoo_task_id, t.odoo_project_id, t.odoo_task_label,
        COALESCE((SELECT SUM((julianday(COALESCE(stopped_at, datetime('now','localtime'))) - julianday(started_at)) * 86400)
          FROM timeslots WHERE task_id=t.id), 0) AS total_seconds,
        (SELECT started_at FROM timeslots WHERE task_id=t.id AND stopped_at IS NULL LIMIT 1) AS running_since,
        (SELECT COUNT(*) FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL) AS unsynced_count,
        COALESCE((SELECT SUM((julianday(stopped_at) - julianday(started_at)) * 86400)
          FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL), 0) AS unsynced_seconds
      FROM tasks t WHERE t.date=? ${archivedClause} ORDER BY t.done ASC,
        COALESCE(t.priority, 0) DESC,
        COALESCE((SELECT MAX(started_at) FROM timeslots WHERE task_id=t.id), t.created_at) DESC,
        t.id DESC
    `).all(today);
    console.log('[tasks:today] Gefunden:', tasks.length);
    return { tasks, activeTaskId, activeSlotId };
  });

  ipcMain.handle('tasks:searchArchive', (_, query) => {
    const q = String(query || '').trim();
    console.log('[tasks:searchArchive] Query:', q);
    if (q.length < 2) return { tasks: [] };
    const like = `%${q.toLowerCase()}%`;
    const today = localNow().split(' ')[0];
    const tasks = db.prepare(`
      SELECT t.*, t.odoo_task_id, t.odoo_project_id, t.odoo_task_label,
        COALESCE((SELECT SUM((julianday(COALESCE(stopped_at, datetime('now','localtime'))) - julianday(started_at)) * 86400)
          FROM timeslots WHERE task_id=t.id), 0) AS total_seconds,
        (SELECT started_at FROM timeslots WHERE task_id=t.id AND stopped_at IS NULL LIMIT 1) AS running_since,
        (SELECT COUNT(*) FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL) AS unsynced_count,
        COALESCE((SELECT SUM((julianday(stopped_at) - julianday(started_at)) * 86400)
          FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL), 0) AS unsynced_seconds
      FROM tasks t
      WHERE (t.date != ? OR COALESCE(t.archived,0)=1)
        AND (
          LOWER(COALESCE(t.title,'')) LIKE ?
          OR LOWER(COALESCE(t.ticket_ref,'')) LIKE ?
          OR LOWER(COALESCE(t.odoo_task_label,'')) LIKE ?
          OR LOWER(COALESCE(t.odoo_stage,'')) LIKE ?
          OR LOWER(COALESCE(t.git_branch,'')) LIKE ?
          OR LOWER(COALESCE(t.note,'')) LIKE ?
          OR LOWER(COALESCE(t.sequence_name,'')) LIKE ?
        )
      ORDER BY t.date DESC, t.id DESC
      LIMIT 100
    `).all(today, like, like, like, like, like, like, like);
    console.log('[tasks:searchArchive] Gefunden:', tasks.length);
    return { tasks };
  });

  ipcMain.handle('tasks:doneHistory', () => {
    // Tasks that were marked done AND have at least one timeslot — these are
    // the items the user actually stamped time on. Ordered by completion time
    // descending. Includes archived (soft-deleted) ones for completeness.
    const tasks = db.prepare(`
      SELECT t.*,
        COALESCE((SELECT SUM((julianday(COALESCE(stopped_at, datetime('now','localtime'))) - julianday(started_at)) * 86400)
          FROM timeslots WHERE task_id=t.id), 0) AS total_seconds,
        (SELECT MAX(stopped_at) FROM timeslots WHERE task_id=t.id) AS last_stop
      FROM tasks t
      WHERE t.done=1
        AND EXISTS (SELECT 1 FROM timeslots WHERE task_id=t.id)
      ORDER BY COALESCE(t.done_at, last_stop, t.date) DESC, t.id DESC
      LIMIT 200
    `).all();
    return { tasks };
  });

  ipcMain.handle('tasks:unsynced', () => {
    const tasks = db.prepare(`
      SELECT t.*, t.odoo_task_id, t.odoo_project_id, t.odoo_task_label,
        COALESCE((SELECT SUM((julianday(COALESCE(stopped_at, datetime('now','localtime'))) - julianday(started_at)) * 86400)
          FROM timeslots WHERE task_id=t.id), 0) AS total_seconds,
        (SELECT started_at FROM timeslots WHERE task_id=t.id AND stopped_at IS NULL LIMIT 1) AS running_since,
        (SELECT COUNT(*) FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL) AS unsynced_count,
        COALESCE((SELECT SUM((julianday(stopped_at) - julianday(started_at)) * 86400)
          FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL), 0) AS unsynced_seconds
      FROM tasks t
      WHERE EXISTS (SELECT 1 FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL)
      ORDER BY t.date DESC, t.id DESC
    `).all();
    return { tasks };
  });

  ipcMain.handle('tasks:add', async (_, { title, ticket_ref, note, deadline, odoo_project_id, odoo_project_name, odoo_task_id, odoo_task_name, odoo_task_sequence }) => {
    const today = localNow().split(' ')[0];
    let odooTaskId = odoo_task_id || null;
    let odooTaskLabel = null;
    let seqName = odoo_task_sequence || null;
    let odooCreateError = null;

    if (odoo_task_id) {
      // Existing Odoo task selected - just link it
      odooTaskLabel = `${odoo_project_name || ''} / ${odoo_task_name || title}`;
    } else if (odoo_project_id && config.odoo.url && config.odoo.username) {
      // Create new task in Odoo
      try {
        const uid = await odooUID();
        if (!uid) throw new Error('Odoo-Auth fehlgeschlagen');
        const vals = { name: title, project_id: odoo_project_id };
        if (deadline) {
          // Odoo date_deadline is a Date field → strip time component
          vals.date_deadline = deadline.includes('T') ? deadline.split('T')[0] : deadline;
        }
        odooTaskId = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, uid, config.odoo.password,
          'project.task', 'create', [vals]
        ]);
        odooTaskLabel = `${odoo_project_name || ''} / ${title}`;
      } catch (e) {
        console.error('[tasks:add] Odoo task create failed:', e.message);
        odooCreateError = e.message || String(e);
      }
    }

    const info = db.prepare('INSERT INTO tasks (title, ticket_ref, note, date, deadline, odoo_task_id, odoo_project_id, odoo_task_label, sequence_name) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(title, ticket_ref || null, note || null, today, deadline || null, odooTaskId, odoo_project_id || null, odooTaskLabel, seqName);
    return { id: info.lastInsertRowid, odooTaskId, odooCreateError };
  });

  ipcMain.handle('odoo:recentProjects', () => {
    // Get distinct projects from recent tasks, ordered by last use
    const projects = db.prepare(`
      SELECT DISTINCT odoo_project_id, odoo_task_label,
        MAX(created_at) as last_used
      FROM tasks
      WHERE odoo_project_id IS NOT NULL
      GROUP BY odoo_project_id
      ORDER BY last_used DESC
      LIMIT 10
    `).all();
    // Extract project name from label "ProjectName / TaskName"
    return projects.map(p => ({
      id: p.odoo_project_id,
      name: (p.odoo_task_label || '').split(' / ')[0].trim(),
      last_used: p.last_used,
    })).filter(p => p.name);
  });

  ipcMain.handle('odoo:searchProjects', async (_, query) => {
    try {
      if (!config.odoo.url || !config.odoo.username || !query) return [];
      const uid = await odooUID();
      if (!uid) return [];

      // Search across configured languages — Odoo translates project names per lang,
      // so a search restricted to one lang may miss matches that exist in another.
      const langs = getSearchLanguages();
      const idSet = new Set();
      for (const lang of langs) {
        try {
          const ids = await odooCall('/xmlrpc/2/object', 'execute_kw', [
            config.odoo.db, uid, config.odoo.password,
            'project.project', 'search', [[['name', 'ilike', query]]],
            { limit: 15, context: { lang } }
          ]);
          (ids || []).forEach(id => idSet.add(id));
        } catch (langErr) {
          console.warn('[odoo:searchProjects] lang', lang, langErr.message);
        }
      }
      if (idSet.size === 0) return [];
      const ids = [...idSet].slice(0, 30);
      const projects = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.project', 'read', [ids],
        { fields: ['id', 'name'], context: { lang: langs[0] } }
      ]);
      return projects.map(p => ({ id: p.id, name: p.name }));
    } catch (e) {
      console.error('[odoo:searchProjects]', e.message);
      return [];
    }
  });

  ipcMain.handle('odoo:autoDetectStageMappings', async () => {
    try {
      if (!config.odoo.url || !config.odoo.username) return { ok: false, error: 'Odoo nicht konfiguriert' };
      const uid = await odooUID();
      if (!uid) return { ok: false, error: 'Auth fehlgeschlagen' };

      // Get all projects
      const projIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.project', 'search', [[]], { limit: 200 }
      ]);
      if (!projIds || !projIds.length) return { ok: true, mappings: {} };
      const projects = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.project', 'read', [projIds], { fields: ['id', 'name', 'type_ids'] }
      ]);

      // Load all stage names in all configured languages via shared helper
      const allStageIds = [...new Set(projects.flatMap(p => p.type_ids || []))];
      if (!allStageIds.length) return { ok: true, mappings: {} };
      const stageMap = await loadStageNames(uid, allStageIds);

      const mappings = {};
      for (const p of projects) {
        const ip = matchStage(p.type_ids || [], stageMap, STAGE_KEYWORDS.in_progress);
        const w = matchStage(p.type_ids || [], stageMap, STAGE_KEYWORDS.waiting);
        const d = matchStage(p.type_ids || [], stageMap, STAGE_KEYWORDS.done);
        if (ip || w || d) {
          mappings[String(p.id)] = {
            in_progress: ip?.id || null,
            waiting: w?.id || null,
            done: d?.id || null,
            project_name: p.name,
            in_progress_name: ip?.name || '',
            waiting_name: w?.name || '',
            done_name: d?.name || '',
          };
        }
      }
      return { ok: true, mappings };
    } catch (e) {
      console.error('[autoDetectStageMappings]', e.message);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('odoo:searchStages', async (_, { projectId }) => {
    try {
      if (!config.odoo.url || !config.odoo.username) return [];
      const uid = await odooUID();
      if (!uid) return [];
      const domain = projectId ? [['project_ids', 'in', [projectId]]] : [];
      const ids = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.task.type', 'search', [domain],
        { limit: 50 }
      ]);
      if (!ids || ids.length === 0) return [];
      const stages = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.task.type', 'read', [ids],
        { fields: ['id', 'name', 'fold'] }
      ]);
      return stages.map(s => ({ id: s.id, name: s.name, fold: s.fold || false }));
    } catch (e) {
      console.error('[odoo:searchStages]', e.message);
      return [];
    }
  });

  ipcMain.handle('odoo:searchTasksInProject', async (_, { projectId, query }) => {
    try {
      if (!config.odoo.url || !config.odoo.username) return [];
      const uid = await odooUID();
      if (!uid) return [];
      const domain = [['project_id', '=', projectId]];
      const words = (query || '').trim().split(/\s+/).filter(Boolean);
      for (const w of words) domain.push('|', ['name', 'ilike', w], ['sequence_name', 'ilike', w]);
      const langs = getSearchLanguages();
      const idSet = new Set();
      for (const lang of langs) {
        try {
          const partIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [
            config.odoo.db, uid, config.odoo.password,
            'project.task', 'search', [domain],
            { limit: 20, context: { lang } }
          ]);
          (partIds || []).forEach(id => idSet.add(id));
        } catch (langErr) {
          console.warn('[odoo:searchTasksInProject] lang', lang, langErr.message);
        }
      }
      const ids = [...idSet].slice(0, 30);
      if (!ids.length) return [];
      let tasks;
      try {
        tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, uid, config.odoo.password,
          'project.task', 'read', [ids],
          { fields: ['id', 'name', 'sequence_name', 'date_deadline'] }
        ]);
      } catch (_) {
        tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, uid, config.odoo.password,
          'project.task', 'read', [ids],
          { fields: ['id', 'name', 'date_deadline'] }
        ]);
      }
      return tasks.map(t => ({ id: t.id, name: t.name, sequence_name: t.sequence_name || '', date_deadline: t.date_deadline || '' }));
    } catch (e) {
      console.error('[odoo:searchTasksInProject]', e.message);
      return [];
    }
  });

  ipcMain.handle('odoo:createTask', async (_, { projectId, name }) => {
    try {
      if (!config.odoo.url || !config.odoo.username) return { ok: false, error: 'Odoo nicht konfiguriert' };
      const uid = await odooUID();
      if (!uid) return { ok: false, error: 'Auth fehlgeschlagen' };
      const taskId = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.task', 'create', [{ name, project_id: projectId }]
      ]);
      return { ok: true, taskId };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('tasks:done', async (_, id) => {
    // stop if running
    if (activeTaskId === id) await stopTimer();
    const result = markTaskDone(id);
    setOdooTaskStage(id, 'done').catch(() => {});
    return { ok: true, ...result };
  });

  ipcMain.handle('tasks:setWaiting', async (_, id) => {
    if (activeTaskId === id) await stopTimer();
    const r = await setOdooTaskStage(id, 'waiting', { force: true });
    // Reflect immediately in local cache so the UI shows the new stage before
    // the next poll runs. Best-effort — actual stage name comes from Odoo.
    db.prepare("UPDATE tasks SET odoo_stage = COALESCE(odoo_stage, 'waiting') WHERE id=?").run(id);
    if (mainWin) mainWin.webContents.send('tasks:refresh');
    return { ok: true, ...(r || {}) };
  });

  ipcMain.handle('tasks:restore', (_, snapshot) => {
    if (!snapshot || !snapshot.id) return { ok: false, error: 'no snapshot' };
    // Re-insert with same fields. Use INSERT OR REPLACE on the original id so
    // any references survive. Reset done flag so it shows up in today's list.
    // Spaltennamen NICHT roh aus dem Snapshot übernehmen (sonst SQL-Injection über
    // den Identifier-Teil): gegen die echten tasks-Spalten whitelisten.
    const validCols = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name));
    const cols = Object.keys(snapshot).filter(c => validCols.has(c));
    if (!cols.length) return { ok: false, error: 'no valid columns' };
    const placeholders = cols.map(() => '?').join(',');
    const restored = { ...snapshot, done: 0, done_at: null, archived: 0 };
    const values = cols.map(c => restored[c]);
    db.prepare(`INSERT OR REPLACE INTO tasks (${cols.join(',')}) VALUES (${placeholders})`).run(...values);
    if (mainWin) mainWin.webContents.send('tasks:refresh');
    return { ok: true };
  });

  ipcMain.handle('tasks:delete', (_, id) => {
    if (activeTaskId === id) stopTimer();
    // Soft-delete: archive flag bleibt erhalten, damit Odoo-Poll den Task
    // nicht erneut anlegt. Sichtbar nur wenn Archiv-Filter aktiv ist.
    db.prepare('UPDATE tasks SET archived=1, done=1 WHERE id=?').run(id);
    return true;
  });

  ipcMain.handle('tasks:unarchive', (_, id) => {
    db.prepare('UPDATE tasks SET archived=0 WHERE id=?').run(id);
    return true;
  });

  ipcMain.handle('tasks:undone', (_, id) => {
    // Also un-archive and clear done_at, otherwise a previously-dismissed
    // (soft-archived) task would stay hidden.
    db.prepare('UPDATE tasks SET done=0, archived=0, done_at=NULL WHERE id=?').run(id);
    // Erledigt-Markierung (.done-Datei) wieder entfernen
    wd.moveToWork(id);
    return true;
  });

  ipcMain.handle('tasks:moveToToday', (_, id) => {
    const today = localNow().split(' ')[0];
    db.prepare('UPDATE tasks SET date=? WHERE id=?').run(today, id);
    if (mainWin) mainWin.webContents.send('tasks:refresh');
    return true;
  });

  ipcMain.handle('tasks:setPriority', (_, { id, priority }) => {
    db.prepare('UPDATE tasks SET priority=? WHERE id=?').run(priority ? 1 : 0, id);
    return true;
  });

  ipcMain.handle('tasks:update', (_, { id, title, ticket_ref, note, private_notes }) => {
    // working_dir wird hier bewusst NICHT geschrieben — es wird ausschließlich
    // über createWorkingDir/move gesetzt. Sonst überschreibt ein offenes
    // Detail-Fenster mit veraltetem Feldwert den durch done/undone bereits
    // verschobenen Pfad.
    db.prepare('UPDATE tasks SET title=?, ticket_ref=?, note=?, private_notes=? WHERE id=?').run(title, ticket_ref || null, note || null, private_notes || null, id);
    if (mainWin) mainWin.webContents.send('tasks:refresh');
    buildTrayMenu();
    return true;
  });

  ipcMain.handle('timeslots:add', (_, { taskId, durationMinutes }) => {
    const now = new Date();
    const started = new Date(now.getTime() - durationMinutes * 60000);
    const pad = n => String(n).padStart(2, '0');
    const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    db.prepare('INSERT INTO timeslots (task_id, started_at, stopped_at) VALUES (?,?,?)').run(taskId, fmt(started), fmt(now));
    return true;
  });

  ipcMain.handle('timeslots:reset', (_, taskId) => {
    const wasRunning = activeTaskId === taskId;
    if (wasRunning) {
      // Stop without syncing, just clear state
      activeTaskId = null;
      activeSlotId = null;
    }
    db.prepare('DELETE FROM timeslots WHERE task_id=?').run(taskId);
    if (wasRunning) {
      // Restart timer
      activeTaskId = taskId;
      const now = localNow();
      const info = db.prepare('INSERT INTO timeslots (task_id, started_at) VALUES (?,?)').run(taskId, now);
      activeSlotId = info.lastInsertRowid;
    }
    buildTrayMenu();
    return { wasRunning };
  });

  ipcMain.handle('tasks:get', (_, id) => {
    return db.prepare(`
      SELECT t.*,
        COALESCE((SELECT SUM((julianday(COALESCE(stopped_at, datetime('now','localtime'))) - julianday(started_at)) * 86400)
          FROM timeslots WHERE task_id=t.id), 0) AS total_seconds,
        (SELECT COUNT(*) FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL) AS unsynced_count,
        COALESCE((SELECT SUM((julianday(stopped_at) - julianday(started_at)) * 86400)
          FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL), 0) AS unsynced_seconds
      FROM tasks t WHERE t.id=?
    `).get(id);
  });

  // Timer
  ipcMain.handle('timer:start', async (_, taskId) => {
    if (activeTaskId === taskId) return { ok: false, reason: 'already running' };
    if (activeTaskId) await stopTimer({ sync: false });
    activeTaskId = taskId;
    const now = localNow();
    const info = db.prepare('INSERT INTO timeslots (task_id, started_at) VALUES (?,?)').run(taskId, now);
    activeSlotId = info.lastInsertRowid;
    buildTrayMenu();
    setOdooTaskStage(taskId, 'in_progress').catch(() => {});
    return { ok: true, slotId: activeSlotId };
  });

  ipcMain.handle('timer:stop', async () => {
    if (!activeTaskId) return { ok: false };
    const result = await stopTimer();
    return result;
  });

  ipcMain.handle('timer:status', () => ({ activeTaskId, activeSlotId }));

  // Config
  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:save', (_, newConfig) => {
    // In-place mutieren statt reassign — sonst behalten Module wie workingdir.js,
    // die die config-Referenz captured haben, die alten Werte.
    Object.assign(config, newConfig);
    saveConfig();
    return true;
  });

  // Odoo
  ipcMain.handle('odoo:test', () => odooTestConnection());
  ipcMain.handle('odoo:searchTasks', (_, query) => odooSearchTasks(query));
  ipcMain.handle('odoo:getTaskBudgets', async (_, odooTaskIds) => {
    try {
      const ids = (odooTaskIds || []).filter(Boolean);
      if (!ids.length) return { ok: true, budgets: {} };
      if (!config.odoo.url || !config.odoo.username) return { ok: false, error: 'Odoo not configured' };
      const uid = await odooUID();
      if (!uid) return { ok: false, error: 'Odoo auth failed' };
      const fields = ['id', 'allocated_hours', 'effective_hours', 'remaining_hours', 'progress'];
      let rows;
      try {
        rows = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, uid, config.odoo.password,
          'project.task', 'read', [ids], { fields }
        ]);
      } catch (e) {
        // Fallback for older versions where some fields may not exist
        rows = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, uid, config.odoo.password,
          'project.task', 'read', [ids], { fields: ['id', 'allocated_hours', 'effective_hours'] }
        ]);
      }
      const budgets = {};
      for (const r of rows) {
        const allocated = Number(r.allocated_hours) || 0;
        const effective = Number(r.effective_hours) || 0;
        const remaining = (typeof r.remaining_hours === 'number') ? r.remaining_hours : (allocated - effective);
        const progress = (typeof r.progress === 'number') ? r.progress : (allocated > 0 ? (effective / allocated) * 100 : 0);
        budgets[r.id] = { allocated, effective, remaining, progress };
      }
      return { ok: true, budgets };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('tasks:linkOdoo', async (_, { taskId, odooTaskId, odooProjectId, odooTaskLabel, gitBranch, gitRepo, deadline }) => {
    db.prepare('UPDATE tasks SET odoo_task_id=?, odoo_project_id=?, odoo_task_label=? WHERE id=?')
      .run(odooTaskId, odooProjectId, odooTaskLabel, taskId);
    // Auto-fill git branch/repo/deadline from Odoo task if available
    if (gitBranch || gitRepo || deadline) {
      db.prepare('UPDATE tasks SET git_branch=COALESCE(?, git_branch), git_repo=COALESCE(?, git_repo), deadline=COALESCE(?, deadline) WHERE id=?')
        .run(gitBranch || null, gitRepo || null, deadline || null, taskId);
    }
    // Retroactively sync all unsynced timeslots
    const syncResults = await syncUnsyncedTimeslots(taskId);
    const synced = syncResults.filter(r => r.ok).length;
    const failed = syncResults.filter(r => !r.ok).length;
    // Jetzt mit Odoo verknüpft → ggf. ausstehendes Kunden-Feedback senden.
    await commFeedback.maybeSend(taskId);
    if (mainWin) mainWin.webContents.send('tasks:refresh');
    buildTrayMenu();
    return { ok: true, synced, failed };
  });
  ipcMain.handle('tasks:unlinkOdoo', (_, taskId) => {
    db.prepare('UPDATE tasks SET odoo_task_id=NULL, odoo_project_id=NULL, odoo_task_label=NULL WHERE id=?').run(taskId);
    if (mainWin) mainWin.webContents.send('tasks:refresh');
    buildTrayMenu();
    return true;
  });

  // VSCode / Project
  ipcMain.handle('tasks:saveVscode', (_, { taskId, vscode_ssh_host, vscode_path, git_repo, git_branch, ticket_url }) => {
    db.prepare('UPDATE tasks SET vscode_ssh_host=?, vscode_path=?, git_repo=?, git_branch=?, ticket_url=? WHERE id=?')
      .run(vscode_ssh_host || null, vscode_path || null, git_repo || null, git_branch || null, ticket_url || null, taskId);
    // Auto-extract Jira ticket from URL (e.g. https://jira.example.com/browse/PROJ-123)
    if (ticket_url) {
      const match = ticket_url.match(/([A-Z][A-Z0-9]+-\d+)/);
      if (match) {
        db.prepare('UPDATE tasks SET ticket_ref=COALESCE(ticket_ref, ?) WHERE id=?').run(match[1], taskId);
      }
    }
    return true;
  });

  ipcMain.handle('tasks:openVscode', async (_, taskId) => {
    const task = db.prepare('SELECT vscode_ssh_host, vscode_path, git_branch FROM tasks WHERE id=?').get(taskId);
    if (!task || !task.vscode_path) return { ok: false, error: 'Kein Pfad hinterlegt' };
    const { exec: execCb } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(execCb);

    // Checkout branch if set (via SSH or locally). Alle User-Werte werden mit
    // sq() single-quote-escaped → keine Command-Injection über git_branch/Pfad.
    let branchMsg = '';
    if (task.git_branch) {
      try {
        const gitDir = task.vscode_path;
        if (task.vscode_ssh_host && !sshHostOk(task.vscode_ssh_host)) { branchMsg = 'Ungültiger SSH-Host'; throw new Error(branchMsg); }
        const remote = `cd ${sq(gitDir)} && git diff --quiet && git checkout ${sq(task.git_branch)} 2>&1 || echo DIRTY`;
        const cmd = task.vscode_ssh_host
          ? `ssh ${sq(task.vscode_ssh_host)} ${sq(remote)}`
          : remote;
        const { stdout } = await execAsync(cmd, { timeout: 10000 });
        if (stdout.includes('DIRTY')) branchMsg = 'Branch nicht gewechselt (dirty)';
        else branchMsg = `Branch: ${task.git_branch}`;
      } catch (e) {
        branchMsg = 'Branch-Checkout fehlgeschlagen: ' + e.message;
      }
    }

    // Open VSCode — execFile mit Args-Array, keine Shell-Interpolation.
    const uri = task.vscode_ssh_host
      ? `vscode://vscode-remote/ssh-remote+${task.vscode_ssh_host}${task.vscode_path}`
      : task.vscode_path;
    execFile('code', ['--new-window', '--folder-uri', uri], (err) => {
      if (err) execFile('open', [uri]);
    });
    return { ok: true, branchMsg };
  });

  ipcMain.handle('tasks:createWorkingDir', (_, taskId) => {
    const res = wd.createWorkingDir(taskId);
    // Hauptliste aktualisieren, damit der Working-Dir-Button sofort erscheint.
    if (res.ok && mainWin) mainWin.webContents.send('tasks:refresh');
    return res;
  });

  ipcMain.handle('tasks:openWorkingDir', (_, taskId) => wd.openWorkingDir(taskId));

  // Merge tasks: target absorbs source, null fields get filled from source
  ipcMain.handle('tasks:syncUnsynced', async (_, taskId) => {
    const results = await syncUnsyncedTimeslots(taskId);
    const synced = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok);
    return { ok: failed.length === 0, synced, failed: failed.length, errors: failed.map(f => f.error) };
  });

  ipcMain.handle('tasks:merge', (_, { targetId, sourceId }) => {
    const target = db.prepare('SELECT * FROM tasks WHERE id=?').get(targetId);
    const source = db.prepare('SELECT * FROM tasks WHERE id=?').get(sourceId);
    if (!target || !source) return { ok: false, error: 'Task nicht gefunden' };

    // Fill null fields on target from source
    const fields = ['ticket_ref', 'note', 'odoo_task_id', 'odoo_project_id', 'odoo_task_label',
                     'vscode_ssh_host', 'vscode_path', 'git_repo', 'git_branch', 'deadline', 'ticket_url', 'odoo_stage', 'sequence_name'];
    const updates = [];
    const values = [];
    for (const f of fields) {
      if (target[f] == null && source[f] != null) {
        updates.push(`${f}=?`);
        values.push(source[f]);
      }
    }
    if (updates.length > 0) {
      values.push(targetId);
      db.prepare(`UPDATE tasks SET ${updates.join(',')} WHERE id=?`).run(...values);
    }

    // Move timeslots from source to target
    db.prepare('UPDATE timeslots SET task_id=? WHERE task_id=?').run(targetId, sourceId);
    // Delete source
    db.prepare('DELETE FROM tasks WHERE id=?').run(sourceId);

    return { ok: true, merged: updates.length };
  });

  // Window
  ipcMain.handle('odoo:openTask', (_, odooTaskId) => {
    if (config.odoo.url && odooTaskId) {
      const url = `${config.odoo.url.replace(/\/$/, '')}/web#id=${odooTaskId}&model=project.task&view_type=form`;
      shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('odoo:openTimesheetDay', (_, date) => {
    if (!config.odoo.url || !date) return { ok: false };
    const base = config.odoo.url.replace(/\/$/, '');
    // Filter analytic.line list view by exact date — works on Odoo 15..18.
    const domain = encodeURIComponent(JSON.stringify([['date', '=', date]]));
    const url = `${base}/web#action=hr_timesheet.act_hr_timesheet_line&view_type=list&domain=${domain}`;
    shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('tasks:openTicket', (_, taskId) => {
    const task = db.prepare('SELECT ticket_url FROM tasks WHERE id=?').get(taskId);
    if (task && task.ticket_url) { shell.openExternal(task.ticket_url); return { ok: true }; }
    return { ok: false };
  });

  // Git commits
  ipcMain.handle('tasks:fetchCommits', async (_, taskId) => {
    const task = db.prepare('SELECT vscode_ssh_host, vscode_path, git_repo, git_branch, last_commit_sha FROM tasks WHERE id=?').get(taskId);
    if (!task || (!task.vscode_path && !task.git_repo)) return { ok: false, error: 'Kein Verzeichnis oder Repo hinterlegt' };

    const { promisify } = require('util');
    const execAsync = promisify(require('child_process').exec);

    const branch = task.git_branch || 'HEAD';
    const logFmt = '--pretty=format:%H||%h||%an||%ad||%s --date=short';

    function parseCommits(stdout) {
      const lines = stdout.trim().split('\n').filter(Boolean);
      return lines.map(l => {
        const [sha, short, author, date, ...msgParts] = l.split('||');
        return { sha, short, author, date, message: msgParts.join('||') };
      });
    }

    // Try gh CLI first if git_repo is set and no local path
    if (task.git_repo && !task.vscode_path) {
      try {
        // Extract owner/repo from git URL
        const repoMatch = task.git_repo.match(/(?:github\.com)[:/](.+?)(?:\.git)?$/);
        if (repoMatch) {
          const nwo = repoMatch[1];
          const limit = task.last_commit_sha ? 100 : 20;
          // execFile mit Args-Array → keine Shell, nwo/branch nicht injizierbar.
          const jq = '.[] | .sha + "||" + (.sha[:7]) + "||" + .commit.author.name + "||" + (.commit.author.date[:10]) + "||" + (.commit.message | split("\\n") | .[0])';
          const { stdout } = await promisify(execFile)('gh',
            ['api', `repos/${nwo}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`, '--jq', jq],
            { timeout: 15000 }
          );
          let commits = parseCommits(stdout);
          // If we have a last_commit_sha, only take commits newer than it
          if (task.last_commit_sha) {
            const idx = commits.findIndex(c => c.sha === task.last_commit_sha);
            if (idx >= 0) commits = commits.slice(0, idx);
          }
          if (commits.length > 0) {
            db.prepare('UPDATE tasks SET last_commit_sha=? WHERE id=?').run(commits[0].sha, taskId);
          }
          return { ok: true, commits, isNew: !task.last_commit_sha };
        }
      } catch (_) { /* gh not available or failed, try next method */ }
    }

    // Try local/SSH git log
    if (task.vscode_path) {
      try {
        const dir = task.vscode_path;
        if (task.vscode_ssh_host && !sshHostOk(task.vscode_ssh_host)) return { ok: false, error: 'Ungültiger SSH-Host' };
        // Revision-Range als ein gequotetes Arg; alle User-Werte via sq().
        const range = task.last_commit_sha ? `${sq(`${task.last_commit_sha}..${branch}`)}` : `${sq(branch)} -20`;
        const local = `cd ${sq(dir)} && git log ${range} ${logFmt}`;
        const cmd = task.vscode_ssh_host ? `ssh ${sq(task.vscode_ssh_host)} ${sq(local)}` : local;

        const { stdout } = await execAsync(cmd, { timeout: 15000 });
        const commits = parseCommits(stdout);
        if (commits.length > 0) {
          db.prepare('UPDATE tasks SET last_commit_sha=? WHERE id=?').run(commits[0].sha, taskId);
        }
        return { ok: true, commits, isNew: !task.last_commit_sha };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    // Fallback: clone/fetch via SSH with git_repo
    if (task.git_repo) {
      try {
        const range = task.last_commit_sha ? `${sq(`${task.last_commit_sha}..${branch}`)}` : `${sq(branch)} -20`;
        const repoId = `/tmp/daytask-repo-${Number(taskId)}`;
        const { stdout } = await execAsync(
          `git ls-remote ${sq(task.git_repo)} ${sq(branch)} && git -c core.sshCommand="ssh" log ${range} ${logFmt}`,
          { timeout: 15000 }
        ).catch(() => {
          // Use GIT_SSH_COMMAND with default private key
          return execAsync(
            `GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no" git clone --bare --single-branch --branch ${sq(branch)} ${sq(task.git_repo)} ${sq(repoId)} 2>/dev/null; cd ${sq(repoId)} && git log ${range} ${logFmt}`,
            { timeout: 30000 }
          );
        });
        const commits = parseCommits(stdout);
        if (commits.length > 0) {
          db.prepare('UPDATE tasks SET last_commit_sha=? WHERE id=?').run(commits[0].sha, taskId);
        }
        return { ok: true, commits, isNew: !task.last_commit_sha };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    return { ok: false, error: 'Keine Methode zum Abrufen der Commits verfügbar' };
  });

  // Window
  // Mitarbeiter
  ipcMain.handle('odoo:getEmployees', async () => {
    try {
      if (!config.odoo.url || !config.odoo.username) return [];
      const uid = await odooUID();
      if (!uid) return [];
      // Get all users who have tasks assigned
      const userIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'res.users', 'search', [[['share', '=', false]]],
        { limit: 100 }
      ]);
      if (!userIds || userIds.length === 0) return [];
      const users = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'res.users', 'read', [userIds],
        { fields: ['id', 'name'] }
      ]);
      return users.map(u => ({ id: u.id, name: u.name, isSelf: u.id === uid }));
    } catch (e) {
      console.error('[odoo:getEmployees]', e.message);
      return [];
    }
  });

  ipcMain.handle('odoo:getEmployeeTasks', async (_, userId) => {
    try {
      if (!config.odoo.url || !config.odoo.username) return { tasks: [], totalHours: 0 };
      const uid = await odooUID();
      if (!uid) return { tasks: [], totalHours: 0 };

      const taskIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.task', 'search', [[['user_ids', 'in', [userId]]]],
        { limit: 100 }
      ]);
      if (!taskIds || taskIds.length === 0) return { tasks: [], totalHours: 0 };

      let tasks;
      try {
        tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, uid, config.odoo.password,
          'project.task', 'read', [taskIds],
          { fields: ['id', 'name', 'project_id', 'stage_id', 'date_deadline', 'sequence_name', 'allocated_hours', 'effective_hours'] }
        ]);
      } catch (_) {
        tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, uid, config.odoo.password,
          'project.task', 'read', [taskIds],
          { fields: ['id', 'name', 'project_id', 'stage_id', 'date_deadline'] }
        ]);
      }

      const totalAllocated = tasks.reduce((s, t) => s + (t.allocated_hours || 0), 0);
      const totalEffective = tasks.reduce((s, t) => s + (t.effective_hours || 0), 0);

      return {
        tasks: tasks.map(t => ({
          id: t.id,
          name: t.name,
          project: t.project_id ? t.project_id[1] : '',
          stage: t.stage_id ? t.stage_id[1] : '',
          deadline: t.date_deadline || '',
          sequence_name: t.sequence_name || '',
          allocated: t.allocated_hours || 0,
          effective: t.effective_hours || 0,
        })),
        totalAllocated,
        totalEffective,
        taskCount: tasks.length,
      };
    } catch (e) {
      console.error('[odoo:getEmployeeTasks]', e.message);
      return { tasks: [], totalHours: 0 };
    }
  });

  // Attendance (Odoo Kiosk-Stempeln) — eigener Mitarbeiter
  async function odooSelfEmployeeId() {
    if (!config.odoo.url || !config.odoo.username) return null;
    const uid = await odooUID();
    if (!uid) return null;
    const empIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      config.odoo.db, uid, config.odoo.password,
      'hr.employee', 'search', [[['user_id', '=', uid]]],
      { limit: 1 }
    ]);
    if (!empIds || !empIds.length) return null;
    return { uid, empId: empIds[0] };
  }

  ipcMain.handle('odoo:attendanceStatus', async () => {
    try {
      const self = await odooSelfEmployeeId();
      if (!self) return { ok: false, state: null };
      const emp = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, self.uid, config.odoo.password,
        'hr.employee', 'read', [[self.empId]],
        { fields: ['attendance_state'] }
      ]);
      const state = emp && emp[0] && emp[0].attendance_state; // 'checked_in' | 'checked_out'
      return { ok: true, state };
    } catch (e) {
      console.error('[odoo:attendanceStatus]', e.message);
      return { ok: false, state: null, error: e.message };
    }
  });

  ipcMain.handle('odoo:attendanceToggle', async () => {
    try {
      const self = await odooSelfEmployeeId();
      if (!self) return { ok: false, state: null, error: 'Kein Mitarbeiter gefunden' };
      const emp = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, self.uid, config.odoo.password,
        'hr.employee', 'read', [[self.empId]],
        { fields: ['attendance_state', 'last_attendance_id'] }
      ]);
      const current = emp && emp[0] && emp[0].attendance_state;
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const nowUtc = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
      if (current === 'checked_in') {
        const lastId = emp[0].last_attendance_id && emp[0].last_attendance_id[0];
        if (!lastId) return { ok: false, state: current, error: 'Keine offene Anwesenheit gefunden' };
        await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, self.uid, config.odoo.password,
          'hr.attendance', 'write', [[lastId], { check_out: nowUtc }]
        ]);
      } else {
        await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, self.uid, config.odoo.password,
          'hr.attendance', 'create', [{ employee_id: self.empId, check_in: nowUtc }]
        ]);
      }
      const emp2 = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, self.uid, config.odoo.password,
        'hr.employee', 'read', [[self.empId]],
        { fields: ['attendance_state'] }
      ]);
      const state = emp2 && emp2[0] && emp2[0].attendance_state;
      return { ok: true, state };
    } catch (e) {
      console.error('[odoo:attendanceToggle]', e.message);
      return { ok: false, state: null, error: e.message };
    }
  });

  // Letzte N Tage Zeitsumme aus Odoo Timesheets (für aktuellen User)
  ipcMain.handle('odoo:lastDaysTimesheet', async (_, days) => {
    try {
      const n = Math.max(1, Math.min(31, parseInt(days, 10) || 10));
      const today = new Date();
      const result = [];
      for (let i = n - 1; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
        const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        result.push({ date: iso, hours: 0, buckets: [] });
      }
      if (!config.odoo.url || !config.odoo.username) return result;
      const uid = await odooUID();
      if (!uid) return result;
      const startDate = result[0].date;
      const lines = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'account.analytic.line', 'search_read',
        [[['user_id', '=', uid], ['date', '>=', startDate]]],
        { fields: ['date', 'unit_amount', 'project_id'], limit: 5000 }
      ]);
      const colors = config.project_colors || {};
      // Per-day bucket map: color → { color, label, hours }
      const dayBuckets = Object.fromEntries(result.map(r => [r.date, new Map()]));
      const map = Object.fromEntries(result.map(r => [r.date, r]));
      for (const l of (lines || [])) {
        const d = (l.date || '').slice(0, 10);
        if (!map[d]) continue;
        const h = l.unit_amount || 0;
        const pid = Array.isArray(l.project_id) ? l.project_id[0] : null;
        const cfg = pid != null ? colors[String(pid)] : null;
        if (cfg && cfg.color) {
          const bm = dayBuckets[d];
          const key = cfg.color;
          const cur = bm.get(key) || { color: cfg.color, label: cfg.label || '', hours: 0 };
          cur.hours += h;
          if (!cur.label && cfg.label) cur.label = cfg.label;
          bm.set(key, cur);
        } else {
          map[d].hours += h;
        }
      }
      for (const r of result) {
        r.buckets = Array.from(dayBuckets[r.date].values());
      }
      return result;
    } catch (e) {
      console.error('[odoo:lastDaysTimesheet]', e.message);
      return [];
    }
  });

  // ── Tagesansicht ──────────────────────────────────────────────────────────
  ipcMain.handle('dayview:get', async (_, date) => {
    try { return await dayView.getDayView(date); }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('dayview:upsertLine', async (_, data) => {
    try { return await dayView.upsertLine(data || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('dayview:deleteLine', async (_, id) => {
    try { return await dayView.deleteLine(id); }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('dayview:scan', async (e, payload) => {
    try {
      const sender = e.sender;
      const date = (payload && typeof payload === 'object') ? payload.date : payload;
      const extraPrompt = (payload && typeof payload === 'object') ? payload.extraPrompt : '';
      return await dayView.scanDay(date, {
        extraPrompt,
        onProgress: (msg) => { try { sender.send('dayview:scanProgress', { date, msg }); } catch {} },
      });
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('window:clickthrough', (_, ignore) => {
    if (process.platform === 'win32') mainWin.setIgnoreMouseEvents(ignore, { forward: true });
  });
  ipcMain.handle('window:hide', () => mainWin.hide());
  ipcMain.handle('window:focus', () => { mainWin.show(); mainWin.focus(); });
  ipcMain.handle('window:openSettings', () => createSettingsWindow());
  ipcMain.handle('window:openTask', (_, taskId) => createTaskWindow(taskId));

  // Odoo: post a chatter message on a project.task
  ipcMain.handle('odoo:postMessage', async (_, { taskId, body, internal }) => {
    try {
      if (!config.odoo.url || !config.odoo.username) return { ok: false, error: 'Odoo nicht konfiguriert' };
      const local = db.prepare('SELECT odoo_task_id FROM tasks WHERE id=?').get(taskId);
      if (!local || !local.odoo_task_id) return { ok: false, error: 'Kein verknüpfter Odoo-Task' };
      if (!body || !body.trim()) return { ok: false, error: 'Nachricht ist leer' };
      const uid = await odooUID();
      if (!uid) return { ok: false, error: 'Auth fehlgeschlagen' };
      const messageId = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.task', 'message_post', [[local.odoo_task_id]],
        {
          body: body,
          message_type: internal ? 'comment' : 'comment',
          subtype_xmlid: internal ? 'mail.mt_note' : 'mail.mt_comment',
        }
      ]);
      return { ok: true, messageId };
    } catch (e) {
      console.error('[odoo:postMessage]', e.message);
      return { ok: false, error: e.message };
    }
  });

  // Fetch chatter messages for a linked task
  ipcMain.handle('odoo:getMessages', async (_, taskId) => {
    try {
      if (!config.odoo.url || !config.odoo.username) return { ok: false, error: 'Odoo nicht konfiguriert' };
      const local = db.prepare('SELECT odoo_task_id FROM tasks WHERE id=?').get(taskId);
      if (!local || !local.odoo_task_id) return { ok: false, error: 'Kein verknüpfter Odoo-Task' };
      const uid = await odooUID();
      if (!uid) return { ok: false, error: 'Auth fehlgeschlagen' };
      const ids = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'mail.message', 'search',
        [[['model', '=', 'project.task'], ['res_id', '=', local.odoo_task_id]]],
        { limit: 50, order: 'date desc' }
      ]);
      if (!ids || !ids.length) return { ok: true, messages: [] };
      const msgs = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'mail.message', 'read', [ids],
        { fields: ['id', 'date', 'author_id', 'body', 'message_type', 'subtype_id'] }
      ]);
      return {
        ok: true,
        messages: msgs.map(m => ({
          id: m.id,
          date: m.date,
          author: m.author_id ? m.author_id[1] : 'System',
          body: m.body || '',
          type: m.message_type,
          subtype: m.subtype_id ? m.subtype_id[1] : '',
        })),
      };
    } catch (e) {
      console.error('[odoo:getMessages]', e.message);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('app:checkUpdate', async () => {
    const { execSync } = require('child_process');
    const appDir = path.join(__dirname, '..');
    const isGit = fs.existsSync(path.join(appDir, '.git'));
    const currentVersion = require(path.join(appDir, 'package.json')).version;

    if (isGit) {
      // Dev mode: git pull
      try {
        execSync('git fetch origin main', { cwd: appDir, timeout: 10000 });
        const behind = execSync('git rev-list HEAD..origin/main --count', { cwd: appDir }).toString().trim();
        return { isGit: true, currentVersion, behind: +behind };
      } catch (e) {
        return { isGit: true, currentVersion, behind: 0, error: e.message };
      }
    } else {
      // Packaged: check GitHub releases
      try {
        const https = require('https');
        const data = await new Promise((resolve, reject) => {
          https.get('https://api.github.com/repos/Odoo-Ninjas/daytask/releases/latest', { headers: { 'User-Agent': 'DayTask' } }, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve(JSON.parse(body)));
          }).on('error', reject);
        });
        if (!data.tag_name) {
          return { isGit: false, currentVersion, error: data.message || 'Keine Release-Info verfügbar' };
        }
        const latest = data.tag_name.replace(/^v/, '');
        return { isGit: false, currentVersion, latestVersion: latest, downloadUrl: data.html_url, isNewer: latest !== currentVersion };
      } catch (e) {
        return { isGit: false, currentVersion, error: e.message };
      }
    }
  });

  ipcMain.handle('app:doUpdate', async () => {
    const { execSync } = require('child_process');
    const appDir = path.join(__dirname, '..');
    try {
      execSync('git pull origin main', { cwd: appDir, timeout: 15000 });
      execSync('npm install', { cwd: appDir, timeout: 60000 });
      app.relaunch();
      app.exit(0);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
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
  buildTrayMenu();
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

// ── Single instance ──────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      mainWin.show();
      mainWin.focus();
    }
  });
}

// ── App bootstrap ─────────────────────────────────────────────────────────────
app.setName('DayTask');

function resumeActiveTimer() {
  try {
    const open = db.prepare(`
      SELECT id, task_id FROM timeslots
      WHERE stopped_at IS NULL
      ORDER BY id DESC
    `).all();
    if (!open.length) return;
    // Neuester offener Slot = aktiv für DIESEN Prozess.
    const [active] = open;
    activeTaskId = active.task_id;
    activeSlotId = active.id;
    console.log('[resume] Timer fortgesetzt für Task', activeTaskId, 'Slot', activeSlotId);
    // WICHTIG (Code-Review C2): NICHT pauschal alle übrigen offenen Slots als
    // Nullzeit schließen — ein offener Slot kann zu einem PARALLEL laufenden Timer
    // im Web-Server (server.js, gleiche DB) gehören; den würden wir sonst auf
    // Dauer 0 nullen und die gemessene Zeit ginge verloren. Nur eindeutig
    // verwaiste, ALTE offene Slots (Crash-Reste, >18 h offen) werden geschlossen.
    const STALE_HOURS = 18;
    const stale = db.prepare(`
      SELECT id FROM timeslots
      WHERE stopped_at IS NULL AND id<>?
        AND (julianday('now','localtime') - julianday(started_at)) * 24 > ?
    `).all(active.id, STALE_HOURS);
    if (stale.length) {
      const closeStmt = db.prepare('UPDATE timeslots SET stopped_at=started_at, synced=1 WHERE id=?');
      db.transaction(() => { for (const o of stale) closeStmt.run(o.id); })();
      console.log('[resume]', stale.length, 'verwaiste (>18h offene) Slots geschlossen');
    }
  } catch (e) {
    console.error('[resume] Fehler:', e.message);
  }
}

app.whenReady().then(() => {
  initDB();
  timeSync.recoverInFlight(); // hängengebliebene In-Flight-Slots (synced=2) zurücksetzen
  resumeActiveTimer();

  // Tray icon
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray-icon.png'));
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip('DayTask');
  tray.on('click', () => {
    // Toggle: if window is visible OR was just hidden by this click's blur,
    // treat the click as "close". Otherwise drop down under the tray icon.
    const justBlurred = Date.now() - (mainWin.__lastBlurAt || 0) < 250;
    if (mainWin.isVisible()) {
      mainWin.hide();
      return;
    }
    if (justBlurred) return; // blur already hid it; user intent = close
    const bounds = tray.getBounds();
    if (mainWin.__dropDown) mainWin.__dropDown(bounds);
    else { mainWin.show(); mainWin.focus(); }
  });
  tray.on('right-click', () => {
    if (trayContextMenu) tray.popUpContextMenu(trayContextMenu);
  });

  setupIPC();
  createMainWindow();
  buildTrayMenu();

  // Cmd+, opens settings
  // Cmd+, handled via window keydown in renderer (not global, to avoid stealing from other apps)

  // Cmd+Shift+T toggles main window — drops down under the tray icon when opening
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    if (mainWin.isVisible()) {
      mainWin.hide();
    } else if (mainWin.__dropDown && tray) {
      mainWin.__dropDown(tray.getBounds());
    } else {
      mainWin.show();
      mainWin.focus();
    }
  });

  // tick every second to update running timer in UI
  tickInterval = setInterval(() => {
    if (mainWin && mainWin.isVisible() && activeTaskId) {
      mainWin.webContents.send('tick', { activeTaskId, activeSlotId, now: Date.now() });
    }
  }, 1000);

  // Poll Odoo for assigned tasks every 5 minutes
  let odooUidCache = null;
  async function pollOdooAssignedTasks() {
    try {
      if (!config.odoo.url || !config.odoo.username) return { ok: false, error: 'Odoo nicht konfiguriert' };
      if (!odooUidCache) odooUidCache = await odooUID();
      if (!odooUidCache) { console.log('[odoo-poll] Kein uid, skip'); return { ok: false, error: 'Kein Odoo-Login' }; }

      console.log('[odoo-poll] Hole zugewiesene Tasks für uid:', odooUidCache);

      // Fetch tasks assigned to current user (only open/active tasks)
      let taskIds;
      try {
        taskIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, odooUidCache, config.odoo.password,
          'project.task', 'search', [
            [['user_ids', 'in', [odooUidCache]], ['is_closed', '=', false]]
          ], { limit: 100 }
        ]);
      } catch (_) {
        // Fallback for older Odoo without is_closed
        taskIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, odooUidCache, config.odoo.password,
          'project.task', 'search', [
            [['user_ids', 'in', [odooUidCache]]]
          ], { limit: 100 }
        ]);
      }
      console.log('[odoo-poll] Gefundene Task-IDs:', taskIds?.length || 0);
      if (!taskIds || taskIds.length === 0) return { ok: true, created: 0, updated: 0 };

      // Try reading with optional fields, fall back gracefully
      let readFields = ['id', 'name', 'project_id', 'date_deadline', 'stage_id', 'sequence_name', 'is_closed'];
      const optionalFields = ['no', 'branch_name', 'repo'];
      for (const f of optionalFields) {
        try {
          await odooCall('/xmlrpc/2/object', 'execute_kw', [
            config.odoo.db, odooUidCache, config.odoo.password,
            'project.task', 'fields_get', [], { attributes: ['string'], allfields: false }
          ]);
          // Just try with all and catch below
          break;
        } catch (_) { /* skip */ }
      }

      let tasks;
      try {
        tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, odooUidCache, config.odoo.password,
          'project.task', 'read', [taskIds],
          { fields: [...readFields, ...optionalFields] }
        ]);
      } catch (e) {
        // Retry without optional fields
        console.log('[odoo-poll] Retry ohne optionale Felder:', e.message.slice(0, 80));
        tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, odooUidCache, config.odoo.password,
          'project.task', 'read', [taskIds],
          { fields: readFields }
        ]);
      }

      // Cache them
      const insertCache = db.prepare('INSERT OR REPLACE INTO odoo_tasks_cache (id, project_id, project_name, task_name, task_no) VALUES (?,?,?,?,?)');
      const tx = db.transaction(() => {
        for (const t of tasks) {
          insertCache.run(t.id, t.project_id ? t.project_id[0] : null, t.project_id ? t.project_id[1] : '', t.name, t.no || '');
        }
      });
      tx();

      // Auto-detect stage mappings for any projects we haven't seen yet
      config.stage_mappings = config.stage_mappings || {};
      const seenProjectIds = new Set(
        tasks.map(t => t.project_id ? t.project_id[0] : null).filter(Boolean)
      );
      let mappingsAdded = 0;
      for (const pid of seenProjectIds) {
        if (config.stage_mappings[String(pid)]) continue; // already configured
        const detected = await detectMappingForProject(odooUidCache, pid);
        if (detected) {
          config.stage_mappings[String(pid)] = detected;
          mappingsAdded++;
          console.log('[odoo-poll] Auto-Mapping für Projekt', pid, detected.project_name, '→',
            `in_progress:${detected.in_progress_name || '-'} / waiting:${detected.waiting_name || '-'} / done:${detected.done_name || '-'}`);
        }
      }
      if (mappingsAdded > 0) {
        saveConfig();
      }

      // Keep ONE local row per Odoo task (non-collective): reuse the existing
      // open row instead of spawning a new one each day. Per-day billing no
      // longer depends on per-day rows — syncUnsyncedTimeslots groups a task's
      // timeslots by their own started_at day. Collective tasks (e.g.
      // Monatsbudget) keep one row PER DAY by design.
      const today = localNow().split(' ')[0];
      let created = 0;
      let updated = 0;
      for (const t of tasks) {
        const label = `${t.project_id ? t.project_id[1] : ''} / ${t.name}${t.no ? ' #' + t.no : ''}`;
        const stageName = t.stage_id ? t.stage_id[1] : '';
        const seqName = t.sequence_name || null;
        const collective = isCollectiveTask(t.name);
        // Trust the stage name even if Odoo reports is_closed=false — some
        // Odoo configs leave "Abgeschlossen" stages with is_closed=False
        // (only fold=True), which would otherwise hide them as "open".
        const isDone = collective ? 0 : ((t.is_closed || /abgeschlossen|done|cancel|erledigt/i.test(stageName)) ? 1 : 0);

        if (isDone) {
          // Odoo closed → mark all local open rows done (local done is sticky).
          const openRows = db.prepare('SELECT id FROM tasks WHERE odoo_task_id=? AND done=0').all(t.id);
          for (const r of openRows) markTaskDone(r.id);
          continue;
        }

        if (collective) {
          // one row per day for collective tasks (unchanged behaviour)
          const existsToday = db.prepare('SELECT 1 FROM tasks WHERE odoo_task_id=? AND date=?').get(t.id, today);
          if (existsToday) {
            db.prepare('UPDATE tasks SET odoo_task_label=?, odoo_stage=?, sequence_name=?, deadline=? WHERE odoo_task_id=? AND date=?')
              .run(label, stageName || null, seqName, t.date_deadline || null, t.id, today);
            updated++;
          } else {
            db.prepare('INSERT INTO tasks (title, date, odoo_task_id, odoo_project_id, odoo_task_label, git_branch, git_repo, deadline, odoo_stage, sequence_name, done) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
              .run(t.name, today, t.id, t.project_id ? t.project_id[0] : null, label, t.branch_name || null, t.repo || null, t.date_deadline || null, stageName || null, seqName, 0);
            created++;
          }
          continue;
        }

        // Non-collective: reuse the most recent open (not done, not archived)
        // row regardless of date and pull it to today so it stays visible;
        // never spawn per-day duplicates.
        const open = db.prepare('SELECT id FROM tasks WHERE odoo_task_id=? AND done=0 AND COALESCE(archived,0)=0 ORDER BY date DESC, id DESC LIMIT 1').get(t.id);
        if (open) {
          db.prepare('UPDATE tasks SET odoo_task_label=?, odoo_stage=?, sequence_name=?, deadline=?, date=? WHERE id=?')
            .run(label, stageName || null, seqName, t.date_deadline || null, today, open.id);
          updated++;
          continue;
        }
        // No open row exists: respect a prior explicit "done" so the poll never
        // re-opens a task the user has dismissed.
        const wasDoneBefore = db.prepare('SELECT 1 FROM tasks WHERE odoo_task_id=? AND done=1 LIMIT 1').get(t.id);
        if (wasDoneBefore) continue;
        db.prepare('INSERT INTO tasks (title, date, odoo_task_id, odoo_project_id, odoo_task_label, git_branch, git_repo, deadline, odoo_stage, sequence_name, done) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(t.name, today, t.id, t.project_id ? t.project_id[0] : null, label, t.branch_name || null, t.repo || null, t.date_deadline || null, stageName || null, seqName, 0);
        created++;
      }
      console.log('[odoo-poll] Erstellt:', created, '/ Aktualisiert:', updated, '/ Übersprungen:', tasks.length - created - updated);

      // Rollover: lokale offene Tasks deren Odoo-Task in Odoo tatsächlich
      // abgeschlossen ist (is_closed=true ODER Stage-Name matched) → date=today,
      // damit nicht aktive Themen im Archiv stranden.
      if (taskIds && taskIds.length > 0) {
        try {
          const candidates = db.prepare(`
            SELECT DISTINCT odoo_task_id FROM tasks
            WHERE done=0 AND date < ? AND odoo_task_id IS NOT NULL
          `).all(today).map(r => r.odoo_task_id);
          const orphans = candidates.filter(id => !taskIds.includes(id));
          if (orphans.length > 0) {
            const verifyTasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [
              config.odoo.db, odooUidCache, config.odoo.password,
              'project.task', 'read', [orphans],
              { fields: ['id', 'is_closed', 'stage_id'] }
            ]).catch(() => []);
            const closedIds = (verifyTasks || []).filter(t => {
              const stageName = t.stage_id ? t.stage_id[1] : '';
              return t.is_closed || /abgeschlossen|done|cancel|erledigt/i.test(stageName);
            }).map(t => t.id);
            if (closedIds.length > 0) {
              const ph = closedIds.map(() => '?').join(',');
              const r = db.prepare(`
                UPDATE tasks SET date=?
                WHERE done=0 AND date < ? AND odoo_task_id IN (${ph})
              `).run(today, today, ...closedIds);
              if (r.changes > 0) console.log('[odoo-poll] Rollover (Odoo closed, local open):', r.changes, 'Odoo-IDs:', closedIds.length);
            }
          }
        } catch (e) {
          console.error('[odoo-poll] Rollover failed:', e.message);
        }
      }

      // Also update locally linked tasks that may not be assigned to us
      const linkedTasks = db.prepare('SELECT DISTINCT odoo_task_id FROM tasks WHERE odoo_task_id IS NOT NULL AND date=?').all(today);
      const linkedIds = linkedTasks.map(t => t.odoo_task_id).filter(id => !taskIds.includes(id));
      if (linkedIds.length > 0) {
        try {
          const linkedData = await odooCall('/xmlrpc/2/object', 'execute_kw', [
            config.odoo.db, odooUidCache, config.odoo.password,
            'project.task', 'read', [linkedIds],
            { fields: ['id', 'name', 'project_id', 'date_deadline', 'stage_id', 'sequence_name', 'is_closed'] }
          ]);
          for (const t of linkedData) {
            const label = `${t.project_id ? t.project_id[1] : ''} / ${t.name}`;
            const stageName = t.stage_id ? t.stage_id[1] : '';
            const seqName = t.sequence_name || null;
            if (isCollectiveTask(t.name)) {
              db.prepare('UPDATE tasks SET odoo_task_label=?, odoo_stage=?, sequence_name=?, deadline=? WHERE odoo_task_id=? AND date=?')
                .run(label, stageName || null, seqName, t.date_deadline || null, t.id, today);
            } else {
              const isDone = (t.is_closed || /abgeschlossen|done|cancel|erledigt/i.test(stageName)) ? 1 : 0;
              // Sticky local done: only allow 0 → 1 via poll, never 1 → 0
              db.prepare('UPDATE tasks SET odoo_task_label=?, odoo_stage=?, sequence_name=?, deadline=? WHERE odoo_task_id=? AND date=?')
                .run(label, stageName || null, seqName, t.date_deadline || null, t.id, today);
              if (isDone) {
                const localRows = db.prepare('SELECT id FROM tasks WHERE odoo_task_id=? AND date=?').all(t.id, today);
                for (const lr of localRows) markTaskDone(lr.id);
              }
            }
          }
          console.log('[odoo-poll] Linked tasks aktualisiert:', linkedIds.length);
        } catch (e) {
          console.error('[odoo-poll] Linked tasks update failed:', e.message);
        }
      }

      // Cleanup DEAKTIVIERT (Wunsch Marc, 2026-06-24): Tasks, die einmal in DayTask
      // sind, werden NICHT mehr automatisch entfernt — auch dann nicht, wenn der
      // verknüpfte Odoo-Task nicht (mehr) dem aktuellen User zugewiesen ist oder
      // (noch) keine Zeitbuchung hat. Früher löschte dieser Block solche "orphans"
      // beim 5-Min-Poll, was frisch angelegte Budget-/Sammel-Tasks (z.B. an
      // "Monatsbudget …" gehängt) wieder verschwinden ließ. Falls das Auto-Cleanup
      // je wieder gewünscht ist, hier reaktivieren (git-Historie).

      // Notify UI to refresh
      if (mainWin) mainWin.webContents.send('tasks:refresh');
      return { ok: true, created, updated: tasks.length - created };
    } catch (e) {
      console.error('[odoo-poll] Fehler:', e.message);
      return { ok: false, error: e.message };
    }
  }

  ipcMain.handle('odoo:pollNow', () => pollOdooAssignedTasks());

  // Initial poll after 5s, then every 5 minutes
  setTimeout(pollOdooAssignedTasks, 5000);
  setInterval(pollOdooAssignedTasks, 5 * 60 * 1000);
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep alive as tray app
app.dock?.hide();
