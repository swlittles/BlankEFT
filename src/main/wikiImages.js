'use strict';
// Pictures from a quest's page on the Escape from Tarkov wiki (location shots, item spots...), so the
// Details panel can show them without opening the wiki. Fetched through the wiki's MediaWiki API.
const fs = require('fs');
const path = require('path');

const WIKI_HOST = 'escapefromtarkov.fandom.com';
const API = `https://${WIKI_HOST}/api.php`;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const USER_AGENT = 'BlankEFT (desktop quest map)';
// the in-game quest banner, trader/item icons and the like
const SKIP_KEY = /QuestPicture|Banner|Icon|Logo|Portrait|Placeholder/i;
const MIN_WIDTH = 150;

/** "https://escapefromtarkov.fandom.com/wiki/Bad_Rep_Evidence" → "Bad_Rep_Evidence", or null. */
function pageFromLink(link) {
  try {
    const u = new URL(String(link));
    if (u.hostname !== WIKI_HOST) return null;
    const m = /^\/wiki\/(.+)$/.exec(u.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
};

/**
 * Pull the content pictures out of a parsed wiki page's HTML.
 * Returns [{ thumb, full, caption }] in page order, without duplicates.
 */
function parseWikiImages(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/<img\b[^>]*>/g)) {
    const tag = m[0];
    const key = attr(tag, 'data-image-key') || '';
    const width = Number(attr(tag, 'width') || 0);
    const src = attr(tag, 'data-src') || attr(tag, 'src') || '';
    if (!src.startsWith('https://') || src.startsWith('data:')) continue;
    if (width < MIN_WIDTH || SKIP_KEY.test(key)) continue;
    if (seen.has(key || src)) continue;
    seen.add(key || src);
    const full = src.replace(/\/scale-to-width-down\/\d+/, '').replace(/\/smart\/width\/\d+\/height\/\d+/, '');
    const caption = (attr(tag, 'alt') || '').trim();
    out.push({ thumb: src, full, caption: caption && caption !== key.replace(/\.\w+$/, '') ? caption : '' });
  }
  return out;
}

class WikiImages {
  constructor(cacheDir) {
    this.dir = path.join(cacheDir, 'wiki');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Pictures for a wiki link: { page, images, stale? }. Cached for a week; a stale cache beats nothing. */
  async forLink(link) {
    const page = pageFromLink(link);
    if (!page) return { page: null, images: [] };
    const file = path.join(this.dir, `${page.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 120)}.json`);
    let cached = null;
    try {
      cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* not cached */
    }
    if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) return { page, images: cached.images };
    try {
      const url = `${API}?action=parse&format=json&prop=text&redirects=1&page=${encodeURIComponent(page)}`;
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.info || json.error.code);
      const images = parseWikiImages(json.parse?.text?.['*']);
      fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), images }));
      return { page, images };
    } catch (err) {
      if (cached) return { page, images: cached.images, stale: true };
      return { page, images: [], error: String(err.message || err) };
    }
  }
}

module.exports = { WikiImages, parseWikiImages, pageFromLink };
