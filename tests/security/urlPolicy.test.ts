import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	assessLocalBaseUrl,
	isLoopbackHostname,
	FORBIDDEN_PROTOCOLS,
} from "../../src/security/urlPolicy";

describe("isLoopbackHostname", () => {
	it("accepts the exact localhost name", () => {
		assert.equal(isLoopbackHostname("localhost"), true);
		assert.equal(isLoopbackHostname("LOCALHOST"), true);
		assert.equal(isLoopbackHostname("localhost."), true);
	});

	it("accepts the whole 127.0.0.0/8 range", () => {
		assert.equal(isLoopbackHostname("127.0.0.1"), true);
		assert.equal(isLoopbackHostname("127.0.0.53"), true);
		assert.equal(isLoopbackHostname("127.255.255.254"), true);
	});

	it("accepts IPv6 loopback in every spelling used by the URL parser", () => {
		assert.equal(isLoopbackHostname("::1"), true);
		assert.equal(isLoopbackHostname("[::1]"), true);
		assert.equal(isLoopbackHostname("0:0:0:0:0:0:0:1"), true);
		assert.equal(isLoopbackHostname("::ffff:127.0.0.1"), true);
	});

	it("rejects hosts that merely contain the word localhost", () => {
		// This is the host-confusion trick a substring check would fall for.
		assert.equal(isLoopbackHostname("localhost.evil.example"), false);
		assert.equal(isLoopbackHostname("notlocalhost"), false);
		assert.equal(isLoopbackHostname("my-localhost.com"), false);
		assert.equal(isLoopbackHostname("localhost-evil.example"), false);
		assert.equal(isLoopbackHostname("sub.localhost"), false);
	});

	it("rejects non-loopback addresses and malformed input", () => {
		assert.equal(isLoopbackHostname("128.0.0.1"), false);
		assert.equal(isLoopbackHostname("192.168.1.10"), false);
		assert.equal(isLoopbackHostname("10.0.0.1"), false);
		assert.equal(isLoopbackHostname("127.0.0.999"), false);
		assert.equal(isLoopbackHostname(""), false);
		assert.equal(isLoopbackHostname("   "), false);
	});
});

describe("assessLocalBaseUrl — loopback HTTP is the expected local setup", () => {
	for (const url of [
		"http://localhost:1234/v1",
		"http://127.0.0.1:11434",
		"http://127.5.5.5:8080/v1",
		"http://[::1]:11434",
	]) {
		it(`treats ${url} as loopback HTTP without a warning`, () => {
			const result = assessLocalBaseUrl(url);
			assert.equal(result.usable, true);
			assert.equal(result.verdict, "loopback-http");
			assert.equal(result.isLoopback, true);
			assert.equal(result.requiresWarning, false);
			assert.equal(result.reason, null);
		});
	}
});

describe("assessLocalBaseUrl — remote endpoints", () => {
	it("flags remote plaintext HTTP as requiring a warning but still usable", () => {
		const result = assessLocalBaseUrl("http://192.168.1.50:11434");
		assert.equal(result.usable, true, "a LAN server must not be blocked outright");
		assert.equal(result.verdict, "remote-http");
		assert.equal(result.isLoopback, false);
		assert.equal(result.requiresWarning, true);
		assert.equal(result.reason, "remote-plaintext");
	});

	it("flags a public plaintext host the same way", () => {
		const result = assessLocalBaseUrl("http://api.example.com/v1");
		assert.equal(result.verdict, "remote-http");
		assert.equal(result.requiresWarning, true);
	});

	it("accepts remote HTTPS without a warning", () => {
		const result = assessLocalBaseUrl("https://gateway.example.com/v1");
		assert.equal(result.usable, true);
		assert.equal(result.verdict, "remote-https");
		assert.equal(result.requiresWarning, false);
	});

	it("does not treat a look-alike loopback host as local", () => {
		const result = assessLocalBaseUrl("http://localhost.attacker.example/v1");
		assert.equal(result.isLoopback, false);
		assert.equal(result.verdict, "remote-http");
		assert.equal(result.requiresWarning, true);
	});
});

describe("assessLocalBaseUrl — rejected input", () => {
	it("rejects every forbidden scheme", () => {
		for (const scheme of FORBIDDEN_PROTOCOLS) {
			const result = assessLocalBaseUrl(`${scheme}//example/payload`);
			assert.equal(result.usable, false, `${scheme} must not be usable`);
			assert.equal(result.verdict, "invalid");
		}
	});

	it("names the reason for a forbidden scheme", () => {
		assert.equal(assessLocalBaseUrl("file:///etc/passwd").reason, "forbidden-scheme");
		assert.equal(assessLocalBaseUrl("javascript:alert(1)").reason, "forbidden-scheme");
		assert.equal(assessLocalBaseUrl("data:text/plain,hello").reason, "forbidden-scheme");
		assert.equal(assessLocalBaseUrl("ftp://example.com/x").reason, "forbidden-scheme");
	});

	it("rejects empty and unparseable values", () => {
		assert.equal(assessLocalBaseUrl("").reason, "empty");
		assert.equal(assessLocalBaseUrl("   ").reason, "empty");
		assert.equal(assessLocalBaseUrl("localhost:1234").usable, false);
		assert.equal(assessLocalBaseUrl("not a url").reason, "unparseable");
	});

	it("never throws, whatever it is handed", () => {
		for (const value of ["", "http://", "://", "http://[oops", "%%%"]) {
			assert.doesNotThrow(() => assessLocalBaseUrl(value));
		}
	});
});

describe("assessLocalBaseUrl — embedded credentials", () => {
	it("detects credentials in the URL and asks for a warning", () => {
		const result = assessLocalBaseUrl("https://user:hunter2@gateway.example.com/v1");
		assert.equal(result.hasEmbeddedCredentials, true);
		assert.equal(result.requiresWarning, true);
		assert.equal(result.reason, "embedded-credentials");
	});

	it("reports plaintext as the more severe reason when both apply", () => {
		const result = assessLocalBaseUrl("http://user:hunter2@gateway.example.com/v1");
		assert.equal(result.hasEmbeddedCredentials, true);
		assert.equal(result.reason, "remote-plaintext");
	});
});
