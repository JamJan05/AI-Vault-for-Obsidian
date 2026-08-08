# Security and privacy checks

What the automated checks verify, what they deliberately do not, and how to run
every one of them locally.

The vocabulary is fixed. A check reports exactly one of:

| Status | Meaning |
|---|---|
| `PASS` | The requirement was verified. |
| `FAIL` | A violation was detected. Blocks a release. |
| `WARNING` | A risk or a deviation from a recommendation. Does not block. |
| `MANUAL_REVIEW` | No honest automated verdict is possible. Never counts as a pass. |
| `BLOCKED` | The check could not run (no network, missing artefact, missing permission). Never counts as a pass. |
| `NOT_APPLICABLE` | The rule does not apply, with a stated reason. |

**A skipped check is not a passed check.** The runner treats `FAIL` and `BLOCKED`
as release blockers and exits non-zero.

---

## Running everything locally

```bash
npm ci                 # clean install from the lockfile
npm run typecheck      # tsc --noEmit
npm run lint           # eslint with the obsidianmd rules
npm test               # unit tests (node:test, compiled by esbuild)
npm run build          # production bundle — required before the compliance run
npm run compliance     # the full policy sweep
```

`npm run compliance` writes four files into the repository root:

| File | Purpose |
|---|---|
| `security-privacy-success-report.md` / `security-privacy-failure-report.md` | Human-readable report, one or the other depending on the decision |
| `compliance-report.json` | Machine-readable results, one entry per check |
| `compliance-report.sarif` | SARIF 2.1.0, suitable for code-scanning ingestion |
| `sbom.cdx.json` | CycloneDX 1.5 SBOM |

All four are git-ignored. In CI they are uploaded as an artifact with a 7-day
retention (14 days on a release).

Individual pieces:

```bash
node scripts/compliance/verify-release-artifacts.mjs   # manifest, versions, artefacts
node scripts/compliance/sbom.mjs                       # SBOM only
npm audit --audit-level=high                           # dependency advisories
```

---

## The test suite

`npm test` compiles `tests/**/*.test.ts` with esbuild — already a devDependency —
and runs them with Node's built-in test runner. No test framework is added to the
supply chain.

| Test file | Covers |
|---|---|
| `tests/security/urlPolicy.test.ts` | Loopback detection, forbidden schemes, remote plaintext HTTP, IPv6, host-confusion look-alikes, embedded credentials |
| `tests/security/redact.test.ts` | Bearer/`x-api-key` redaction, OpenAI and Anthropic key shapes, plugin key fields, URL credentials, control-character stripping, length capping |
| `tests/security/paths.test.ts` | Path traversal, absolute paths, drive letters, NUL bytes, prefix-collision containment, safe joining |
| `tests/api/contracts.test.ts` | `normalizeLocalBaseUrl`, `parseLocalModelList`, and the OpenAI / Responses / Anthropic / Ollama response validators |
| `tests/rag/ignorePaths.test.ts` | Ignored RAG path semantics: anchoring, globs, case-insensitivity, invalid patterns |
| `tests/rag/canvasParser.test.ts` | Canvas parsing of malformed JSON, non-object JSON, cycles, dangling edges, isolated nodes |
| `tests/rag/ranking.test.ts` | Tokenizer, BM25, cosine similarity, chunking, content hashing, URL sanitizing |

Every credential-shaped literal in the tests contains the marker
`EXAMPLENOTAREALKEY`. The secret scanner requires that marker inside `tests/` and
`.compliance/fixtures/`; a credential-shaped string there without it fails the
run.

---

## The compliance checks

Rule ids and source URLs live in
[`.compliance/obsidian-policy-map.json`](../.compliance/obsidian-policy-map.json).
Thresholds, allowlists and exceptions live in
[`.compliance/ai-vault-policy.json`](../.compliance/ai-vault-policy.json).
Changing a threshold changes what blocks a pull request, so every relaxation must
be an exception entry with an owner, a justification and an expiry date.

### Obsidian policy — `scripts/compliance/checks/obsidian-policy.mjs`

| Check | Rule | Verifies |
|---|---|---|
| `manifest-description` | OBS-SUB-003 | ≤250 characters, ends with a period, no emoji |
| `manifest-min-app-version` | OBS-SUB-002 | `minAppVersion` present, semver, matching `versions.json` |
| `manifest-desktop-only` | OBS-SUB-004 | `isDesktopOnly` is set when Node built-ins are imported |
| `manifest-funding-url` | OBS-SUB-001 | Absent, or a valid https link |
| `command-id-prefix` | OBS-SUB-005 | Command ids do not repeat the plugin id |
| `no-sample-code` | OBS-SUB-006 | No `MyPlugin` / `SampleSettingTab` placeholders |
| `no-html-injection-sinks` | OBS-GUIDE-005 | No `innerHTML`, `outerHTML`, `insertAdjacentHTML` |
| `no-global-app` | OBS-GUIDE-001 | No `window.app`; files with a typed `app: App` parameter are exempt |
| `request-url-only` | OBS-OO-002 | No `fetch`, XHR, WebSocket or `sendBeacon` |
| `filesystem-adapter-guard` | OBS-OO-006 | `FileSystemAdapter` only behind `instanceof` |
| `no-any-casts` | OBS-OO-008 | No `any` in `src/` |
| `no-hardcoded-config-dir` | OBS-OO-009 | `.obsidian` is never a literal path |
| `trash-file-usage` | OBS-OO-004 | Vault files are trashed, not hard-deleted |
| `vault-api-preference` | OBS-GUIDE-015 | Inventories Adapter API usage for human review |
| `logging-hygiene` | OBS-GUIDE-002 | No note content, prompt, history or credential reaches the console |
| `trademark-usage` | OBS-POL-015 | No first-party implication in the name or README |
| `no-ads` | OBS-POL-003 | No advertising code |
| `secret-storage-adoption` | OBS-SEC-002 | Reports whether `SecretStorage` is used; the migration is a product decision |
| `fork-policy` | OBS-POL-016 | Always `MANUAL_REVIEW` — origin cannot be derived from the repository |

### Privacy and network — `scripts/compliance/checks/privacy.mjs`

| Check | Rule | Verifies |
|---|---|---|
| `network-endpoint-inventory` | OBS-POL-002 | Every host reachable from `src/` is on the declared allowlist |
| `no-telemetry` | OBS-POL-004 | No analytics host, SDK or identifier in source, dependencies or the lockfile |
| `no-first-party-backend` | OBS-POL-011 | No endpoint operated by this project, and `PRIVACY.md` says so |
| `disclosure-network` | OBS-POL-008 | **Both directions**: every contacted host is documented, and every documented host is contacted |
| `disclosure-external-files` | OBS-POL-009 | Access outside the vault is disclosed |
| `disclosure-costs` | OBS-POL-006/007 | Accounts, keys and possible costs are disclosed |
| `prompt-injection-risk` | OBS-SEC-001 | Always `MANUAL_REVIEW` — an application-level risk, not a pattern match |

Host extraction strips comments first: a URL in a comment documents a rule, it is
not an endpoint.

### Code security — `scripts/compliance/checks/code-security.mjs`

| Check | Verifies |
|---|---|
| `no-dynamic-execution` | No `eval`, `Function`, `child_process`, `vm` |
| `no-self-update` | No runtime code download, no writes into the plugin directory |
| `no-obfuscation` | No single-line source files, no packed base64 or hex blobs |
| `local-url-validation` | `assessLocalBaseUrl` guards both the request path and the settings UI |
| `error-redaction` | No raw provider response body in an error message |
| `path-containment` | `ExternalStorage` enforces the containment helpers |
| `atomic-json-writes` | Temp file plus rename |
| `key-file-permissions` | `keys.json` is written owner-only where supported |
| `model-output-not-executed` | No model output reaching an execution sink |
| `json-parse-guarded` | Every `JSON.parse` sits inside a `try` block |
| `rag-ignore-enforcement` | The ignore list is applied in the engine, the chat view and the link resolver |

`json-parse-guarded` uses the TypeScript parser rather than brace counting.
Counting braces cannot survive a regex literal containing a quote — such as
`` /[\\/:*?"<>|]/ `` — and would report guarded calls as unguarded.

### Supply chain — `scripts/compliance/checks/supply-chain.mjs`

| Check | Verifies |
|---|---|
| `lockfile-integrity` | Committed, `lockfileVersion` ≥ 2, integrity hashes, public registry only, version matching `package.json` |
| `dependency-specifiers` | No `git+`, URL, `file:` or `link:` dependency |
| `install-scripts` | Inventories every package with an install script; only `esbuild` is accepted |
| `npm-audit` | Blocks on `high` and `critical`; `moderate` and `low` are reported separately |
| `license-inventory` | Dependency licences against the allow/deny/review lists |
| `license-present` | `LICENSE` exists, `package.json` declares it, the README names it |
| `source-availability` | No runtime dependencies, no committed binaries |
| `sbom` | CycloneDX 1.5 generated and structurally validated |

The audit scope is `all`, not production-only. The plugin has no runtime npm
dependencies, so a production-only audit would always be empty and would prove
nothing — but a compromised build tool is still real exposure for anyone who
builds or releases the plugin.

### GitHub Actions — `scripts/compliance/checks/actions.mjs`

| Check | Verifies |
|---|---|
| `actions-sha-pinning` | Every action pinned to a full 40-character SHA with a version comment |
| `actions-permissions` | Explicit least-privilege `permissions` in every workflow |
| `actions-pull-request-target` | `pull_request_target` never builds or runs PR code |
| `actions-script-injection` | No attacker-controllable context interpolated into a shell |
| `actions-persist-credentials` | `persist-credentials: false` where no push happens |
| `actions-hardening` | Timeouts, concurrency, no secret echo, no `curl \| sh`, `continue-on-error` justified |
| `actions-pr-secrets` | Pull-request workflows reference no repository secret |

Workflow bodies are read with `#` comments stripped, so a comment explaining *why*
`pull_request_target` is avoided is not mistaken for a usage.

### Secrets — `scripts/compliance/checks/secrets.mjs`

Scans every git-tracked file plus the built bundle for OpenAI, Anthropic, GitHub,
AWS and Slack credential shapes, bearer tokens and PEM private keys.

**A match is never printed.** The finding records the shape and the length only.

### Release integrity — `scripts/compliance/checks/release.mjs`

| Check | Rule | Verifies |
|---|---|---|
| `version-consistency` | OBS-REL-003 | manifest, package, lockfile, `versions.json` and the git tag agree |
| `release-assets` | OBS-REL-001 | The workflow uploads `main.js`, `manifest.json`, `styles.css` |
| `attestation-coverage` | OBS-REL-002 | Every uploaded asset appears in the attestation `subject-path` |
| `main-js-not-committed` | OBS-OO-001 | `main.js` is git-ignored and untracked |
| `bundle-inspection` | REL-BUNDLE-001 | No undeclared host or forbidden construct in `main.js` |
| `release-reproducibility` | REL-REPRO-001 | Always `MANUAL_REVIEW` — see the procedure below |

### Documentation — `scripts/compliance/checks/docs.mjs`

Verifies that `README.md`, `PRIVACY.md` and `SECURITY.md` contain every section
declared in `.compliance/ai-vault-policy.json → requiredDocuments`, that
`SECURITY.md` warns against posting credentials, notes and raw logs, that this
document exists, and that every policy exception has an owner, a justification and
a live expiry.

---

## Reproducing a release build

This is the check that cannot be automated in the workflow, because it needs the
published artefact and a decision about which release to compare against.

```bash
TAG=1.1.1
git worktree add /tmp/repro "$TAG"
cd /tmp/repro
npm ci
npm run build
sha256sum main.js

gh release download "$TAG" -R JamJan05/AI-Vault-for-Obsidian -p 'main.js' -D /tmp/published
sha256sum /tmp/published/main.js
```

The two digests must match. They did for 1.1.1:
`d0725ea1d0c7d58296eaad7d1b5138aef786c2c0dbf5c0b1daf2d2a16172201c`.

A mismatch is not automatically evidence of tampering — a different Node or
esbuild version changes the output. Investigate before concluding. This is why
`esbuild` majors are excluded from Dependabot: bumping the bundler changes the
bytes of `main.js` and breaks comparison against already published releases.

Also verify the provenance attestation:

```bash
gh attestation verify /tmp/published/main.js -R JamJan05/AI-Vault-for-Obsidian
```

---

## Checks that cannot be automated

| Item | Why | Who decides |
|---|---|---|
| Fork origin (`OBS-POL-016`) | Not derivable from the repository | Maintainer |
| Trademark confusion (`OBS-POL-015`) | Automated checks catch only the obvious cases | Maintainer |
| Migration to `SecretStorage` (`OBS-SEC-002`) | Requires raising `minAppVersion` and dropping support for older installs | Product decision |
| Prompt injection | Application-level risk with no static signal | Ongoing design |
| Adapter API usage (`OBS-GUIDE-015`) | Each call must be confirmed to target the plugin's own storage, not a user note | Maintainer |
| Licence obligations for review-list licences | Attribution requirements need reading | Maintainer |
| Release reproducibility | Needs the published artefact and a chosen tag | Release process |

---

## Required status checks

Set these as required on `main` in **Settings → Branches → Branch protection**:

- `Security and privacy / Build, lint and test`
- `Security and privacy / Security and privacy compliance`
- `Security and privacy / CodeQL`
- `Security and privacy / Dependency review`
- `Security and privacy / Publication gate`
- `Validate version / Check version consistency`

`Publication gate` is the fail-closed aggregate: it runs with `always()` and fails
when any needed job failed or was skipped unexpectedly, so it is the single check
worth requiring if you only require one.

---

## Repository settings that CI cannot set

These are account-level settings, not files, and must be enabled by the owner in
**Settings → Code security**:

- **Dependabot alerts** — currently disabled. Without them, an advisory published
  between scheduled runs is not reported until the next weekly run.
- **Dependabot security updates** — automatic fix pull requests.
- **Private vulnerability reporting** — required for the flow described in
  `SECURITY.md`.
- **Code scanning** — the CodeQL job uploads results here.

---

## What these checks are not

They are an automated check of selected safeguards and compliance evidence.

They are **not** a certification of GDPR compliance, and a green workflow does
**not** mean the plugin has been approved by Obsidian. A `GO` decision is a
technical recommendation to the repository owner and nothing more.
