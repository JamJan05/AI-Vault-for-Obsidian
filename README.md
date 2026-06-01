# AI Vault for Obsidian

Chat with **GPT**, **Claude**, and **local models** directly inside Obsidian — with RAG over your vault, conversation history, projects, and smart modes.

AI Vault turns Obsidian into a full AI workspace. Talk to frontier models or local OpenAI-compatible servers, give them access to your notes and canvases, organize chats into projects, and keep everything synced with your vault — without ever leaving the app.

-----

## ✨ Features

### 🤖 Multi-provider AI

Switch between **OpenAI**, **Anthropic**, and **Local API** models with a single click in the chat header — no need to dive into settings.

**OpenAI models:**

- GPT-5
- GPT-5 nano
- GPT-5 mini
- GPT-5 Search
- GPT-4o
- GPT-4o mini
- GPT-4o turbo

**Anthropic models:**

- Claude Sonnet 4.5
- Claude Opus 4.5
- Claude Haiku 4.5

**Local API models:**

- LM Studio
- Ollama
- Jan
- LocalAI
- llama.cpp server
- vLLM
- Other OpenAI-compatible local servers

### 📚 RAG over your vault

The plugin indexes your notes locally and feeds the most relevant context to the AI on every message.

- Full support for **Markdown** (`.md`) files
- Full support for **Canvas** (`.canvas`) files — the parser understands canvas topology through edges and reconstructs the logical flow of nodes
- Local index stored outside the vault (no sync bloat)

### 🗂️ Projects

Group related conversations into **projects** — each with its own system prompt, model, and context scope. Perfect for separating work, study, and personal threads.

### 💬 Conversation history

Every chat is saved automatically and stored **outside the vault**, so it never inflates your Obsidian Sync or clutters your file tree.

### 🎯 Smart modes

Switch the AI’s behavior depending on what you need:

- **Code mode** — focused on programming, with code-aware formatting
- **Learn mode** — explains concepts step by step, asks clarifying questions
- **Thinking mode** — deeper reasoning before answering

### 🌐 Web search

Use GPT-5 Search to fetch live information from the web directly in your chat.

### 🌍 Bilingual UI

Full interface in **English** and **Polish**.

### ⚡ Streaming & cost tracking

- Live token streaming — see the response as it’s generated
- Built-in **token counter** and **cost tracker** for every conversation

-----

## 📱 Platform support

|Platform|Status                                |
|--------|--------------------------------------|
|Windows |✅ Supported                           |
|macOS   |✅ Supported                           |
|Linux   |✅ Supported                           |


-----

## 🚀 Installation

### From Obsidian Community Plugins (recommended once approved)

1. Open **Settings → Community plugins**
1. Make sure **Restricted mode** is **off**
1. Click **Browse** and search for **AI Vault**
1. Click **Install**, then **Enable**

### Manual installation

1. Download the latest release from the [Releases page](https://github.com/JamJan05/AI-Vault-for-Obsidian/releases)
1. Extract `main.js`, `manifest.json`, and `styles.css` into:
   
   ```
   <your-vault>/.obsidian/plugins/ai-vault/
   ```
1. Reload Obsidian
1. Enable **AI Vault** in **Settings → Community plugins**

-----

## 🔑 Setup

After enabling the plugin:

1. Open **Settings → AI Vault**
1. Paste your **OpenAI API key** and/or **Anthropic API key**, or choose **Local API** for local models
1. Choose your default model
1. Open the chat from the ribbon icon on the left sidebar

> Your API keys are stored locally on your device. They are never sent anywhere except directly to the official OpenAI and Anthropic endpoints. Local API requests are sent only to the Base URL you configure.

### Local API setup

Use **Provider → Local API** for local model servers.

For **LM Studio** and other OpenAI-compatible servers:

1. Start the local server in LM Studio
1. Load a model
1. Set **Local API Type** to **OpenAI-compatible**
1. Set **Base URL** to `http://localhost:1234/v1`
1. Click **Refresh models**
1. Select the model from the dropdown

For **Ollama**:

1. Start Ollama with `ollama serve`
1. Pull a model, for example `ollama pull llama3`
1. Set **Local API Type** to **Ollama**
1. Set **Base URL** to `http://localhost:11434`
1. Click **Refresh models**
1. Select the model from the dropdown

-----

## 📖 Usage

### Starting a chat

Click the **AI Vault** icon in the left ribbon — the chat panel opens on the right.

### Switching models

Click the model name in the chat header to switch between GPT, Claude, and Local API models without leaving the conversation.

### Using vault context (RAG)

Toggle the **vault context** button to let the AI search your notes and canvases for relevant information before answering.

### Creating a project

Use the **Projects** menu in the chat header to create a new project, set its system prompt, and assign conversations to it.

### Changing mode

Pick **Code**, **Learn**, or **Thinking** mode from the mode selector — the AI will adapt its style accordingly.

-----

## 🔒 Privacy

- **API keys** are stored locally on your device.
- **Conversation history** is stored locally, outside your vault.
- **RAG index** is stored locally, outside your vault.
- Vault content is sent to the model **only** when you enable vault context, and only the relevant chunks are transmitted.
- No data is sent to any third party other than the official OpenAI / Anthropic APIs or the Local API Base URL you configure.

-----

## 💰 Cost

The plugin itself is **free and open source**.

You pay only for what you use via your own OpenAI / Anthropic API keys, billed directly by the providers. Local API usage is handled by your local server. The built-in cost tracker shows estimated spend per conversation when provider usage data is available.

-----

## 🛠️ Tech

- Written in **TypeScript**
- Built with **esbuild**
- Uses official **OpenAI** and **Anthropic** REST APIs with streaming (SSE)
- Uses **Obsidian requestUrl** for non-streaming Local API requests
- Local-first architecture — no external servers

-----

## 🐛 Reporting issues

Found a bug or have a feature request? Open an issue on [GitHub Issues](https://github.com/JamJan05/AI-Vault-for-Obsidian/issues).

When reporting bugs, please include:

- Obsidian version
- Operating system
- Plugin version
- Steps to reproduce

-----

## 🤝 Contributing

Pull requests are welcome. For larger changes, please open an issue first to discuss what you’d like to change.

-----

## 📜 License

[MIT](LICENSE) © 2026 JamJan05
