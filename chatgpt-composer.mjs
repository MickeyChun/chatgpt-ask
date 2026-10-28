// Page-side helpers. Use stable composer ids first; labels are localized and may change.
const editorExpr = "(document.querySelector('#prompt-textarea') || document.querySelector('.ProseMirror'))";
export const composerReadyExpr = `!!${editorExpr} && document.readyState === 'complete'`;
export const focusComposerExpr = `${editorExpr}.focus()`;
export const selectComposerContentsExpr = `(() => {
  const editor = ${editorExpr};
  editor.focus();
  if (typeof editor.select === 'function') editor.select();
  else {
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
})()`;

// innerText inserts visual paragraph spacing ("\n\n") that is not part of the
// draft. Read logical block separators and explicit hard breaks instead.
export function readComposerText(editor) {
  if (typeof editor.value === "string") return editor.value;
  const blocks = new Set(["P", "DIV", "PRE", "LI", "UL", "OL", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6"]);
  const readNode = (node) => {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (node.nodeName === "BR") return node.classList?.contains("ProseMirror-trailingBreak") ? "" : "\n";
    return readChildren(node);
  };
  const readChildren = (node) => {
    const children = [...node.childNodes].filter((child) => child.nodeType === 1 || child.nodeType === 3);
    return children.map((child, index) => {
      const previous = children[index - 1];
      const separator = index > 0 && (blocks.has(child.nodeName) || blocks.has(previous.nodeName)) ? "\n" : "";
      return separator + readNode(child);
    }).join("");
  };
  return readChildren(editor);
}

export const composerStateExpr = (prompt, conversationId = null) => `(() => {
  const editor = ${editorExpr};
  if (!editor) return { state: 'no_editor' };
  ${conversationId ? `if (!location.pathname.endsWith(${JSON.stringify(`/c/${conversationId}`)})) return { state: 'wrong_conversation' };` : ""}
  const text = (${readComposerText.toString()})(editor);
  const normalize = (s) => s.replace(/\\r\\n/g, '\\n').trim();
  const buttons = [...document.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0 && getComputedStyle(b).visibility !== 'hidden');
  const describe = (b) => ({
    id: b.id || '', testId: b.getAttribute('data-testid') || '', label: b.getAttribute('aria-label') || '',
    disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
  });
  if (buttons.some((b) => b.getAttribute('data-testid') === 'stop-button' || /^(stop(?: generating| streaming)?|停止(?:生成|回應|回覆|串流|流式传输)?)$/i.test(b.getAttribute('aria-label') || ''))) return { state: 'busy' };
  if (normalize(text) !== normalize(${JSON.stringify(prompt)})) return {
    state: text.trim() ? 'draft_changed' : 'empty_draft',
    editorTag: editor.tagName, editorId: editor.id, actualLength: text.length, expectedLength: ${JSON.stringify(prompt)}.length,
    startsWithExpected: normalize(text).startsWith(normalize(${JSON.stringify(prompt)})),
    endsWithExpected: normalize(text).endsWith(normalize(${JSON.stringify(prompt)})),
  };
  const form = editor.closest('form');
  const candidates = buttons.filter((b) => {
    const d = describe(b);
    return d.id === 'composer-submit-button' || ['send-button', 'composer-submit-button'].includes(d.testId)
      || /^(send|send prompt|send message|发送|发送消息|发送提示|傳送|傳送訊息|傳送提示|送出|送出訊息)$/i.test(d.label.trim())
      || (form && b.form === form && b.type === 'submit');
  });
  const button = candidates.find((b) => !describe(b).disabled);
  if (!button) return { state: candidates.length ? 'disabled' : 'missing_send_button', buttons: buttons.map(describe).slice(-8) };
  button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = button.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (!rect.width || !rect.height || !button.contains(document.elementFromPoint(x, y))) return { state: 'covered', buttons: [describe(button)] };
  return { state: 'ready', x, y, button: describe(button) };
})()`;
