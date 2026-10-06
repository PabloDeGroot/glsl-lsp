// glslLsp.nudge* commands: increment/decrement the number under each cursor.

import { Range, window } from 'vscode';
import { planNudge } from './nudgeCore';

/** Nudges the numbers under the cursors; false when the key should do its default (see planNudge). */
export function nudgeNumbers(direction: 1 | -1, multiplier: number): boolean {
  const editor = window.activeTextEditor;
  if (!editor) return false;
  const doc = editor.document;
  const cursors = editor.selections.map((sel) => ({ line: sel.active.line, character: sel.active.character, text: doc.lineAt(sel.active.line).text }));
  const edits = planNudge(cursors, direction, multiplier);
  if (!edits) return false;
  void editor.edit((b) => {
    for (const e of edits) b.replace(new Range(e.line, e.start, e.line, e.end), e.newText);
  });
  return true;
}
