# Changelog

## [Unreleased]

### Added
- **Ignored RAG paths** (`Settings → AI-Vault → RAG`): exclude folders or files from RAG with one pattern
  per line, for example `Assets/**`, `Unsorted/**` or `*.canvas`. Matching notes are never indexed,
  never sent to the embeddings model, never used as RAG context and never listed as sources.
  Patterns support `*`, `**` and comments (`#`), and are matched case-insensitively against
  vault-relative paths.

### Changed
- Notes excluded from RAG are no longer pulled in indirectly by `[[wikilink]]` expansion of a manually
  attached note. Notes attached manually are still sent, as an explicit user choice.
- Existing indexes are filtered at query time and swept on load, so the setting takes effect before a
  reindex and stored chunks of newly ignored notes are removed from `rag-index.json`.

## [1.0.7] - 2026-07-11

### Fixed
- Replaced direct `fetch()` calls with Obsidian `requestUrl()` for OpenAI and Anthropic requests.
- Moved static chat-view styles to CSS and kept only dynamic values in `setCssProps()` or `setCssStyles()`.
- Removed unsafe Node module loading and tightened external-storage response and error types.
- Fixed fallback modal promise handling, unused imports, empty expressions, and unnecessary type assertions.
- Replaced vault-wide wikilink lookup with Obsidian `MetadataCache` resolution.

### Security and release
- Documented the narrowly scoped uses of desktop file access, vault enumeration, and clipboard writes.
- Added build provenance attestations for `main.js` and `styles.css` release assets.

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
