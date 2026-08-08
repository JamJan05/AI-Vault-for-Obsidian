# Privacy

Fixture: a privacy document that is missing every required section.

The required-doc-sections check declares which sections must exist in
`.compliance/ai-vault-policy.json` under `requiredDocuments`. This file contains
none of them, so feeding it to the docs check must produce FAIL.
