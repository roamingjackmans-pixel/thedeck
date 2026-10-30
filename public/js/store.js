// Saving to this browser (localStorage). Every call is wrapped so a private window or blocked storage
// never breaks the game; it just forgets things when the page closes.
const PREFIX = 'thedeck.';

export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Returns false if the browser refused to save. */
export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* nothing saved, nothing to remove */ }
}
