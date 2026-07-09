// Guard: Zeitbuchungen nur auf Projekten erlauben, die sie zulassen.
//
// In Odoo hat jedes project.project ein Flag `allow_timesheets`. Ist es FALSE,
// darf auf Aufgaben dieses Projekts KEINE account.analytic.line (Timesheet-Zeile)
// angelegt werden. Odoo blendet den Timesheet-Tab dann zwar in der UI aus, lässt
// per ORM/XML-RPC aber je nach Version trotzdem ein `create` zu — deshalb prüfen
// wir es hier explizit, bevor DayTask (Sync ODER manueller Nachtrag) bucht.
//
// Ergebnis wird pro Projekt gecacht (die Config ändert sich selten). Reine
// (config, odooCall, odooUID)-Logik ohne Express-Bezug.

'use strict';

function makeProjectGuard({ config, odooCall, odooUID }) {
  const cache = new Map(); // project_id (int) -> boolean (allow_timesheets)

  // project_id direkt oder – falls nur ein Task bekannt ist – über den Task auflösen.
  async function resolveProjectId(projectId, taskId) {
    if (projectId) return parseInt(projectId, 10);
    if (!taskId) return null;
    const uid = await odooUID();
    const rows = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      config.odoo.db, uid, config.odoo.password,
      'project.task', 'read', [[parseInt(taskId, 10)]], { fields: ['project_id'] },
    ]);
    const pr = rows && rows[0] && rows[0].project_id;
    return Array.isArray(pr) ? pr[0] : null;
  }

  // true = buchen erlaubt. Ohne auflösbares Projekt kann nicht geprüft werden →
  // true (Odoo entscheidet dann selbst), damit der Guard nie fälschlich alles blockt.
  async function allowsTimesheets(projectId, taskId) {
    const pid = await resolveProjectId(projectId, taskId);
    if (!pid) return true;
    if (cache.has(pid)) return cache.get(pid);
    const uid = await odooUID();
    const rows = await odooCall('/xmlrpc/2/object', 'execute_kw', [
      config.odoo.db, uid, config.odoo.password,
      'project.project', 'read', [[pid]], { fields: ['allow_timesheets'] },
    ]);
    // Projekt nicht gefunden → nicht blocken (kein Config-Signal vorhanden).
    const allowed = !rows || !rows.length ? true : !!rows[0].allow_timesheets;
    cache.set(pid, allowed);
    return allowed;
  }

  // Wirft, wenn das Projekt keine Zeitbuchungen erlaubt.
  async function assertAllowed(projectId, taskId) {
    if (await allowsTimesheets(projectId, taskId)) return;
    const pid = await resolveProjectId(projectId, taskId);
    const e = new Error(`Projekt #${pid} erlaubt keine Zeiterfassung (allow_timesheets=false) — Buchung abgelehnt`);
    e.code = 'timesheets_not_allowed';
    throw e;
  }

  function clearCache() { cache.clear(); }

  return { allowsTimesheets, assertAllowed, clearCache };
}

module.exports = { makeProjectGuard };
