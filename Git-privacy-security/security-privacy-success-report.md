# AI-Vault — security and privacy check report

## Decision

GO — technically ready to be considered for publication

This is a technical recommendation to the repository owner. It is not approval by Obsidian and it does not publish anything.

## Run context

- **repository**: JamJan05/AI-Vault-for-Obsidian
- **commit**: 83f10cd2b0821ff88eed0505213429a3e6c10d4e
- **ref**: main
- **pullRequest**: not a pull request
- **event**: push
- **runId**: 31303238289
- **workflow**: Security and privacy
- **startedAt**: 2026-08-09T08:19:35.958Z

## Summary

- PASS: 57
- FAIL: 0
- WARNING: 2
- BLOCKED: 0
- MANUAL_REVIEW: 6
- NOT_APPLICABLE: 0
- Highest detected risk level: **medium**

## Blocked or manual-review items

| Check | Reason | Blocks publication | Required action |
|---|---|---|---|
| Adapter API usage is limited and justified | The plugin stores its own data files inside the plugin folder, which the Vault API does not address; each adapter call needs a human to confirm it is the plugin's own storage and not a user note. | no | Where the target is a user note, switch to the Vault API (getFileByPath, read, process). |
| The Obsidian trademark is not used in a confusing way | Automated checks can only catch the obvious cases; whether the branding could confuse a user is a human judgement. | no | Rename so the plugin cannot be mistaken for a first-party Obsidian feature. |
| Fork policy | Whether this project is a fork of another plugin, and whether the original author approved it, cannot be established from the repository contents. | no | If this is a fork, document the original author's written approval in the README and credit them as a contributor. |
| API keys use the Obsidian SecretStorage API | Keys are stored by the plugin itself (keys.json outside the vault, or data.json when the user opts into Obsidian Sync) rather than in SecretStorage. Adopting SecretStorage requires raising minAppVersi… (truncated) | no | SecretStorage and SecretComponent were exposed to plugins in the Obsidian 1.11.x line (see https://obsidian.md/changelog/2026-01-07-desktop-v1.11.4/). The plugin currently declares minAppVersion 1.7.2… (truncated) |
| Prompt injection through note content and model output | Note text, canvas content and model replies are all untrusted input that reaches a prompt or the rendered view. This is an application-level risk that no static check can settle, and it cannot be solv… (truncated) | no | Keep the mitigations that exist (model output is rendered, never executed; no eval; no shell; no automatic file writes from a reply) and document the residual risk in PRIVACY.md. |
| A clean build reproduces the published release artefact | Verifying a published artefact needs network access and a chosen tag, so this cannot run inside the offline compliance sweep. Last recorded verification: tag 1.1.1 on 2026-08-08 — All three published … (truncated) | no | git worktree add /tmp/repro <tag> && cd /tmp/repro && npm ci && npm run build && sha256sum main.js, then compare with the published asset and record the result in .compliance/reproducibility.json. |

## Warnings

| Check | Severity | Summary |
|---|---|---|
| Plugin description follows the submission requirements | low | description contains typographic dashes (—); a plain hyphen is safer |
| Vulnerabilities below the blocking threshold | medium | 1 below threshold, 1 under an active exception |

## All checks

| Check | Status | Attempts | Last result | Evidence/log | Blocks publication |
|---|---|---:|---|---|---|
| Vulnerabilities below the blocking threshold | ⚠️ WARNING | 1 | 1 below threshold, 1 under an active exception | `npm-audit-below-threshold` | no |
| Plugin description follows the submission requirements | ⚠️ WARNING | 1 | description contains typographic dashes (—); a plain hyphen is safer | `manifest-description` | no |
| API keys use the Obsidian SecretStorage API | 🔍 MANUAL_REVIEW | 1 | SecretStorage is not used; minAppVersion is 1.7.2 | `secret-storage-adoption` | no |
| A clean build reproduces the published release artefact | 🔍 MANUAL_REVIEW | 1 | Last verified: 1.1.1 on 2026-08-08, 3 artefact(s), all exact | `release-reproducibility` | no |
| Adapter API usage is limited and justified | 🔍 MANUAL_REVIEW | 1 | 9 vault.adapter reference(s) | `vault-api-preference` | no |
| Prompt injection through note content and model output | 🔍 MANUAL_REVIEW | 1 | Inherent to a retrieval-augmented assistant: retrieved note text can carry instructions aimed at the model. | `prompt-injection-risk` | no |
| The Obsidian trademark is not used in a confusing way | 🔍 MANUAL_REVIEW | 1 | name "AI-Vault", id "ai-vault" — no first-party implication detected | `trademark-usage` | no |
| Fork policy | 🔍 MANUAL_REVIEW | 1 | Requires the maintainer to confirm the project's origin. | `fork-policy` | no |
| Every network endpoint in the source is a declared one | ✅ PASS | 1 | hosts in source: api.anthropic.com, api.openai.com, localhost — all declared | `network-endpoint-inventory` | no |
| No client-side telemetry or analytics | ✅ PASS | 1 | no analytics hosts or SDKs in source, dependencies or lockfile | `no-telemetry` | no |
| Documentation and code agree about network use | ✅ PASS | 1 | 2 declared host(s) documented in both directions | `disclosure-network` | no |
| No eval, Function constructor or child process execution | ✅ PASS | 1 | no eval / Function / child_process in src/ | `no-dynamic-execution` | no |
| The plugin does not install or update itself or its dependencies | ✅ PASS | 1 | no code downloads or writes into the plugin directory | `no-self-update` | no |
| The source is not obfuscated | ✅ PASS | 1 | 34 source files, all readable; the release bundle is minified, which is not obfuscation | `no-obfuscation` | no |
| Model output is rendered, never executed | ✅ PASS | 1 | model replies only reach the Markdown renderer and JSON parsing | `model-output-not-executed` | no |
| pull_request_target is not used to build or run pull-request code | ✅ PASS | 1 | no workflow uses pull_request_target | `actions-pull-request-target` | no |
| Pull-request workflows receive no repository secrets | ✅ PASS | 1 | no pull-request workflow references a repository secret | `actions-pr-secrets` | no |
| No credential is committed to the repository | ✅ PASS | 1 | 100 file(s) scanned (tracked and not-yet-committed), no credential found | `secret-scan` | no |
| The built bundle contains no credential | ✅ PASS | 1 | main.js contains no credential-shaped literal | `bundle-secret-scan` | no |
| The built bundle contains nothing that is not in the source | ✅ PASS | 1 | bundle hosts: api.anthropic.com, api.openai.com — all declared | `bundle-inspection` | no |
| isDesktopOnly is set when Node.js or Electron APIs are used | ✅ PASS | 1 | 2 Node built-in import(s); isDesktopOnly=true | `manifest-desktop-only` | no |
| No innerHTML / outerHTML / insertAdjacentHTML | ✅ PASS | 1 | no HTML injection sinks in src/ | `no-html-injection-sinks` | no |
| No note content, prompts, history or credentials reach the console | ✅ PASS | 1 | 38 console call(s), none passing user content or credentials | `logging-hygiene` | no |
| Access to files outside the vault is disclosed | ✅ PASS | 1 | README/PRIVACY explain the storage directory outside the vault | `disclosure-external-files` | no |
| The Local API Base URL is validated centrally and warned about in the UI | ✅ PASS | 1 | assessLocalBaseUrl guards both the request path and the settings UI | `local-url-validation` | no |
| Untrusted response bodies are sanitized before they reach a message or log | ✅ PASS | 1 | every provider response body passes through sanitizeErrorDetail() | `error-redaction` | no |
| File paths outside the vault are confined to the data directory | ✅ PASS | 1 | containment enforced at 5 site(s) in src/storage/ | `path-containment` | no |
| Ignored RAG paths are enforced at indexing, retrieval and prompt assembly | ✅ PASS | 1 | enforced in the engine (13 sites), the chat view (3) and the link resolver (4) | `rag-ignore-enforcement` | no |
| The lockfile is committed, complete and pinned to the public registry | ✅ PASS | 1 | lockfileVersion 3, 349 entries, all pinned with integrity hashes | `lockfile-integrity` | no |
| No dependency is installed from a URL, git or a local path | ✅ PASS | 1 | every dependency is a registry version range | `dependency-specifiers` | no |
| npm audit finds no high or critical vulnerability | ✅ PASS | 1 | critical=0 high=0 moderate=1 low=0 | `npm-audit` | no |
| No attacker-controllable context is interpolated into a shell | ✅ PASS | 1 | no untrusted GitHub context is interpolated into a run step | `actions-script-injection` | no |
| manifest, package, lockfile, versions.json and the git tag agree | ✅ PASS | 1 | version 1.1.1 is consistent across all files and has a matching tag | `version-consistency` | no |
| The release publishes main.js, manifest.json and styles.css | ✅ PASS | 1 | all 3 required asset(s) are uploaded | `release-assets` | no |
| README, PRIVACY and SECURITY contain every required disclosure | ✅ PASS | 1 | every required section is present in README.md, PRIVACY.md and SECURITY.md | `required-doc-sections` | no |
| minAppVersion is declared and consistent with versions.json | ✅ PASS | 1 | minAppVersion 1.7.2 matches versions.json | `manifest-min-app-version` | no |
| All network calls go through Obsidian requestUrl | ✅ PASS | 1 | no fetch/XHR/WebSocket/sendBeacon in src/; requestUrl is used | `request-url-only` | no |
| FileSystemAdapter is only used behind an instanceof guard | ✅ PASS | 1 | 2 reference(s), 1 instanceof guard(s) | `filesystem-adapter-guard` | no |
| The .obsidian configuration directory is not hardcoded | ✅ PASS | 1 | configDir is always read from the vault | `no-hardcoded-config-dir` | no |
| Vault files are trashed rather than hard-deleted | ✅ PASS | 1 | no direct vault file deletion | `trash-file-usage` | no |
| The plugin operates no backend of its own | ✅ PASS | 1 | no first-party endpoint in source, and PRIVACY.md says so explicitly | `no-first-party-backend` | no |
| Required accounts, keys and possible costs are disclosed | ✅ PASS | 1 | accounts, keys and cost implications are documented | `disclosure-costs` | no |
| JSON files are written atomically | ✅ PASS | 1 | writes go through a temp file plus rename | `atomic-json-writes` | no |
| The key file is restricted to the current user where the platform allows it | ✅ PASS | 1 | keys.json is written with owner-only permissions | `key-file-permissions` | no |
| Untrusted JSON is parsed inside a try/catch | ✅ PASS | 1 | all 7 JSON.parse call(s) are inside a try block | `json-parse-guarded` | no |
| Packages with install scripts are known and accepted | ✅ PASS | 1 | install scripts: esbuild — all accepted | `install-scripts` | no |
| Every dependency licence is on the allow list | ✅ PASS | 1 | 348 package(s), all on the allow list: MIT×293, Apache-2.0×25, ISC×17, BSD-2-Clause×7, BSD-3-Clause×2, Python-2.0×1, MPL-2.0×1, BlueOak-1.0.0×1, 0BSD×1 | `license-inventory` | no |
| A LICENSE file exists and the licence is stated | ✅ PASS | 1 | MIT, LICENSE present and referenced from the README | `license-present` | no |
| Everything bundled into the release is present as readable source | ✅ PASS | 1 | no runtime dependencies and no committed binaries; the bundle is built only from src/ | `source-availability` | no |
| Checkout does not keep credentials when they are not needed | ✅ PASS | 1 | checkout credentials are only kept where a push happens | `actions-persist-credentials` | no |
| Build provenance covers every published artefact | ✅ PASS | 1 | all 3 published artefact(s) are attested | `attestation-coverage` | no |
| SECURITY.md warns against posting keys, notes and full logs in public issues | ✅ PASS | 1 | the policy warns against posting credentials, private notes and raw logs | `security-policy-warnings` | no |
| Every policy exception has an owner, a justification and a live expiry | ✅ PASS | 1 | 2 exception(s), all attributed and unexpired | `policy-exceptions` | no |
| A valid CycloneDX SBOM is generated | ✅ PASS | 1 | CycloneDX 1.5 with 348 components written to sbom.cdx.json | `sbom` | no |
| fundingUrl is absent or a valid https link | ✅ PASS | 1 | fundingUrl is not set | `manifest-funding-url` | no |
| Command ids do not repeat the plugin id | ✅ PASS | 1 | no command id repeats the plugin id | `command-id-prefix` | no |
| Sample plugin code has been removed | ✅ PASS | 1 | no sample-plugin identifiers found | `no-sample-code` | no |
| No use of the global app instance | ✅ PASS | 1 | app is always reached through the plugin/view instance | `no-global-app` | no |
| No `any` casts in the plugin source | ✅ PASS | 1 | no `any` in src/ | `no-any-casts` | no |
| No advertising inside or outside the plugin interface | ✅ PASS | 1 | no advertising code found | `no-ads` | no |
| Every third-party action is pinned to a full commit SHA | ✅ PASS | 1 | 15 action reference(s), all pinned to a full SHA | `actions-sha-pinning` | no |
| Workflows declare least-privilege permissions | ✅ PASS | 1 | all 3 workflow(s) declare explicit permissions | `actions-permissions` | no |
| Workflows are hardened: timeouts, concurrency, no secret echo, no curl-to-shell | ✅ PASS | 1 | timeouts, concurrency and log hygiene are all in place | `actions-hardening` | no |
| main.js is a build output, not a committed file | ✅ PASS | 1 | main.js is git-ignored and untracked | `main-js-not-committed` | no |
| The security and privacy checks are documented | ✅ PASS | 1 | docs/SECURITY-PRIVACY-CHECKS.md describes what runs and how to reproduce it | `checks-documentation` | no |

## Policy sources

- https://cheatsheetseries.owasp.org/cheatsheets/CI_CD_Security_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/User_Privacy_Protection_Cheat_Sheet.html
- https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-github-hosted-runners
- https://docs.github.com/en/actions/reference/security/secure-use#understanding-the-risk-of-script-injections
- https://docs.github.com/en/actions/reference/security/secure-use#using-secrets
- https://docs.github.com/en/actions/reference/security/secure-use#using-the-github_token-in-a-workflow
- https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions
- https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
- https://docs.github.com/en/code-security/tutorials/implement-supply-chain-best-practices/securing-builds
- https://docs.github.com/en/code-security/tutorials/implement-supply-chain-best-practices/securing-code
- https://docs.obsidian.md/Developer+policies
- https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions
- https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins
- https://docs.obsidian.md/oo/plugin
- https://docs.obsidian.md/plugins/guides/secret-storage
- https://obsidian.md/help/plugin-security
- https://owasp.org/www-project-application-security-verification-standard/
- https://owasp.org/www-project-software-component-verification-standard/

---

This report is an automated check of selected safeguards and compliance evidence. It is not a certification of GDPR compliance, and it does not mean the plugin has been approved by Obsidian.
