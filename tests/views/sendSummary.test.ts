/**
 * The send summary tells the user where note text is about to go. If it is
 * wrong, the user's consent is based on a false statement — so it is tested.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { describeOutgoing } from "../../src/views/sendSummary";
import { setLanguage } from "../../src/i18n";
import type { SendSummaryInput } from "../../src/views/sendSummary";

const BASE: SendSummaryInput = {
	provider:       "openai",
	localBaseUrl:   "http://localhost:1234/v1",
	ragActive:      false,
	semanticActive: false,
	attachedNotes:  0,
	webSearch:      false,
	projectActive:  false,
	historyLimit:   0,
};

const summary = (overrides: Partial<SendSummaryInput>): ReturnType<typeof describeOutgoing> =>
	describeOutgoing({ ...BASE, ...overrides });

afterEach(() => setLanguage("en"));

describe("describeOutgoing — destination", () => {
	it("names the cloud provider", () => {
		assert.match(summary({ provider: "openai" }).text, /^Sends to OpenAI:/);
		assert.match(summary({ provider: "anthropic" }).text, /^Sends to Anthropic:/);
	});

	it("says a loopback server is this device", () => {
		for (const url of ["http://localhost:11434", "http://127.0.0.1:1234/v1", "http://[::1]:8080"]) {
			const result = summary({ provider: "local", localBaseUrl: url });
			assert.match(result.text, /^Sends to this device \(/, url);
			assert.equal(result.warning, false, url);
		}
	});

	it("names a remote host and never calls it this device", () => {
		const result = summary({ provider: "local", localBaseUrl: "https://gateway.example.com/v1" });
		assert.match(result.text, /^Sends to gateway\.example\.com:/);
		assert.equal(result.text.includes("this device"), false);
		assert.equal(result.warning, false);
	});

	it("is not fooled by a hostname that merely contains localhost", () => {
		for (const url of ["http://localhost.evil.example/v1", "http://notlocalhost:1234"]) {
			const result = summary({ provider: "local", localBaseUrl: url });
			assert.equal(result.text.includes("this device"), false, url);
			assert.equal(result.warning, true, url);
		}
	});

	it("warns about plain HTTP to a remote host", () => {
		const result = summary({ provider: "local", localBaseUrl: "http://192.168.1.10:11434" });
		assert.equal(result.warning, true);
		assert.match(result.text, /Not encrypted/);
	});

	it("never shows credentials embedded in the URL", () => {
		const result = summary({ provider: "local", localBaseUrl: "https://user:hunter2@gateway.example.com/v1" });
		assert.equal(result.text.includes("hunter2"), false);
		assert.equal(result.text.includes("user:"), false);
	});

	it("falls back to a generic name for an unusable URL", () => {
		for (const url of ["", "not a url", "file:///etc/passwd", "javascript:alert(1)"]) {
			const result = summary({ provider: "local", localBaseUrl: url });
			assert.match(result.text, /^Sends to your Local API:/, url);
		}
	});

	it("ignores the Local API URL for cloud providers", () => {
		const result = summary({ provider: "anthropic", localBaseUrl: "http://192.168.1.10:11434" });
		assert.equal(result.warning, false);
		assert.equal(result.text.includes("192.168"), false);
	});
});

describe("describeOutgoing — contents", () => {
	it("always lists the message and the conversation", () => {
		const { text } = summary({});
		assert.match(text, /your message/);
		assert.match(text, /the whole conversation/);
	});

	it("states the history limit when one is set", () => {
		const { text } = summary({ historyLimit: 12 });
		assert.match(text, /the last 12 messages/);
		assert.equal(text.includes("whole conversation"), false);
	});

	it("lists each source only when it is active", () => {
		const quiet = summary({}).text;
		for (const word of ["attached", "RAG", "project", "web search"]) {
			assert.equal(quiet.includes(word), false, word);
		}

		const loud = summary({ attachedNotes: 3, ragActive: true, projectActive: true, webSearch: true }).text;
		assert.match(loud, /3 attached note/);
		assert.match(loud, /up to 5 note fragments found by RAG/);
		assert.match(loud, /other chats in the project/);
		assert.match(loud, /web search by the provider/);
	});

	it("never claims web search for the Local API", () => {
		const { text } = summary({ provider: "local", webSearch: true });
		assert.equal(text.includes("web search"), false);
	});
});

describe("describeOutgoing — semantic search", () => {
	it("discloses the second destination when chatting with another provider", () => {
		for (const provider of ["anthropic", "local"] as const) {
			const { text } = summary({ provider, ragActive: true, semanticActive: true });
			assert.match(text, /also goes to OpenAI/, provider);
		}
	});

	it("does not repeat OpenAI when OpenAI is already the destination", () => {
		const { text } = summary({ provider: "openai", ragActive: true, semanticActive: true });
		assert.equal(text.includes("also goes to OpenAI"), false);
	});

	it("says nothing when semantic search or RAG is off", () => {
		assert.equal(summary({ provider: "anthropic", ragActive: true, semanticActive: false }).text.includes("OpenAI"), false);
		assert.equal(summary({ provider: "anthropic", ragActive: false, semanticActive: true }).text.includes("OpenAI"), false);
	});
});

describe("describeOutgoing — language", () => {
	it("is translated", () => {
		setLanguage("pl");
		const { text } = summary({ provider: "anthropic", ragActive: true, semanticActive: true });
		assert.match(text, /^Wysyła do Anthropic:/);
		assert.match(text, /trafia też do OpenAI/);
	});
});

describe("describeOutgoing — note tools", () => {
	it("says nothing while the tools are off", () => {
		assert.equal(summary({}).text.includes("read your notes"), false);
		assert.equal(summary({ noteTools: false, autoApply: true }).text.includes("read your notes"), false);
		assert.equal(summary({ noteTools: false, autoApply: true }).warning, false);
	});

	it("says that notes can be read, where they go, and that changes are approved", () => {
		const result = summary({ provider: "anthropic", noteTools: true });
		assert.match(result.text, /can read your notes — what it reads goes to Anthropic/);
		assert.match(result.text, /you approve one by one/);
		assert.equal(result.warning, false);
	});

	it("warns when changes are written without asking", () => {
		const result = summary({ provider: "openai", noteTools: true, autoApply: true });
		assert.match(result.text, /CHANGE THEM WITHOUT ASKING/);
		assert.equal(result.warning, true);
	});

	it("says nothing for a local model, which is not offered the tools", () => {
		const result = summary({ provider: "local", noteTools: true, autoApply: true });
		assert.equal(result.text.includes("read your notes"), false);
		assert.equal(result.warning, false);
	});
});

describe("describeOutgoing — marked notes", () => {
	it("says that only marked notes can be changed, when that is required", () => {
		assert.match(summary({ noteTools: true, requireMark: true }).text, /Only notes you mark with #name/);
		assert.equal(summary({ noteTools: true, requireMark: false }).text.includes("#name"), false);
		assert.equal(summary({ noteTools: false, requireMark: true }).text.includes("#name"), false);
	});
});

describe("describeOutgoing — linked notes", () => {
	it("says that linked notes can be changed too, only when that is on", () => {
		assert.match(summary({ noteTools: true, requireMark: true, followLinks: true }).text, /and the notes they link to/);
		assert.equal(summary({ noteTools: true, requireMark: true }).text.includes("link to"), false);
		assert.equal(summary({ noteTools: true, requireMark: false, followLinks: true }).text.includes("link to"), false);
	});
});
