#!/usr/bin/env node
'use strict';

const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.homedir(), '.daytask.db');
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);

// ── ANSI ──────────────────────────────────────────────────────────────────────
const A = {
  R:    '\x1b[0m',
  bold: '\x1b[1m',
  dim:  '\x1b[2m',
  rev:  '\x1b[7m',
  grn:  '\x1b[32m',
  yel:  '\x1b[33m',
  cyn:  '\x1b[36m',
  red:  '\x1b[31m',
  gray: '\x1b[90m',
  clr:  '\x1b[2J\x1b[H',
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
};

function strip(s) { return s.replace(/\x1b\[[0-9;]*[mGKHJA-Za-z]/g, ''); }

// ── Time ──────────────────────────────────────────────────────────────────────
function localNow() {
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function parseLocal(s) {
  if (!s) return null;
  const [dt, tm = '00:00:00'] = s.split(' ');
  const [y, mo, d] = dt.split('-').map(Number);
  const [h, mi, sec] = tm.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi, sec);
}

function fmtSecs(secs) {
  secs = Math.max(0, Math.floor(secs));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}h`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function elapsedSecs(since) {
  const t = parseLocal(since);
  return t ? (Date.now() - t.getTime()) / 1000 : 0;
}

// ── DB ────────────────────────────────────────────────────────────────────────
function loadTasks() {
  const today = localNow().split(' ')[0];
  return db.prepare(`
    SELECT t.*,
      COALESCE((
        SELECT SUM((julianday(COALESCE(ts.stopped_at, datetime('now','localtime'))) - julianday(ts.started_at)) * 86400)
        FROM timeslots ts WHERE ts.task_id = t.id
      ), 0) AS total_seconds,
      (SELECT ts.started_at FROM timeslots ts WHERE ts.task_id = t.id AND ts.stopped_at IS NULL LIMIT 1) AS running_since
    FROM tasks t WHERE t.date = ?
    ORDER BY t.done ASC, COALESCE(t.priority,0) DESC,
      COALESCE((SELECT MAX(ts.started_at) FROM timeslots ts WHERE ts.task_id = t.id), t.created_at) DESC, t.id DESC
  `).all(today);
}

function getActiveSlot() {
  return db.prepare('SELECT id, task_id, started_at FROM timeslots WHERE stopped_at IS NULL ORDER BY id DESC LIMIT 1').get() || null;
}

// ── State ─────────────────────────────────────────────────────────────────────
let tasks = [], cursor = 0, activeSlot = null;
let mode = 'list'; // 'list' | 'input' | 'desc'
let inputBuf = '', statusMsg = '', statusTimer = null;
let scrollOffset = 0;
let descBuf = '', descTaskId = null;
let listH = 1; // updated by draw()

function setStatus(msg, ms = 3000) {
  statusMsg = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusMsg = ''; draw(); }, ms);
}

// ── Draw ──────────────────────────────────────────────────────────────────────
function draw() {
  const W = Math.max(40, process.stdout.columns || 80);
  const H = Math.max(8,  process.stdout.rows    || 24);
  const lines = [];

  // ── Description edit mode ─────────────────────────────────────────────────
  if (mode === 'desc') {
    const t = tasks.find(x => x.id === descTaskId);
    lines.push(`${A.bold} ✎ ${t?.title?.slice(0, W - 4) || ''}${A.R}`);
    lines.push('─'.repeat(W));
    const noteLines = (t?.note || '').split('\n');
    const noteH = H - 5;
    for (let i = 0; i < noteH; i++) {
      const l = noteLines[i] ?? '';
      lines.push(` ${A.dim}${l.slice(0, W - 2)}${A.R}`);
    }
    lines.push('─'.repeat(W));
    lines.push(` ${A.cyn}Notiz:${A.R} ${descBuf}${A.rev} ${A.R}`);
    lines.push(`${A.dim} Enter:Speichern  Esc:Abbrechen${A.R}`);
    process.stdout.write(A.clr + lines.join('\n'));
    return;
  }

  // Header
  const dateStr = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  const activeTask = activeSlot ? tasks.find(t => t.id === activeSlot.task_id) : null;
  let right = '';
  if (activeTask) {
    const s = elapsedSecs(activeSlot.started_at);
    right = `${A.cyn}⏱ ${activeTask.title.slice(0,22)}  ${fmtSecs(s)}${A.R}`;
  }
  const left = `${A.bold} DayTask — ${dateStr}${A.R}`;
  const gap = W - strip(left).length - strip(right).length;
  lines.push(left + ' '.repeat(Math.max(1, gap)) + right);
  lines.push('─'.repeat(W));

  // Task list
  listH = H - 4; // header(1) + sep(1) + sep(1) + footer(1)

  // Scroll: keep cursor in view
  ensureInView();

  const slice = tasks.slice(scrollOffset, scrollOffset + listH);
  const hasAbove = scrollOffset > 0;
  const hasBelow = scrollOffset + listH < tasks.length;

  for (let i = 0; i < listH; i++) {
    const t = slice[i];
    if (!t) {
      // Show scroll hint on last empty line
      if (i === 0 && hasAbove) lines.push(` ${A.dim}↑ mehr oben…${A.R}`);
      else lines.push('');
      continue;
    }

    const globalIdx = i + scrollOffset;
    const isSel    = globalIdx === cursor;
    const isActive = activeSlot?.task_id === t.id;

    // Scroll arrows on first/last visible
    let marker = isSel ? '▶' : ' ';
    if (i === 0 && hasAbove) marker = isSel ? '▶' : '↑';
    if (i === listH - 1 && hasBelow) marker = isSel ? '▶' : '↓';

    const check  = t.done ? '✓' : ' ';
    const prio   = t.priority ? '★' : ' ';

    const rightW = 8;
    let timeStr = '';
    if (isActive) {
      const s = elapsedSecs(t.running_since || activeSlot.started_at);
      timeStr = fmtSecs(s);
    } else if (t.total_seconds > 0) {
      timeStr = fmtSecs(t.total_seconds);
    }
    const timeField = timeStr.padStart(rightW);

    const titleW = W - 4 - rightW - 1;
    const noteHint = t.note ? '…' : ' ';
    const titleCut = t.title.slice(0, titleW - 1).padEnd(titleW - 1) + noteHint;

    if (isSel) {
      lines.push(A.rev + ` ${marker}${check}${prio} ${titleCut} ${timeField}` + A.R);
    } else {
      const cc = t.done ? A.dim : isActive ? A.cyn : '';
      const tc = t.done ? A.dim : isActive ? A.cyn : A.gray;
      lines.push(` ${marker}${cc}${check}${prio} ${titleCut}${A.R} ${tc}${timeField}${A.R}`);
    }
  }

  lines.push('─'.repeat(W));

  // Footer
  const posStr = tasks.length > listH ? `${A.dim}[${cursor + 1}/${tasks.length}]${A.R} ` : '';
  if (mode === 'input') {
    lines.push(` ${A.cyn}Neuer Task:${A.R} ${inputBuf}${A.rev} ${A.R}`);
  } else if (statusMsg) {
    lines.push(` ${statusMsg}`);
  } else {
    lines.push(`${posStr}${A.dim}j/k↑↓  Space:Timer  Enter:Notiz  s:Stop  d:Done  n:Neu  ^B/^F:Seite  q:Quit${A.R}`);
  }

  process.stdout.write(A.clr + lines.join('\n'));
}

// ── Actions ───────────────────────────────────────────────────────────────────
function reload() {
  tasks = loadTasks();
  activeSlot = getActiveSlot();
  scrollOffset = 0; // Reset scroll when reloading
  if (tasks.length && cursor >= tasks.length) cursor = tasks.length - 1;

  // Auto-focus active task
  if (activeSlot) {
    const activeIdx = tasks.findIndex(t => t.id === activeSlot.task_id);
    if (activeIdx >= 0) cursor = activeIdx;
  }

  draw();
}

function ensureInView(h = listH) {
  if (cursor < scrollOffset) scrollOffset = cursor;
  if (cursor >= scrollOffset + h) scrollOffset = cursor - h + 1;
  if (scrollOffset < 0) scrollOffset = 0;
  if (tasks.length > 0 && scrollOffset >= tasks.length) scrollOffset = Math.max(0, tasks.length - h);
}

function startTimer() {
  if (!tasks.length) return;
  const t = tasks[cursor];
  if (t.done) { setStatus(`${A.red}Task ist bereits erledigt${A.R}`); draw(); return; }
  if (activeSlot?.task_id === t.id) { setStatus('Timer läuft bereits'); draw(); return; }
  if (activeSlot) db.prepare('UPDATE timeslots SET stopped_at=? WHERE id=?').run(localNow(), activeSlot.id);
  const row = db.prepare('INSERT INTO timeslots (task_id, started_at) VALUES (?,?)').run(t.id, localNow());
  activeSlot = { id: row.lastInsertRowid, task_id: t.id, started_at: localNow() };
  setStatus(`${A.cyn}⏱ Gestartet: ${t.title.slice(0,40)}${A.R}`);
  tasks = loadTasks();
  draw();
}

function stopTimer() {
  if (!activeSlot) { setStatus(`${A.red}Kein aktiver Timer${A.R}`); draw(); return; }
  const title = tasks.find(t => t.id === activeSlot.task_id)?.title || '';
  db.prepare('UPDATE timeslots SET stopped_at=? WHERE id=?').run(localNow(), activeSlot.id);
  activeSlot = null;
  setStatus(`Gestoppt: ${title.slice(0,40)}`);
  tasks = loadTasks();
  draw();
}

function markDone() {
  if (!tasks.length) return;
  const t = tasks[cursor];
  if (activeSlot?.task_id === t.id) stopTimer();
  db.prepare('UPDATE tasks SET done=1 WHERE id=?').run(t.id);
  setStatus(`${A.grn}✓ Erledigt: ${t.title.slice(0,40)}${A.R}`);
  tasks = loadTasks();
  if (tasks.length && cursor >= tasks.length) cursor = tasks.length - 1;
  draw();
}

function markUndone() {
  if (!tasks.length) return;
  const t = tasks[cursor];
  db.prepare('UPDATE tasks SET done=0 WHERE id=?').run(t.id);
  setStatus(`↩ Zurückgesetzt: ${t.title.slice(0,40)}`);
  tasks = loadTasks(); draw();
}

function addTask() {
  const title = inputBuf.trim();
  inputBuf = ''; mode = 'list';
  if (!title) { draw(); return; }
  const today = localNow().split(' ')[0];
  db.prepare('INSERT INTO tasks (title, date) VALUES (?,?)').run(title, today);
  setStatus(`${A.grn}+ Erstellt: ${title.slice(0,40)}${A.R}`);
  tasks = loadTasks();
  cursor = 0; scrollOffset = 0;
  draw();
}

function openDesc() {
  if (!tasks.length) return;
  const t = tasks[cursor];
  descTaskId = t.id;
  descBuf = '';
  mode = 'desc';
  draw();
}

function saveDesc() {
  const note = descBuf.trim();
  if (note) {
    const t = tasks.find(x => x.id === descTaskId);
    const existing = (t?.note || '').trimEnd();
    const combined = existing ? existing + '\n' + note : note;
    db.prepare('UPDATE tasks SET note=? WHERE id=?').run(combined, descTaskId);
  }
  mode = 'list'; descBuf = ''; descTaskId = null;
  tasks = loadTasks();
  setStatus(`${A.grn}Notiz gespeichert${A.R}`);
  draw();
}

function quit() {
  process.stdout.write(A.clr + A.show);
  process.exit(0);
}

// ── Input ─────────────────────────────────────────────────────────────────────
let keyBuf = '', keyTimer = null;

function onKey(key) {
  if (mode === 'desc') {
    if (key === '\r' || key === '\n')          { saveDesc(); }
    else if (key === '\x1b')                   { mode = 'list'; descBuf = ''; descTaskId = null; draw(); }
    else if (key === '\x7f' || key === '\b')   { descBuf = descBuf.slice(0,-1); draw(); }
    else if (key.length === 1 && key >= ' ')   { descBuf += key; draw(); }
    return;
  }
  if (mode === 'input') {
    if (key === '\r' || key === '\n')          { addTask(); }
    else if (key === '\x1b')                   { inputBuf = ''; mode = 'list'; draw(); }
    else if (key === '\x7f' || key === '\b')   { inputBuf = inputBuf.slice(0,-1); draw(); }
    else if (key.length === 1 && key >= ' ')   { inputBuf += key; draw(); }
    return;
  }
  switch (key) {
    case 'j': case '\x1b[B': cursor = Math.min(tasks.length - 1, cursor + 1); draw(); break;
    case 'k': case '\x1b[A': cursor = Math.max(0, cursor - 1); draw(); break;
    case 'g':                cursor = 0; scrollOffset = 0; draw(); break;
    case 'G':                cursor = Math.max(0, tasks.length - 1); draw(); break;
    case '\x02':             cursor = Math.max(0, cursor - listH); draw(); break; // Ctrl+B
    case '\x06':             cursor = Math.min(tasks.length - 1, cursor + listH); draw(); break; // Ctrl+F
    case ' ':                startTimer(); break;
    case '\r': case '\n':    openDesc(); break;
    case 's':                stopTimer(); break;
    case 'd':                markDone(); break;
    case 'D':                markUndone(); break;
    case 'n':                mode = 'input'; inputBuf = ''; draw(); break;
    case 'r':                reload(); break;
    case 'q': case '\x03':   quit(); break;
  }
}

process.stdin.on('data', chunk => {
  keyBuf += chunk;
  clearTimeout(keyTimer);
  keyTimer = setTimeout(() => { const k = keyBuf; keyBuf = ''; onKey(k); }, 10);
});

// ── Boot ──────────────────────────────────────────────────────────────────────
if (!process.stdout.isTTY) {
  // Pipe mode: plain text output
  const slot = getActiveSlot();
  for (const t of loadTasks()) {
    const active = slot?.task_id === t.id ? ' ⏱' : '';
    const done   = t.done ? '[✓]' : '[ ]';
    const time   = t.total_seconds > 0 ? ' ' + fmtSecs(t.total_seconds) : '';
    console.log(`${t.id}\t${done} ${t.title}${active}${time}`);
  }
  process.exit(0);
}

process.stdout.write(A.hide);
process.on('exit',    () => process.stdout.write(A.show));
process.on('SIGINT',  quit);
process.on('SIGTERM', quit);
process.on('uncaughtException', err => {
  process.stdout.write(A.show);
  console.error('\nFehler:', err.message);
  process.exit(1);
});

process.stdout.on('resize', draw);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

setInterval(() => { if (activeSlot) draw(); }, 1000);

reload();
