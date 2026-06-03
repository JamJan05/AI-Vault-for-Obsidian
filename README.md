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
- ⚡ **Streaming responses** - see answers as they are generated.
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

> AI-Vault is desktop-only because streaming and external local storage rely on desktop APIs.

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
- Jan
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

> Web search is not available for local models. Local API requests are sent only to the Base URL you configure and never leave your machine.

---

## 📚 Vault Context

AI-Vault can add your notes to the model context in two ways:

- 🔎 **Automatic RAG** searches indexed `.md` and `.canvas` files for relevant chunks.
- 📎 **Manual context** lets you pick specific notes or canvases for the conversation.

Canvas files are parsed into readable text using their nodes and edges, so the model can understand the flow of a canvas instead of receiving raw JSON.

The RAG engine combines keyword search and embeddings when available. If no OpenAI key is configured for embeddings, lexical search can still provide useful matches.

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

By default, AI-Vault stores plugin data outside your vault in a local folder next to the vault directory:

```text
<parent-of-vault>/<vault-name>-gpt-data/
```

This keeps data out of Obsidian Sync by default.

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

AI-Vault does not use its own backend server. Requests go directly from Obsidian to the configured OpenAI or Anthropic API, or to the Local API Base URL you set.

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

## 🐛 Reporting Issues

Found a bug or have a feature request? Open an issue on [GitHub Issues](https://github.com/JamJan05/AI-Vault-for-Obsidian/issues).

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
