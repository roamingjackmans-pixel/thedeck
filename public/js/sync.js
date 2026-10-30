// Sharing the deck with everyone.
//
// The deck everyone plays is public/cards.json in this site's GitHub repo. A device that has been
// connected with a GitHub token (one that can only edit this repo) publishes by committing a new
// cards.json; GitHub Pages redeploys in about a minute and every phone picks it up.
// Each published deck carries a revision number, so a device can tell when the shared deck changed
// underneath its own unpublished edits.

export const REPO_OWNER = 'roamingjackmans-pixel';
export const REPO_NAME = 'thedeck';
const FILE = 'public/cards.json';
const BRANCH = 'main';
const API = 'https://api.github.com';

/** GitHub's "new token" page with the name, permission and expiry filled in. */
export const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new?' + new URLSearchParams({
  name: 'THE DECK',
  target_name: REPO_OWNER,
  expires_in: '366',
  contents: 'write',
});

const headers = token => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
});

export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(String(b64).replace(/\s/g, '')), c => c.charCodeAt(0)));
}

export class SyncError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function request(fetchImpl, url, init, token) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, cache: 'no-store', headers: { ...headers(token), ...(init?.headers || {}) } });
  } catch {
    throw new SyncError("Couldn't reach GitHub. Check your connection and try again.", 0);
  }
  if (res.ok) return res.json();
  let detail = '';
  try { detail = (await res.json()).message || ''; } catch { /* no body */ }
  if (res.status === 401) {
    throw new SyncError("GitHub didn't accept the token. It may have been mistyped, revoked or expired. Connect this device again with a new one.", 401);
  }
  if (res.status === 403 || res.status === 404) {
    throw new SyncError(`That token can't edit the ${REPO_NAME} repo. Make a new one with access to ${REPO_NAME} and Contents set to "Read and write".`, res.status);
  }
  if (res.status === 409) throw new SyncError('The shared deck changed while publishing.', 409);
  throw new SyncError(`GitHub said no (${res.status}${detail ? `: ${detail}` : ''}).`, res.status);
}

/** Checks a token and returns the GitHub username it belongs to. */
export async function checkToken(token, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const user = await request(fetchImpl, `${API}/user`, { method: 'GET' }, token);
  return user.login;
}

/** The deck file text as it should be committed. */
export function deckFileText(deck, revision, updated = new Date().toISOString()) {
  return JSON.stringify({ format: 'the-deck', version: 1, revision, updated, groups: deck.groups, cards: deck.cards }, null, 2) + '\n';
}

async function readShared(fetchImpl, token) {
  const file = await request(fetchImpl, `${API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE}?ref=${BRANCH}`, { method: 'GET' }, token);
  let revision = 0;
  try { revision = Number(JSON.parse(fromBase64(file.content)).revision) || 0; } catch { /* unreadable: treat as revision 0 */ }
  return { sha: file.sha, revision };
}

/**
 * Publishes a deck for everyone.
 *   baseRevision: the shared revision this device's edits started from.
 *   force: publish even if someone else published since then.
 * Returns { revision, updated } on success, or { conflict: true, revision } when the shared deck
 * moved on since baseRevision and force wasn't set.
 */
export async function publishDeck(token, deck, { baseRevision = 0, force = false, fetch: fetchImpl = globalThis.fetch } = {}) {
  for (let attempt = 0; ; attempt++) {
    const current = await readShared(fetchImpl, token);
    if (!force && current.revision !== baseRevision) return { conflict: true, revision: current.revision };
    const revision = current.revision + 1;
    const updated = new Date().toISOString();
    try {
      await request(fetchImpl, `${API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Update the deck from the secret menu (revision ${revision})`,
          content: toBase64(deckFileText(deck, revision, updated)),
          sha: current.sha,
          branch: BRANCH,
        }),
      }, token);
      return { revision, updated };
    } catch (err) {
      // Someone published between our read and write: read again (once) and re-check.
      if (err.status === 409 && attempt === 0) continue;
      throw err;
    }
  }
}
