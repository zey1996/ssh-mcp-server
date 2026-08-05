import { describe, it } from "node:test";
import assert from "node:assert";
import { renderKey } from "../build/services/terminal-session.js";

describe("terminal renderKey", () => {
	it("maps common special keys to the expected escape sequences", () => {
		assert.equal(renderKey("Enter"), "\r");
		assert.equal(renderKey("Return"), "\r");
		assert.equal(renderKey("Escape"), "\x1b");
		assert.equal(renderKey("Esc"), "\x1b");
		assert.equal(renderKey("Tab"), "\t");
		assert.equal(renderKey("Backspace"), "\x7f");
		assert.equal(renderKey("Space"), " ");
		assert.equal(renderKey("Up"), "\x1b[A");
		assert.equal(renderKey("Down"), "\x1b[B");
		assert.equal(renderKey("Right"), "\x1b[C");
		assert.equal(renderKey("Left"), "\x1b[D");
		assert.equal(renderKey("Home"), "\x1b[H");
		assert.equal(renderKey("End"), "\x1b[F");
		assert.equal(renderKey("F1"), "\x1bOP");
		assert.equal(renderKey("F4"), "\x1bOS");
		assert.equal(renderKey("F12"), "\x1b[24~");
	});

	it("translates Ctrl+<letter> into the matching control byte", () => {
		assert.equal(renderKey("Ctrl+C"), "\x03");
		assert.equal(renderKey("Ctrl+D"), "\x04");
		assert.equal(renderKey("Ctrl+Z"), "\x1a");
		assert.equal(renderKey("Ctrl+L"), "\x0c");
		assert.equal(renderKey("Ctrl+["), "\x1b");
	});

	it("prefixes Alt+<char> with ESC", () => {
		assert.equal(renderKey("Alt+x"), "\x1bx");
		assert.equal(renderKey("Alt+Enter"), "\x1bEnter");
	});

	it("passes literal text through unchanged", () => {
		assert.equal(renderKey("1"), "1");
		assert.equal(renderKey("whoami"), "whoami");
		assert.equal(renderKey("/ip"), "/ip");
	});

	it("is case-insensitive for the Ctrl/Alt prefix", () => {
		assert.equal(renderKey("ctrl+c"), "\x03");
		assert.equal(renderKey("ALT+x"), "\x1bx");
	});
});
