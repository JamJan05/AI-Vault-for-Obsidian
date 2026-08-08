import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	MAX_DETAIL_LENGTH,
	REDACTED,
	redactSecrets,
	safeErrorMessage,
	sanitizeErrorDetail,
	stripControlCharacters,
} from "../../src/security/redact";

// Every credential-shaped string below is a synthetic, obviously fake literal.
// None of them is or ever was a working key.
const FAKE_OPENAI_KEY = "sk-EXAMPLENOTAREALKEY000000000000000000";
const FAKE_ANTHROPIC_KEY = "sk-ant-EXAMPLENOTAREALKEY0000000000000000";

describe("redactSecrets", () => {
	it("redacts an Authorization: Bearer header", () => {
		const out = redactSecrets(`Authorization: Bearer ${FAKE_OPENAI_KEY}`);
		assert.ok(!out.includes(FAKE_OPENAI_KEY), "the token must not survive");
		assert.ok(out.includes(REDACTED));
	});

	it("redacts a bearer token in a JSON-ish body", () => {
		const out = redactSecrets(`{"Authorization":"Bearer abcdef1234567890"}`);
		assert.ok(!out.includes("abcdef1234567890"));
	});

	it("redacts an x-api-key header", () => {
		const out = redactSecrets(`x-api-key: ${FAKE_ANTHROPIC_KEY}`);
		assert.ok(!out.includes(FAKE_ANTHROPIC_KEY));
	});

	it("redacts OpenAI key shapes wherever they appear", () => {
		const out = redactSecrets(`Incorrect API key provided: ${FAKE_OPENAI_KEY}. Check your key.`);
		assert.ok(!out.includes(FAKE_OPENAI_KEY));
		assert.ok(out.includes("Incorrect API key provided"), "the useful part must survive");
	});

	it("redacts Anthropic key shapes without leaving the sk-ant prefix", () => {
		const out = redactSecrets(`authentication_error: ${FAKE_ANTHROPIC_KEY}`);
		assert.ok(!out.includes(FAKE_ANTHROPIC_KEY));
		assert.ok(!out.includes("sk-ant-"));
	});

	it("redacts the plugin's own settings field names", () => {
		for (const field of ["apiKey", "claudeApiKey", "localApiKey"]) {
			const out = redactSecrets(`{"${field}":"super-secret-value"}`);
			assert.ok(!out.includes("super-secret-value"), `${field} must be redacted`);
		}
	});

	it("redacts credentials embedded in a URL", () => {
		const out = redactSecrets("connect failed: https://alice:hunter2@example.com/v1");
		assert.ok(!out.includes("hunter2"));
		assert.ok(out.includes("example.com"));
	});

	it("leaves ordinary text alone", () => {
		const message = "Local API error 503: upstream unavailable";
		assert.equal(redactSecrets(message), message);
	});

	it("is safe on empty and non-string input", () => {
		assert.equal(redactSecrets(""), "");
		assert.equal(redactSecrets(undefined as unknown as string), "");
	});
});

describe("stripControlCharacters", () => {
	const ESC = String.fromCharCode(0x1b);
	const NUL = String.fromCharCode(0x00);

	it("removes ANSI escapes and NUL bytes", () => {
		const out = stripControlCharacters(`normal${ESC}[31mred${NUL}end`);
		assert.ok(!out.includes(ESC), "escape character must be gone");
		assert.ok(!out.includes(NUL), "NUL byte must be gone");
		assert.equal(out, "normal[31mredend");
	});

	it("removes DEL and C1 control characters", () => {
		const out = stripControlCharacters(`a${String.fromCharCode(0x7f)}b${String.fromCharCode(0x9b)}c`);
		assert.equal(out, "abc");
	});

	it("collapses newlines so a remote value cannot forge a log line", () => {
		const out = stripControlCharacters("line one\nERROR: fake\r\nline two");
		assert.ok(!out.includes("\n"));
		assert.ok(!out.includes("\r"));
		assert.equal(out, "line one ERROR: fake line two");
	});
});

describe("sanitizeErrorDetail", () => {
	it("caps the length and marks the truncation", () => {
		const out = sanitizeErrorDetail("x".repeat(5000));
		assert.ok(out.length <= MAX_DETAIL_LENGTH + 16);
		assert.ok(out.endsWith("… (truncated)"));
	});

	it("honours an explicit shorter cap", () => {
		const out = sanitizeErrorDetail("y".repeat(500), 50);
		assert.ok(out.startsWith("y".repeat(50)));
		assert.ok(out.endsWith("… (truncated)"));
	});

	it("redacts before truncating, so a key cannot survive at the cut", () => {
		const out = sanitizeErrorDetail(`prefix ${FAKE_OPENAI_KEY} suffix`, 4000);
		assert.ok(!out.includes(FAKE_OPENAI_KEY));
	});

	it("accepts Errors, objects, numbers and nullish values", () => {
		assert.equal(sanitizeErrorDetail(new Error("boom")), "boom");
		assert.equal(sanitizeErrorDetail(404), "404");
		assert.equal(sanitizeErrorDetail(null), "");
		assert.equal(sanitizeErrorDetail(undefined), "");
		assert.ok(sanitizeErrorDetail({ detail: "bad gateway" }).includes("bad gateway"));
	});

	it("redacts secrets inside an object payload", () => {
		const out = sanitizeErrorDetail({ error: { message: `bad key ${FAKE_ANTHROPIC_KEY}` } });
		assert.ok(!out.includes(FAKE_ANTHROPIC_KEY));
	});

	it("survives a value that cannot be serialized", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		assert.doesNotThrow(() => sanitizeErrorDetail(cyclic));
	});
});

describe("safeErrorMessage", () => {
	it("keeps the fixed prefix when the detail is dropped", () => {
		assert.equal(safeErrorMessage("Could not connect.", null), "Could not connect.");
		assert.equal(safeErrorMessage("Could not connect.", "   "), "Could not connect.");
	});

	it("appends a sanitized detail when there is one", () => {
		const out = safeErrorMessage("Could not connect.", new Error(`bearer ${FAKE_OPENAI_KEY}`));
		assert.ok(out.startsWith("Could not connect."));
		assert.ok(!out.includes(FAKE_OPENAI_KEY));
	});
});
