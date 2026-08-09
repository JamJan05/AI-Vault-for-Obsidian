# AI-Vault — Code Analysis

> Static review of the source tree at version **1.0.9**, branch `main`, commit `064aa87`.
> Architecture and module reference live in [`ARCHITECTURE.md`](ARCHITECTURE.md).
> Every finding below cites `file:line` and was verified against the current source — nothing here is
> inferred from documentation alone.

---

## 1. Metrics

| Metric | Value |
| --- | --- |
| TypeScript source | 6 677 lines / 29 files |
| Largest module | `src/views/ChatView.ts` — 1 524 lines (23 % of the codebase) |
| Second largest | `src/SettingsTab.ts` — 739 lines |
| i18n | 296 keys × 2 languages; 35 keys unreferenced |
| Stylesheet | `styles.css` — 652 lines, 228 `.gpt-*` selectors |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, 131 warnings — 122 `prefer-create-el`, 9 `ui/sentence-case`; 100 auto-fixable |
| Test suite | none |
| Runtime dependencies | none |
| `any` in source | none — external payloads go through type guards |

Distribution by layer:

| Layer | Lines | Share |
| --- | --- | --- |
| Views + settings UI | 2 859 | 43 % |
| i18n | 722 | 11 % |
| RAG | 689 | 10 % |
| API clients | 611 | 9 % |
| Storage | 489 | 7 % |
| Entry point | 431 | 6 % |
| History / projects | 305 | 5 % |
| Foundation (utils, models, types, settings, constants) | 571 | 9 % |

---

## 2. Strengths

These are worth protecting during any refactor.

1. **Acyclic layering with structural interfaces.** No module imports the concrete `GPTPlugin`; each
   declares the minimal shape it needs (`RAGEngine.PluginWithDeps`, `HistoryManager.PluginWithStorage`,
   …). The dependency graph is a DAG without any DI framework.
2. **One network chokepoint.** `requestCompletion` (`src/api/streaming.ts:88`) centralizes transport,
   abort racing, HTTP error mapping, provider-error detection and usage normalization. Provider
   differences are reduced to a body builder plus an `extractText` callback.
3. **Data-loss-aware caching.** `HistoryManager.getMessages` (`src/history/HistoryManager.ts:60`)
   distinguishes "file absent" from "read failed" and refuses to cache the failure case, with a comment
   explaining that caching it would let the next save overwrite real history. This is the kind of bug
   most codebases only fix after losing user data.
4. **Atomic external writes.** `ExternalStorage.writeJson` (`src/storage/ExternalStorage.ts:259`) writes
   `<file>.tmp` and renames, so an interrupted write cannot truncate the RAG index or history.
5. **No unchecked casts on external data.** HTTP responses, `.canvas` JSON, the persisted RAG index,
   Node module shapes and model-generated quiz JSON all pass through explicit type guards.
6. **Migration discipline.** Five legacy formats are handled non-destructively (see
   `ARCHITECTURE.md` §7.3), each guarded so it runs at most once.
7. **Comments explain rationale.** `src/storage/ExternalStorage.ts:117-119` records why static imports
   replaced dynamic `import()`; `src/utils.ts:51` records why aborts are never retried;
   `src/rag/RAGEngine.ts:44-52` records why RRF replaced weighted scoring.
8. **CI enforces release hygiene.** `validate.yml` makes a hand-bumped version fail the build, and
   `release.yml` attaches build provenance attestations to the shipped assets.

---

## 3. Findings

Severity reflects user-visible impact, not effort. **F-1 … F-4** are the ones worth fixing first.

### F-1 · High · Streaming scaffolding is unreachable, and the feature is silently absent

`requestCompletion` forces `stream: false` (`src/api/streaming.ts:98`) and calls
`onChunk(text)` exactly once with the finished answer (`:140`). Everything in `ChatView` built for
incremental rendering can therefore never run as intended:

- `RENDER_INTERVAL_MS` throttling and `lastRenderTime` (`src/views/ChatView.ts:953-962`) always see a
  single call, so the throttle never engages.
- The typing cursor `renderPlainTextContent(el, partial, true)` (`:959`, `:1323`) flashes once at most.
- The abort-with-partial-answer branch (`:1029-1036`) is dead: the only way to have partial text is to
  abort mid-stream, and there is no stream. Aborting always lands in the `isAbort && !partial` branch.

This is a legitimate consequence of the `requestUrl()` requirement, but the code reads as if streaming
works. `README.md` also advertises "Cancelable responses", which in practice means *cancel before the
single response arrives*.

**Fix direction:** either delete the dead paths and document the non-streaming design, or keep them
behind a clearly named `SUPPORTS_STREAMING = false` constant so the intent is explicit.

### F-2 · High · Code-block copy buttons never appear

`addCodeCopyButtons` (`src/views/ChatView.ts:1326`) queries
`.gpt-code-block pre[data-rawcode]`. Nothing in the codebase ever produces that markup — the custom
markdown renderer that did was replaced by `MarkdownRenderer.render`, which emits Obsidian's own
`<pre><code>` structure. Consequences:

- The per-code-block "Copy" button advertised in `README.md` ("copy messages and code blocks") is
  missing at runtime.
- `base64ToUtf8` (`src/utils.ts:95`) is only used inside this dead path, and its counterpart
  `utf8ToBase64` (`:88`) has no callers at all.
- `.gpt-code-block` styling (`styles.css:276`) is dead CSS.

**Fix direction:** re-target the selector at what Obsidian actually renders
(`container.querySelectorAll("pre > code")`, walking up to the `<pre>`) and read the code text from
`codeEl.textContent` instead of a base64 attribute — which also removes the need for both base64
helpers.

### F-3 · High · API keys are blanked in memory right after migration

`_loadApiKeys` (`src/main.ts:362-379`) writes the legacy keys into `keys.json`, deletes them from the
settings object, saves, and then attempts to restore them:

```ts
delete (this.settings as unknown as Record<string, unknown>).apiKey;
// …
this.settings.apiKey = this.settings.apiKey ?? "";   // always "" — the field was just deleted
```

Each of the three restore lines resolves to `""`. `keys.json` on disk is correct, but for the rest of
the session the in-memory keys are empty, so the first request after migration fails with
"no API key" until Obsidian is restarted. The migration notice
(`notice_keys_migrated`) makes this look like a success.

**Fix direction:** capture the three values into locals before deleting, then assign the locals back.

### F-4 · Medium-high · The file-modify debounce is global, not per file

`main.ts:59-61` wraps `rag.updateFile` in a single `debounce(…, 3000)` instance and the comment claims
"max once per 3s per file". `debounce` (`src/utils.ts:16`) keeps **one** timer and one pending argument
list, so editing file A and then file B within 3 s discards A's update entirely — A's index entries stay
stale until a full re-index. This is easy to hit with search-and-replace across notes or with
sync-driven bulk modifications.

**Fix direction:** key the debounce by `file.path` (a `Map<string, timer>`), or collect paths into a
pending `Set` and flush them all when the timer fires.

### F-5 · Medium · `autoDetectProvider` has no effect

`ChatView.getEffectiveProvider` (`src/views/ChatView.ts:502-506`):

```ts
if (!this.settings.autoDetectProvider) return this.settings.provider;
const detected = detectProvider(model);
return detected === this.settings.provider ? detected : this.settings.provider;
```

Both branches return `this.settings.provider`, so the toggle in
`SettingsTab.renderModelSelector` (`:268-278`) changes nothing that reaches a request. Either the
detection should win when it disagrees, or the setting should be removed. Right now the settings UI
advertises behaviour the code does not implement.

### F-6 · Medium · `recent` search mode cannot work on a freshly built index

`RAGEngine.search` applies the recency bonus only when `s.entry.mtime` exists
(`src/rag/RAGEngine.ts:357`), but `buildIndex` constructs entries **without** `mtime`, `folder` or
`extension` (`:258-265`). Only the incremental `updateFile` path populates them (`:401-411`). So after a
full re-index the recency boost silently disappears, and reappears file-by-file as notes get edited —
non-deterministic ranking behaviour. `RAGSearchMode` also has no settings UI at all, so `hybrid` is the
only mode a user can select; `semantic`, `exact` and `recent` are reachable only by hand-editing
`data.json`.

**Fix direction:** populate the three fields in `buildIndex` exactly as `updateFile` does (a shared
`createEntry(file, chunk)` helper would prevent the drift from recurring), and expose `ragSearchMode` in
settings or drop it from `PluginSettings`.

### F-7 · Medium · Settings text fields write files on every keystroke

Every `addText`/`addTextArea` handler in `SettingsTab` calls `await this.plugin.saveSettings()` inside
`onChange` (e.g. `:311`, `:372`, `:385`, `:539`, `:702`). Obsidian fires `onChange` per keystroke, and in
local-key mode `saveSettings` (`src/main.ts:318-338`) writes **two** files per call (`keys.json` +
`data.json`, the former with a tmp-write and rename). Typing a 400-character system prompt therefore
performs on the order of 800 file writes. Nothing breaks, but it is needless disk churn and the
interleaved async writes are a plausible source of the historical "settings toggle" flakiness.

**Fix direction:** debounce persistence for free-text fields (300–500 ms), keeping immediate saves for
toggles, dropdowns and buttons.

### F-8 · Medium · Session cap evicts by insertion order, not age

`saveSession` (`src/history/HistoryManager.ts:118-132`) upserts in place for existing sessions and
`unshift`s new ones, then `splice(100)` to cap the list. Since an updated session keeps its old
position, `this.sessions` is ordered by *first save*, not by `updatedAt`. A long-running conversation
that was created early can be evicted — with its message file deleted — while newer but untouched
sessions survive. `HistoryView` also renders in this raw order, so the sidebar is not reliably
newest-first.

**Fix direction:** sort by `updatedAt` descending before capping (and before rendering).

### F-9 · Medium · Chat state and DOM diverge on a failed request

In the generic error branch of `sendMessage` (`src/views/ChatView.ts:1058-1067`) the user message is
removed from state (`this.messages.pop()`) while both the user bubble and the error bubble stay in the
DOM. `regenerateLastMessage` (`:1253-1263`) then computes a DOM cut-off from a `this.messages` index:

```ts
const idx = this.messages.length - 1 - lastUserIdx;
const allMsgs = this.chatContainer.querySelectorAll(".gpt-msg");
for (let i = allMsgs.length - 1; i >= idx; i--) allMsgs[i].remove();
```

That mapping assumes a 1:1 correspondence between `messages` entries and `.gpt-msg` nodes. After any
failed request the counts differ, so regenerate can delete the wrong bubbles. Two smaller related
issues: `bubble.parentElement!` (`:1003`) and `this.sendBtn.parentElement!` (`:1213`) are non-null
assertions on DOM lookups, and the error branch does not remove the stale user bubble.

**Fix direction:** either remove the user bubble too when popping the message, or index bubbles by a
`data-msg-index` attribute instead of relying on positional equality.

### F-10 · Low-medium · Empty sessions leave orphaned message files

`saveSession` only writes the body when `session.messages?.length` is truthy
(`src/history/HistoryManager.ts:102`). If a session's messages are cleared, the previous
`session-<id>.json` is neither overwritten nor deleted, and `getMessages` will happily return the stale
content on the next load.

### F-11 · Low-medium · `Date.now().toString()` used as an id

Both `HistoryManager.newSession` (`:88-97`) and `ProjectManager.createProject`
(`src/history/ProjectManager.ts:53`) derive ids from `Date.now()`. Two projects created in the same
millisecond — or a session created programmatically in the same tick as another — collide, and for
sessions a collision means two conversations sharing one message file.

**Fix direction:** append a short random suffix, or use `crypto.randomUUID()` (available in Electron).

### F-12 · Low · Untranslated Polish and English strings in a bilingual plugin

The plugin is advertised as fully localized, but these bypass `i18n`:

| Location | String |
| --- | --- |
| `src/views/ProjectsView.ts:285` | `"Zapisz"` (Save) |
| `src/views/ProjectsView.ts:87`, `162`; `src/views/HistoryView.ts:63` | `aria-label` `"Zamknij"`, `"Edytuj"` |
| `src/storage/ExternalStorage.ts:323` | `"External storage nieaktywny"` (mixed-language error) |
| `src/rag/canvasParser.ts:130`, `133`, `137` | `### Plik:`, `### Link:`, `## Grupa:` |
| `src/history/ProjectManager.ts:131` | fallback title `"Rozmowa"` |
| `src/views/ChatView.ts:194`, `196` | `"⏳ Indexing vault…"`, `"⏳ Indexing… n/total"` |
| `src/views/ChatView.ts:1394`, `1418`, `1439`, `1444` | `"Question n of m"`, `"✅ Correct!"`, `"Checking…"` |
| `src/views/ChatView.ts:1345-1346` | code-copy `"Copy code"` / `"Copy"` (in the dead path from F-2) |
| `src/views/ChatView.ts:1088`, `1092-1093` | code-mode prompt rules hardcoded in English between translated ones |

Section headers in `SettingsTab` are also inconsistently composed: some emoji live in the i18n value
(`settings_rag_title`), others are concatenated in code (`"💬 " + t(...)` at `:558`, `"⚙️ " + t(...)`
at `:462`).

### F-13 · Low · Duplicated constants and mappings

- `FILE_RAG_INDEX` is re-declared locally in `src/rag/RAGEngine.ts:16` instead of imported from
  `src/constants.ts:16` — two sources of truth for the same filename.
- Effort mapping exists twice with **different values**: `mapEffortForGPT5`
  (`src/models.ts:57-64`) maps `fast → "minimal"`, while `THINKING_MODES.fast.effort`
  (`:83`) is `"low"`. Only the former is used for requests; the latter is unused, so the discrepancy is
  currently harmless but misleading.
- Token defaults appear in both `THINKING_MODES[*].tokens` (`src/models.ts`) and
  `maxTokensFast/Normal/Think` in `DEFAULT_SETTINGS`. The settings values win because `ChatView` passes
  them explicitly (`getMaxTokensForMode`, `:1516`); the `THINKING_MODES` numbers are fallbacks only.
- `LEGACY_DIR_NAME` (`src/constants.ts:23`) has no references.

### F-14 · Low · Model catalogue duplicated between chat and settings

`ALL_MODELS` (`src/views/ChatView.ts:90-105`) and the dropdown in
`SettingsTab.renderModelSelector` (`:222-234`) list the same models with different labels
(`"GPT-5"` vs `"GPT-5 (reasoning, best)"`). Adding or renaming a model requires edits in both places,
and they can drift apart unnoticed.

**Fix direction:** move a single catalogue into `models.ts` and derive both UIs from it.

### F-15 · Low · Provider-API details worth re-verifying

- `web_search_20260209` (`src/api/anthropic.ts:52`) is a dated server-tool identifier; it should be
  checked against the current Anthropic tool version, since a stale id fails the whole request rather
  than degrading gracefully.
- `body` in `src/api/openai.ts:61`, `:76`, `:84` sets `stream: false` with odd indentation, and
  `requestCompletion` sets it again — harmless, but it reads like leftover editing.
- `RAGEngine.getEmbedding`/`getEmbeddingsBatch` (`:153`, `:170`) cast the response with
  `(r.json as { data: { embedding: number[] }[] })` and index `[0]` without validation — the only place
  in the API surface that skips the type-guard discipline used everywhere else. A malformed response
  throws a `TypeError` inside `withRetry`, which then retries it three times.

### F-16 · Low · Performance characteristics to keep in mind

- The whole RAG index is serialized with a single `JSON.stringify` on every save
  (`src/rag/RAGEngine.ts:144`). With 1 536-dimension embeddings, a vault of a few thousand chunks
  produces a file in the tens of megabytes and a multi-hundred-millisecond blocking stringify on the
  UI thread.
- `search()` (`:326-344`) maps over every entry and performs two full sorts per query — fine at
  thousands of chunks, noticeable at hundreds of thousands.
- `buildIndex` holds the whole index in memory and never yields to the event loop except at network
  awaits; a large first-time index will make the UI stutter. `onProgress` is also skipped for
  empty-content files (`:254` does `done++; continue;` without calling it), so the progress readout can
  stall.

### F-17 · Informational · Unused code inventory

| Item | Location |
| --- | --- |
| 6 barrel files, zero importers | `src/{api,rag,views,history,storage}/index.ts` (+ nothing imports them) |
| `escapeHtml` | `src/utils.ts:69` |
| `sanitizeUrl` | `src/utils.ts:79` |
| `utf8ToBase64` | `src/utils.ts:88` |
| `base64ToUtf8` | `src/utils.ts:95` — only used by the dead F-2 path |
| `LEGACY_DIR_NAME` | `src/constants.ts:23` |
| `UsageStats`, `APICallOptions` | `src/types.ts:85`, `:91` — superseded by `StreamUsage`/positional args |
| `HistoryIndex`, `ProjectsFile` | `src/types.ts:34`, `:49` — the files store bare arrays instead |
| `ThinkingModeConfig.effort` | `src/models.ts:74` — never read |
| 35 i18n keys | e.g. `settings_storage_open_*`, `chat_copied`, `export_header`, `tokens_session_cost`, `notice_restart_required`, `projects_no_chats`, `code_rule_4_lang` |
| `.gpt-code-block` styles | `styles.css:276` |

`settings_storage_open_name` / `_btn` / `_desc` / `notice_storage_open_fail` are particularly telling —
an "open folder in file manager" feature was translated in both languages but never wired up.

### F-18 · Informational · No tests, and the easy targets are obvious

There is no test runner in `package.json`. The following are pure, dependency-free and cover the
riskiest logic in the codebase:

| Unit | Why it matters |
| --- | --- |
| `tokenize`, `chunkText`, `bm25Score`, `cosineSim`, `contentHash` | ranking quality regressions are otherwise invisible |
| `parseCanvasToText` | graph traversal with cycles, orphans and missing edge endpoints |
| `normalizeLocalBaseUrl`, `parseLocalModelList` | the two functions users hit first when a local server misbehaves |
| `ChatView.normalizeQuestion` | reconciles ~10 model-emitted quiz shapes; brittle by nature |
| `detectProvider`, `mapEffortForGPT5` | tiny, and F-5 shows how quietly this logic can break |
| `withRetry` | backoff and no-retry rules, testable with fake timers |

`ExternalStorage` is also testable in isolation because its Node API is behind the
`NodeFsPromises`/`NodePathApi` interfaces — a fake object satisfies the type guards.

### F-19 · Low · Settings will not appear in Obsidian's settings search (1.13.0+) — **fixed**

Originally `obsidianmd/settings-tab/prefer-setting-definitions` fired on `GPTSettingsTab`: the tab did
not implement `getSettingDefinitions()`, so on Obsidian 1.13.0 and later none of the plugin's settings
were discoverable through the global settings search.

`src/SettingsTab.ts` now builds the tab from `getSettingDefinitions()`
(`src/SettingsTab.ts:71`), which returns one heading row, three top-level rows and seven groups —
24 searchable rows in total. Each row is a `SettingDefinitionRender`, so the imperative control logic is
unchanged; only the `name` / `desc` metadata moved out where Obsidian can index it. Two consequences of
the API contract shaped the design:

- `display()` is **not called** when `getSettingDefinitions()` returns a non-empty array, so the two
  cannot coexist as independent renderers. `display()` therefore delegates to `renderLegacy()`, which
  walks the same definitions imperatively — the fallback path for Obsidian &lt; 1.13, still required
  because `manifest.json` declares `minAppVersion: 1.7.2`.
- The ten former `this.display()` re-render calls became `this.rerender()`, which prefers `update()`
  (1.13+) and falls back to `renderLegacy()`.

Obsidian 1.13 also added `settings?: unknown` to `Plugin`, which collided with the subclass field in
`src/main.ts`; it is now `declare settings: PluginSettings` (TS2612).

### F-20 · Informational · Lint warnings and repo hygiene

- 131 lint warnings: 122 `obsidianmd/prefer-create-el` (`createEl("div", …)` → `createDiv(…)`),
  100 of them auto-fixable with `eslint --fix`; 9 `obsidianmd/ui/sentence-case` — all false positives
  on the brand name and key placeholders (`"AI-Vault Chat"` → *"Ai-vault chat"*, `"sk-..."` →
  *"Sk-..."*), so they should be suppressed rather than "fixed". No warning left has user-facing
  consequences; clearing the noise is still worthwhile so genuine warnings stay visible.
- Note that `eslint-comments/no-restricted-disable` forbids disabling
  `@typescript-eslint/no-deprecated`, so deprecated APIs have to be reached indirectly rather than
  suppressed — that is why `rerender()` calls `renderLegacy()` instead of `display()`.
- Log prefixes are inconsistent: `[AI-Vault]` almost everywhere but `[GPT RAG]` in
  `src/rag/RAGEngine.ts:225`, `:274`, `:321`, `:423`, `:431`.
- Class and view-type names still carry the pre-rename `GPT`/`gpt-` prefix (`GPTPlugin`, `GPTChatView`,
  `gpt-chat-view`, `.gpt-*`, `<vault>-gpt-data`). The view types and folder name **must not** change
  (they are persisted state), but the internal class names could be aligned with the product name.
- ~~`RELEASE_NOTES_1.0.7.md` sits in the repo root while `CHANGELOG.md` already covers 1.0.7.~~
  Resolved: deleted. Every claim it made survives elsewhere — the highlights in the `CHANGELOG.md`
  1.0.7 entry, the `requestUrl()`/no-streaming constraint in `ARCHITECTURE.md` §3, and the
  cancellation semantics in `ARCHITECTURE.md` §"Cancellation". The file remains in git history.
- `CHANGELOG.md` stops at 1.0.7 although two further versions have shipped — there is no entry for
  **1.0.8** or **1.0.9**, both of which are tagged and released. It also jumps 1.0.2 → 1.0.7 while
  `versions.json` lists 1.0.4, 1.0.5 and 1.0.6, and tags exist for 1.0.3 as well.
- The 1.0.9 release contains no source changes relative to 1.0.8: tag `1.0.9` points at
  `205ee38 fix settings storage toggles` (the 1.0.8 code), and the only newer commit on `main` is
  `064aa87 chore: update version to 1.0.9`, which touches version metadata alone. Worth confirming that
  this is intentional rather than a release-workflow misfire.

---

## 4. Prioritized backlog

| # | Finding | Effort | Why now |
| --- | --- | --- | --- |
| 1 | **F-3** restore keys after migration | minutes | silently breaks the first session after upgrade |
| 2 | **F-2** fix code-copy selector | ~30 min | documented feature that does not exist at runtime |
| 3 | **F-6** populate `mtime`/`folder`/`extension` in `buildIndex` | ~30 min | makes ranking deterministic; shared entry factory prevents recurrence |
| 4 | **F-4** per-path debounce | ~30 min | silent RAG staleness during bulk edits |
| 5 | **F-8** sort by `updatedAt` before capping | ~15 min | prevents deleting an active conversation |
| 6 | **F-5** make `autoDetectProvider` work or remove it | ~15 min | settings currently promise nothing |
| 7 | **F-1** delete or flag the streaming scaffolding | ~1 h | removes the largest source of misleading code |
| 8 | **F-9** align message state with DOM | ~1 h | regenerate can corrupt the visible transcript |
| 9 | **F-7** debounce text-field saves | ~1 h | large reduction in disk writes |
| 10 | **F-12** move remaining strings into i18n | ~1 h | the bilingual claim is a headline feature |
| ~~10b~~ | ~~**F-19** add `getSettingDefinitions()`~~ | done | settings are now indexed by search on Obsidian 1.13+ |
| 11 | **F-17** delete dead code, barrels and unused keys | ~1 h | shrinks bundle and review surface |
| 12 | **F-18** add a test runner + the pure-function suite | ~half day | first real regression net |
| 13 | **F-14 / F-13** unify model catalogue and constants | ~half day | removes the two-places-to-edit trap |
| 14 | Split `ChatView` into controller / prompt builder / quiz renderer | 1–2 days | unlocks testing the send path |

---

## 5. Verification notes

Everything above was checked against the working tree, not inferred:

- `npm run typecheck` → clean; `npm run lint` → `✖ 131 problems (0 errors, 131 warnings)`.
- Dead-code claims verified with repo-wide greps for each identifier, excluding its own definition
  (barrels: no file imports `./index` or any `*/index` path; `.gpt-code-block`/`data-rawcode`: the only
  producer would be a custom renderer that no longer exists — the sole match is the query selector at
  `ChatView.ts:1328` plus the CSS rule at `styles.css:276`).
- Unused i18n keys enumerated by extracting the 296 keys of the `en` dictionary
  (`src/i18n.ts:11-349`) and grepping each as a quoted literal across `src/**/*.ts` excluding
  `i18n.ts`; `default_system_prompt` is excluded from the count because it is resolved internally by
  `setLanguage`.
- `main.js` is git-ignored (`.gitignore:2`) and only `styles.css` among build outputs is tracked, so the
  local `main.js` being older than `src/` is expected, not a stale committed artifact.
