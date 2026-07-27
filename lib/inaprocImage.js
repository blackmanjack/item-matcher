// Domain-domain resmi INAPROC yang boleh diakses. Link & URL gambar datang dari isi
// file Excel yang diupload user — tanpa allowlist ini, fitur ini jadi vektor SSRF
// (server bisa dipaksa fetch ke alamat internal lewat kolom LINK yang dipalsukan).
const ALLOWED_PAGE_HOSTS = new Set(['katalog.inaproc.id']);
const ALLOWED_IMAGE_HOSTS = new Set(['asset.inaproc.id', 'files.inaproc.id']);

const FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

const IMAGE_MIME_TO_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function isAllowedHost(url, allowedHosts) {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && allowedHosts.has(parsed.hostname);
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ambil URL og:image pertama dari HTML halaman produk.
 */
function extractOgImageUrl(html) {
  const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

/**
 * Fetch halaman produk INAPROC dan ambil URL gambar utamanya (og:image).
 * Return null (bukan throw) kalau host tidak diizinkan, gagal fetch, timeout,
 * atau tidak ada og:image — supaya baris lain dalam batch import tetap lanjut.
 */
async function fetchProductImageUrl(pageUrl) {
  if (!isAllowedHost(pageUrl, ALLOWED_PAGE_HOSTS)) return null;

  try {
    const res = await fetchWithTimeout(pageUrl);
    if (!res.ok) return null;
    const html = await res.text();
    return extractOgImageUrl(html);
  } catch {
    return null;
  }
}

/**
 * Download bytes gambar dari imageUrl (harus di ALLOWED_IMAGE_HOSTS).
 * Return {buffer, ext} atau null kalau gagal/host tidak diizinkan/bukan gambar/kelewat besar.
 */
async function downloadImageBuffer(imageUrl) {
  if (!isAllowedHost(imageUrl, ALLOWED_IMAGE_HOSTS)) return null;

  try {
    const res = await fetchWithTimeout(imageUrl);
    if (!res.ok) return null;

    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
    const ext = IMAGE_MIME_TO_EXT[contentType];
    if (!ext) return null;

    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_BYTES) return null;

    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) return null;

    return { buffer: Buffer.from(arrayBuffer), ext, mimetype: contentType };
  } catch {
    return null;
  }
}

/**
 * Gabungan: dari link halaman produk -> buffer gambar siap disimpan.
 */
async function fetchProductImage(pageUrl) {
  const imageUrl = await fetchProductImageUrl(pageUrl);
  if (!imageUrl) return null;
  return downloadImageBuffer(imageUrl);
}

/**
 * Jalankan `worker` atas tiap item di `items` dengan concurrency terbatas.
 * Tidak pakai dependency tambahan (mis. p-limit) — cukup untuk kebutuhan ini.
 */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(runners);
  return results;
}

module.exports = {
  extractOgImageUrl,
  fetchProductImageUrl,
  downloadImageBuffer,
  fetchProductImage,
  runWithConcurrency,
  IMAGE_MIME_TO_EXT,
};
