// Tagesansicht ("Day View") — geteilte Logik für main.js (Electron-IPC) und
// server.js (Web-API).
//
// Drei Aufgaben:
//   1. getDayView(date)      — account.analytic.line des Users für genau EINEN Tag
//                              aus Odoo lesen, gruppiert nach Projekt (inkl. der
//                              Beschreibungs-Texte `name` pro Zeile).
//   2. upsertLine / deleteLine — Inline-Bearbeiten der Zeiten: direkt write/create/
//                              unlink auf account.analytic.line (kein Zwischenpuffer).
//   3. scanDay(date)         — pro am Tag aktivem Work-Ordner (ermittelt aus den
//                              Claude-Session-Logs unter ~/.claude/projects) ein
//                              headless `claude -p` starten. Claude liest die Logs +
//                              git-History und liefert {hours, description}. Das
//                              Ergebnis wird (gemappt auf den verknüpften Odoo-Task)
//                              direkt als account.analytic.line nach Odoo geladen.
//                              Jeder Lauf schreibt einen Trace nach ~/.daytask/traces.
//
// Reine (db, config, odooCall, odooUID)-Logik ohne Express-/Electron-Bezug.

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const roundUp15 = (h) => Math.ceil(h * 4) / 4; // auf nächste 15 min aufrunden
const IDLE_GAP_S = 900; // Lücken > 15 min zählen nicht als aktive Zeit

// Lokales (nicht UTC-) ISO-Datum YYYY-MM-DD eines Date-Objekts.
function localDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function makeDayView({ getDb, config, odooCall, odooUID }) {
  const db = () => (typeof getDb === 'function' ? getDb() : getDb);
  const odooReady = () => !!(config.odoo && config.odoo.url && config.odoo.username);
  const scanDir = () => config.scan_dir || config.work_dir || path.join(os.homedir(), 'ai', 'work');
  const claudeBin = () => config.claude_bin || 'claude';
  const claudeArgs = () => (Array.isArray(config.claude_scan_args) ? config.claude_scan_args : ['--dangerously-skip-permissions']);

  // ── 1. Lesen ──────────────────────────────────────────────────────────────
  async function getDayView(date) {
    const empty = { ok: true, date, totalHours: 0, projects: [] };
    if (!odooReady()) return { ...empty, ok: false, error: 'Odoo nicht konfiguriert' };
    const uid = await odooUID();
    if (!uid) return { ...empty, ok: false, error: 'Auth fehlgeschlagen' };
    const lines = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      config.odoo.db, uid, config.odoo.password,
      'account.analytic.line', 'search_read',
      [[['user_id', '=', uid], ['date', '=', date]]],
      { fields: ['id', 'date', 'unit_amount', 'name', 'project_id', 'task_id'], limit: 1000 },
    ]);
    const byProject = new Map();
    let total = 0;
    for (const l of (lines || [])) {
      const pid = Array.isArray(l.project_id) ? l.project_id[0] : 0;
      const pname = Array.isArray(l.project_id) ? l.project_id[1] : '(ohne Projekt)';
      let g = byProject.get(pid);
      if (!g) { g = { project_id: pid || null, project_name: pname, hours: 0, lines: [] }; byProject.set(pid, g); }
      const h = l.unit_amount || 0;
      g.hours += h; total += h;
      g.lines.push({
        id: l.id,
        task_id: Array.isArray(l.task_id) ? l.task_id[0] : null,
        task_name: Array.isArray(l.task_id) ? l.task_id[1] : '',
        name: l.name || '',
        unit_amount: h,
      });
    }
    const projects = [...byProject.values()].sort((a, b) => b.hours - a.hours);
    for (const p of projects) p.lines.sort((a, b) => b.unit_amount - a.unit_amount);
    return { ok: true, date, totalHours: Math.round(total * 100) / 100, projects };
  }

  // ── 2. Inline-Bearbeiten ────────────────────────────────────────────────────
  // id gesetzt  → write (vorhandene Zeile ändern)
  // id leer     → create (neue Zeile; project_id + date Pflicht)
  async function upsertLine({ id, unit_amount, name, project_id, task_id, date }) {
    if (!odooReady()) return { ok: false, error: 'Odoo nicht konfiguriert' };
    const uid = await odooUID();
    if (!uid) return { ok: false, error: 'Auth fehlgeschlagen' };
    const hours = Number(unit_amount);
    if (id) {
      const vals = {};
      if (unit_amount !== undefined && unit_amount !== null && !Number.isNaN(hours)) vals.unit_amount = hours;
      if (name !== undefined) vals.name = String(name || '');
      if (!Object.keys(vals).length) return { ok: false, error: 'Nichts zu ändern' };
      await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'account.analytic.line', 'write', [[parseInt(id, 10)], vals],
      ]);
      return { ok: true, id: parseInt(id, 10) };
    }
    if (!project_id) return { ok: false, error: 'project_id fehlt' };
    if (!date) return { ok: false, error: 'date fehlt' };
    const vals = {
      name: String(name || '/'),
      date,
      unit_amount: Number.isNaN(hours) ? 0 : hours,
      project_id: parseInt(project_id, 10),
    };
    if (task_id) vals.task_id = parseInt(task_id, 10);
    const newId = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      config.odoo.db, uid, config.odoo.password,
      'account.analytic.line', 'create', [vals],
    ]);
    return { ok: true, id: newId };
  }

  async function deleteLine(id) {
    if (!odooReady()) return { ok: false, error: 'Odoo nicht konfiguriert' };
    const uid = await odooUID();
    if (!uid) return { ok: false, error: 'Auth fehlgeschlagen' };
    await odooCall('/xmlrpc/2/object', 'execute_kw', [
      config.odoo.db, uid, config.odoo.password,
      'account.analytic.line', 'unlink', [[parseInt(id, 10)]],
    ]);
    return { ok: true };
  }

  // ── 3. Scan via Claude ──────────────────────────────────────────────────────

  // Alle Claude-Session-Logs (~/.claude/projects/*/*.jsonl) nach Einträgen des
  // gewünschten Tages durchsuchen und je cwd die grob aktive Zeit (Summe der
  // Lücken < 15 min) bestimmen. Liefert eine Map cwd → aktive Sekunden.
  function activeCwdsForDate(date) {
    const root = path.join(os.homedir(), '.claude', 'projects');
    const perCwd = new Map(); // cwd → number[] (epoch-ms der Events am Tag)
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { return new Map(); }
    const dayStart = new Date(date + 'T00:00:00').getTime();
    const dayEnd = dayStart + 24 * 3600 * 1000;
    for (const d of dirs) {
      const sub = path.join(root, d);
      let files = [];
      try { files = fs.readdirSync(sub).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const fp = path.join(sub, f);
        // Dateien, die vor dem Tag zuletzt geschrieben wurden, können keine
        // Events des Tages enthalten → überspringen (Performance).
        try { if (fs.statSync(fp).mtimeMs < dayStart) continue; } catch { continue; }
        let content = '';
        try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }
        for (const ln of content.split('\n')) {
          if (!ln) continue;
          let o;
          try { o = JSON.parse(ln); } catch { continue; }
          const ts = o && o.timestamp;
          const cwd = o && o.cwd;
          if (!ts || !cwd) continue;
          const t = Date.parse(ts);
          if (!(t >= dayStart && t < dayEnd)) continue;
          if (!perCwd.has(cwd)) perCwd.set(cwd, []);
          perCwd.get(cwd).push(t);
        }
      }
    }
    const out = new Map();
    for (const [cwd, arr] of perCwd) {
      arr.sort((a, b) => a - b);
      let sec = 0;
      for (let i = 1; i < arr.length; i++) {
        const gap = (arr[i] - arr[i - 1]) / 1000;
        if (gap > 0 && gap < IDLE_GAP_S) sec += gap;
      }
      out.set(cwd, sec);
    }
    return out;
  }

  // cwd → Ticket-Ordner zusammenfassen + auf einen verknüpften Odoo-Task mappen.
  // Bevorzugt der längste tasks.working_dir, der ein Präfix von cwd ist (sauberes
  // Mapping zu odoo_task_id/odoo_project_id). Sonst Fallback auf scan_dir + max. 2
  // Pfadsegmente (Kunde/Ticket).
  function collapseToTicketDir(cwd) {
    const d = db();
    let best = null;
    try {
      const rows = d.prepare("SELECT working_dir, odoo_task_id, odoo_project_id, title, sequence_name FROM tasks WHERE working_dir IS NOT NULL AND working_dir != ''").all();
      for (const r of rows) {
        const wd = r.working_dir;
        if (cwd === wd || cwd.startsWith(wd.endsWith('/') ? wd : wd + '/')) {
          if (!best || wd.length > best.working_dir.length) best = r;
        }
      }
    } catch { /* noop */ }
    if (best) {
      return {
        dir: best.working_dir,
        odoo_task_id: best.odoo_task_id || null,
        odoo_project_id: best.odoo_project_id || null,
        ticket: best.sequence_name || '',
        title: best.title || '',
      };
    }
    const base = scanDir().replace(/\/$/, '');
    if (cwd === base || cwd.startsWith(base + '/')) {
      const rel = cwd.slice(base.length + 1).split('/').filter(Boolean);
      const dir = rel.length ? path.join(base, ...rel.slice(0, 2)) : base;
      return { dir, odoo_task_id: null, odoo_project_id: null, ticket: '', title: '' };
    }
    return null;
  }

  // Kandidaten-Ordner unter scan_dir, die am Tag aktiv waren (gemappt auf Odoo).
  function candidateDirs(date) {
    const base = scanDir().replace(/\/$/, '');
    const active = activeCwdsForDate(date);
    const byDir = new Map();
    for (const [cwd, sec] of active) {
      if (cwd !== base && !cwd.startsWith(base + '/')) continue; // nur unter scan_dir
      const c = collapseToTicketDir(cwd);
      if (!c) continue;
      const cur = byDir.get(c.dir) || { ...c, seconds: 0 };
      cur.seconds += sec;
      // Mapping nachziehen, falls ein längerer cwd den Task auflöst
      if (!cur.odoo_task_id && c.odoo_task_id) { cur.odoo_task_id = c.odoo_task_id; cur.odoo_project_id = c.odoo_project_id; cur.ticket = c.ticket; cur.title = c.title; }
      byDir.set(c.dir, cur);
    }
    return [...byDir.values()].sort((a, b) => b.seconds - a.seconds);
  }

  function runClaude(dir, date, hintHours) {
    const prompt =
      `Du bist ein Zeiterfassungs-Assistent. Analysiere ausschließlich für den Tag ${date} ` +
      `die Arbeit, die im aktuellen Verzeichnis (${dir}) geleistet wurde.\n\n` +
      `Datenquellen, die du auswerten sollst:\n` +
      `1. Die Claude-Session-Logs unter ~/.claude/projects (JSONL; jede Zeile hat "cwd" und "timestamp"). ` +
      `Betrachte die Sessions, deren cwd unter ${dir} liegt, und schätze aus den Timestamps am ${date} die aktive Arbeitszeit ` +
      `(zusammenhängende Aktivität; Lücken über 15 Minuten zählen nicht).\n` +
      `2. Die git-History dieses Verzeichnisses (z.B. \`git log --since='${date} 00:00' --until='${date} 23:59'\`) als Anhaltspunkt, WAS gemacht wurde.\n\n` +
      `Grobe Vorab-Schätzung aus den Logs: ca. ${hintHours.toFixed(2)} Stunden (nur Anhaltspunkt, korrigiere wenn nötig).\n\n` +
      `Antworte mit GENAU EINEM JSON-Objekt und sonst nichts:\n` +
      `{"hours": <Dezimalzahl, auf 0.25 gerundet>, "description": "<1-2 Sätze, was an dem Tag gemacht wurde, aus Endkunden-/Tester-Sicht>"}\n` +
      `Wenn an dem Tag erkennbar nichts gearbeitet wurde, gib {"hours": 0, "description": ""} zurück.`;
    const args = [...claudeArgs(), '-p', prompt];
    const timeoutMs = parseInt(config.claude_scan_timeout_ms, 10) || 240000;
    return new Promise((resolve) => {
      execFile(claudeBin(), args, { cwd: dir, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
        resolve({ err, stdout: stdout || '', stderr: stderr || '', prompt });
      });
    });
  }

  function parseClaudeJson(stdout) {
    if (!stdout) return null;
    // Letztes {...}-Objekt im Output greifen (claude kann davor Text schreiben).
    const matches = stdout.match(/\{[\s\S]*?\}/g);
    if (!matches) return null;
    for (let i = matches.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(matches[i]);
        if (o && (typeof o.hours === 'number' || typeof o.description === 'string')) return o;
      } catch { /* weiter */ }
    }
    return null;
  }

  function writeTrace(date, entries, summary) {
    try {
      const dir = path.join(os.homedir(), '.daytask', 'traces');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fp = path.join(dir, `scan-${date}-${stamp}.log`);
      let out = `# DayTask Scan-Trace\nDatum: ${date}\nScan-Dir: ${scanDir()}\nLauf: ${new Date().toISOString()}\n`;
      out += `Zusammenfassung: ${JSON.stringify(summary)}\n\n`;
      for (const e of entries) {
        out += `${'='.repeat(70)}\nDIR: ${e.dir}\nOdoo-Task: ${e.odoo_task_id || '–'}  Ticket: ${e.ticket || '–'}  Hint: ${e.hint?.toFixed?.(2)}h\n`;
        out += `--- PROMPT ---\n${e.prompt || ''}\n--- CLAUDE STDOUT ---\n${e.stdout || ''}\n`;
        if (e.stderr) out += `--- CLAUDE STDERR ---\n${e.stderr}\n`;
        out += `--- PARSED ---\n${JSON.stringify(e.parsed)}\n--- ODOO ---\n${JSON.stringify(e.odoo)}\n\n`;
      }
      fs.writeFileSync(fp, out, { mode: 0o600 });
      return fp;
    } catch (e) { return null; }
  }

  // Bestehende (User-)Zeile für (Task, Tag) finden, sonst neu anlegen → Stunden +
  // Beschreibung schreiben. Liefert {action, id}.
  async function uploadLine(uid, date, c, hours, description) {
    const h = roundUp15(hours);
    const existing = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      config.odoo.db, uid, config.odoo.password,
      'account.analytic.line', 'search',
      [[['user_id', '=', uid], ['date', '=', date], ['task_id', '=', c.odoo_task_id]]],
      { limit: 1 },
    ]);
    if (existing && existing.length) {
      await odooCall('/xmlrpc/2/object', 'execute_kw', [
        config.odoo.db, uid, config.odoo.password,
        'account.analytic.line', 'write', [[existing[0]], { unit_amount: h, name: description || '/' }],
      ]);
      return { action: 'updated', id: existing[0], hours: h };
    }
    const vals = { name: description || '/', date, unit_amount: h, project_id: c.odoo_project_id, task_id: c.odoo_task_id };
    const id = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      config.odoo.db, uid, config.odoo.password,
      'account.analytic.line', 'create', [vals],
    ]);
    return { action: 'created', id, hours: h };
  }

  // date: YYYY-MM-DD. onProgress(msg) optional. dirsOnly: nur Kandidaten zurück
  // (kein claude, kein Upload) — für eine Vorschau.
  async function scanDay(date, opts = {}) {
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, error: 'Ungültiges Datum' };
    if (!odooReady()) return { ok: false, error: 'Odoo nicht konfiguriert' };

    const cands = candidateDirs(date).slice(0, parseInt(config.scan_max_dirs, 10) || 25);
    if (!cands.length) {
      onProgress(`Keine aktiven Ordner unter ${scanDir()} am ${date} gefunden.`);
      return { ok: true, date, scanned: 0, uploaded: 0, results: [], traceFile: null, message: 'Keine Aktivität gefunden' };
    }
    onProgress(`${cands.length} aktive Ordner gefunden, starte Claude…`);

    const uid = await odooUID();
    if (!uid) return { ok: false, error: 'Auth fehlgeschlagen' };

    const entries = [];
    const results = [];
    let uploaded = 0;

    // Sequenziell (claude-Prozesse sind teuer; vermeidet Rate-/Last-Probleme).
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const hint = (c.seconds || 0) / 3600;
      onProgress(`(${i + 1}/${cands.length}) ${path.basename(c.dir)} – Claude analysiert…`);
      const run = await runClaude(c.dir, date, hint);
      const parsed = parseClaudeJson(run.stdout);
      const entry = { dir: c.dir, odoo_task_id: c.odoo_task_id, ticket: c.ticket, hint, prompt: run.prompt, stdout: run.stdout, stderr: run.stderr, parsed, odoo: null };
      let odooRes = null;
      const hours = parsed && typeof parsed.hours === 'number' ? parsed.hours : 0;
      const desc = parsed && parsed.description ? String(parsed.description) : '';
      if (run.err && !parsed) {
        odooRes = { skipped: 'claude_error', error: (run.err.killed ? 'timeout' : run.err.message) };
      } else if (!parsed) {
        odooRes = { skipped: 'no_json' };
      } else if (hours <= 0) {
        odooRes = { skipped: 'zero_hours' };
      } else if (!c.odoo_task_id) {
        odooRes = { skipped: 'no_odoo_task' };
      } else {
        try {
          odooRes = await uploadLine(uid, date, c, hours, desc);
          uploaded++;
        } catch (e) {
          odooRes = { skipped: 'odoo_error', error: e.message };
        }
      }
      entry.odoo = odooRes;
      entries.push(entry);
      results.push({
        dir: c.dir, ticket: c.ticket, title: c.title,
        odoo_task_id: c.odoo_task_id, hint: Math.round(hint * 100) / 100,
        hours, description: desc, odoo: odooRes,
      });
    }

    const summary = { scanned: cands.length, uploaded };
    const traceFile = writeTrace(date, entries, summary);
    onProgress(`Fertig: ${uploaded} Zeile(n) nach Odoo geladen.`);
    return { ok: true, date, scanned: cands.length, uploaded, results, traceFile };
  }

  return { getDayView, upsertLine, deleteLine, scanDay, candidateDirs };
}

module.exports = { makeDayView };
