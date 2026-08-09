# AI-Vault — Developer Documentation

Internal documentation for the AI-Vault Obsidian plugin. User-facing setup, features and installation
instructions live in the [root README](../README.md).

| Document | Contents |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | What the plugin is and the constraints that shape it, build pipeline and CI, repository layout, the five-layer model and dependency graph, module-by-module reference, key data flows (send message, index build, settings/keys), persistence model and migrations, cross-cutting concerns, extension points |
| [`CODE-ANALYSIS.md`](CODE-ANALYSIS.md) | Metrics, verified strengths, 20 findings with `file:line` evidence and fix directions, dead-code inventory, test-coverage gaps, prioritized backlog |
| [`SECURITY-PRIVACY-CHECKS.md`](SECURITY-PRIVACY-CHECKS.md) | What the compliance sweep runs, how each check is decided, and how to reproduce a run locally |

Per-version release history lives in [`CHANGELOG.md`](../CHANGELOG.md).

`ARCHITECTURE.md` and `CODE-ANALYSIS.md` describe version **1.0.9** on branch `main` (commit `064aa87`) and have not been
re-verified against the current version. When they drift from the code, the code is right — re-verify a claim before
acting on it.

## Quick orientation for a new contributor

1. `src/main.ts` — the boot sequence in `onload()` explains the whole object graph in one screen.
2. `src/views/ChatView.ts` — where a user request becomes a provider call; start at `sendMessage()`
   and `buildSystemMessage()`.
3. `src/api/streaming.ts` — every network request goes through `requestCompletion()`.
4. `src/storage/ExternalStorage.ts` — why the plugin is desktop-only.
5. `src/rag/RAGEngine.ts` — index format, incremental updates, and the hybrid BM25 + embedding ranker.

## Commands

```bash
npm install
npm run dev        # esbuild watch, inline sourcemap
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src (obsidianmd rules)
npm run build      # typecheck + minified production bundle
```
