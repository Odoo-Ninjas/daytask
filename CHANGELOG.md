# Changelog

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
