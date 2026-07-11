# AI-Vault 1.0.7

This maintenance release resolves the Obsidian community-plugin review findings.

## Highlights

- All cloud API requests now use Obsidian's `requestUrl()` API.
- Chat view styling uses CSS classes and Obsidian CSS helpers instead of static inline assignments.
- External storage has strict typing and desktop-gated Node.js module loading.
- Wikilinks are resolved through Obsidian's metadata cache instead of scanning every Markdown file.
- Release assets include GitHub build provenance attestations for `main.js` and `styles.css`.

## Permissions and privacy

- Node.js `fs` and `path` are used only on desktop for the optional storage folder outside the vault.
- Full vault enumeration is limited to the note picker and the explicitly enabled RAG index.
- Clipboard access is write-only and occurs only after the user presses a copy button.

Because `requestUrl()` does not expose an abortable SSE stream, cloud responses are applied as a complete JSON response. Pressing Stop immediately ends the conversation operation and discards any response that arrives later.
