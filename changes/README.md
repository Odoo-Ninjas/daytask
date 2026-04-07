# Changelog Fragments

Each pull request should include a changelog fragment file in this directory.

## Naming

Files are named `<description>.<type>` where `<type>` is one of:

- **feature** - New features or enhancements
- **fix** - Bug fixes
- **misc** - Other changes (docs, refactoring, CI, etc.)

## Content

Each file contains a single line describing the change from the user's perspective.

## Example

File: `changes/timer-fix.fix`

```
Fix timer double-counting in task list
```

## What happens on release

The release workflow collects all fragment files, groups them by type, appends
a new section to `CHANGELOG.md`, and deletes the fragments.
