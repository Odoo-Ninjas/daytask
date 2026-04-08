# DayTask

Minimaler Daily-Task-Tracker mit Odoo Timesheet Sync – als macOS Menu-Bar-App.

## Setup

```bash
cd daytask
npm install
npx electron-rebuild   # Native Module für Electron kompilieren
npm start
```

> **Hinweis:** `npx electron-rebuild` ist nach jedem `npm install` nötig, da `better-sqlite3` für die Electron Node-Version kompiliert werden muss.
>
> Falls `npm start` in einem VSCode-Terminal nicht funktioniert: VSCode setzt `ELECTRON_RUN_AS_NODE=1`, was Electron als normalen Node-Prozess startet. Das Script entfernt die Variable automatisch, aber bei Problemen: `unset ELECTRON_RUN_AS_NODE && npm start`

## Was es kann

- **Floating Window** – immer sichtbar, rechts oben
- **Schnell Task anlegen** – Titel eingeben, Enter. Optional Ticket-Referenz (#JIRA-123, #42 etc.)
- **Timer starten/stoppen** – ▶ Button pro Task
- **Odoo Sync** – beim Stop wird automatisch ein `account.analytic.line` Eintrag angelegt
- **Menu-Bar** – zeigt aktiven Task + Laufzeit

## Odoo konfigurieren

App starten → ⚙ → Server URL, DB, User, Passwort eintragen → Speichern.

Odoo API-Key statt Passwort geht auch (empfohlen): Odoo → Einstellungen → Benutzer → API-Schlüssel.

## Daten

- SQLite DB: `~/.daytask.db`
- Config: `~/.daytask.json`

## Nächste Schritte (Erweiterungen)

- [ ] SSH-Erkennung: `ps aux | grep ssh` pollen → Task-Vorschlag
- [ ] Browser-URL via AppleScript auslesen → Auto-Tag
- [ ] Ticket-URL aus Referenz aufbauen (Jira/GitHub/Linear)
- [ ] Wochensummary
- [ ] Odoo-Projekte aus API laden (Dropdown statt ID)
