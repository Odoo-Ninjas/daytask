// Deferred-Feedback an den Kunden über comm.
//
// Wird ein Task mit aktivierter Option „Kunden informieren" angelegt
// (comm_feedback_pending=1) und bekommt er SPÄTER eine Odoo-Verknüpfung MIT
// Ticketnummer, schickt diese Logik EINMAL automatisch eine für den Kunden
// sichtbare Antwort über comm ("Wir bearbeiten Ihr Anliegen unter Ticket
// No. …") zurück an den Ursprungskanal und löscht danach das Flag.
//
// Geteilt zwischen server.js (Web-Variante) und main.js (Electron), damit beide
// Linking-Pfade (web /api/tasks/link-odoo und IPC tasks:linkOdoo) exakt gleich
// reagieren. Reine (db, config, odoo)-Logik ohne Express-/Electron-Bezug.

const DEFAULT_TEMPLATE =
  'Vielen Dank für Ihre Nachricht! Wir bearbeiten Ihr Anliegen unter Ticket No. {ticket} und melden uns dort.';

// getDb: liefert die (ggf. erst später initialisierte) DB-Instanz.
// odooCall/odooUID: dieselben XML-RPC-Helfer wie im aufrufenden Modul.
function makeCommFeedback({ getDb, config, odooCall, odooUID }) {
  const db = () => (typeof getDb === 'function' ? getDb() : getDb);

  // Ticketnummer für den Kundentext: bevorzugt sequence_name (ZO-XXXXX), dann
  // ticket_ref. Fehlt beides, aber ein Odoo-Task ist verknüpft → sequence_name
  // aus Odoo nachladen und am Task persistieren (link-odoo setzt es nicht).
  async function resolveTicket(task) {
    if (task.sequence_name) return task.sequence_name;
    if (task.odoo_task_id && config.odoo && config.odoo.url && config.odoo.username) {
      try {
        const uid = await odooUID();
        if (uid) {
          const r = await odooCall('/xmlrpc/2/object', 'execute_kw', [
            config.odoo.db, uid, config.odoo.password,
            'project.task', 'read', [[task.odoo_task_id]], { fields: ['sequence_name'] },
          ]);
          const seq = r && r[0] && r[0].sequence_name;
          if (seq) {
            db().prepare('UPDATE tasks SET sequence_name=? WHERE id=?').run(seq, task.id);
            return seq;
          }
        }
      } catch (e) { /* Odoo nicht erreichbar → unten auf ticket_ref zurückfallen */ }
    }
    return task.ticket_ref || null;
  }

  // Idempotent. Sendet nur, wenn: Flag gesetzt, comm-Ziel vorhanden, Odoo
  // verknüpft und eine Ticketnummer ermittelbar ist. Bei Erfolg wird das Flag
  // gelöscht (kein zweiter Versand). Wirft nie — liefert immer ein Status-Objekt.
  async function maybeSend(taskId) {
    let task;
    try {
      task = db().prepare(
        'SELECT id, title, comm_meta, comm_feedback_pending, sequence_name, ticket_ref, odoo_task_id FROM tasks WHERE id=?'
      ).get(taskId);
    } catch (e) { return { ok: false, skipped: true, error: e.message }; }
    if (!task || !task.comm_feedback_pending || !task.comm_meta) return { ok: false, skipped: true };
    if (!task.odoo_task_id) return { ok: false, skipped: true, reason: 'not_linked' };
    let comm;
    try { comm = JSON.parse(task.comm_meta); } catch { return { ok: false, skipped: true, reason: 'bad_comm_meta' }; }
    if (!comm || !comm.url || !comm.token) return { ok: false, skipped: true, reason: 'bad_comm_meta' };
    const ticket = await resolveTicket(task);
    if (!ticket) return { ok: false, skipped: true, reason: 'no_ticket' };
    const tpl = (config.comm_feedback_template && String(config.comm_feedback_template).trim()) || DEFAULT_TEMPLATE;
    const text = tpl.replace(/\{ticket\}/g, ticket).replace(/\{title\}/g, task.title || '');
    try {
      const r = await fetch(`${comm.url}/api/task-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: comm.token, text, kind: 'update' }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        return { ok: false, error: d.detail || ('HTTP ' + r.status) };
      }
      db().prepare('UPDATE tasks SET comm_feedback_pending=0 WHERE id=?').run(taskId);
      console.log('[commFeedback] gesendet an', comm.channel, '— Ticket', ticket);
      return { ok: true, ticket, channel: comm.channel };
    } catch (e) {
      console.error('[commFeedback] Versand fehlgeschlagen:', e.message);
      return { ok: false, error: e.message };
    }
  }

  return { maybeSend, DEFAULT_TEMPLATE };
}

module.exports = { makeCommFeedback, DEFAULT_TEMPLATE };
