// Shared filename sanitiser. The character class is the union of what macOS,
// Windows and Obsidian each dislike: a vault synced to Windows must still open.
const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;

// A title's colon becomes " - ", as Radarr writes it ("Lecture 3: Markets" is
// "Lecture 3 - Markets"); a colon inside a word becomes "-". His rule for every ARCH
// plugin, 2026-10-02 (*"this need to be a universal rule"*).
const colonRule = (s) => String(s || '').replace(/\s*:\s+/g, ' - ').replace(/:/g, '-');
// Before 0.11.10 a colon was dropped; legacyName keeps that name so an older profile note,
// with his t-rank and his writing in it, is still found.
function legacyName(raw, fallback = 'untitled') {
  return sanitizeName(String(raw || '').replace(/:/g, ''), fallback);
}

function sanitizeName(raw, fallback = 'untitled') {
  const cleaned = colonRule(raw)
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
    .trim();
  return cleaned || fallback;
}

module.exports = { sanitizeName, legacyName };
