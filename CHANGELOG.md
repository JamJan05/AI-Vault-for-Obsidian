# Changelog

## [1.0.2] - 2026-05-21

### Fixed
- Security: replaced unsafe HTML insertion with Obsidian DOM APIs.
- UI: use `Setting().setHeading()` for consistent Settings sections.
- Theming: replaced direct inline style manipulation with CSS classes or `setCssProps()`.
- Compatibility: updated `minAppVersion` to Obsidian 1.7.2 for `Workspace.revealLeaf()`.
- Compatibility: use `window.setTimeout()` and `window.clearTimeout()` for popout-safe timers.
- Compatibility: use `ownerDocument` instead of global `document` in views.
- Types: removed unsafe `any` and `TFile` casts in repaired code paths.
- Promises: awaited `revealLeaf()` and handled unload save failures.
- Mobile: replaced native `confirm()` calls with Obsidian modal dialogs.

### Changed
- Desktop-only: plugin now requires desktop Obsidian because SSE streaming and external storage rely on desktop APIs.

## [1.0.1] - 2026-05-12

### Fixed
- Removed "Obsidian" from plugin description per community guidelines.

## [1.0.0] - 2026-05-12

Initial release.
