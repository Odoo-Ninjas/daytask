// Gemeinsame Working-Dir-Logik für die Electron-Variante (main.js) und die
// Web-Variante (server.js). Reine (db, config)-Logik ohne Electron-/Express-
// Abhängigkeit, damit beide Seiten exakt dasselbe Verhalten haben.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// Wert sicher für eine single-quote-Shell-Interpolation escapen.
// Schließt Command-Injection über interpolierte User-Werte.
const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// SSH-Host validieren: nur [host], [user@host], optional :port. sq() macht den
// Wert shell-sicher, verhindert aber NICHT, dass ssh einen mit '-' beginnenden
// Wert als Option (z.B. -oProxyCommand=…) interpretiert. Daher zusätzlich
// Argument-Injection ausschließen.
// `_` ist erlaubt (SSH-Config-Aliase wie zebroo_hetzner), nur kein führendes '-'.
const sshHostOk = h => typeof h === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9._@:_-]*[A-Za-z0-9])?$/.test(h);

// Sprechender Verzeichnis-Name aus Ticket + Titel. Säubert aggressiv und
// neutralisiert Pfad-Traversal (Slashes → '-', '..'/'.'-only fällt weg).
function slugForTask(task) {
  const clean = s => String(s || '').trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-') // alles andere → '-'
    .replace(/\.{2,}/g, '.')           // '..' → '.' (kein Parent-Traversal)
    .replace(/^[.\-]+|[.\-]+$/g, '');  // führende/abschließende '.'/'-' weg
  const ticket = clean(task.sequence_name || task.ticket_ref);
  const titleSlug = clean(String(task.title || '').toLowerCase()).slice(0, 40).replace(/-+$/g, '');
  const slug = [ticket, titleSlug].filter(Boolean).join('-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `task-${task.id}`;
}

// Factory: getDb liefert die (ggf. erst später initialisierte) DB-Instanz,
// config ist das Live-Config-Objekt.
function makeWorkingDir(getDb, config) {
  const db = () => (typeof getDb === 'function' ? getDb() : getDb);
  const workBase = () => config.work_dir || path.join(os.homedir(), 'ai', 'work');
  const doneBase = () => config.done_dir || path.join(os.homedir(), 'ai', 'done');

  // Eindeutiges Zielverzeichnis: hängt die Task-ID an, falls der Slug bereits
  // von einem ANDEREN Task belegt ist — verhindert geteiltes Verzeichnis/TASK.md.
  function dirForTask(task) {
    const slug = slugForTask(task);
    const dir = path.join(workBase(), slug);
    const owner = db().prepare('SELECT id FROM tasks WHERE working_dir=? AND id<>?').get(dir, task.id);
    return owner ? path.join(workBase(), `${slug}-${task.id}`) : dir;
  }

  // Verschiebt das Working-Dir zwischen zwei Basisverzeichnissen (work ↔ done).
  // No-op wenn kein Dir hinterlegt ist, das Quellverz. fehlt oder außerhalb
  // von fromBase liegt (manuell gesetzte Fremdpfade werden nie angefasst).
  function moveWorkingDir(id, fromBase, toBase) {
    const row = db().prepare('SELECT working_dir, vscode_path FROM tasks WHERE id=?').get(id);
    if (!row || !row.working_dir) return;
    const src = row.working_dir;
    if (!fs.existsSync(src)) return;
    const rel = path.relative(fromBase, src);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') return;
    const dest = path.join(toBase, path.basename(src));
    try {
      fs.mkdirSync(toBase, { recursive: true });
      if (fs.existsSync(dest)) { console.error('[moveWorkingDir] Ziel existiert bereits, überspringe:', dest); return; }
      fs.renameSync(src, dest);
      if (row.vscode_path === src) db().prepare('UPDATE tasks SET working_dir=?, vscode_path=? WHERE id=?').run(dest, dest, id);
      else db().prepare('UPDATE tasks SET working_dir=? WHERE id=?').run(dest, id);
      console.log('[moveWorkingDir]', src, '→', dest);
    } catch (e) { console.error('[moveWorkingDir] failed:', e.message); }
  }

  function moveToDone(id) { moveWorkingDir(id, workBase(), doneBase()); }
  function moveToWork(id) { moveWorkingDir(id, doneBase(), workBase()); }

  // Legt das Arbeitsverzeichnis + vorausgefüllte TASK.md an und speichert
  // working_dir (und vscode_path, falls noch leer). Idempotent.
  function createWorkingDir(taskId) {
    const task = db().prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task) return { ok: false, error: 'Task nicht gefunden' };
    const dir = dirForTask(task);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const taskMd = path.join(dir, 'TASK.md');
      if (!fs.existsSync(taskMd)) {
        const odooUrl = (task.odoo_task_id && config.odoo && config.odoo.url)
          ? `${config.odoo.url.replace(/\/$/, '')}/web#id=${task.odoo_task_id}&model=project.task&view_type=form`
          : '';
        // comm-Antwort-Block: wenn comm (von der comm-App) mitgegeben wurde,
        // weiß Claude im Work-Dir, wie er dem Kunden über comm antwortet.
        let comm = null;
        try { comm = task.comm_meta ? JSON.parse(task.comm_meta) : null; } catch (e) { comm = null; }
        const kundeBlock = comm ? [
          '## Kunde antworten — IMMER über comm (nicht direkt an Discord/Teams/Mail)',
          '',
          `Kanal: **${comm.channel}**`,
          '',
          'Zwischenbericht / Update an den Kunden:',
          '```bash',
          `curl -s -X POST ${comm.url}/api/task-send -H "Content-Type: application/json" \\`,
          `  -d '{"token":"${comm.token}","text":"DEIN TEXT","kind":"update"}'`,
          '```',
          'Fertig + Abschlussbericht: gleiches Kommando mit `"kind":"done"` (markiert die Nachricht in comm als erledigt).',
        ] : [
          '## Kunde informieren (Discord/Teams/Mail)',
          '',
          '- [ ] ',
        ];
        // Ticket-Block: wenn ein Odoo-Task verknüpft ist, weiß ein Agent im
        // Work-Dir, wie er einen Statusreport/Kommentar ins Ticket schreibt
        // (curl an den lokalen DayTask-Server, der per XML-RPC message_post).
        const dtPort = process.env.PORT || config.web_port || 3000;
        const odooBlock = task.odoo_task_id ? [
          '## Ticket aktualisieren — Statusreport/Kommentar ins Odoo-Ticket',
          '',
          'Interne Log-Notiz ans verknüpfte Odoo-Ticket (z.B. Zwischenstand / Abschlussbericht):',
          '```bash',
          `curl -s -X POST http://localhost:${dtPort}/api/odoo/comment -H "Content-Type: application/json" \\`,
          `  -d '{"odoo_task_id": ${task.odoo_task_id}, "body": "DEIN TEXT", "internal": true}'`,
          '```',
          'Body als **Plaintext** (keine HTML-Tags — würden sichtbar; Zeilenumbrüche `\\n` werden zu Absätzen).',
          '`"internal": false` → für den Kunden sichtbarer Kommentar statt interner Notiz.',
          '',
          '### Task abschließen',
          '',
          'Wenn die Aufgabe fertig ist: erst Abschlussbericht als Kommentar (oben), dann Ticket auf „erledigt" setzen und Work-Ordner nach `~/ai/done` verschieben:',
          '```bash',
          `curl -s -X POST http://localhost:${dtPort}/api/odoo/set-done   -H "Content-Type: application/json" -d '{"odoo_task_id": ${task.odoo_task_id}}'`,
          `curl -s -X POST http://localhost:${dtPort}/api/tasks/move-done -H "Content-Type: application/json" -d '{"odoo_task_id": ${task.odoo_task_id}}'`,
          '```',
          '`set-done` braucht ein gemapptes Done-Stage (Settings → Stage-Mappings). `move-done` markiert den Task erledigt, stoppt einen laufenden Timer (mit Odoo-Sync) und verschiebt den Ordner.',
        ] : [];
        // Optionale Metadaten-Zeilen geben `false` zurück → werden gefiltert,
        // die '' bleiben als bewusste Leerzeilen-Trenner erhalten.
        const lines = [
          `# ${task.title || 'Ohne Titel'}`,
          '',
          task.sequence_name ? `- Ticket: ${task.sequence_name}` : (task.ticket_ref ? `- Ticket: ${task.ticket_ref}` : false),
          odooUrl ? `- Odoo: ${odooUrl}` : false,
          task.deadline ? `- Deadline: ${task.deadline}` : false,
          task.git_repo ? `- Repo: ${task.git_repo}` : false,
          task.git_branch ? `- Branch: ${task.git_branch}` : false,
          '',
          '## Aufgabe',
          '',
          (task.note || '').trim(),
          '',
          ...kundeBlock,
          ...(odooBlock.length ? ['', ...odooBlock] : []),
          '',
          '## Notizen',
          '',
          (task.private_notes || '').trim(),
          '',
        ].filter(l => l !== false);
        fs.writeFileSync(taskMd, lines.join('\n'), 'utf8');
      }
      if (task.vscode_path) db().prepare('UPDATE tasks SET working_dir=? WHERE id=?').run(dir, taskId);
      else db().prepare('UPDATE tasks SET working_dir=?, vscode_path=? WHERE id=?').run(dir, dir, taskId);
      return { ok: true, dir };
    } catch (e) {
      console.error('[createWorkingDir] failed:', e.message);
      return { ok: false, error: e.message };
    }
  }

  // Öffnet das Working-Dir in VS Code. `open -a` löst die App über LaunchServices
  // auf (PATH-unabhängig — wichtig für die aus dem Dock gestartete, gepackte App,
  // die `code` oft nicht im PATH hat). Fallback: Finder. execFile = keine Shell.
  function openWorkingDir(taskId) {
    const task = db().prepare('SELECT working_dir FROM tasks WHERE id=?').get(taskId);
    if (!task || !task.working_dir) return { ok: false, error: 'Kein Working Dir hinterlegt' };
    if (!fs.existsSync(task.working_dir)) return { ok: false, error: 'Working Dir existiert nicht (mehr)' };
    execFile('open', ['-a', 'Visual Studio Code', task.working_dir], (err) => {
      if (err) execFile('open', [task.working_dir]);
    });
    return { ok: true, dir: task.working_dir };
  }

  return { slugForTask, moveWorkingDir, moveToDone, moveToWork, createWorkingDir, openWorkingDir };
}

module.exports = { makeWorkingDir, slugForTask, sq, sshHostOk };
