/* Level Designer — history.js
 * Undo/redo over the whole document.
 *
 * Snapshots, not diffs: every edit path in the tool mutates st.doc in place
 * through dozens of little closures, so there is no single place a diff could be
 * captured. A serialized snapshot per step is a few hundred KB and can't drift
 * from what the editors actually did.
 *
 * mark() runs *after* the mutation, so commit() banks the previous snapshot as
 * the undoable state and keeps the fresh one as the present.
 */

const LIMIT = 60; // ~60 steps back; beyond that the oldest are dropped

export function makeHistory() {
  let present = null;
  let saved = null; // snapshot as last written to disk, for the dirty flag
  const past = [];
  const future = [];

  const clone = (s) => JSON.parse(s);

  return {
    // Start (or restart) from a document with no history — boot, Ouvrir, reload.
    reset(doc) { present = JSON.stringify(doc); past.length = 0; future.length = 0; },

    // `coalesce` folds this change into the previous step instead of adding one:
    // typing "Tutorial_3" is one undo, not ten.
    commit(doc, coalesce = false) {
      const next = JSON.stringify(doc);
      if (next === present) return;
      if (!coalesce) {
        past.push(present);
        if (past.length > LIMIT) past.shift();
        future.length = 0; // a new edit invalidates anything that was undone
      }
      present = next;
    },

    markSaved() { saved = present; },
    isClean() { return present === saved; },
    canUndo() { return past.length > 0; },
    canRedo() { return future.length > 0; },

    undo() {
      if (!past.length) return null;
      future.push(present);
      present = past.pop();
      return clone(present);
    },
    redo() {
      if (!future.length) return null;
      past.push(present);
      present = future.pop();
      return clone(present);
    },
  };
}
