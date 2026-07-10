// Stopp laufender Agenten (Claude Code / opencode / …) in einem Arbeitsverzeichnis.
//
// Ausgelöst von der comm-App: erkennt deren Triage in einer eingehenden
// Kundennachricht einen ausdrücklichen Stopp-Wunsch ("stopp", "halt", …), ruft
// comm den DayTask-Endpoint /api/comm/stop-work auf. DayTask ermittelt die
// betroffenen working_dir(s) (Tasks mit passendem comm_meta) und stoppt hier
// den/die Agenten:
//   1) Marker-Datei .STOP ins Verzeichnis schreiben (kooperativ auswertbar,
//      tool-neutral — auch für opencode & Co. sowie für Nachvollziehbarkeit),
//   2) Prozesse finden, deren cwd == working_dir (oder ein Unterordner davon)
//      ist UND deren Command in der Allowlist steht, und ihnen ein Signal
//      senden (Default SIGINT ≈ Esc: unterbricht den laufenden Turn, ohne die
//      Session zu killen; hart via config.stop_agent_signal="SIGTERM").
//
// Bewusst tool-agnostisch: die Allowlist (config.stop_agent_commands) bestimmt,
// welche Prozesse als "Agent" gelten — so lässt sich opencode/andere ergänzen.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Prozesse mit ihrem aktuellen Arbeitsverzeichnis (cwd) auflisten — nur solche,
// deren Command-Name in `commands` beginnt (lsof -c ist ein Präfix-Match und
// case-sensitiv: "claude" trifft die CLI, nicht die Desktop-App "Claude Helper").
// Rückgabe: [{pid, command, cwd}]. Best effort — lsof-Fehler => [].
function listAgentProcs(commands) {
  return new Promise((resolve) => {
    const cmds = (commands || []).filter(Boolean);
    if (!cmds.length) return resolve([]);
    // -a = UND-Verknüpfung der Filter, -d cwd = nur der cwd-Deskriptor,
    // -F pcfn = maschinenlesbar (p=pid, c=command, f=fd, n=name/pfad).
    const args = ['-a', '-d', 'cwd', '-Fpcfn'];
    for (const c of cmds) args.push('-c', c);
    execFile('lsof', args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // lsof endet mit Exit 1, wenn manche fds nicht lesbar sind — stdout trotzdem nutzen.
      if (!stdout) return resolve([]);
      const procs = [];
      let cur = null;
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const tag = line[0], val = line.slice(1);
        if (tag === 'p') { cur = { pid: parseInt(val, 10), command: '', cwd: '' }; procs.push(cur); }
        else if (tag === 'c' && cur) cur.command = val;
        else if (tag === 'n' && cur) cur.cwd = val;
      }
      resolve(procs.filter(p => p.pid && p.cwd));
    });
  });
}

// Gehört `cwd` zum Zielverzeichnis `dir` (identisch oder ein Unterordner)?
function underDir(cwd, dir) {
  if (!cwd || !dir) return false;
  return cwd === dir || cwd.startsWith(dir.replace(/\/+$/, '') + '/');
}

// Ein einzelnes Arbeitsverzeichnis stoppen: Marker schreiben + passende Agenten
// signalisieren. `meta` (reason/source/conversation/sender) landet in der
// .STOP-Datei. `config` liefert Allowlist + Signal. Rückgabe:
// {dir, marker:bool, signaled:[{pid,command,signal}], errors:[...]}.
async function stopWorkingDir(dir, meta, config) {
  const result = { dir, marker: false, signaled: [], errors: [] };
  if (!dir || !fs.existsSync(dir)) { result.errors.push('dir fehlt'); return result; }

  // 1) Marker-Datei — Grundwahrheit „hier wurde ein Stopp verlangt", auch wenn
  //    gerade kein Prozess läuft (ein später gestarteter Agent kann sie lesen).
  try {
    const payload = {
      ts: new Date().toISOString(),
      reason: (meta && meta.reason) || '',
      source: (meta && meta.source) || '',
      conversation: (meta && meta.conversation) || '',
      sender: (meta && meta.sender) || '',
    };
    fs.writeFileSync(path.join(dir, '.STOP'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    result.marker = true;
  } catch (e) { result.errors.push('marker: ' + e.message); }

  // 2) Laufende Agenten in diesem Verzeichnis signalisieren.
  if (config && config.stop_signal_agents === false) return result;
  const commands = (config && config.stop_agent_commands) || ['claude', 'opencode'];
  const signal = (config && config.stop_agent_signal) || 'SIGINT';
  // lsof meldet cwds immer als aufgelöste Pfade (z.B. /private/tmp statt /tmp,
  // symlink-freie Home-Pfade). Zielverzeichnis daher ebenfalls auflösen, damit
  // der Vergleich auch bei symlink-behafteten Pfaden greift.
  let realDir = dir;
  try { realDir = fs.realpathSync(dir); } catch { /* Fallback: unaufgelöst */ }
  let procs = [];
  try { procs = await listAgentProcs(commands); }
  catch (e) { result.errors.push('lsof: ' + e.message); }
  for (const p of procs) {
    if (p.pid === process.pid) continue; // niemals sich selbst
    if (!underDir(p.cwd, realDir) && !underDir(p.cwd, dir)) continue;
    try {
      process.kill(p.pid, signal);
      result.signaled.push({ pid: p.pid, command: p.command, signal });
    } catch (e) {
      // ESRCH = schon weg (ok); EPERM = kein Recht (fremder User) — beides melden.
      result.errors.push(`kill ${p.pid} (${e.code || e.message})`);
    }
  }
  return result;
}

module.exports = { stopWorkingDir, listAgentProcs, underDir };
