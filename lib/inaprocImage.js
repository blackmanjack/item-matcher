// Domain-domain resmi INAPROC yang boleh diakses. Link & URL gambar datang dari isi
// file Excel yang diupload user — tanpa allowlist ini, fitur ini jadi vektor SSRF
// (server bisa dipaksa fetch ke alamat internal lewat kolom LINK yang dipalsukan).
const ALLOWED_PAGE_HOSTS = new Set(['katalog.inaproc.id']);
const ALLOWED_IMAGE_HOSTS = new Set(['asset.inaproc.id', 'files.inaproc.id']);

// Diturunkan dari 10s/2x retry supaya satu batch import (diproses per-poll di
// Vercel serverless function) tidak berisiko melewati batas durasi function
// kalau beberapa item beruntun timeout.
const FETCH_TIMEOUT_MS = 8_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_RETRIES = 1; // percobaan ulang untuk 429/503/timeout, di luar percobaan pertama
const RETRY_BASE_DELAY_MS = 500;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sama seperti fetchWithTimeout, tapi retry dengan backoff untuk kegagalan
 * transient (429/503 dari server, atau timeout/network error) — supaya menaikkan
 * concurrency tidak langsung menggagalkan item begitu INAPROC sesekali menolak.
 */
async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options);
      if (res.status === 429 || res.status === 503) {
        lastError = new Error(`HTTP ${res.status}`);
      } else {
        return res;
      }
    } catch (err) {
      lastError = err;
    }
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

// Cache in-memory per proses (hidup selama server jalan) supaya link/URL gambar
// yang sama (duplikat di file Excel) tidak di-fetch ulang dalam import yang sama
// atau import berikutnya.
const pageImageUrlCache = new Map(); // pageUrl -> imageUrl | null
const imageBufferCache = new Map(); // imageUrl -> {buffer, ext, mimetype} | null

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
  if (pageImageUrlCache.has(pageUrl)) return pageImageUrlCache.get(pageUrl);

  let imageUrl = null;
  try {
    const res = await fetchWithRetry(pageUrl);
    if (res.ok) {
      const html = await res.text();
      imageUrl = extractOgImageUrl(html);
      if (!imageUrl) console.error(`[inaproc] og:image tidak ditemukan di ${pageUrl}`);
    } else {
      console.error(`[inaproc] HTTP ${res.status} saat GET halaman ${pageUrl}`);
    }
  } catch (err) {
    console.error(`[inaproc] gagal fetch halaman ${pageUrl}:`, err?.name, err?.message);
    imageUrl = null;
  }
  pageImageUrlCache.set(pageUrl, imageUrl);
  return imageUrl;
}

/**
 * Download bytes gambar dari imageUrl (harus di ALLOWED_IMAGE_HOSTS).
 * Return {buffer, ext} atau null kalau gagal/host tidak diizinkan/bukan gambar/kelewat besar.
 */
async function downloadImageBuffer(imageUrl) {
  if (!isAllowedHost(imageUrl, ALLOWED_IMAGE_HOSTS)) return null;
  if (imageBufferCache.has(imageUrl)) return imageBufferCache.get(imageUrl);

  let result = null;
  try {
    const res = await fetchWithRetry(imageUrl);
    if (res.ok) {
      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
      const ext = IMAGE_MIME_TO_EXT[contentType];
      const contentLength = Number(res.headers.get('content-length') || 0);

      if (!ext) {
        console.error(`[inaproc] content-type tidak didukung "${contentType}" untuk ${imageUrl}`);
      } else if (contentLength > MAX_IMAGE_BYTES) {
        console.error(`[inaproc] gambar terlalu besar (${contentLength} bytes) untuk ${imageUrl}`);
      } else {
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength <= MAX_IMAGE_BYTES) {
          result = { buffer: Buffer.from(arrayBuffer), ext, mimetype: contentType };
        }
      }
    } else {
      console.error(`[inaproc] HTTP ${res.status} saat GET gambar ${imageUrl}`);
    }
  } catch (err) {
    console.error(`[inaproc] gagal fetch gambar ${imageUrl}:`, err?.name, err?.message);
    result = null;
  }
  imageBufferCache.set(imageUrl, result);
  return result;
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
