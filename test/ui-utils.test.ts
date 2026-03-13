import assert from "node:assert/strict";
import test from "node:test";

import { safeTruncate, escapeHtml, humanizeOperatorLabel } from "../src/ui/utils";

test("safeTruncate returns original string when shorter than maxLength", () => {
  assert.equal(safeTruncate("hello", 10), "hello");
});

test("safeTruncate truncates long strings with ellipsis", () => {
  assert.equal(safeTruncate("hello world", 8), "hello...");
});

test("safeTruncate handles edge case maxLength of 3", () => {
  assert.equal(safeTruncate("hello", 3), "hel");
});

test("safeTruncate handles edge case maxLength of 0", () => {
  assert.equal(safeTruncate("hello", 0), "");
});

test("safeTruncate handles edge case maxLength of 1", () => {
  assert.equal(safeTruncate("hello", 1), "h");
});

test("safeTruncate handles empty string", () => {
  assert.equal(safeTruncate("", 10), "");
});

test("safeTruncate handles exact length match", () => {
  assert.equal(safeTruncate("hello", 5), "hello");
});

test("escapeHtml escapes ampersand", () => {
  assert.equal(escapeHtml("foo & bar"), "foo &amp; bar");
});

test("escapeHtml escapes less than and greater than", () => {
  assert.equal(escapeHtml("<div>"), "&lt;div&gt;");
});

test("escapeHtml escapes double quotes", () => {
  assert.equal(escapeHtml('foo="bar"'), "foo=&quot;bar&quot;");
});

test("escapeHtml escapes single quotes", () => {
  assert.equal(escapeHtml("foo'bar"), "foo&#39;bar");
});

test("escapeHtml handles empty string", () => {
  assert.equal(escapeHtml(""), "");
});

test("escapeHtml handles string with no special characters", () => {
  assert.equal(escapeHtml("hello world"), "hello world");
});

test("escapeHtml escapes all special characters", () => {
  assert.equal(escapeHtml('<script>alert("xss")</script>'), "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
});

test("humanizeOperatorLabel converts underscores and hyphens to spaces", () => {
  assert.equal(humanizeOperatorLabel("my_agent"), "My Agent");
  assert.equal(humanizeOperatorLabel("my-agent"), "My Agent");
});

test("humanizeOperatorLabel capitalizes first letter of each word", () => {
  assert.equal(humanizeOperatorLabel("hello world"), "Hello World");
});

test("humanizeOperatorLabel handles empty string", () => {
  assert.equal(humanizeOperatorLabel(""), "未知助手");
});

test("humanizeOperatorLabel handles whitespace only", () => {
  assert.equal(humanizeOperatorLabel("   "), "未知助手");
});

test("humanizeOperatorLabel handles multiple spaces", () => {
  assert.equal(humanizeOperatorLabel("hello   world"), "Hello World");
});

test("humanizeOperatorLabel handles multiple underscores", () => {
  assert.equal(humanizeOperatorLabel("my__agent__test"), "My Agent Test");
});

test("humanizeOperatorLabel handles mixed separators", () => {
  assert.equal(humanizeOperatorLabel("my_agent-test"), "My Agent Test");
});
