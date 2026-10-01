# Privacy policy — AI-Vault for Obsidian

**Version 1.5.0 · last reviewed 2026-09-29**

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
| Can it work fully offline? | Yes, with a local model server. Semantic search (embeddings) is off unless you turn it on. |
| Where is your data stored? | On your machine, by default in a folder next to your vault. |

---

## Third parties

The plugin can contact exactly three kinds of endpoint. Nothing else.

| Service | Host | When it is contacted | Why |
|---|---|---|---|
| OpenAI | `api.openai.com` | You send a message with the OpenAI provider selected; or, **only if you turned on semantic search**, the RAG index is built or a question is asked with RAG on | The Responses API (`/v1/responses`, used for GPT-6 and GPT-5.6 models and for any OpenAI model with web search), chat completions (`/v1/chat/completions`, used for older models such as GPT-4o), and text embeddings (`/v1/embeddings`) |
| Anthropic | `api.anthropic.com` | You send a message with the Anthropic provider selected | Messages API (`/v1/messages`), including Anthropic's server-side web search when you enable it and Anthropic's server-side refusal fallback |
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
3. **RAG chunks** — up to 5 fragments from your indexed notes that are related to
   your message: they share a word with it, their note is named after it, or,
   with semantic search on, their meaning is close to it. When nothing is
   related, no fragment is sent. If you attached no notes either, the prompt
   states that the search found nothing.
4. **Project context** — short summaries of the other conversations in the active
   project, up to 4 000 characters in total.
5. **Conversation history** — the previous messages in the current conversation.
   **By default this is the whole conversation:** the "Max messages in context"
   setting defaults to `0`, which means unlimited. Set it to a positive number to
   send only the most recent N messages.
6. **Your message.**

The assembled system prompt is truncated at 120 000 characters.

The chat view shows a one-line summary of this above the input before you send:
the destination (the provider, "this device" for a loopback Local API, or the
hostname of a remote one) and which of the items above the message will carry.

### When the RAG index is built

**By default, building the index sends nothing.** The index is a keyword (BM25)
index that is built and searched entirely on your machine. Indexing is on by
default (`ragEnabled` and `ragAutoIndex` are both `true`) and starts when the
plugin loads, but it stays local.

**Semantic search is opt-in.** It is controlled by **Settings → RAG → Semantic
search**, which is off by default (`ragEmbeddingsEnabled: false`). Turning it on
opens a dialog that states what will be sent, and nothing is enabled unless you
confirm. An OpenAI API key on its own never enables it.

Once you have turned it on, and an OpenAI API key is configured:

> **The content of your vault is sent to OpenAI — not only the notes you are
> asking about.** The text of every indexed note is sent to
> `api.openai.com/v1/embeddings` in batches of 20 chunks, using the
> `text-embedding-3-small` model. Each chunk is truncated to 8 000 characters.
> **Every question you ask with RAG on is sent there too**, to be compared with
> the stored vectors — even when you chat with Anthropic or a local model.

Ways to control this:

- Leave **Semantic search** off. Search then uses keywords only and sends nothing.
- Add paths to **Ignored RAG paths** — matching notes are never read, never
  embedded, never retrieved and never listed as sources.
- Turn off **Auto-index** and/or **RAG** in settings.
- **Delete stored embeddings** removes the vectors from your machine. It cannot
  remove anything OpenAI has already received.

Turning semantic search off stops all embedding requests immediately. Vectors
created earlier stay in `rag-index.json` on your machine, unused, until you
delete them or turn semantic search back on.

**Upgrading from 1.1.x or earlier.** Those versions created embeddings whenever
an OpenAI key was configured. From 1.5.0 the setting starts off for everyone,
including existing installs, and a notice says so once.

`.md` and `.canvas` files are indexed. Canvas files are converted to readable text
(nodes and edges) before indexing.

### When you turn on note editing

Note editing is off by default. It needs the master switch in the settings and,
for each conversation, the Edit button in the chat view. While both are on, the
request also carries the definitions of seven tools, and the model can ask the
plugin to run them:

- `search_notes` — the paths of notes whose name or folder matches the model's
  query, and, when the RAG index is built, up to 8 matching fragments of up to
  1 500 characters each. With semantic search on, the query is also sent to
  OpenAI for embedding, like any RAG question.
- `read_note` — the text of one Markdown note, up to 40 000 characters.
- `read_canvas` — the cards of one canvas as text (their ids, text, linked files
  and URLs) and its connections, up to 40 000 characters.
- `edit_note`, `append_to_note`, `create_note` — change a note or create one.
- `edit_canvas` — add text cards, change the text of text cards, remove cards and
  add connections in a canvas, or create a canvas.

**What this sends.** Whatever a tool returns goes to the selected provider in the
next request of the same exchange: note paths, fragments and the text of every
note the model chose to read. The model decides which notes to read, so this can
be more than RAG would have attached. Every note read this way is listed under
the answer as a source. The tool calls and their results are not saved in the
conversation history and are not sent again with later messages; the answer is.

**What stays out of reach.** Only `.md` and `.canvas` files inside the vault, as Obsidian
shows it: a folder you linked into the vault (a symlink or junction) is part of
the vault, so exclude it with the ignored RAG paths if the model should not reach
it. Not hidden
folders, not Obsidian's configuration folder (so not `data.json`, where settings
live), not paths matching your ignored RAG paths. There is no tool to delete,
rename or move a file, and none to run a command or open a URL.

**Which notes can be changed.** By default only notes you marked in a message
typed into the conversation — `#Name` or `#Folder/Name`, with spaces written as
hyphens (`#My-note`) or in brackets (`#[[My note]]`), optionally with `.md` or
`.canvas`. A hyphen in a mark matches a space or a hyphen in the name; when that
fits more than one file, none of them can be changed.
The list is built from what you type in the chat box, never from note text, web
pages, model replies, text sent by a command, or a conversation reopened from the
history. A change to any other note is refused before it reaches the confirmation
dialog. The setting "Only change notes marked with #name" turns this off; it is
on by default and is switched back on whenever the master switch is switched off.
With "A mark also covers linked notes" on (off by default), the notes and canvases
a marked note links to can be changed too: one step away, at most 60, never an
ignored or hidden path. The plugin reads those links from the vault itself. Note
that this makes the content of a marked note part of the decision: a link added
to it widens what the next message may change.
Marks do not limit what the model can read.

**What is written.** Each change is shown to you as a diff and is written only
after you press Apply. For a canvas the dialog shows its cards and connections
as text, before and after; positions, sizes and colours are not shown. The
button "Apply all in this answer" accepts the change shown and every later change
of the same answer without showing them; they are still limited to the notes you
marked, and are listed under the answer. The next message asks again. A canvas
is never rewritten as free text: the plugin applies the requested card changes
to the parsed file and keeps everything else, and a file that is not a valid
canvas is refused, not overwritten. The setting "Apply changes without asking" removes that
step; it is off by default, and switching the master switch off switches it off
too. Changes are written with Obsidian's Vault API, and only if the note still
has the text you were shown. Switching either switch off, or pressing Stop, ends
tool use at once: nothing more is read, and a change that was not yet written is
not written, even if its dialog is still open. At most 12 rounds of tool calls are answered per
message.

Note editing is not available for the Local API.

### When you enable web search

Web search runs **on the provider's side**, not in Obsidian:

- OpenAI: the `web_search` tool of the Responses API. Pages the answer cites are
  listed under it as ordinary links; the plugin does not open them.
- Anthropic: the `web_search_20260209` server tool, or `web_search_20250305` for
  Claude Haiku 4.5.

Your message and its context reach the provider, which then performs the searches.
The plugin does not open connections to search engines itself. Web search is not
available for the Local API.

### What the provider keeps, and which model answers

- **OpenAI Responses API.** By default OpenAI stores every Responses API result
  for 30 days. The plugin sends `store: false` with every such request, so that
  storage is declined. This does not change OpenAI's own abuse-monitoring
  retention, which is governed by their policy and your account settings.
- **Anthropic refusal fallback.** For Claude Sonnet 5.5 and Claude Opus 5.5 the
  plugin sends `fallbacks: "default"`. If the selected model declines a request,
  Anthropic re-runs the same request on another Claude model that Anthropic
  chooses. Your data does not reach any additional company or host — it stays
  with Anthropic — but the answer can come from a different Claude model than
  the one you picked. When that happens the message is labelled with the model
  that answered. This uses an Anthropic beta feature
  (`server-side-fallback-2026-07-01`).
- **No automatic retries of rejected requests.** A request the provider rejects
  as invalid or unauthorized is not sent again. Only timeouts, rate limits and
  server errors are retried, up to three times.

### What is never sent

- The sources saved with an answer are kept for you, not for the model. They are
  removed from the conversation before it is sent to any provider.

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
| `keys.json` | Your OpenAI, Anthropic and Local API keys — only on Obsidian older than 1.11.4; newer versions keep them in Obsidian's secret storage instead |
| `history-index.json` | Conversation titles, timestamps, model, project link |
| `history/session-*.json` | The full text of every saved conversation and, for each answer, the sources it used: the note name, its path in the vault, and the first 200 characters of the fragment that was sent |
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
  - **Off (default), Obsidian 1.11.4 or newer** — keys are kept in Obsidian's
    `SecretStorage`. `data.json` stores only the *name* of each secret. According
    to Obsidian's documentation the values are held in local storage, keyed to
    the vault, on that device; they are not part of the vault and are not
    synced. The plugin writes no key file in this mode.
  - **Off (default), older Obsidian** — keys live in `keys.json` outside the vault
    and are not synced. On Linux and macOS the file is set to owner-only
    permissions (`0600`); Windows has no equivalent and the call is a no-op
    there. The file is plaintext JSON.
  - **On** — keys are written into `data.json` inside the vault as plaintext,
    which means they travel through Obsidian Sync and land in every synced
    device and backup. SecretStorage is not used in this mode, because it would
    not sync.
- **Moving to SecretStorage is automatic and verified.** On the first start with
  Obsidian 1.11.4 or newer, each key is written to SecretStorage and read back.
  Only when every key reads back correctly are the copies in `keys.json` and
  `data.json` deleted. If anything fails, nothing is deleted and the plugin keeps
  using its key file.
- Secrets in SecretStorage are shared by name: another plugin that knows a
  secret's name can read it. That is how Obsidian designed the store. The plugin
  names its secrets `ai-vault-openai-api-key`, `ai-vault-anthropic-api-key` and
  `ai-vault-local-api-key`.
- SecretStorage is not described by Obsidian as encrypted, and this plugin makes
  no such claim. It keeps keys out of the vault, out of sync and out of the
  plugin's own files; it does not protect them from someone with access to your
  user account.

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
| API keys | Remove the secrets in Obsidian's secret storage (the key field in settings opens it). On Obsidian older than 1.11.4: clear the key fields, then delete `keys.json` from the storage folder |
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
  warning in settings, the chat view marks the destination as unencrypted, and
  the first message to that address asks for confirmation, because your messages
  and your Local API key travel unencrypted.
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
- A reply cannot make the plugin read a file, write a file, or send a request —
  **unless you have turned on note editing** for the conversation. Then the model
  can read Markdown notes and propose changes to them, within the limits described
  under "When you turn on note editing".
- JSON in a reply (quizzes) is parsed defensively and never trusted structurally.

What it cannot do: stop a model from being *persuaded* by text you fed it. Be
careful about indexing notes from untrusted sources, and use ignored RAG paths for
anything you do not want reaching a prompt.

With note editing on, this risk is larger. A note or a web page that misleads the
model could make it read notes you did not ask about — their text then reaches the
provider, and with web search on the model could also put it into a search query —
or propose a change you did not ask for. The confirmation dialog is the safeguard
against unwanted changes: read the diff before you press Apply, and leave "Apply
changes without asking" off. Marking limits where a change can land: with "Only
change notes marked with #name" on, a misled model still cannot change a note you
did not name. Consider keeping web search off in conversations
where note editing is on.

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
