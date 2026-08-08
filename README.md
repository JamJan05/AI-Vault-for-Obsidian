# ✨ AI-Vault for Obsidian

Chat with **OpenAI GPT**, **Anthropic Claude**, and **local models** directly inside Obsidian, with vault-aware context, conversation history, projects, smart modes, and local-first storage.

AI-Vault turns your Obsidian workspace into an AI assistant that can use your notes, canvases, selected files, and project history as context while keeping plugin data on your own machine.

---

## 🚀 Highlights

- 🤖 **Multi-provider chat** - switch between OpenAI, Anthropic, and local models from the chat view.
- 🖥️ **Local models** - run models offline through LM Studio, Ollama, and other OpenAI-compatible servers.
- 📚 **Vault RAG** - search relevant Markdown and Canvas content from your vault.
- 📎 **Manual note context** - attach specific notes or canvases to a conversation.
- 🗂️ **Projects** - group related chats with custom prompts and shared project context.
- 🕘 **Conversation history** - automatically save and reopen previous chats.
- ⚡ **Cancelable responses** - stop an in-progress conversation from the chat view.
- 🧠 **Thinking modes** - choose Fast, Normal, or Think mode.
- 🎓 **Learn mode** - generate study-friendly answers and interactive quiz-style responses.
- 💻 **Code mode** - get programming-focused answers with code formatting.
- 🌐 **Web search** - use supported OpenAI and Claude web-search capabilities.
- 🌍 **Bilingual UI** - fully localized English and Polish interface.
- 🔐 **Local-first storage** - history, projects, keys, and RAG index can stay outside your vault.

---

## 🧩 Requirements

- 🖥️ Obsidian desktop **1.7.2 or newer**
- 🔑 OpenAI API key and/or Anthropic API key — **or** a local model server (LM Studio, Ollama, …)
- 📡 Internet access for cloud model calls, embeddings, and web search (local models can run offline)

> AI-Vault is desktop-only because optional storage outside the vault requires desktop file-system APIs.

---

## 🤖 Supported Models

### OpenAI

- GPT-5
- GPT-5 Mini
- GPT-5 Nano
- GPT-5 Search
- GPT-4o
- GPT-4o Mini
- GPT-4 Turbo

### Anthropic

- Claude Opus 4.5
- Claude Sonnet 4.5
- Claude Haiku 4.5

### Local API

Any model served by an OpenAI-compatible or Ollama endpoint, including:

- LM Studio
- Ollama
- LocalAI
- llama.cpp server
- vLLM
- Other OpenAI-compatible local servers

---

## 🖥️ Local Models

Use **Provider → Local API** to chat with models running on your own machine. AI-Vault supports two endpoint types and can fetch the available model list from your server.

### LM Studio (and other OpenAI-compatible servers)

1. Start the local server in LM Studio and load a model.
2. In **Settings → AI-Vault**, set **Local API Type** to **OpenAI-compatible**.
3. Set **Base URL** to `http://localhost:1234/v1`.
4. Click **Refresh models** and select a model from the list.

### Ollama

1. Start Ollama with `ollama serve`.
2. Pull a model, for example `ollama pull llama3`.
3. In **Settings → AI-Vault**, set **Local API Type** to **Ollama**.
4. Set **Base URL** to `http://localhost:11434` (no `/v1` — AI-Vault uses Ollama's native endpoints).
5. Click **Refresh models** and select a model from the list.

> Web search is not available for Local API models. Local API requests are sent only to the Base URL you configure. If your Base URL points to a cloud service or third-party gateway, your chat messages and Local API key are sent to that endpoint. Leave **Local API key** empty for local Ollama or LM Studio.

---

## 📚 Vault Context

AI-Vault can add your notes to the model context in two ways:

- 🔎 **Automatic RAG** searches indexed `.md` and `.canvas` files for relevant chunks.
- 📎 **Manual context** lets you pick specific notes or canvases for the conversation.

Canvas files are parsed into readable text using their nodes and edges, so the model can understand the flow of a canvas instead of receiving raw JSON.

The RAG engine combines keyword search and embeddings when available. If no OpenAI key is configured for embeddings, lexical search can still provide useful matches.

Building the enabled vault-wide RAG index enumerates Markdown and Canvas files. File contents are read incrementally for indexing; ordinary wikilink resolution uses Obsidian's metadata cache and does not scan the vault.

### 🚫 Ignored RAG paths

**Settings → AI-Vault → RAG → Ignored RAG paths** takes one pattern per line and keeps matching notes out of RAG entirely — they are not indexed, not sent to the embeddings model, not used as context and not listed as sources:

```text
Assets/**
Unsorted/**
Templates/**
*.canvas
# lines starting with a hash are comments
```

- Patterns are matched case-insensitively against vault-relative paths.
- A pattern without `/` matches that file name at any depth, and a top-level folder of that name; a pattern containing `/` is anchored at the vault root.
- `*` matches within one path segment, `**` crosses segments. A pattern without wildcards also covers everything below it, so `Assets` behaves like `Assets/**`.
- Ignored notes are also skipped when they would be reached through a `[[wikilink]]` from an attached note.
- Notes you attach manually with the paperclip are **still sent** — that is an explicit choice, not automatic retrieval.
- Changing the list takes effect immediately for search and removes stored chunks of newly ignored notes; re-index to fully rebuild.

This only affects AI-Vault's RAG. It does not hide anything inside Obsidian.

---

## 🗂️ Projects

Projects let you keep related conversations together.

Each project can have:

- 📝 its own custom system prompt,
- 💬 linked conversations,
- 🧠 context from other chats in the same project,
- 🎨 a project color for easier scanning.

This works well for long-running research, coding tasks, study topics, writing work, or client-specific threads.

---

## 💬 Chat Tools

Inside the AI-Vault chat view you can:

- 🧠 switch reasoning mode,
- 🔁 regenerate the last response,
- ⏹️ stop generation,
- 📋 copy messages and code blocks,
- 📤 export a conversation to a note,
- 📚 toggle RAG,
- 🔄 re-index the vault,
- 📎 attach notes manually,
- 🌐 toggle web search,
- 🎓 enable Learn mode,
- 💻 enable Code mode.

---

## 🌍 Language

The entire interface is fully localized in **English** and **Polish**. Switch it any time in **Settings → AI-Vault → Language / Język**; the change applies across settings, chat, projects, history, quizzes, and notices.

---

## 🔐 Privacy And Storage

> **Full detail:** [`PRIVACY.md`](PRIVACY.md) documents exactly what is sent, to whom, when, where it is stored and how to delete it. This section is the summary.

### 🌐 Network use

AI-Vault contacts three kinds of endpoint and nothing else:

| Service | Host | Why |
| --- | --- | --- |
| OpenAI | `api.openai.com` | Chat completions, the Responses API (GPT-5 with web search), and text embeddings for the RAG index |
| Anthropic | `api.anthropic.com` | Messages API, including Anthropic's server-side web search |
| Local API | the Base URL **you** configure | Chat with a model server you run or choose |

Every request is caused by something you did — sending a message, refreshing the model list, or indexing. The plugin has **no backend of its own**, sends **no telemetry, analytics or crash reports**, and has no install, device or vault identifier.

### 🔑 Accounts, API keys and costs

- OpenAI and Anthropic each require **your own account and API key**.
- Those providers **bill you for usage**, including the embedding requests the RAG index makes. AI-Vault itself is free and never charges anything.
- A local model server needs no account and costs nothing beyond your own hardware.
- Web search is billed by the provider that performs it.

### 📚 What RAG sends

With RAG enabled and an OpenAI key configured, the text of **every indexed note** is sent to OpenAI's embeddings endpoint — not only the notes you are asking about. Indexing is on by default and starts when the plugin loads.

To control this: turn off **Auto-index**, use **Ignored RAG paths**, or leave the OpenAI key empty (RAG then falls back to keyword-only search, which runs entirely on your machine).

### 💾 Storage

By default, AI-Vault stores plugin data outside your vault in a local folder next to the vault directory:

```text
<parent-of-vault>/<vault-name>-gpt-data/
```

This keeps data out of Obsidian Sync by default.

Storage location is configurable. API keys have their own **Obsidian Sync / local** choice. Conversation history, projects, and the RAG index use the external-storage setting and can instead be kept in the plugin folder inside the vault for Obsidian Sync.

Stored locally:

- 🔑 API keys
- 🕘 conversation history
- 🗂️ projects
- 📚 RAG index

Data is sent to model providers only when it is part of a request, for example:

- your chat message,
- selected notes,
- relevant RAG chunks,
- project context,
- web-search requests.

AI-Vault does not use its own backend server. Requests go directly from Obsidian to the configured OpenAI or Anthropic API, or to the Local API Base URL you set. Local API can be a local server such as Ollama or LM Studio, or a user-configured authenticated Ollama/OpenAI-compatible gateway such as Ollama Cloud, LiteLLM, LocalAI, or vLLM.

Desktop Node.js `fs` and `path` access is limited to the optional external storage directory. Clipboard access is write-only and runs only when you press a message or code copy button. The plugin never reads clipboard contents.

---

## 📦 Installation

### Manual Installation

1. Download the latest release from the [Releases page](https://github.com/JamJan05/AI-Vault-for-Obsidian/releases).
2. Copy the plugin files into:

```text
<your-vault>/.obsidian/plugins/ai-vault/
```

Required files:

```text
main.js
manifest.json
styles.css
```

3. Reload Obsidian.
4. Open **Settings -> Community plugins**.
5. Enable **AI-Vault**.

### Community Plugins

Once available in the Obsidian Community Plugins directory:

1. Open **Settings -> Community plugins**.
2. Turn off **Restricted mode** if needed.
3. Click **Browse**.
4. Search for **AI-Vault**.
5. Install and enable the plugin.

---

## ⚙️ Setup

1. Open **Settings -> AI-Vault**.
2. Choose the interface language.
3. Add your OpenAI API key and/or Anthropic API key, or configure a **Local API** server.
4. Choose your default provider and model.
5. Configure RAG, token limits, storage, and system prompt settings.
6. Open AI-Vault from the ribbon icon or command palette.

---

## 🛠️ Development

Install dependencies:

```bash
npm install
```

Run a development build:

```bash
npm run dev
```

Run typecheck:

```bash
npm run typecheck
```

Run the Obsidian and TypeScript lint rules:

```bash
npm run lint
```

Create a production build:

```bash
npm run build
```

The production plugin files are:

```text
main.js
manifest.json
styles.css
```

---

## 🛡️ Security

Found a security problem? **Do not open a public issue.** Report it privately — see [`SECURITY.md`](SECURITY.md) for the process, and for what must never appear in a report (API keys, private note content, unredacted logs).

Release assets carry a signed build provenance attestation and the build is reproducible from source:

```bash
gh attestation verify main.js -R JamJan05/AI-Vault-for-Obsidian
```

What the automated security and privacy checks verify — and what they deliberately do not — is documented in [`docs/SECURITY-PRIVACY-CHECKS.md`](docs/SECURITY-PRIVACY-CHECKS.md).

---

## 🐛 Reporting Issues

Found a bug or have a feature request? Open an issue on [GitHub Issues](https://github.com/JamJan05/AI-Vault-for-Obsidian/issues).

> ⚠️ Never paste an API key, private note content or an unredacted console log into a public issue.

Please include:

- 🧱 Obsidian version
- 💻 operating system
- 🔖 AI-Vault version
- 🤖 selected provider and model
- 🧭 steps to reproduce
- 🧾 relevant console errors, if available

---

## 🤝 Contributing

Pull requests are welcome. For larger changes, please open an issue first to discuss the proposed direction.

---

## 📜 License

[MIT](LICENSE) © 2026 JamJan05
