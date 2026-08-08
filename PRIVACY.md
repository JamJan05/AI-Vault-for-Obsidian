# Privacy policy — AI-Vault for Obsidian

**Version 1.1.1 · last reviewed 2026-08-08**

AI-Vault is a local Obsidian plugin. It has no backend of its own, no account, and
no analytics. Everything it sends leaves your machine only because you asked it to
answer a question — and it goes directly from Obsidian to the model provider you
chose, never through anything operated by this project.

This document describes what the code actually does. Where a statement could not
be verified from the code, it says so. If you find a discrepancy between this
document and the source, the source is right — please open an issue.

---

## Summary

| Question | Answer |
|---|---|
| Does the plugin have its own server? | No. |
| Does it collect telemetry or analytics? | No. |
| Does it require an account with this project? | No. |
| Does it send your notes anywhere? | Only to the model provider you select, and only as described below. |
| Can it work fully offline? | Yes, with a local model server and RAG embeddings turned off. |
| Where is your data stored? | On your machine, by default in a folder next to your vault. |

---

## Third parties

The plugin can contact exactly three kinds of endpoint. Nothing else.

| Service | Host | When it is contacted | Why |
|---|---|---|---|
| OpenAI | `api.openai.com` | You send a message with the OpenAI provider selected, or the RAG index is built while an OpenAI API key is configured | Chat completions (`/v1/chat/completions`), the Responses API (`/v1/responses`, used for GPT-5 with web search), and text embeddings (`/v1/embeddings`) |
| Anthropic | `api.anthropic.com` | You send a message with the Anthropic provider selected | Messages API (`/v1/messages`), including Anthropic's server-side web search when you enable it |
| Local API | **whatever Base URL you configure** | You send a message with the Local API provider selected, or you press "Refresh models" | Chat with a model server you run or choose — LM Studio, Ollama, LocalAI, llama.cpp, vLLM, or an OpenAI-compatible gateway |

Your data is processed by those providers under **their** privacy policies and
terms, not this one:

- OpenAI — <https://openai.com/policies/privacy-policy>
- Anthropic — <https://www.anthropic.com/legal/privacy>
- Local API — whatever the operator of that endpoint says; if you run it yourself,
  that is you.

**Costs and accounts.** OpenAI and Anthropic both require your own account and API
key, and both bill you for usage — including the embedding requests the RAG index
makes. This plugin never charges anything and never sees your billing. A local
model server needs no account and costs nothing beyond your own hardware.

---

## What is sent

### When you send a chat message

The request contains, in this order:

1. **The system prompt** — the global one from settings, or the project's own
   prompt when a project is active, plus the Code-mode or Learn-mode instructions
   when those are on.
2. **Manually attached notes** — every note you attached with the paperclip
   button, truncated to the first 3 000 characters each. Notes reached by a
   `[[wikilink]]` from an attached note are included too, one level deep, unless
   the link target matches your ignored RAG paths.
3. **RAG chunks** — up to 5 fragments from your indexed notes that the search
   ranked as relevant to your message.
4. **Project context** — short summaries of the other conversations in the active
   project, up to 4 000 characters in total.
5. **Conversation history** — the previous messages in the current conversation.
   **By default this is the whole conversation:** the "Max messages in context"
   setting defaults to `0`, which means unlimited. Set it to a positive number to
   send only the most recent N messages.
6. **Your message.**

The assembled system prompt is truncated at 120 000 characters.

### When the RAG index is built

If an OpenAI API key is configured, the text of **every indexed note** is sent to
`api.openai.com/v1/embeddings` in batches of 20 chunks, using the
`text-embedding-3-small` model. Each chunk is truncated to 8 000 characters.

This matters, so it is worth stating plainly:

> **With RAG enabled and an OpenAI key configured, the content of your vault is
> sent to OpenAI — not only the notes you are asking about.** Indexing is on by
> default (`ragEnabled` and `ragAutoIndex` are both `true`), and it starts when
> the plugin loads.

Ways to control this:

- Turn off **Auto-index** and/or **RAG** in settings.
- Add paths to **Ignored RAG paths** — matching notes are never read, never
  embedded, never retrieved and never listed as sources.
- Leave the OpenAI API key empty. RAG then falls back to keyword-only (BM25)
  search, which runs entirely on your machine and sends nothing.

`.md` and `.canvas` files are indexed. Canvas files are converted to readable text
(nodes and edges) before indexing.

### When you enable web search

Web search runs **on the provider's side**, not in Obsidian:

- OpenAI: `tools: [{ type: "web_search" }]`, `web_search_options` for
  `gpt-5-search-api`, or the Responses API for GPT-5 with search.
- Anthropic: the `web_search_20260209` server tool.

Your message and its context reach the provider, which then performs the searches.
The plugin does not open connections to search engines itself. Web search is not
available for the Local API.

### What is never sent

- The plugin sends nothing on its own schedule. Every request is caused by an
  action you took: sending a message, refreshing the model list, or indexing.
- There is no crash reporting, no usage counter, no heartbeat, no install
  identifier, no device identifier and no vault identifier.
- The clipboard is **write-only** — used when you press a copy button. The plugin
  never reads clipboard contents.

---

## Where data is stored

### Default: a folder next to your vault

On desktop, with external storage enabled (the default), the plugin writes to:

```text
<parent-of-your-vault>/<vault-name>-gpt-data/
```

You can point this anywhere via **Settings → Storage → Storage path**.

| File | Contents |
|---|---|
| `keys.json` | Your OpenAI, Anthropic and Local API keys |
| `history-index.json` | Conversation titles, timestamps, model, project link |
| `history/session-*.json` | The full text of every saved conversation |
| `projects.json` | Project names, descriptions and custom system prompts |
| `rag-index.json` | Note fragments and their embedding vectors |

This folder is **outside the vault**, so **Obsidian Sync does not synchronize it**.
That is the point: conversation history and API keys stay on the machine that
created them.

Obsidian's Developer policies require plugins to disclose access to files outside
a vault. This is that disclosure: the plugin reads and writes only inside the
directory above, and path handling refuses any path that would escape it (see
`src/security/paths.ts`).

### If external storage is turned off, or on mobile

Everything moves into the plugin's own folder inside the vault:

```text
<your-vault>/<config-dir>/plugins/ai-vault/
```

Files there **are** covered by Obsidian Sync and by any vault backup. That is a
trade-off you choose, not a default.

### Settings and API keys

- `data.json` in the plugin folder always holds your settings. It is inside the
  vault and therefore synced.
- API keys have their own switch, **"Sync API keys via Obsidian Sync"**:
  - **Off (default)** — keys live in `keys.json` outside the vault and are not
    synced. On Linux and macOS the file is set to owner-only permissions (`0600`);
    Windows has no equivalent and the call is a no-op there.
  - **On** — keys are written into `data.json` inside the vault, which means they
    travel through Obsidian Sync and land in every synced device and backup.
- Keys are stored in plaintext JSON. They are **not** currently held in Obsidian's
  `SecretStorage`. That API arrived in the Obsidian 1.11 line, and this plugin
  still supports 1.7.2, so adopting it would drop support for existing installs.
  See `.compliance/obsidian-policy-map.json` (rule `OBS-SEC-002`) for the decision
  record.

### Exported conversations

**Export to note** writes a Markdown file into an `AI-Vault/` folder inside your
vault. That file is an ordinary note: synced, backed up and searchable like any
other.

---

## Retention and deletion

Nothing expires on a timer, with one exception: **conversation history is capped
at 100 sessions** and the oldest are dropped beyond that.

Everything else persists until you remove it.

To delete your data:

| What | How |
|---|---|
| A single conversation | Delete it in the History view |
| A project | Delete it in the Projects view |
| All history, projects and the RAG index | Delete the storage folder shown in **Settings → Storage** |
| API keys | Clear the key fields in settings, then delete `keys.json` from the storage folder |
| Settings | Delete `data.json` from the plugin folder inside your vault |
| Everything | Uninstall the plugin, then delete both the plugin folder inside the vault and the external storage folder |

Uninstalling the plugin through Obsidian removes the plugin folder inside the
vault. It does **not** remove the external storage folder — Obsidian does not know
about it. Delete that one yourself.

**Data already sent to a provider is outside this plugin's reach.** Deleting a
conversation locally does not delete anything from OpenAI's or Anthropic's
systems; use the provider's own controls for that.

---

## Logging

The plugin writes only to the Obsidian developer console, never to a file and
never over the network. Before anything from a provider or a Local API endpoint
reaches a message or a log, it passes through `sanitizeErrorDetail()`
(`src/security/redact.ts`), which:

- redacts `Authorization` headers, bearer tokens, `x-api-key`, and OpenAI- and
  Anthropic-shaped keys;
- redacts the `apiKey`, `claudeApiKey` and `localApiKey` fields;
- redacts credentials embedded in a URL;
- strips control characters, so a hostile endpoint cannot forge log lines;
- caps the fragment at 300 characters.

That function is covered by unit tests (`tests/security/redact.test.ts`) and is
the same function used to sanitize the CI compliance reports.

Note contents, prompts, conversation history and RAG chunks are never logged.

---

## Sending data to an endpoint you configure

The **Local API Base URL** decides where your messages, note excerpts, RAG chunks
and Local API key are sent. The plugin therefore validates it
(`src/security/urlPolicy.ts`):

- Only `http:` and `https:` are accepted. `file:`, `javascript:`, `data:`, `ftp:`
  and every other scheme are refused before any request is made.
- Plain HTTP is treated as normal **only for a genuine loopback address**:
  `localhost`, anything in `127.0.0.0/8`, and IPv6 `::1`. A hostname that merely
  contains the word "localhost" — `localhost.example.com`, `notlocalhost` — is
  treated as remote.
- A **remote plaintext HTTP** endpoint is not blocked, because running a model
  server elsewhere on your LAN is a legitimate choice. It does raise a visible
  warning in settings before the value takes effect, because your messages and
  your Local API key travel unencrypted.
- A username and password embedded in the URL raises a warning: URLs end up in
  logs and error messages.

If you point the Base URL at a hosted gateway, that gateway receives everything a
model provider would. Choose it as deliberately as you would choose OpenAI.

---

## Prompt injection — a risk this plugin cannot remove

Retrieved note text and model replies are untrusted input. A note in your vault —
or a web page a provider's search tool retrieves — can contain text written to
manipulate the model's behaviour.

What the plugin does about it:

- Model output is **rendered, never executed**. There is no `eval`, no
  `Function` constructor, no shell, and no `innerHTML`.
- A reply cannot make the plugin read a file, write a file, or send a request.
- JSON in a reply (quizzes) is parsed defensively and never trusted structurally.

What it cannot do: stop a model from being *persuaded* by text you fed it. Be
careful about indexing notes from untrusted sources, and use ignored RAG paths for
anything you do not want reaching a prompt.

---

## Scope of this document

This is a plugin privacy policy. It is not legal advice, and it is not a
certification of compliance with the GDPR or any other regulation. The automated
checks in CI verify selected safeguards and compliance evidence — see
[`docs/SECURITY-PRIVACY-CHECKS.md`](docs/SECURITY-PRIVACY-CHECKS.md) — but no
workflow can certify a legal outcome.

If you are processing personal data of other people through this plugin, you are
the controller of that processing and the model provider is your processor. That
relationship is between you and them.

---

## Changes

This document is versioned with the plugin. Material changes to what is sent,
where it is stored or who receives it will be recorded in
[`CHANGELOG.md`](CHANGELOG.md) as well as here.

Questions or a discrepancy between this document and the code:
<https://github.com/JamJan05/AI-Vault-for-Obsidian/issues>. Please do not include
API keys, private note content or unredacted logs in a public issue — see
[`SECURITY.md`](SECURITY.md).
