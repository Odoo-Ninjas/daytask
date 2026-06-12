# Changelog

## v0.15.5

## Fixes
- Drei Befunde aus der dritten Review-Runde behoben: Quellcode-Leak der Web-Variante geschlossen (Case-/URL-Encoding-Bypass der Datei-Sperre, z.B. /SERVER.JS auf case-insensitivem macOS-Dateisystem); SSH-Hostnamen mit Unterstrich (z.B. zebroo_hetzner) werden wieder akzeptiert (Regression aus der Host-Validierung); GET /api/config liefert das web_token nicht mehr aus.


## v0.15.4

## Fixes
- Web-Variante secure-by-default: bindet jetzt nur noch an 127.0.0.1 (LAN/iPad-Zugriff per config.web_host="0.0.0.0" + config.web_token explizit aktivieren). Server-seitige Quelldateien (server.js, main.js, workingdir.js, preload.js, cli.js) werden nicht mehr ausgeliefert. SSH-Hosts werden validiert (verhindert ssh-Argument-Injection wie -oProxyCommand).


## v0.15.3

## Fixes
- Sicherheits-Nachzug: verbleibende Command-Injection im Git-Commits-/Clone-Abruf geschlossen (gh api via execFile, alle SSH/git-Aufrufe mit Shell-Escaping); Config-Speichern überschreibt die geteilte config-Referenz nicht mehr (Working-Dir nutzte sonst nach Änderung veraltete Pfade); web_token/web_host nicht mehr über die Web-API überschreibbar; Working-Dir öffnet jetzt zuverlässig in VS Code (PATH-unabhängig via open -a).


## v0.15.2

## Fixes
- Working-Dir-Feature gehärtet: Command-Injection beim Öffnen in VS Code / SSH-Branch-Checkout geschlossen (execFile + Shell-Escaping), Slug-Kollision zweier Tasks aufs selbe Verzeichnis verhindert, leere TASK.md-Metadatenzeilen entfernt, kein Überschreiben eines verschobenen Working-Dir mehr durch ein offenes Detailfenster. Web-Variante: optionales Auth-Token (config.web_token) und konfigurierbare Bind-Adresse (config.web_host) gegen ungeschützten LAN-Zugriff; Warnung beim Start ohne Token. Renderer-Logging unter Electron 38 wieder funktionsfähig.


## v0.15.1

## Misc
- Electron auf 38.8.6 angehoben (schließt alle relevanten Sicherheitslücken der 36er-Linie, u.a. PowerMonitor-/Fullscreen-Use-after-free, Command-Line-Switch-Injection, AppleScript-Injection); transitive Fixes für tmp und qs


## v0.15.0

## Features
- Frisch angelegte Aufgaben erscheinen sofort in der Liste, unabhängig vom aktiven Filter; mit der nächsten Filter-Aktion verschwinden sie wenn sie nicht zum Filter passen
- Neues Working-Dir pro Aufgabe: per "Anlegen" wird unter ~/ai/work/<Ticket-Slug> ein Verzeichnis mit vorausgefüllter TASK.md erstellt und in VS Code geöffnet. Beim Erledigen wandert es automatisch nach ~/ai/done, beim Zurückholen wieder nach ~/ai/work. Eigener VSCode-Button in der Aufgabenliste öffnet das Working-Dir direkt.

## Fixes
- Tasks mit Odoo-Stage "Abgeschlossen"/"Erledigt"/"Done"/"Cancel" werden lokal als erledigt erkannt, auch wenn Odoo `is_closed=False` zurückgibt; einmalige DB-Bereinigung räumt alte Inkonsistenzen auf
- Erledigte Aufgaben werden vom Odoo-Poll nicht mehr neu angelegt (Done bleibt persistent, auch ohne erfasste Zeit)


## v0.14.1

## Fixes
- Stempel-Button schreibt jetzt direkt in hr.attendance (create check_in / write check_out auf last_attendance_id) — die zuvor genutzte Methode attendance_action_change existiert in aktuellen Odoo-Versionen nicht mehr


## v0.14.0

## Features
- Neuer Stempel-Button in der Top-Leiste — toggelt die Odoo-Anwesenheit (hr.attendance) wie der Kiosk-Modus, mit Status-Lampe (grün=eingestempelt, rot=ausgestempelt)


## v0.13.0

## Features
- Beim Odoo-Poll werden lokale Tasks gelöscht, wenn der Odoo-Task gelöscht wurde oder man nicht mehr im user_ids steht (außer wenn lokal Zeiten erfasst sind)
- Erledigte Aufgaben ohne erfasste Zeit werden sofort gelöscht; neuer Button "Done History" zeigt erledigte Aufgaben mit Zeitstempel in Reihenfolge der Erledigung
- Neuer Kiosk-Toggle-Button in der Top-Leiste (🖥) — aktiviert/deaktiviert den Vollbild-Kioskmodus und zeigt seinen Status durch ein anderes Icon und Highlight an
- Statusfilter-Auswahl bleibt nach App-Neustart erhalten
- Beim sofortigen Löschen einer erledigten Aufgabe (keine Zeiten erfasst) erscheint kurz ein „Rückgängig"-Toast
- In den Task-Details gibt es einen "⏸ Warten"-Button um den Odoo-Status manuell auf Waiting zu setzen

## Fixes
- Nach Schließen der Task-Details öffnet sich das Hauptfenster wieder (vorher blieb die App unsichtbar)


## v0.11.1

## Fixes
- Cmd+Shift+T klappt das Fenster jetzt direkt unter dem Tray-Icon auf (statt nur Fokus zu togglen)


## v0.11.0

## Features
- Tasks werden archiviert statt gelöscht — verhindert, dass der Odoo-Poll gelöschte Tasks erneut anlegt. Mit aktivem Archiv-Filter sind sie schraffiert sichtbar und können per ↩-Button wieder zurückgeholt werden
- Klick auf einen Tag in der Tagesleiste öffnet die Odoo-Timesheets gefiltert auf das gewählte Datum
- Poll-Button (⟳) in der Top-Leiste — löst den Odoo-Poll für zugewiesene Tasks manuell aus statt nur alle 5 Minuten
- Neue Status-Filterleiste oben mit klickbaren Chips für die Odoo-Stages — Mehrfachauswahl möglich. Reihenfolge konfigurierbar in den Einstellungen (Default: progress, inbox, waiting, todo, abgeschlossen)
- Klick auf das Tray-Icon klappt das Fenster direkt unter dem Menüleisten-Icon auf (statt am rechten Bildschirmrand). Klick außerhalb schließt das Fenster komplett — keine schwebende Mini-Bar mehr. Erneuter Klick auf das Icon togglet
- Fensterhöhe per Maus am unteren Rand draggable — die gewählte Höhe wird persistent gespeichert und nach Neustart wiederhergestellt

## Fixes
- Tray-Icon ist jetzt ein echtes Template-Icon (transparenter Hintergrund) — kein weißes Quadrat mehr in der Menüleiste

## Misc
- Fensterbreite von 560 auf 720 Pixel erhöht — mehr Platz für Task-Titel und Badges


## v0.10.0

## Features
- Drag the collapsed mini-bar to move the window without having to expand first; a plain click still expands as before

## Fixes
- Fix main window and tray not refreshing after task title/link changes from the task details window — previously only collapse/expand triggered a reload


## v0.9.1

Release v0.9.1
## v0.9.1

## Features
- Web/PWA mode: `npm run web` startet einen Express-Server — DayTask läuft damit in jedem Browser und ist als PWA installierbar (iPad, Desktop)
- Service Worker für Offline-Fähigkeit und PWA-Install-Prompt
- `dt` CLI-Binary (`npx dt` oder global installiert) für schnellen Zugriff auf Tasks im Terminal
- Keyboard-Navigation in der Task-Liste: ArrowUp/Down bewegt den Fokus, Enter öffnet den Task, Ctrl+B/F scrollt seitenweise

## Fixes
- Fix update check showing "Neue Version: v" when GitHub API returns no tag_name (e.g. 404 for private repos)
- Fix task-list overflow: `min-height: 0` auf task-list-wrap damit Flex-Scrolling korrekt funktioniert

## v0.8.0

Release v0.8.0
## v0.8.0

## Features
- Drag the collapsed mini-bar to move the window without having to expand first; a plain click still expands as before

## Fixes
- Fix main window and tray not refreshing after task title/link changes from the task details window — previously only collapse/expand triggered a reload


## v0.7.0

## Features
- Neue Projekte bekommen beim Odoo-Poll automatisch ein Stage-Mapping angelegt (In Progress/Waiting/Done werden per Keyword erkannt)
- Klick auf das "x ausstehend" Badge in der Taskliste lädt die Timeslots direkt hoch (oder öffnet die Odoo-Verknüpfung wenn nicht verlinkt)
- Pin-Button im Header verhindert das automatische Einklappen des Hauptfensters
- Prio-Button (Stern) in Übersicht und Task-Detail — priorisierte Tasks werden in der Liste nach oben sortiert
- Quick-add project input searches Odoo tasks too — picking a task directly fills project + task in one step instead of two separate searches
- Link or change the Odoo task directly from the task details window without going back to the main window
- Task picker dropdown shows matching projects directly below the search term with a + button to create the typed task in any project without re-typing the query
- Task-Detail-Fenster hat jetzt Start/Stop/Erledigt/Wieder-Offen Buttons

## Fixes
- Sammelaufgaben werden beim Odoo-Poll nicht mehr auf "done" gesetzt — ihr lokaler Status bleibt erhalten
- Fix silent failure when creating a new Odoo task from quick-add: strip time component from deadline and surface Odoo errors via toast so the task is actually linked
- Fix EIO crash in main process when stdout/stderr are closed (packaged builds during Odoo polling)
- Stage Auto-Erkennung liest jetzt alle konfigurierten Sprachen — Deutsch/English-Stages werden korrekt zugeordnet
- Lokal erledigte Tasks kommen nicht mehr zurück, wenn Odoo sie noch als offen führt — done=1 bleibt bis zum manuellen "wieder offen"


## v0.6.0

## Features
- Großes Task-Fenster mit Sidebar-Tabs (Details, Zeit, Nachricht, Verlauf) — Reiter "Nachricht senden" postet via message_post in den verknüpften Odoo-Task


## v0.5.1

## Fixes
- Ticketnummern werden korrekt aus sequence_name gelesen statt aus dem nicht existenten Feld 'no'


## v0.5.0

## Features
- Projekt-/Tasksuche läuft jetzt mehrsprachig (en_US, de_DE konfigurierbar) und das Settings-Fenster wurde im Discord-Stil mit Sidebar-Navigation neu gestaltet
- Odoo Tasksuche findet jetzt auch Ticketnummern und zeigt sie in der Ergebnisliste an
- Search shows Odoo tasks alongside local results, click to create+link


## v0.4.0

## Features
- Auto-detect stage mappings from Odoo projects on settings open
- Auto-save task fields on blur, save before upload
- Combine all pending timeslots into one Odoo timesheet entry per task
- Show 'Task erstellen' option in Odoo task dropdown when no match found
- Create new Odoo task directly from the link-task search dialog
- Default deadline to today 17:00 when creating new tasks
- Set Odoo task to Done stage when marking task as done (except collective tasks)
- Configurable keywords for collective tasks that skip Done stage
- Poll syncs task title and Odoo label from Odoo on each update
- Settings auto-save on every field change without manual save button
- Show Odoo task link in task detail overlay

## Fixes
- Fix upload button in task details not showing for tasks with pending slots
- Fix npm start in VSCode terminal (ELECTRON_RUN_AS_NODE conflict)
- Poll no longer overwrites local task title with Odoo task name
- Fix task meta badges wrapping and simplify pending label to Nx
- Poll also updates stage/status of locally linked tasks not assigned to user


## v0.3.3

## Features
- Auto-set Odoo stage on timer start/stop (In Progress / Waiting)
- Mandatory deadline field (date + time) when creating new tasks
- Only poll open tasks from Odoo (is_closed=false)
- Poll syncs deadline and done-status from Odoo stage changes
- Improved task search: split query into words matching name or project
- Odoo-based autocomplete for project and stage selection in settings
- Show app version in footer
- Show total tracked time in task detail overlay
- Upload button in task details to sync unsynced timeslots to Odoo
- Upload filter button to show tasks with pending timeslots across all dates

## Fixes
- Auto-skip timeslots shorter than 36 seconds when syncing
- Fix Windows: mini-bar click now expands window reliably
- Fix preload crash from package.json import breaking all IPC on Windows
- Fix Windows: collapsed window no longer blocks clicks on area behind it


## v0.3.2

Release v0.3.2
## v0.3.1

Release v0.3.1
## v0.3.0

Release v0.3.0
## v0.2.2

Release v0.2.2
## v0.2.1

Release v0.2.1
## v0.2.0

## Features
- DayTask app - initial release
- Round up to next 15min when syncing to Odoo
- Show pending/unsynced timeslots badge for all tasks (not just unlinked ones)
- Show total unsynced time in footer

## Fixes
- Fix CSP blocking inline scripts
- Fix release: only NSIS installer for Windows
- Fix timer double-counting in task list (list showed wrong elapsed time)
- Fix Windows click-through in mini mode
- Fix CSS rendering on Windows

## Misc
- Add electron-builder config and GitHub Actions release workflow


## v0.1.0

### Features
- DayTask app - initial release
- Round up to next 15min when syncing to Odoo
- Show pending/unsynced timeslots badge for all tasks (not just unlinked ones)
- Show total unsynced time in footer

### Fixes
- Fix release: only NSIS installer for Windows
- Fix CSS rendering on Windows
- Fix Windows click-through in mini mode
- Fix CSP blocking inline scripts
- Fix timer double-counting in task list (list showed wrong elapsed time)

### Misc
- Add electron-builder config and GitHub Actions release workflow
