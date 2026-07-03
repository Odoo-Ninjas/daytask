# DayTask

Minimaler Daily-Task-Tracker mit Odoo Timesheet Sync – als Web-App (lokaler Server + Browser/PWA).

## Setup

```bash
cd daytask
npm install
npm run web      # startet den Server (Default-Port 3000)
```

Dann im Browser `http://localhost:3000` öffnen. `npm start` ist ein Alias für `npm run web`.

> **Hinweis:** `better-sqlite3` wird bei `npm install` als natives Modul für dein
> installiertes Node kompiliert. Bei ABI-Fehlern (`NODE_MODULE_VERSION`): `npm rebuild better-sqlite3`.

### Port / Netzwerk

- Port über `PORT=3001 npm run web` überschreibbar.
- Der Server bindet auf alle Interfaces und zeigt beim Start die LAN-URLs an
  (z.B. fürs iPad → Safari → „Zum Home-Bildschirm" installiert die PWA).
- Für den LAN-Zugriff ist ein Token nötig (`?token=…` in der URL, danach in localStorage);
  localhost ist ohne Token erreichbar.

## Was es kann

- **Task-Liste im Browser / als PWA** – installierbar auf iPad/Desktop
- **Schnell Task anlegen** – Titel eingeben, Enter. Optional Ticket-Referenz (#JIRA-123, #42 etc.)
- **Timer starten/stoppen** – ▶ Button pro Task
- **Odoo Sync** – beim Stop wird automatisch ein `account.analytic.line` Eintrag angelegt

## Odoo konfigurieren

Web-UI öffnen → ⚙ → Server URL, DB, User, Passwort eintragen → Speichern.

Odoo API-Key statt Passwort geht auch (empfohlen): Odoo → Einstellungen → Benutzer → API-Schlüssel.

## CLI

`dt` (siehe `bin` in `package.json`) bietet einen Terminal-Client auf dieselbe DB.

## Daten

- SQLite DB: `~/.daytask.db`
- Config: `~/.daytask.json`
