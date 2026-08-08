# Security policy — AI-Vault for Obsidian

## Reporting a vulnerability

**Report privately. Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:

1. Go to <https://github.com/JamJan05/AI-Vault-for-Obsidian/security/advisories/new>
2. Describe the issue, the impact, and how to reproduce it.

If private reporting is unavailable to you, open a public issue that says only
*"security issue, please contact me"* — with no technical detail — and wait to be
contacted.

For a vulnerability in Obsidian itself rather than in this plugin, report it to
the Obsidian team: <https://help.obsidian.md/Help+and+support#Report+a+security+issue>.

### What to include

- What an attacker can achieve, concretely.
- The steps to reproduce, and the plugin version (see `manifest.json`).
- Your Obsidian version and operating system.
- The provider and model in use, if relevant.
- A minimal proof of concept.

### What never to put in a report — public or private

Reports are read by humans and, once an advisory is published, by everyone.
**Never include:**

- 🔑 **API keys or tokens** — not OpenAI, Anthropic, Local API, GitHub, nor any
  `Authorization` header. If a key was ever exposed, rotate it at the provider
  first, then report.
- 📓 **Private note content** — reproduce with a throwaway vault and synthetic
  notes instead. "A note containing X triggers Y" is enough.
- 📋 **Unredacted logs** — Obsidian console output can carry file paths and error
  bodies. Trim it to the relevant lines and remove anything identifying.
- 🌐 **Raw responses from a private endpoint** — a Local API response can echo
  your prompt and your key.
- 🧑 **Personal data** — yours or anyone else's — that is not needed to diagnose
  the issue.

If a credential is genuinely necessary to demonstrate the issue, say so in the
report and do not paste it; it will be arranged out of band.

### Response

This is a single-maintainer project, so please be patient.

| Stage | Target |
|---|---|
| Acknowledgement | within 7 days |
| Initial assessment | within 14 days |
| Fix or documented mitigation for a confirmed high/critical issue | within 30 days of confirmation |

Credit is given in the release notes unless you prefer otherwise. Please give a
reasonable window before public disclosure.

---

## Supported versions

Only the latest released version receives security fixes. Older versions are not
patched.

| Version | Supported |
|---|---|
| Latest release | ✅ |
| Anything earlier | ❌ — update first |

The current version is in [`manifest.json`](manifest.json); releases are at
<https://github.com/JamJan05/AI-Vault-for-Obsidian/releases>.

---

## Security model

### What this plugin is trusted with

Obsidian states plainly that it *"cannot reliably restrict plugins to specific
permissions"* — a community plugin inherits the application's full access
(<https://obsidian.md/help/plugin-security>). Installing AI-Vault means trusting
it with your vault contents, your API keys and network access. Everything below
is about deserving that trust, not about a sandbox that would enforce it.

### What the plugin can do

- Read `.md` and `.canvas` files in your vault (for RAG and attached context).
- Create notes in an `AI-Vault/` folder when you export a conversation.
- Read and write files in one directory outside the vault (history, projects, RAG
  index, API keys). Path handling refuses anything that would escape it.
- Make HTTPS requests to `api.openai.com` and `api.anthropic.com`, and requests to
  the Local API Base URL you configure.

### What it deliberately does not do

- No `eval`, no `Function` constructor, no `child_process`, no shell.
- No `innerHTML`, `outerHTML` or `insertAdjacentHTML`.
- No `fetch` — every request goes through Obsidian's `requestUrl`.
- No telemetry, no analytics, no crash reporting, no first-party backend.
- No self-update, and no downloading of code at runtime.
- No reading of the clipboard.

### Where secrets live

API keys are stored in plaintext JSON, by default in `keys.json` in the storage
folder outside your vault, restricted to your user account where the operating
system supports it. If you enable **"Sync API keys via Obsidian Sync"** they move
into `data.json` inside the vault and travel with your sync and your backups.

Keys are not currently held in Obsidian's `SecretStorage`; that API requires a
newer Obsidian than this plugin's `minAppVersion`. See `PRIVACY.md` and
`.compliance/obsidian-policy-map.json` (`OBS-SEC-002`).

**If you suspect a key was exposed, rotate it at the provider immediately.** The
plugin cannot revoke a key.

---

## Verifying a release

Release assets are built by GitHub Actions from a tagged commit and carry a signed
build provenance attestation. To verify what you downloaded:

```bash
gh attestation verify main.js -R JamJan05/AI-Vault-for-Obsidian
gh attestation verify manifest.json -R JamJan05/AI-Vault-for-Obsidian
gh attestation verify styles.css -R JamJan05/AI-Vault-for-Obsidian
```

To reproduce the build yourself and compare it byte for byte:

```bash
git clone https://github.com/JamJan05/AI-Vault-for-Obsidian
cd AI-Vault-for-Obsidian
git checkout <tag>
npm ci
npm run build
sha256sum main.js
```

The digest must match the published `main.js`. If it does not, do not install it —
open a security report.

---

## Automated checks

Every pull request and push to `main`, plus a weekly scheduled run, executes the
security and privacy workflow: build, lint, unit tests, secret scanning, CodeQL,
`npm audit`, dependency review, licence checks, SBOM generation, a GitHub Actions
audit and the Obsidian policy compliance checks.

What runs, what it proves and how to reproduce it locally is documented in
[`docs/SECURITY-PRIVACY-CHECKS.md`](docs/SECURITY-PRIVACY-CHECKS.md).

These checks verify selected safeguards and compliance evidence. They are not a
certification of compliance with any regulation, and passing them does not mean
the plugin has been approved by Obsidian.
