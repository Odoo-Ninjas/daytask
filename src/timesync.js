// Geteilte, idempotente Timeslot -> Odoo-Sync-Logik (genutzt von server.js +
// cli.js, damit alle Pfade exakt gleich und vor allem OHNE Doppelbuchung syncen).
//
// Designziele (aus dem Code-Review):
//   * KEINE Doppelbuchung bei parallelem Sync (Electron-App + Web-Server greifen auf
//     dieselbe ~/.daytask.db zu) oder bei Retry nach Crash: Slots werden vor dem
//     XML-RPC atomar "geclaimt" (synced 0 -> 2 = in-flight). Wer den Claim gewinnt,
//     bucht; der andere sieht 0 Aenderungen und macht nichts.
//   * Idempotenz: die erzeugte account.analytic.line-ID wird pro Slot in
//     timeslots.odoo_line_id persistiert. Ein erneuter Sync desselben Tages
//     AKTUALISIERT die bestehende Zeile (write) statt eine zweite anzulegen.
//   * Kein Aufrund-Drift: pro (Task, Tag) existiert genau EINE Zeile; ihre
//     unit_amount = aufgerundete Summe ALLER zu dieser Zeile gehoerenden Slots.
//
// Reine (db, config, odooCall, odooUID)-Logik ohne Express-/Electron-Bezug.

'use strict';

const dayOf = (s) => String(s).split('T')[0].split(' ')[0];
const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 3600000;
const roundUp15 = (h) => Math.ceil(h * 4) / 4; // auf naechste 15 min aufrunden

function makeTimeSync({ getDb, config, odooCall, odooUID }) {
  const db = () => (typeof getDb === 'function' ? getDb() : getDb);

  // Beim Start haengengebliebene In-Flight-Slots (synced=2 aus einem abgebrochenen
  // Sync, z.B. Crash zwischen Claim und Buchung) zuruecksetzen, damit sie erneut
  // gebucht werden. Muss einmal pro Prozessstart aufgerufen werden.
  function recoverInFlight() {
    try {
      const r = db().prepare('UPDATE timeslots SET synced=0 WHERE synced=2').run();
      if (r.changes) console.log('[timesync] recovered', r.changes, 'in-flight Slots');
    } catch (e) { /* noop */ }
  }

  // Summe (Stunden) aller geschlossenen Slots, die zu einer bekannten Odoo-Zeile
  // gehoeren (gleiche odoo_line_id).
  function hoursForLine(lineId) {
    const rows = db().prepare(
      'SELECT started_at, stopped_at FROM timeslots WHERE odoo_line_id=? AND stopped_at IS NOT NULL'
    ).all(lineId);
    return rows.reduce((acc, r) => acc + hoursBetween(r.started_at, r.stopped_at), 0);
  }

  async function syncUnsyncedTimeslots(taskId) {
    const d = db();
    const slots = d.prepare(`
      SELECT ts.*, t.title, t.ticket_ref, t.note, t.odoo_task_id, t.odoo_project_id
      FROM timeslots ts JOIN tasks t ON t.id=ts.task_id
      WHERE ts.task_id=? AND ts.synced=0 AND ts.stopped_at IS NOT NULL
      ORDER BY ts.started_at
    `).all(taskId);
    if (!slots.length) return [];

    // Null-Slots (<0.01h) direkt als gesynct markieren; den Rest nach Kalendertag
    // gruppieren und atomar claimen (synced 0 -> 2). Alles in EINER Transaktion,
    // damit ein paralleler Sync nicht dieselben Slots greift.
    const byDay = new Map();
    const claim = d.prepare('UPDATE timeslots SET synced=2 WHERE id=? AND synced=0');
    const sweepZero = d.prepare('UPDATE timeslots SET synced=1 WHERE id=? AND synced=0');
    d.transaction(() => {
      for (const s of slots) {
        const h = hoursBetween(s.started_at, s.stopped_at);
        if (h < 0.01) { sweepZero.run(s.id); continue; }
        if (!claim.run(s.id).changes) continue; // anderer Prozess war schneller
        const day = dayOf(s.started_at);
        let g = byDay.get(day);
        if (!g) { g = { hours: 0, ids: [] }; byDay.set(day, g); }
        g.hours += h;
        g.ids.push(s.id);
      }
    })();

    if (!byDay.size) return [{ ok: true, skipped: true }];

    const first = slots[0];
    const releaseStmt = d.prepare('UPDATE timeslots SET synced=0 WHERE id=? AND synced=2');
    const release = (ids) => d.transaction(() => { for (const id of ids) releaseStmt.run(id); })();
    const releaseAll = () => { for (const g of byDay.values()) release(g.ids); };

    if (!first.odoo_task_id) { releaseAll(); return [{ ok: false, error: 'no_odoo_task', pending: true }]; }
    if (!config.odoo || !config.odoo.url || !config.odoo.username) { releaseAll(); return [{ ok: false, error: 'Odoo not configured' }]; }

    let uid;
    try { uid = await odooUID(); } catch (e) { releaseAll(); return [{ ok: false, error: e.message }]; }
    if (!uid) { releaseAll(); return [{ ok: false, error: 'Odoo auth failed' }]; }

    // Beschreibung (einmal fuer alle Tageszeilen dieses Tasks).
    let desc = first.ticket_ref ? `[${first.ticket_ref}] ${first.title}` : first.title;
    if (first.note) {
      desc += '\n' + first.note;
    } else {
      try {
        const t = await odooCall('/xmlrpc/2/object', 'execute_kw', [
          config.odoo.db, uid, config.odoo.password,
          'project.task', 'read', [[first.odoo_task_id]], { fields: ['description'] }
        ]);
        if (t?.[0]?.description) {
          const plain = t[0].description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (plain) desc += '\n' + plain;
        }
      } catch (_) {}
    }

    const markDone = d.prepare('UPDATE timeslots SET synced=1, odoo_line_id=? WHERE id=?');
    const results = [];
    for (const [day, g] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      // Existiert fuer (Task, Tag) bereits eine von UNS erzeugte Zeile (bekannte
      // odoo_line_id an einem schon gesyncten Slot)? Dann diese aktualisieren, statt
      // eine zweite anzulegen. Nur Zeilen mit bekannter ID werden zusammengerechnet —
      // Alt-Daten ohne odoo_line_id bleiben unangetastet (kein nachtraegliches Aufblaehen).
      const prior = d.prepare(
        "SELECT odoo_line_id FROM timeslots WHERE task_id=? AND substr(started_at,1,10)=? AND synced=1 AND odoo_line_id IS NOT NULL LIMIT 1"
      ).get(taskId, day);
      const existingLineId = prior ? prior.odoo_line_id : null;
      try {
        let lineId = existingLineId;
        if (existingLineId) {
          const total = roundUp15(hoursForLine(existingLineId) + g.hours);
          await odooCall('/xmlrpc/2/object', 'execute_kw', [
            config.odoo.db, uid, config.odoo.password,
            'account.analytic.line', 'write', [[existingLineId], { unit_amount: total }]
          ]);
        } else {
          lineId = await odooCall('/xmlrpc/2/object', 'execute_kw', [
            config.odoo.db, uid, config.odoo.password,
            'account.analytic.line', 'create', [{
              name: desc, date: day, unit_amount: roundUp15(g.hours),
              project_id: first.odoo_project_id, task_id: first.odoo_task_id,
            }]
          ]);
        }
        d.transaction(() => { for (const id of g.ids) markDone.run(lineId, id); })();
        results.push({ ok: true, lineId, synced: g.ids.length, date: day });
      } catch (e) {
        // Tag bleibt ungesynct (zurueck auf synced=0) -> spaeterer Retry.
        release(g.ids);
        results.push({ ok: false, error: e.message, date: day });
      }
    }
    return results;
  }

  return { syncUnsyncedTimeslots, recoverInFlight };
}

module.exports = { makeTimeSync, dayOf, hoursBetween, roundUp15 };
