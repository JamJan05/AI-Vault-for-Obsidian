# Changelog

## [Unreleased]

### Added
- **New models.** OpenAI: GPT-6 Sol (new default), GPT-6 Astra, GPT-6 Luna and GPT-5.6 Terra.
  Anthropic: Claude Sonnet 5.5 (new default) and Claude Opus 5.5. GPT-4o, GPT-4o Mini and
  Claude Haiku 4.5 remain available.
- Web sources cited by an OpenAI answer are listed under the message as links.
- A clear message when a Claude model declines a request, instead of "empty response".

### Changed
- **One model picker.** The chat header has a single picker that lists the models of every provider;
  choosing a model also selects its provider. The separate provider button is gone.
- **Saved models are migrated.** GPT-4 Turbo, GPT-5, GPT-5 Mini, GPT-5 Nano, GPT-5 Search,
  Claude Opus 4.5 and Claude Sonnet 4.5 are replaced with their closest current model on first load,
  with a notice. OpenAI shuts down GPT-4 Turbo on 2026-10-23.
- Thinking modes now map to each model's own reasoning effort. Claude models use adaptive thinking;
  the fixed thinking budget is only sent to Claude Haiku 4.5.
- Requests the provider rejects (HTTP 4xx other than 408 and 429) are no longer retried.

### Privacy
- OpenAI reasoning models are called through the Responses API (`/v1/responses`). Every such request
  is sent with `store: false`, which declines OpenAI's default 30-day storage of the response.
- Claude Sonnet 5.5 and Claude Opus 5.5 are sent with Anthropic's server-side refusal fallback: a
  declined request may be answered by another Claude model, and the message then names that model.
  No new host or company receives data.
- No new network hosts. See `PRIVACY.md`.

### Removed
- The "Auto-detect provider" setting, which never changed which provider was used.
- The `gpt-5-search-api` model; web search is now a toggle on every listed cloud model.

- Settings are now declared through `getSettingDefinitions()`, so every setting is discoverable in
  Obsidian's settings search on 1.13.0 and later. The imperative `display()` remains as the rendering
  path for Obsidian versions older than 1.13, driven by the same definitions.
- Narrowed the `settings` field to `declare settings: PluginSettings`, because Obsidian 1.13 declares
  `settings?: unknown` on `Plugin`.
- Raised the `obsidian` development dependency to 1.13.1 for the declarative settings typings.
  `minAppVersion` is unchanged at 1.7.2.

## [1.1.0] - 2026-07-25

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
