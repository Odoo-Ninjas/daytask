# Changelog

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
