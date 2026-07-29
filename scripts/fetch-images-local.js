// Jalankan auto-fetch gambar INAPROC dari komputer ini (bukan dari server Vercel),
// karena katalog.inaproc.id memblokir request dari IP milik cloud/hosting provider
// (termasuk Vercel) tapi tidak memblokir koneksi internet biasa seperti ini.
//
// Cara pakai:
//   node scripts/fetch-images-local.js <base-url-app> [limit]
//   contoh: node scripts/fetch-images-local.js https://item-matcher.vercel.app
//   contoh (uji coba 5 item dulu): node scripts/fetch-images-local.js https://item-matcher.vercel.app 5
//
// Script ini HANYA memakai API publik app (GET/PUT /api/items) yang sudah ada -
// tidak menyentuh database/Blob langsung, jadi tidak perlu kredensial khusus,
// cukup URL app yang sudah di-deploy.

const { fetchProductImage, runWithConcurrency } = require('../lib/inaprocImage');

const CONCURRENCY = Number(process.env.INAPROC_CONCURRENCY) || 8;

async function main() {
  const baseUrl = (process.argv[2] || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    console.error('Pemakaian: node scripts/fetch-images-local.js <base-url-app>');
    console.error('Contoh: node scripts/fetch-images-local.js https://item-matcher.vercel.app');
    process.exit(1);
  }

  console.log(`Mengambil daftar item dari ${baseUrl}/api/items ...`);
  const res = await fetch(`${baseUrl}/api/items`);
  if (!res.ok) {
    console.error(`Gagal ambil daftar item: HTTP ${res.status}`);
    process.exit(1);
  }
  const items = await res.json();

  const limit = Number(process.argv[3]);
  let targets = items.filter((item) => item.link && !item.gambar);
  console.log(`Total item: ${items.length}, butuh gambar: ${targets.length}`);
  if (Number.isInteger(limit) && limit > 0) {
    targets = targets.slice(0, limit);
    console.log(`(dibatasi ${limit} item untuk uji coba)`);
  }
  if (targets.length === 0) {
    console.log('Tidak ada item yang perlu diambil gambarnya. Selesai.');
    return;
  }

  let berhasil = 0;
  let gagal = 0;
  let done = 0;

  await runWithConcurrency(targets, CONCURRENCY, async (item) => {
    try {
      const result = await fetchProductImage(item.link);
      if (!result) {
        gagal++;
        console.log(`[gagal] ${item.namaItem} - gambar tidak ditemukan/link tidak bisa diakses`);
        return;
      }

      const form = new FormData();
      form.append('namaItem', item.namaItem);
      form.append('tipe', item.tipe || '');
      form.append('merk', item.merk || '');
      form.append('link', item.link || '');
      form.append('gambarFile', new Blob([result.buffer], { type: result.mimetype }), `image${result.ext}`);

      const putRes = await fetch(`${baseUrl}/api/items/${item.id}`, { method: 'PUT', body: form });
      if (!putRes.ok) {
        gagal++;
        const err = await putRes.json().catch(() => ({}));
        console.log(`[gagal] ${item.namaItem} - upload ke server gagal: ${err.error || putRes.status}`);
        return;
      }

      berhasil++;
      console.log(`[ok] ${item.namaItem}`);
    } catch (err) {
      gagal++;
      console.log(`[gagal] ${item.namaItem} - ${err.message}`);
    } finally {
      done++;
      if (done % 10 === 0 || done === targets.length) {
        console.log(`--- progress: ${done}/${targets.length} (berhasil: ${berhasil}, gagal: ${gagal}) ---`);
      }
    }
  });

  console.log(`\nSelesai. Berhasil: ${berhasil}, gagal: ${gagal}, total diproses: ${targets.length}`);
}

main().catch((err) => {
  console.error('Script berhenti karena error:', err);
  process.exit(1);
});
