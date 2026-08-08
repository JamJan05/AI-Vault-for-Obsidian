# Compliance controller fixtures

Deliberately non-compliant inputs used by `tests/compliance/controller.test.ts` to
prove that the checks in `scripts/compliance/checks/` actually fail when they
should. A check that never fires is indistinguishable from a check that is broken.

**Every credential-shaped string in this directory is synthetic and contains the
marker `EXAMPLENOTAREALKEY` or `NOTAREALSECRET`.** The secret scanner requires that
marker inside `.compliance/fixtures/` and `tests/`; a credential-shaped literal
here without it fails the run. Nothing in this directory is or ever was a working
credential, and nothing here is loaded by the plugin at runtime.

| File | Represents |
|---|---|
| `leaked-key.txt` | An obviously fake API key committed to the repository |
| `base-urls.json` | Base URL cases: loopback HTTP, remote HTTP, forbidden schemes, look-alike hosts |
| `path-traversal.json` | Storage path segments that must be refused |
| `authorization-logging.ts.txt` | Source that logs an `Authorization` header and note content |
| `missing-privacy-section.md` | A `PRIVACY.md` with required sections removed |
| `version-mismatch.json` | manifest / package / versions that disagree |

`authorization-logging.ts.txt` uses a `.txt` suffix so it is never compiled into
the plugin or type-checked as project source.
