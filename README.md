# ✨ AI-Vault for Obsidian

**Talk to your notes.** Ask a question and get an answer built from what you have already written — with links back to the exact fragments it used. Use **OpenAI GPT**, **Anthropic Claude** or a **model running on your own computer**, all from one chat panel inside Obsidian.

**Let it write, too.** Switch on note editing and the AI can fill in your notes and canvases — add a section, fix a passage, create a new note. By default you see every change as a diff and nothing is saved until you approve it. For now this works with GPT and Claude models; local models can chat but not edit.

**You decide how private it is.** AI-Vault has no server, no account and no telemetry: it does not collect analytics, crash reports or any identifier. It only talks to the AI services you set up, and only when you do something. Run a local model with semantic search off and nothing leaves your machine at all.

---

## 🔒 You choose the privacy level

| Setup | What leaves your computer |
| --- | --- |
| 🖥️ **Local model** (LM Studio, Ollama, … running on your computer) | Nothing, as long as semantic search is off. The chat, the vault search and the history all stay on your machine, and it works offline. |
| ☁️ **OpenAI or Claude** | Your message, the conversation, and the note fragments used as context — sent only to the provider you chose, with your own API key. |
| 🧠 **+ Semantic search** (opt-in) | The text of every indexed note and each question you ask with RAG on, sent to OpenAI for embeddings — whichever chat model you use, a local one included. Off by default; turning it on asks you to confirm. |

Whichever you pick, the plugin itself never phones home. Conversation history, projects and the search index are stored on your disk — by default outside the vault, so Obsidian Sync does not copy them unless you choose otherwise. Notes you want to keep private can be kept out of the index, automatic context and note editing with [ignored paths](#-ignored-rag-paths); a note you attach yourself with the paperclip is still sent. Details: [Privacy and storage](#-privacy-and-storage) and [`PRIVACY.md`](PRIVACY.md).

---

## 🚀 Highlights

- 🤖 **One chat, three providers** — OpenAI, Anthropic, or a local server (LM Studio, Ollama and other OpenAI-compatible servers), picked from one list.
- 📚 **Answers from your vault** — RAG finds the relevant fragments of your notes and canvases; you can also attach notes by hand. Sources are listed under each answer and open the note at the fragment that was used.
- ✏️ **Note editing (opt-in)** — the model can read notes and canvases and propose changes, which you approve as a diff. Off until you switch it on; for now GPT and Claude only.
- 🗂️ **Projects and history** — conversations are saved automatically; a project groups chats and gives them their own system prompt.
- 🧠 **Modes** — Fast, Normal or Think; Chat, Learn (with quizzes) or Code.
- 🌐 **Web search** — run by OpenAI or Anthropic on their side.
- 👀 **No surprises** — a line above the input says what the next message will send, and to whom.
- 🌍 **English and Polish** interface.
- 💸 **Free and open source** (MIT). You pay only your AI provider, if you use one.

---

## 🧩 Requirements

- Obsidian desktop **1.7.2 or newer** (desktop only: storage outside the vault needs desktop file-system APIs).
- An OpenAI and/or Anthropic **API key**, or a local model server.
- Internet access for cloud models and web search. Local models work offline.

---

## 📦 Installation and setup

**Manual:** download `main.js`, `manifest.json` and `styles.css` from the [Releases page](https://github.com/JamJan05/AI-Vault-for-Obsidian/releases) into `<your-vault>/.obsidian/plugins/ai-vault/`, reload Obsidian and enable **AI-Vault** in **Settings → Community plugins**.

**Community Plugins** (once listed): **Settings → Community plugins → Browse**, search for **AI-Vault**, install and enable.

Then open **Settings → AI-Vault**, add an API key or configure a Local API server, choose a model, and open the chat from the ribbon icon or the command palette.

---

## 🤖 Models

| Provider | Models |
| --- | --- |
| OpenAI | GPT-6 Sol (default), GPT-6 Astra, GPT-6 Luna, GPT-5.6 Terra, GPT-4o and GPT-4o Mini (older) |
| Anthropic | Claude Sonnet 5.5 (default), Claude Opus 5.5, Claude Haiku 4.5 |
| Local API | any model served by an OpenAI-compatible or Ollama endpoint — LM Studio, Ollama, LocalAI, llama.cpp server, vLLM |

Any other model id can be typed in by hand. Models offered by earlier versions are replaced in your settings with their closest current equivalent, and a notice says which one was chosen.

### 🖥️ Local models

In **Settings → AI-Vault**, choose **Provider → Local API**, then:

- **LM Studio / OpenAI-compatible:** type **OpenAI-compatible**, Base URL `http://localhost:1234/v1`.
- **Ollama:** type **Ollama**, Base URL `http://localhost:11434` (no `/v1`).

Click **Refresh models** and pick one. Leave **Local API key** empty for a server on your own machine.

> Requests go only to the Base URL you configure. If it points to a cloud service or a gateway, your messages and Local API key are sent there. Web search and note editing are not available for Local API models.

---

## 📚 Vault context

- 🔎 **RAG** searches the indexed `.md` and `.canvas` files and adds the related fragments to your question. The search is a keyword search that runs on your machine. When nothing is related, nothing is added.
- 📎 **Attached notes** — the paperclip adds notes or canvases you pick, with the notes they link to.

Canvases are turned into readable text (cards and connections), not sent as raw JSON.

**Semantic search** is optional and off by default — see [What RAG sends](#-what-rag-sends).

### 🚫 Ignored RAG paths

**Settings → AI-Vault → RAG → Ignored RAG paths** takes one pattern per line. Matching notes are not indexed, not sent for embeddings, not used as context, not reachable by note editing, and not followed through a `[[wikilink]]` from an attached note.

```text
Assets/**
Templates/**
*.canvas
# lines starting with a hash are comments
```

- Matching is case-insensitive, against vault-relative paths.
- A pattern without `/` matches that file name at any depth and a top-level folder of that name; a pattern with `/` is anchored at the vault root.
- `*` stays within one path segment, `**` crosses segments. `Assets` behaves like `Assets/**`.
- Notes you attach with the paperclip are **still sent** — that is your explicit choice.

---

## ✏️ Note editing

Off by default. Without it the model cannot read or change a file; it only sees what the plugin puts into the prompt. It takes two switches:

1. **Settings → AI-Vault → Note editing → Let the model read and edit notes** — the master switch. While it is off, the chat view has no Edit button.
2. **The Edit button in the chat view** — for the current conversation only. Every new or reopened conversation starts with it off.

While both are on, the model can:

- 🔎 search the vault and 📖 read Markdown notes and canvases,
- ✏️ replace a passage in a note, add text at its end, or create a note,
- 🗺️ add, change, remove and connect the cards of a canvas, or create a canvas (only the text of text cards can be changed; new cards are placed below the existing ones).

It cannot delete, rename or move files, touch anything but `.md` and `.canvas` files, or reach hidden folders, Obsidian's configuration folder or your ignored RAG paths.

**You name the notes it may change.** Mark a note or canvas in your message with a hash — *"#Plan add a section about deadlines"*:

| You type | It means |
| --- | --- |
| `#Plan` | the note or canvas called Plan, in any folder |
| `#Projects/Plan` | exactly that path |
| `#Plan-B` or `#[[Plan B]]` | a name with spaces |
| `#Plan.md`, `#Plan.canvas` | when a note and a canvas share a name |

A mark lasts for the rest of the conversation. A name that matches no file lets the model create one with that name; a name that matches several files allows none of them until you add the folder or the extension. Only marks you type in the chat box count — text in a note, on a web page or in a reply cannot mark anything. Marks limit writing, not reading.

**You approve each change.** A dialog shows the file and a diff — for a canvas, its cards and connections before and after — and nothing is written until you press **Apply**. **Apply all in this answer** also accepts the remaining changes of the same answer. Changed notes are listed under the answer. Stop, or switching Edit off, ends it at once.

Three settings relax these rules; decide deliberately:

| Setting | Default | Effect |
| --- | --- | --- |
| Only change notes marked with #name | on | off: the model may propose changes to any note |
| A mark also covers linked notes | off | on: a mark also covers the notes that note links to — one step, at most 60. Meant for a hub note: *"fix the notes in #biology"* |
| Apply changes without asking | off | on: changes are written with no dialog. The line above the input warns you while it is on |

Notes the model reads are sent to the provider and listed as sources. Changes go through Obsidian's Vault API, so file recovery can restore an earlier version. Works with OpenAI and Claude models.

---

## 🗂️ Projects

A project keeps related conversations together. It can have its own system prompt and a colour, and its chats share context: short summaries of the other conversations in the project are added to the prompt.

---

## 🔐 Privacy and storage

> **Full detail:** [`PRIVACY.md`](PRIVACY.md) documents exactly what is sent, to whom, when, where it is stored and how to delete it. This section is the summary.

### 🌐 Network use

AI-Vault contacts three kinds of endpoint and nothing else:

| Service | Host | Why |
| --- | --- | --- |
| OpenAI | `api.openai.com` | The Responses API (sent with `store: false`, so OpenAI does not keep the response), chat completions for older models, and text embeddings for the RAG index |
| Anthropic | `api.anthropic.com` | Messages API, including Anthropic's server-side web search and refusal fallback (a declined request may be answered by another Claude model) |
| Local API | the Base URL **you** configure | Chat with a model server you run or choose |

Every request is caused by something you did — sending a message, refreshing the model list, or indexing. The plugin has **no backend of its own**, sends **no telemetry, analytics or crash reports**, and has no install, device or vault identifier.

A request carries your message, the conversation, attached notes, related RAG fragments, project context and, with note editing on, whatever the model reads through its tools.

### 🔑 Accounts, API keys and costs

- OpenAI and Anthropic each require **your own account and API key**, and **bill you for usage** — including web search and, if you turn it on, the embedding requests of semantic search.
- AI-Vault itself is free. A local model server needs no account.

### 📚 What RAG sends

By default, **nothing**: the index is built and searched on your machine.

**Semantic search is opt-in** (**Settings → RAG → Semantic search**). If you turn it on and confirm the dialog, the text of **every indexed note** is sent to OpenAI's embeddings endpoint — not only the notes you ask about — and so is every question you ask with RAG on, even when you chat with Claude or a local model. An OpenAI key alone never enables this. **Delete stored embeddings** removes the vectors from your machine.

### 💾 Storage

Conversation history, projects and the RAG index are stored outside your vault by default, in a folder next to it, which keeps them out of Obsidian Sync:

```text
<parent-of-vault>/<vault-name>-gpt-data/
```

The location is configurable, and the data can be kept in the plugin folder inside the vault instead if you want it synced.

API keys are kept in Obsidian's secret storage on Obsidian 1.11.4 and newer. On older versions they are in a file in the folder above, or in the plugin's `data.json` if you choose to sync them.

Node.js `fs` and `path` are used only for that storage folder. The clipboard is write-only: the plugin writes to it when you press a copy button and never reads it.

---

## 🛡️ Security

Found a security problem? **Do not open a public issue.** Report it privately — see [`SECURITY.md`](SECURITY.md).

Release assets carry a signed build provenance attestation, and the build is reproducible from source:

```bash
gh attestation verify main.js -R JamJan05/AI-Vault-for-Obsidian
```

What the automated checks verify, and what they do not, is in [`docs/SECURITY-PRIVACY-CHECKS.md`](docs/SECURITY-PRIVACY-CHECKS.md).

---

## 🛠️ Development

```bash
npm ci              # install dependencies
npm run dev         # development build, watching for changes
npm run build       # typecheck and production build
npm test            # unit tests
npm run lint        # Obsidian and TypeScript lint rules
npm run compliance  # security and privacy checks
```

The plugin is three files: `main.js`, `manifest.json` and `styles.css`. The code is described in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## 🐛 Issues and contributing

Bugs and feature requests go to [GitHub Issues](https://github.com/JamJan05/AI-Vault-for-Obsidian/issues). Please include your Obsidian version, operating system, AI-Vault version, the provider and model, steps to reproduce, and any console errors.

> ⚠️ Never paste an API key, private note content or an unredacted console log into a public issue.

Pull requests are welcome. For larger changes, open an issue first to discuss the direction.

---

## 📜 License

[MIT](LICENSE) © 2026 JamJan05
