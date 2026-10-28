import assert from "node:assert/strict";
import test from "node:test";
import { readComposerText } from "../chatgpt-composer.mjs";

const text = (value) => ({ nodeType: 3, nodeName: "#text", nodeValue: value });
const element = (tag, ...children) => ({ nodeType: 1, nodeName: tag, childNodes: children });
const paragraph = (...children) => element("P", ...children);
const trailingBreak = () => ({ ...element("BR"), classList: { contains: (name) => name === "ProseMirror-trailingBreak" } });
const editor = (...children) => ({
  ...element("DIV", ...children),
  get innerText() { throw new Error("Visual innerText must not determine the submitted text"); },
});

test("the observed three-paragraph DOM represents 995 characters, not 997", () => {
  const paragraphs = ["甲".repeat(375), "乙".repeat(299), "丙".repeat(319)];
  assert.equal(paragraphs.join("\n\n").length, 997);
  const actual = readComposerText(editor(...paragraphs.map(value => paragraph(text(value)))));
  assert.equal(actual.length, 995);
  assert.equal(actual, paragraphs.join("\n"));
});

test("empty paragraphs remain explicit blank lines", () => {
  assert.equal(readComposerText(editor(paragraph(text("one")), paragraph(trailingBreak()), paragraph(text("three")))), "one\n\nthree");
});

test("explicit hard breaks are retained and ProseMirror caret placeholders are ignored", () => {
  assert.equal(readComposerText(editor(paragraph(text("one"), element("BR"), text("two"), element("BR"), trailingBreak()))), "one\ntwo\n");
  assert.equal(readComposerText(editor(paragraph(trailingBreak()))), "");
});

test("inline marks, literal spaces, tabs, and code indentation are preserved", () => {
  assert.equal(readComposerText(editor(paragraph(text("  one "), element("STRONG", text("two")), text("\t three  ")), paragraph(text("    code")))), "  one two\t three  \n    code");
});

test("textareas use their value without DOM paragraph conversion", () => {
  assert.equal(readComposerText({ value: "one\r\n\r\n  two" }), "one\r\n\r\n  two");
});

test("comments and inline wrappers do not introduce paragraph separators", () => {
  assert.equal(readComposerText(editor(paragraph(element("SPAN", text("one")), { nodeType: 8, nodeName: "#comment" }, element("EM", text("two"))))), "onetwo");
});
