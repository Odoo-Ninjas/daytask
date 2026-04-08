# Changelog

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
