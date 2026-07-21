/* Level Designer — sync.js
 * Live state sharing between every tab/window of the tool on this machine.
 *
 * Why: the doc used to live only in one tab's memory, so opening the designer on
 * a second screen gave you a second independent copy loaded from disk. Editing
 * one screen left the other stale, and whichever one you saved last silently
 * overwrote the other's work (writeHandle stringifies the whole doc, no merge).
 *
 * Model: one shared document, last edit wins, no merge. That's the right fit
 * here — it's one designer looking at several screens, not two people editing.
 * Every local edit is broadcast (debounced); every tab applies what it receives.
 */

const NAME = "leveldesign-sync";
const PUSH_DELAY = 200; // coalesce keystrokes; a doc is a few hundred KB
const HELLO_WAIT = 400; // how long a booting tab waits for a dirty tab to answer

export const tabId = Math.random().toString(36).slice(2);

export function makeBus({ onState, onSaved, getState }) {
  // Firefox/Chrome/Edge all ship BroadcastChannel; if it's ever missing the tool
  // must still work, just without cross-tab sync.
  if (typeof BroadcastChannel !== "function") {
    return { push() {}, saved() {}, announceHandle() {}, hello: async () => null, alive: false };
  }
  const ch = new BroadcastChannel(NAME);
  let pending = null;
  let helloReply = null; // resolve() of the in-flight hello(), if any

  ch.onmessage = ({ data }) => {
    if (!data || data.from === tabId) return;
    switch (data.t) {
      case "hello": {
        // Only tabs holding something the newcomer can't get from disk answer:
        // unsaved edits, or the file handle (which a duplicated tab never
        // inherits, so without this its first Sauvegarder re-prompts a picker).
        const s = getState();
        if (s.dirty || s.handle) ch.postMessage({ t: "state", from: tabId, to: data.from, ...s });
        break;
      }
      case "state":
        if (data.to && data.to !== tabId) return;
        if (helloReply) { helloReply(data); helloReply = null; }
        else onState(data);
        break;
      case "saved":
        onSaved(data);
        break;
    }
  };

  const post = (m) => ch.postMessage({ ...m, from: tabId });

  return {
    alive: true,
    // Debounced so a burst of keystrokes sends one message, but always trailing:
    // the last edit must go out or tabs diverge.
    push(state) {
      clearTimeout(pending);
      pending = setTimeout(() => post({ t: "state", ...state }), PUSH_DELAY);
    },
    // Carries the doc as written, so the pending push can be dropped: a tab that
    // only got the "saved" flag would clear its unsaved marker while still
    // holding the edits that preceded the save.
    saved(handle) {
      clearTimeout(pending);
      post({ t: "saved", ...getState(), dirty: false, handle });
    },
    announceHandle(handle) { post({ t: "state", ...getState(), handle }); },
    // Resolves with another tab's state, or null if nobody has anything better
    // than the file on disk.
    hello() {
      return new Promise((resolve) => {
        const done = (v) => { helloReply = null; resolve(v); };
        helloReply = done;
        post({ t: "hello" });
        setTimeout(() => { if (helloReply === done) done(null); }, HELLO_WAIT);
      });
    },
  };
}
