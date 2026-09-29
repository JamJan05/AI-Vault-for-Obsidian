# Changelog

## [Unreleased]

### Fixed
- The project dialog is built with Obsidian's element helpers instead of `document.createElement`.

### Release
- The release workflow now points the tag at the commit that sets the version, so `manifest.json`
  at the tag matches the published manifest. Before, the tag stayed on the previous commit and the
  repository manifest at the tag still named the old version.

## [1.5.0] - 2026-09-29

### Added
- **New models.** OpenAI: GPT-6 Sol (new default), GPT-6 Astra, GPT-6 Luna and GPT-5.6 Terra.
  Anthropic: Claude Sonnet 5.5 (new default) and Claude Opus 5.5. GPT-4o, GPT-4o Mini and
  Claude Haiku 4.5 remain available.
- **Sources open the passage that was used.** Clicking a source under an answer opens the note; for
  a note found by RAG it goes to the fragment the model was given and selects it. The lookup runs on
  your device.
- **Sources are saved with the conversation**, so they are still there when you open it from the
  history. Only the note's name, path and the first 200 characters of the fragment are stored, and
  they are never sent to a provider.
- Web sources cited by an OpenAI answer are listed under the message as links.
- A clear message when a Claude model declines a request, instead of "empty response".

### Changed
- **Simpler chat view.** The thinking mode is a menu next to Send instead of a bar of buttons. Learn
  and Code are one "conversation mode" menu, so they can no longer be on at the same time.
  Regenerate sits under the last answer, and export and re-index moved to a "more" menu in the header.
  The RAG badge is gone; the RAG button already shows the state.
- **Simpler settings.** The default thinking mode and the system prompt are grouped under "Chat";
  token limits and the context limit moved to "Advanced" at the bottom.
- The note picker is a standard Obsidian dialog: Escape closes it, and it searches the whole path.
- **One model picker.** The chat header has a single picker that lists the models of every provider;
  choosing a model also selects its provider. The separate provider button is gone.
- **Saved models are migrated.** GPT-4 Turbo, GPT-5, GPT-5 Mini, GPT-5 Nano, GPT-5 Search,
  Claude Opus 4.5 and Claude Sonnet 4.5 are replaced with their closest current model on first load,
  with a notice. OpenAI shuts down GPT-4 Turbo on 2026-10-23.
- Thinking modes now map to each model's own reasoning effort. Claude models use adaptive thinking;
  the fixed thinking budget is only sent to Claude Haiku 4.5.
- Requests the provider rejects (HTTP 4xx other than 408 and 429) are no longer retried.

### Privacy
- **API keys move to Obsidian's secret storage** on Obsidian 1.11.4 and newer. Settings keep only the
  names of the secrets, and the plugin no longer writes a key file there. Existing keys are moved
  automatically: each is written, read back, and only then are the old copies in `keys.json` and
  `data.json` deleted. Older Obsidian versions, and anyone who syncs their keys, are unchanged.
- The settings tab now says where the keys actually are, instead of one fixed warning.
- Sending to a remote Local API over plain HTTP now asks for confirmation before the first message,
  not only when the address is typed in settings.
- **The chat says what it is about to send.** A line above the input names the destination and lists
  what the next message carries: the conversation, attached notes, RAG fragments, project context and
  web search. It warns when a Local API is remote and unencrypted.
- **Semantic search is now opt-in.** Earlier versions sent the text of every indexed note to OpenAI
  for embeddings as soon as an OpenAI key was configured. The new **Semantic search** setting is off
  by default, for existing installs too, and turning it on shows what will be sent and asks for
  confirmation. Without it RAG uses keyword search, which never leaves the device.
- Questions are no longer sent to OpenAI for embedding when you chat with Claude or a local model,
  unless semantic search is on.
- New **Delete stored embeddings** button removes the vectors from the local index.
- Embedding responses are validated before use, and rejected embedding requests are not retried.
- OpenAI reasoning models are called through the Responses API (`/v1/responses`). Every such request
  is sent with `store: false`, which declines OpenAI's default 30-day storage of the response.
- Claude Sonnet 5.5 and Claude Opus 5.5 are sent with Anthropic's server-side refusal fallback: a
  declined request may be answered by another Claude model, and the message then names that model.
  No new host or company receives data.
- No new network hosts. See `PRIVACY.md`.

### Fixed
- Editing several notes within three seconds updated the RAG index for the last one only.
- The "recent" ranking boost was missing after a full re-index.
- The history limit of 100 removed conversations by creation order, which could delete one still in
  use. It now removes the ones used longest ago, and the history list is sorted the same way.
- Copy buttons on code blocks never appeared.
- Conversations were not auto-titled when the interface language was Polish.
- Stop had no effect on Local API requests.
- Two conversations or projects created in the same millisecond shared an id.
- Settings text fields wrote to disk on every keystroke.
- Regenerate could remove the wrong messages after a failed request.
- Stopping a request before any answer arrived left the question on screen but not in the
  conversation. The question is now returned to the input.
- Retrying on a fallback model showed the question twice.

### Review fixes
- Turning key sync off could leave the API keys in no file at all when SecretStorage refused them
  and the folder outside the vault was not active. The keys now stay in `data.json` in that case.
- A failed save of the history no longer turns a finished answer into an error.
- A second message can no longer start while the first is still collecting context.
- Closing the chat while a confirmation is open, or while notes are being read, cancels the
  message instead of sending it from a closed view.
- Claude Haiku 4.5 in Thinking mode failed when the token limit was set below 1024.
- Re-indexing with semantic search on no longer scans the whole index once per note.
- Quiz answers given as true/false are matched to the option text, whatever the order.
- Sources list only the attached notes that were actually read.

### Internal
- The chat view was split into smaller modules. Prompt assembly, quiz parsing, the model list and
  export are now separate, unit-tested modules. No behaviour change is intended.
- Quizzes written by a model are normalized to a fixed shape before they are drawn, with limits on
  the number of questions and options.
- Exported notes get file names that cannot contain path separators or link syntax.
- Unit tests grew from 185 to 413.

### Removed
- Unused code: barrel files, HTML and base64 helpers, leftover streaming code and 33 unused
  translation keys.
- The last interface strings that bypassed translation.
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
