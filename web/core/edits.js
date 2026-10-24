// Edits to a previous stage program. A retry usually changes a few lines, and rewriting the whole program costs the
// full output again (loop-2 measurement 2026-10-24: ~70% of stage-program calls are retries that rewrite everything).
// The coder may answer a retry with search/replace blocks against its previous program; a complete program in a
// python block is still accepted when the change is large.
//
//   <<<<<<< SEARCH
//   exact lines of the previous program
//   =======
//   their replacement
//   >>>>>>> REPLACE

import { extractPython } from "./llm.js";

const BLOCK = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n?=======\r?\n([\s\S]*?)\r?\n?>>>>>>> REPLACE/g;

// {code} for an answer that applies, {error} for one that does not (the coder is told why and tries again)
export function applyAnswer(previous, answer) {
  const blocks = [...String(answer).matchAll(BLOCK)].map((m) => ({ search: m[1], replace: m[2] }));
  if (!blocks.length) {
    try {
      return { code: extractPython(answer), edits: 0 };
    } catch (e) {
      return { error: e.message };
    }
  }
  let code = previous;
  for (const [i, b] of blocks.entries()) {
    if (!b.search.trim()) return { error: `edit ${i + 1}: its SEARCH part is empty` };
    const at = code.indexOf(b.search);
    if (at < 0) return { error: `edit ${i + 1}: its SEARCH text is not in the previous program (copy the lines exactly, including indentation)` };
    if (code.indexOf(b.search, at + 1) >= 0) return { error: `edit ${i + 1}: its SEARCH text occurs more than once; include more lines so it is unique` };
    code = code.slice(0, at) + b.replace + code.slice(at + b.search.length);
  }
  return { code, edits: blocks.length };
}
