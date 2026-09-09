// Shared filename sanitiser. The character class is the union of what macOS,
// Windows and Obsidian each dislike: a vault synced to Windows must still open.
const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;

function sanitizeName(raw, fallback = 'untitled') {
  const cleaned = String(raw || '')
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
    .trim();
  return cleaned || fallback;
}

module.exports = { sanitizeName };
