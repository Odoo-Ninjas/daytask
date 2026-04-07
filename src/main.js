const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, globalShortcut, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

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
  }
};
if (fs.existsSync(CONFIG_PATH)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch {}
}
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── Database ──────────────────────────────────────────────────────────────────
const DB_PATH = path.join(os.homedir(), '.daytask.db');
let db;
function initDB() {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
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
}

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
  return odooCall('/xmlrpc/2/common', 'authenticate', [
    config.odoo.db, config.odoo.username, config.odoo.password, {}
  ]);
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

    // Search project.task with domain filter (no stage filter - show all)
    const domain = query
      ? ['|', ['name', 'ilike', query], ['project_id.name', 'ilike', query]]
      : [];

    console.log('[odoo-search] Query:', query, 'Domain:', JSON.stringify(domain));
    let taskIds;
    try {
      taskIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.task', 'search', [domain],
        { limit: 50 }
      ]);
    } catch (searchErr) {
      console.log('[odoo-search] Search error:', searchErr.message);
      // Retry without stage filter
      const simpleDomain = query ? [['name', 'ilike', query]] : [];
      taskIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.task', 'search', [simpleDomain],
        { limit: 50 }
      ]);
    }
    console.log('[odoo-search] Gefunden:', taskIds?.length || 0);

    if (!taskIds || taskIds.length === 0) return { ok: true, tasks: [] };

    let tasks;
    const baseFields = ['id', 'name', 'project_id', 'date_deadline', 'stage_id', 'sequence_name'];
    try {
      tasks = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.task', 'read', [taskIds],
        { fields: [...baseFields, 'no', 'branch_name', 'repo'] }
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
      no: t.no || '',
      branch_name: t.branch_name || '',
      repo: t.repo || '',
      date_deadline: t.date_deadline || '',
    }));

    // Update cache
    const insertCache = db.prepare('INSERT OR REPLACE INTO odoo_tasks_cache (id, project_id, project_name, task_name, task_no) VALUES (?,?,?,?,?)');
    const tx = db.transaction(() => {
      for (const t of result) insertCache.run(t.id, t.project_id, t.project_name, t.name, t.no);
    });
    tx();

    return { ok: true, tasks: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pushTimeslotToOdoo(slotId) {
  try {
    const slot = db.prepare('SELECT ts.*, t.title, t.ticket_ref, t.note, t.odoo_task_id, t.odoo_project_id FROM timeslots ts JOIN tasks t ON t.id=ts.task_id WHERE ts.id=?').get(slotId);
    if (!slot || !slot.stopped_at) return { ok: false, error: 'slot not complete' };

    // Only sync if an Odoo task is linked
    if (!slot.odoo_task_id) return { ok: false, error: 'no_odoo_task', pending: true };

    if (!config.odoo.url || !config.odoo.username) return { ok: false, error: 'Odoo not configured' };

    const start = new Date(slot.started_at);
    const stop = new Date(slot.stopped_at);
    const hours = (stop - start) / 3600000;
    if (hours < 0.01) return { ok: false, error: 'too short' };

    const uid = await odooUID();
    if (!uid) return { ok: false, error: 'Odoo auth failed' };

    // Build description: local note + Odoo task description as fallback
    let desc = slot.ticket_ref ? `[${slot.ticket_ref}] ${slot.title}` : slot.title;
    if (slot.note) {
      desc += '\n' + slot.note;
    } else {
      // Fetch internal description from Odoo task
      try {
        const odooTask = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, uid, config.odoo.password,
          'project.task', 'read', [[slot.odoo_task_id]],
          { fields: ['description'] }
        ]);
        if (odooTask && odooTask[0] && odooTask[0].description) {
          // Strip HTML tags
          const plain = odooTask[0].description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (plain) desc += '\n' + plain;
        }
      } catch (_) { /* ignore */ }
    }
    const vals = {
      name: desc,
      date: slot.started_at.split('T')[0].split(' ')[0],
      unit_amount: Math.round(hours * 100) / 100,
      project_id: slot.odoo_project_id,
      task_id: slot.odoo_task_id,
    };

    const lineId = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      config.odoo.db, uid, config.odoo.password,
      'account.analytic.line', 'create', [vals]
    ]);
    db.prepare('UPDATE timeslots SET synced=1 WHERE id=?').run(slotId);
    return { ok: true, lineId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function syncUnsyncedTimeslots(taskId) {
  const slots = db.prepare('SELECT id FROM timeslots WHERE task_id=? AND synced=0 AND stopped_at IS NOT NULL').all(taskId);
  const results = [];
  for (const slot of slots) {
    const r = await pushTimeslotToOdoo(slot.id);
    results.push(r);
  }
  return results;
}

// ── Windows ───────────────────────────────────────────────────────────────────
let mainWin = null;
let settingsWin = null;
let tray = null;
let activeTaskId = null;
let activeSlotId = null;
let tickInterval = null;

const MAIN_WIN_FULL = { width: 380, height: 560 };
const MAIN_WIN_MINI = { width: 380, height: 46 };

function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWin = new BrowserWindow({
    width: MAIN_WIN_FULL.width,
    height: MAIN_WIN_FULL.height,
    x: width - 400,
    y: 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    }
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWin.setAlwaysOnTop(true, 'floating', 1);
  mainWin.on('blur', () => {
    mainWin.setSize(MAIN_WIN_MINI.width, MAIN_WIN_MINI.height);
    if (process.platform === 'win32') mainWin.setIgnoreMouseEvents(true, { forward: true });
    mainWin.webContents.send('window:mini', true);
  });
  mainWin.on('focus', () => {
    if (process.platform === 'win32') mainWin.setIgnoreMouseEvents(false);
    mainWin.setSize(MAIN_WIN_FULL.width, MAIN_WIN_FULL.height);
    mainWin.webContents.send('window:mini', false);
  });
}

function createSettingsWindow() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 420,
    title: 'DayTask – Einstellungen',
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    }
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

function buildTrayMenu() {
  const activeTask = activeTaskId ? db.prepare('SELECT id, title, sequence_name FROM tasks WHERE id=?').get(activeTaskId) : null;
  const taskRef = activeTask ? (activeTask.sequence_name || '') : '';
  const label = activeTask ? `⏱ ${taskRef ? taskRef + ' ' : ''}${activeTask.title}` : 'DayTask';
  tray.setTitle(label);
  const menu = Menu.buildFromTemplate([
    { label: activeTask ? `Läuft: ${taskRef ? taskRef + ' ' : ''}${activeTask.title}` : 'Kein aktiver Task', enabled: false },
    { type: 'separator' },
    { label: 'Fenster anzeigen', click: () => { mainWin.show(); mainWin.focus(); } },
    { label: 'Einstellungen', click: createSettingsWindow },
    { type: 'separator' },
    { label: 'Beenden', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
function setupIPC() {
  // Tasks
  ipcMain.handle('tasks:today', () => {
    const today = localNow().split(' ')[0];
    console.log('[tasks:today] Abfrage für:', today);
    const tasks = db.prepare(`
      SELECT t.*, t.odoo_task_id, t.odoo_project_id, t.odoo_task_label,
        COALESCE((SELECT SUM((julianday(COALESCE(stopped_at, datetime('now','localtime'))) - julianday(started_at)) * 86400)
          FROM timeslots WHERE task_id=t.id), 0) AS total_seconds,
        (SELECT started_at FROM timeslots WHERE task_id=t.id AND stopped_at IS NULL LIMIT 1) AS running_since,
        (SELECT COUNT(*) FROM timeslots WHERE task_id=t.id AND synced=0 AND stopped_at IS NOT NULL) AS unsynced_count
      FROM tasks t WHERE t.date=? ORDER BY t.done ASC,
        COALESCE((SELECT MAX(started_at) FROM timeslots WHERE task_id=t.id), t.created_at) DESC,
        t.id DESC
    `).all(today);
    console.log('[tasks:today] Gefunden:', tasks.length);
    return { tasks, activeTaskId, activeSlotId };
  });

  ipcMain.handle('tasks:add', async (_, { title, ticket_ref, note, odoo_project_id, odoo_project_name, odoo_task_id, odoo_task_name, odoo_task_sequence }) => {
    const today = localNow().split(' ')[0];
    let odooTaskId = odoo_task_id || null;
    let odooTaskLabel = null;
    let seqName = odoo_task_sequence || null;

    if (odoo_task_id) {
      // Existing Odoo task selected - just link it
      odooTaskLabel = `${odoo_project_name || ''} / ${odoo_task_name || title}`;
    } else if (odoo_project_id && config.odoo.url && config.odoo.username) {
      // Create new task in Odoo
      try {
        const uid = await odooUID();
        if (uid) {
          const vals = { name: title, project_id: odoo_project_id };
          odooTaskId = await odooCall('/xmlrpc/2/object', 'execute_kw', [
            config.odoo.db, uid, config.odoo.password,
            'project.task', 'create', [vals]
          ]);
          odooTaskLabel = `${odoo_project_name || ''} / ${title}`;
        }
      } catch (e) {
        console.error('[tasks:add] Odoo task create failed:', e.message);
      }
    }

    const info = db.prepare('INSERT INTO tasks (title, ticket_ref, note, date, odoo_task_id, odoo_project_id, odoo_task_label, sequence_name) VALUES (?,?,?,?,?,?,?,?)')
      .run(title, ticket_ref || null, note || null, today, odooTaskId, odoo_project_id || null, odooTaskLabel, seqName);
    return { id: info.lastInsertRowid, odooTaskId };
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
      const ids = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.project', 'search', [[['name', 'ilike', query]]],
        { limit: 15 }
      ]);
      if (!ids || ids.length === 0) return [];
      const projects = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.project', 'read', [ids],
        { fields: ['id', 'name'] }
      ]);
      return projects.map(p => ({ id: p.id, name: p.name }));
    } catch (e) {
      console.error('[odoo:searchProjects]', e.message);
      return [];
    }
  });

  ipcMain.handle('odoo:searchTasksInProject', async (_, { projectId, query }) => {
    try {
      if (!config.odoo.url || !config.odoo.username) return [];
      const uid = await odooUID();
      if (!uid) return [];
      const domain = [['project_id', '=', projectId]];
      if (query) domain.push(['name', 'ilike', query]);
      const ids = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'project.task', 'search', [domain],
        { limit: 20 }
      ]);
      if (!ids || ids.length === 0) return [];
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

  ipcMain.handle('tasks:done', (_, id) => {
    // stop if running
    if (activeTaskId === id) stopTimer();
    db.prepare('UPDATE tasks SET done=1 WHERE id=?').run(id);
    return true;
  });

  ipcMain.handle('tasks:delete', (_, id) => {
    if (activeTaskId === id) stopTimer();
    db.prepare('DELETE FROM timeslots WHERE task_id=?').run(id);
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);
    return true;
  });

  ipcMain.handle('tasks:undone', (_, id) => {
    db.prepare('UPDATE tasks SET done=0 WHERE id=?').run(id);
    return true;
  });

  ipcMain.handle('tasks:update', (_, { id, title, ticket_ref, note, private_notes }) => {
    db.prepare('UPDATE tasks SET title=?, ticket_ref=?, note=?, private_notes=? WHERE id=?').run(title, ticket_ref || null, note || null, private_notes || null, id);
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
    return db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
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
    config = { ...config, ...newConfig };
    saveConfig();
    return true;
  });

  // Odoo
  ipcMain.handle('odoo:test', () => odooTestConnection());
  ipcMain.handle('odoo:searchTasks', (_, query) => odooSearchTasks(query));
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
    return { ok: true, synced, failed };
  });
  ipcMain.handle('tasks:unlinkOdoo', (_, taskId) => {
    db.prepare('UPDATE tasks SET odoo_task_id=NULL, odoo_project_id=NULL, odoo_task_label=NULL WHERE id=?').run(taskId);
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

    // Checkout branch if set (via SSH or locally)
    let branchMsg = '';
    if (task.git_branch) {
      try {
        const gitDir = task.vscode_path;
        const cmd = task.vscode_ssh_host
          ? `ssh ${task.vscode_ssh_host} "cd '${gitDir}' && git diff --quiet && git checkout '${task.git_branch}' 2>&1 || echo DIRTY"`
          : `cd '${gitDir}' && git diff --quiet && git checkout '${task.git_branch}' 2>&1 || echo DIRTY`;
        const { stdout } = await execAsync(cmd, { timeout: 10000 });
        if (stdout.includes('DIRTY')) branchMsg = 'Branch nicht gewechselt (dirty)';
        else branchMsg = `Branch: ${task.git_branch}`;
      } catch (e) {
        branchMsg = 'Branch-Checkout fehlgeschlagen: ' + e.message;
      }
    }

    // Open VSCode
    let uri;
    if (task.vscode_ssh_host) {
      uri = `vscode://vscode-remote/ssh-remote+${task.vscode_ssh_host}${task.vscode_path}`;
    } else {
      uri = task.vscode_path;
    }
    execCb(`code --folder-uri "${uri}"`, (err) => {
      if (err) execCb(`open "${uri}"`);
    });
    return { ok: true, branchMsg };
  });

  // Merge tasks: target absorbs source, null fields get filled from source
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
          const sha = task.last_commit_sha ? `--sha=${branch}` : `--sha=${branch}`;
          const { stdout } = await execAsync(
            `gh api repos/${nwo}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit} --jq '.[] | .sha + "||" + (.sha[:7]) + "||" + .commit.author.name + "||" + (.commit.author.date[:10]) + "||" + (.commit.message | split("\\n") | .[0])'`,
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
        const since = task.last_commit_sha ? `${task.last_commit_sha}..${branch}` : `${branch} -20`;
        const cmd = task.vscode_ssh_host
          ? `ssh ${task.vscode_ssh_host} "cd '${dir}' && git log ${since} ${logFmt}"`
          : `cd '${dir}' && git log ${since} ${logFmt}`;

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
        const since = task.last_commit_sha ? `${task.last_commit_sha}..${branch}` : `${branch} -20`;
        const { stdout } = await execAsync(
          `git ls-remote ${task.git_repo} ${branch} && git -c core.sshCommand="ssh" log ${since} ${logFmt}`,
          { timeout: 15000 }
        ).catch(() => {
          // Use GIT_SSH_COMMAND with default private key
          return execAsync(
            `GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no" git clone --bare --single-branch --branch ${branch} ${task.git_repo} /tmp/daytask-repo-${taskId} 2>/dev/null; cd /tmp/daytask-repo-${taskId} && git log ${since} ${logFmt}`,
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
  ipcMain.handle('window:clickthrough', (_, ignore) => {
    if (process.platform === 'win32') mainWin.setIgnoreMouseEvents(ignore, { forward: true });
  });
  ipcMain.handle('window:hide', () => mainWin.hide());
  ipcMain.handle('window:openSettings', () => createSettingsWindow());
}

async function stopTimer({ sync = true } = {}) {
  if (!activeSlotId) return { ok: false };
  const now = localNow();
  db.prepare('UPDATE timeslots SET stopped_at=? WHERE id=?').run(now, activeSlotId);
  const slotId = activeSlotId;
  activeTaskId = null;
  activeSlotId = null;
  buildTrayMenu();
  let syncResult = null;
  if (sync) {
    syncResult = await pushTimeslotToOdoo(slotId);
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

app.whenReady().then(() => {
  initDB();

  // Tray icon
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray-icon.png'));
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip('DayTask');
  tray.on('click', () => {
    if (mainWin.isVisible()) mainWin.hide();
    else { mainWin.show(); mainWin.focus(); }
  });

  setupIPC();
  createMainWindow();
  buildTrayMenu();

  // Cmd+, opens settings
  globalShortcut.register('CommandOrControl+,', () => {
    createSettingsWindow();
  });

  // Cmd+Shift+T toggles focus on main window
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    if (mainWin.isFocused()) {
      mainWin.blur();
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
      if (!config.odoo.url || !config.odoo.username) return;
      if (!odooUidCache) odooUidCache = await odooUID();
      if (!odooUidCache) { console.log('[odoo-poll] Kein uid, skip'); return; }

      console.log('[odoo-poll] Hole zugewiesene Tasks für uid:', odooUidCache);

      // Fetch tasks assigned to current user, not in folded stage (= not done/cancelled)
      const domain = [['user_ids', 'in', [odooUidCache]], ['stage_id.fold', '=', false]];
      const taskIds = await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, odooUidCache, config.odoo.password,
        'project.task', 'search', [domain], { limit: 100 }
      ]);
      console.log('[odoo-poll] Gefundene Task-IDs:', taskIds?.length || 0);
      if (!taskIds || taskIds.length === 0) return;

      // Try reading with optional fields, fall back gracefully
      let readFields = ['id', 'name', 'project_id', 'date_deadline', 'stage_id', 'sequence_name'];
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

      // Auto-create tasks for today if they don't exist yet
      const today = localNow().split(' ')[0];
      let created = 0;
      for (const t of tasks) {
        const exists = db.prepare('SELECT 1 FROM tasks WHERE odoo_task_id=? AND date=?').get(t.id, today);
        if (!exists) {
          const label = `${t.project_id ? t.project_id[1] : ''} / ${t.name}${t.no ? ' #' + t.no : ''}`;
          const stageName = t.stage_id ? t.stage_id[1] : '';
          const seqName = t.sequence_name || null;
          db.prepare('INSERT INTO tasks (title, date, odoo_task_id, odoo_project_id, odoo_task_label, git_branch, git_repo, deadline, odoo_stage, sequence_name) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(t.name, today, t.id, t.project_id ? t.project_id[0] : null, label, t.branch_name || null, t.repo || null, t.date_deadline || null, stageName || null, seqName);
          created++;
        } else {
          // Update stage + sequence_name on existing task
          const stageName = t.stage_id ? t.stage_id[1] : '';
          const seqName = t.sequence_name || null;
          db.prepare('UPDATE tasks SET odoo_stage=?, sequence_name=? WHERE odoo_task_id=? AND date=?').run(stageName || null, seqName, t.id, today);
        }
      }
      console.log('[odoo-poll] Erstellt:', created, '/ Aktualisiert:', tasks.length - created);

      // Notify UI to refresh
      if (mainWin) mainWin.webContents.send('tasks:refresh');
    } catch (e) {
      console.error('[odoo-poll] Fehler:', e.message);
    }
  }

  // Initial poll after 5s, then every 5 minutes
  setTimeout(pollOdooAssignedTasks, 5000);
  setInterval(pollOdooAssignedTasks, 5 * 60 * 1000);
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep alive as tray app
app.dock?.hide();
