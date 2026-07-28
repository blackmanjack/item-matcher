const { put, del } = require('@vercel/blob');
const sharp = require('sharp');
const crypto = require('crypto');

const THUMB_MAX_SIZE = 200;
const THUMB_QUALITY = 75;

// Generate thumbnail webp kecil dari buffer gambar sumber. Return buffer webp,
// atau null kalau gagal (caller fallback ke gambar asli).
async function generateThumbnailBuffer(buffer) {
  try {
    return await sharp(buffer)
      .resize({ width: THUMB_MAX_SIZE, height: THUMB_MAX_SIZE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer();
  } catch {
    return null;
  }
}

// Upload gambar (buffer) + thumbnail-nya ke Vercel Blob -> { gambar, gambarThumb }
// (URL https publik). Dipakai baik untuk upload manual maupun hasil auto-fetch INAPROC.
async function uploadImageToBlob(buffer, ext, contentType) {
  const id = crypto.randomUUID();
  const original = await put(`uploads/${id}${ext}`, buffer, {
    access: 'public',
    contentType,
    addRandomSuffix: false,
  });

  const thumbBuffer = await generateThumbnailBuffer(buffer);
  if (!thumbBuffer) {
    return { gambar: original.url, gambarThumb: original.url };
  }

  const thumb = await put(`uploads/${id}_thumb.webp`, thumbBuffer, {
    access: 'public',
    contentType: 'image/webp',
    addRandomSuffix: false,
  });
  return { gambar: original.url, gambarThumb: thumb.url };
}

// Hapus gambar dari Blob berdasarkan URL-nya. Best-effort: kegagalan (mis. URL
// bukan dari Blob store ini, atau sudah terhapus) diabaikan supaya tidak
// menggagalkan operasi delete item.
async function deleteImageFromBlob(url) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  try {
    await del(url);
  } catch {
    // abaikan - best-effort
  }
}

module.exports = { uploadImageToBlob, deleteImageFromBlob };
