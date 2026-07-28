require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');

const { findMatches } = require('./lib/matcher');
const { readExcelBuffer, readCsvBuffer, writeExcelBuffer } = require('./lib/excel');
const { parsePdfBuffer } = require('./lib/pdfParser');
const { fetchProductImage, runWithConcurrency, IMAGE_MIME_TO_EXT } = require('./lib/inaprocImage');
const { verifyLicense } = require('./lib/license');
const { uploadImageToBlob, deleteImageFromBlob } = require('./lib/blobStorage');
const db = require('./lib/db');

// ---------- Lisensi ----------
// LICENSE_SECRET hanya diketahui vendor (kamu), dipakai untuk verifikasi tanda tangan
// kode lisensi. Kode lisensi klien sendiri diisi lewat env var LICENSE_KEY (di Vercel:
// Project Settings > Environment Variables), atau file data/license.txt untuk deploy
// non-serverless yang punya disk persisten.
//
// Set LICENSE_ENFORCED=false di .env untuk menonaktifkan sementara pengecekan lisensi
// (mis. saat masih development/demo) - tinggal hapus/ubah lagi ke true untuk aktifkan.
const LICENSE_ENFORCED = process.env.LICENSE_ENFORCED !== 'false';
const LICENSE_SECRET = process.env.LICENSE_SECRET || '';
const LICENSE_FILE = path.join(__dirname, 'data', 'license.txt');

function readLicenseKey() {
  if (process.env.LICENSE_KEY) return process.env.LICENSE_KEY.trim();
  try {
    return fs.readFileSync(LICENSE_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function getLicenseStatus() {
  if (!LICENSE_ENFORCED) {
    return { valid: true, disabled: true, reason: null };
  }
  if (!LICENSE_SECRET) {
    return { valid: false, reason: 'Server belum dikonfigurasi (LICENSE_SECRET kosong). Hubungi vendor.' };
  }
  return verifyLicense(readLicenseKey(), LICENSE_SECRET);
}

function requireLicense(req, res, next) {
  const status = getLicenseStatus();
  if (!status.valid) {
    return res.status(402).json({ error: status.reason || 'Lisensi tidak aktif', licenseInvalid: true });
  }
  next();
}

const MAX_TEXT_LEN = 300;

// ---------- Upload konfigurasi ----------

// Mimetype dicek sebagai pertahanan tambahan, tapi ekstensi adalah penentu utama:
// isi file tetap divalidasi ketat oleh parser (exceljs/pdf-parse) yang akan menolak
// file dengan format internal yang tidak valid meskipun ekstensinya cocok.
const DOC_MIME_WHITELIST = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'application/zip', // beberapa OS/browser melaporkan xlsx sebagai zip
  'text/csv',
  'application/csv',
  'text/plain', // sebagian browser kirim csv sebagai text/plain
  'application/pdf',
  'application/octet-stream', // fallback saat OS tidak mengenali mimetype
]);
const DOC_EXT_WHITELIST = new Set(['.xlsx', '.xls', '.csv', '.pdf']);

function docFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!DOC_EXT_WHITELIST.has(ext) || !DOC_MIME_WHITELIST.has(file.mimetype)) {
    return cb(new Error('Tipe file tidak didukung. Gunakan .xlsx, .xls, .csv, atau .pdf'));
  }
  cb(null, true);
}

const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: docFileFilter,
});

// memoryStorage (bukan diskStorage) - filesystem Vercel read-only, buffer di-upload
// langsung ke Vercel Blob dari route handler.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!IMAGE_MIME_TO_EXT[file.mimetype]) {
      return cb(new Error('Gambar harus berformat PNG, JPEG, WEBP, atau GIF'));
    }
    cb(null, true);
  },
});

function sanitizeField(value) {
  return String(value || '').trim().slice(0, MAX_TEXT_LEN);
}

async function readTabularBuffer(buffer, originalname) {
  const ext = path.extname(originalname || '').toLowerCase();
  if (ext === '.csv') return readCsvBuffer(buffer);
  return readExcelBuffer(buffer);
}

// ---------- App ----------

const app = express();
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint status lisensi harus terdaftar SEBELUM middleware requireLicense supaya
// frontend tetap bisa cek status walau lisensi sedang tidak valid.
app.get('/api/license/status', (req, res) => {
  res.json(getLicenseStatus());
});

app.use('/api', requireLicense);

// ---------- Master item CRUD ----------

app.get('/api/items', async (req, res, next) => {
  try {
    res.json(await db.getAllItems());
  } catch (err) {
    next(err);
  }
});

app.post('/api/items', imageUpload.single('gambarFile'), async (req, res, next) => {
  try {
    const namaItem = sanitizeField(req.body?.namaItem);
    if (!namaItem) {
      return res.status(400).json({ error: 'namaItem wajib diisi' });
    }

    let gambar = '';
    let gambarThumb = '';
    if (req.file) {
      const ext = IMAGE_MIME_TO_EXT[req.file.mimetype];
      const uploaded = await uploadImageToBlob(req.file.buffer, ext, req.file.mimetype);
      gambar = uploaded.gambar;
      gambarThumb = uploaded.gambarThumb;
    }

    const item = await db.insertItem({
      namaItem,
      tipe: sanitizeField(req.body?.tipe),
      merk: sanitizeField(req.body?.merk),
      link: sanitizeField(req.body?.link),
      gambar,
      gambarThumb,
    });
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

app.put('/api/items/:id', imageUpload.single('gambarFile'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.getItem(id);
    if (!existing) {
      return res.status(404).json({ error: 'Item tidak ditemukan' });
    }

    const namaItem = sanitizeField(req.body?.namaItem);
    if (!namaItem) {
      return res.status(400).json({ error: 'namaItem wajib diisi' });
    }

    const updates = {
      namaItem,
      tipe: sanitizeField(req.body?.tipe),
      merk: sanitizeField(req.body?.merk),
      link: sanitizeField(req.body?.link),
    };

    if (req.file) {
      const ext = IMAGE_MIME_TO_EXT[req.file.mimetype];
      const uploaded = await uploadImageToBlob(req.file.buffer, ext, req.file.mimetype);
      updates.gambar = uploaded.gambar;
      updates.gambarThumb = uploaded.gambarThumb;
      await deleteImageFromBlob(existing.gambar);
      await deleteImageFromBlob(existing.gambarThumb);
    }

    const updated = await db.updateItem(id, updates);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/items/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const deleted = await db.deleteItem(id);
    if (deleted) {
      await deleteImageFromBlob(deleted.gambar);
      await deleteImageFromBlob(deleted.gambarThumb);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Hapus banyak item sekaligus (checkbox terpilih di UI)
app.post('/api/items/bulk-delete', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'ids wajib berupa array angka' });

    const deleted = await db.deleteItemsByIds(ids);
    for (const item of deleted) {
      await deleteImageFromBlob(item.gambar);
      await deleteImageFromBlob(item.gambarThumb);
    }
    res.json({ deleted: deleted.length });
  } catch (err) {
    next(err);
  }
});

// Hapus SELURUH master data (tombol "Hapus Semua Data")
app.delete('/api/items', async (req, res, next) => {
  try {
    const deleted = await db.deleteAllItems();
    for (const item of deleted) {
      await deleteImageFromBlob(item.gambar);
      await deleteImageFromBlob(item.gambarThumb);
    }
    res.json({ deleted: deleted.length });
  } catch (err) {
    next(err);
  }
});

// Concurrency untuk auto-fetch gambar INAPROC saat import - configurable lewat env
// var INAPROC_CONCURRENCY kalau perlu disesuaikan (mis. dinaikkan/diturunkan sesuai
// toleransi rate-limit server INAPROC).
const INAPROC_CONCURRENCY = Number(process.env.INAPROC_CONCURRENCY) || 16;

// Jumlah item yang diproses per panggilan GET /api/import-progress - job auto-fetch
// gambar INAPROC TIDAK jalan sebagai background process (fungsi serverless Vercel
// dibekukan begitu response dikirim), melainkan dicicil: setiap polling dari frontend
// (tiap ~1 detik, lihat pollImportProgress() di public/app.js) juga memproses satu
// batch berikutnya, sampai semua item selesai. State job disimpan di tabel
// import_jobs (lib/db.js), bukan memori proses, supaya konsisten walau tiap request
// bisa kena instance serverless yang berbeda.
const IMPORT_BATCH_SIZE = Number(process.env.IMPORT_BATCH_SIZE) || 8;

app.get('/api/import-progress/:jobId', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const job = await db.getImportJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job tidak ditemukan (mungkin sudah kedaluwarsa)' });

    if (job.completed) {
      return res.json(job);
    }

    const batch = await db.getPendingImportItems(jobId, IMPORT_BATCH_SIZE);
    if (batch.length === 0) {
      // Tidak ada sisa item pending tapi job belum ditandai completed (kondisi
      // tepi, mis. batch sebelumnya crash) - tandai selesai sekarang.
      const finalStatus = await db.advanceImportJob(jobId, { batchDone: 0, gambarBerhasil: 0, gambarGagal: [] });
      return res.json(finalStatus);
    }

    let gambarBerhasil = 0;
    const gambarGagal = [];

    await runWithConcurrency(batch, Math.min(INAPROC_CONCURRENCY, batch.length), async (item) => {
      const result = await fetchProductImage(item.link);
      if (result) {
        const uploaded = await uploadImageToBlob(result.buffer, result.ext, result.mimetype);
        await db.saveItemFetchResult(item.id, uploaded);
        gambarBerhasil++;
      } else {
        await db.saveItemFetchResult(item.id, null);
        gambarGagal.push({ namaItem: item.namaItem, alasan: 'Gambar tidak ditemukan / link tidak bisa diakses' });
      }
    });

    const status = await db.advanceImportJob(jobId, { batchDone: batch.length, gambarBerhasil, gambarGagal });
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// Import massal master data dari file Excel/CSV/PDF (kolom: nama item, tipe, merk, gambar)
app.post('/api/items/import', docUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });

    const ext = path.extname(req.file.originalname || '').toLowerCase();
    let parsedItems;

    if (ext === '.pdf') {
      // Parser tabel PDF khusus format "NO | NAMA | TIPE | QTY | GAMBAR" milik company.
      // Gambar tidak ikut terekstrak dari PDF (gambar per baris, bukan teks) —
      // silakan upload gambar manual per item lewat form edit setelah import.
      parsedItems = (await parsePdfBuffer(req.file.buffer)).map((r) => ({
        namaItem: sanitizeField(r.namaItem),
        tipe: sanitizeField(r.tipe),
        merk: '',
        link: '',
        gambar: '',
      }));
    } else {
      const { headers, rows } = await readTabularBuffer(req.file.buffer, req.file.originalname);
      const normalizedHeaders = headers.map((h) => h.toLowerCase().replace(/\s+/g, ''));

      const colIndex = (candidates) =>
        normalizedHeaders.findIndex((h) => candidates.some((c) => h.includes(c)));

      const idxNama = colIndex(['namaitem', 'namaproduk', 'nama', 'item', 'produk']);
      const idxTipe = colIndex(['tipe', 'type']);
      const idxMerk = colIndex(['merk', 'merek', 'brand']);
      const idxGambar = colIndex(['gambar', 'image', 'foto']);
      const idxLink = colIndex(['link', 'url', 'inaproc']);

      if (idxNama === -1) {
        return res.status(400).json({ error: 'Kolom "nama item" tidak ditemukan di file' });
      }

      parsedItems = rows
        .map((row) => ({
          namaItem: sanitizeField(row[idxNama]),
          tipe: idxTipe !== -1 ? sanitizeField(row[idxTipe]) : '',
          merk: idxMerk !== -1 ? sanitizeField(row[idxMerk]) : '',
          gambar: idxGambar !== -1 ? sanitizeField(row[idxGambar]) : '',
          link: idxLink !== -1 ? sanitizeField(row[idxLink]) : '',
        }))
        .filter((item) => item.namaItem);
    }

    // Ambil gambar otomatis dari kolom LINK (INAPROC) kalau diminta lewat checkbox di UI.
    const autoFetchImage = req.body?.autoFetchImage === 'true';
    const willNeedFetch = autoFetchImage && parsedItems.some((item) => !item.gambar && item.link);
    const jobId = willNeedFetch ? crypto.randomUUID() : null;

    const imported = await db.insertItemsBulk(parsedItems, jobId);

    if (!jobId) {
      return res.status(201).json({ imported: imported.length, items: imported, gambarBerhasil: 0, gambarGagal: [] });
    }

    const totalPending = parsedItems.filter((item) => !item.gambar && item.link).length;
    await db.createImportJob(jobId, totalPending);

    // Batch pertama TIDAK diproses di sini (respons harus balik cepat) - polling
    // pertama dari frontend (langsung setelah respons ini) yang memproses batch 1.
    res.status(201).json({ imported: imported.length, items: imported, jobId });
  } catch (err) {
    next(err);
  }
});

// ---------- Matching list client ----------

// Preview file client: kembalikan header + beberapa baris pertama agar admin pilih kolom
app.post('/api/match/preview', docUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
    const { headers, rows } = await readTabularBuffer(req.file.buffer, req.file.originalname);
    res.json({ headers, sampleRows: rows.slice(0, 5), totalRows: rows.length });
  } catch (err) {
    next(err);
  }
});

// Jalankan fuzzy matching untuk seluruh baris pada kolom yang dipilih
app.post('/api/match/run', docUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
    const colIndex = Number(req.body.colIndex);
    if (!Number.isInteger(colIndex) || colIndex < 0) {
      return res.status(400).json({ error: 'colIndex wajib diisi' });
    }

    const { rows } = await readTabularBuffer(req.file.buffer, req.file.originalname);
    const masterItems = await db.getAllItems();

    const results = rows
      .map((row) => {
        const clientText = String(row[colIndex] || '').trim();
        if (!clientText) return null;
        const candidates = findMatches(clientText, masterItems, 3);
        return { clientText, candidates };
      })
      .filter(Boolean);

    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// Export hasil final (setelah admin pilih match per baris) ke Excel
app.post('/api/export', async (req, res, next) => {
  try {
    const { rows } = req.body || {};
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows wajib berupa array' });

    const exportRows = rows.slice(0, 5000).map((r) => ({
      'Item Client': sanitizeField(r.clientText),
      'Item Company': sanitizeField(r.namaItem),
      Tipe: sanitizeField(r.tipe),
      Merk: sanitizeField(r.merk),
      'Skor Kemiripan': typeof r.score === 'number' ? r.score : '',
      _imageUrl: /^https?:\/\//i.test(r.gambar || '') ? r.gambar : undefined,
    }));

    const buffer = await writeExcelBuffer(exportRows);
    res.setHeader('Content-Disposition', 'attachment; filename="hasil-matching.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// ---------- Error handler ----------
// Menangkap error dari multer (tipe file/ukuran ditolak) & error tak terduga lain
// supaya selalu balas JSON rapi, bukan stack trace HTML default Express.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err) {
    return res.status(400).json({ error: err.message || 'Gagal memproses request' });
  }
  next();
});

// app.listen() hanya dipanggil saat server.js dijalankan langsung (mis. `npm start`
// untuk dev lokal) - di Vercel, api/index.js require() app ini sebagai handler
// serverless, tanpa listen ke port.
if (require.main === module) {
  const PORT = process.env.PORT || 3999;
  app.listen(PORT, () => {
    console.log(`Item Matcher jalan di http://localhost:${PORT}`);
  });
}

module.exports = app;
