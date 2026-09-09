// Re-encoding a downloaded profile picture. Runs in Obsidian's renderer, which
// carries Chromium's canvas encoder, so there is no external tool.
//
// Chromium encodes image/png, image/jpeg and image/webp and nothing else. WebP
// is what the vault's existing profile notes use, and it is roughly half the
// size of the JPEG X serves. This file is therefore renderer-only: unlike the
// rest of lib/ it cannot run under plain Node, because OffscreenCanvas does not
// exist there.

async function encodeWebp(blob, quality = 0.85) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: 'image/webp', quality });
  const data = new Uint8Array(await out.arrayBuffer());
  // An icon that is already tiny can come out larger as WebP. Keeping the
  // original there costs nothing and avoids a "conversion" that adds bytes.
  if (data.length >= blob.size) return { data: null, skipped: 'larger' };
  return { data, ext: '.webp', bytes: data.length };
}

module.exports = { encodeWebp };
