require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const { findMatches } = require('./lib/matcher');
const { readExcelBuffer, readCsvBuffer, writeExcelBuffer } = require('./lib/excel');
const { parsePdfBuffer } = require('./lib/pdfParser');
const { fetchProductImage, runWithConcurrency, IMAGE_MIME_TO_EXT } = require('./lib/inaprocImage');
const { verifyLicense } = require('./lib/license');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'master-items.json');
const adapter = new FileSync(DB_PATH);
const db = low(adapter);
db.defaults({ items: [], nextId: 1 }).write();

// ---------- Lisensi ----------
// LICENSE_SECRET hanya diketahui vendor (kamu), dipakai untuk verifikasi tanda tangan
// kode lisensi. Kode lisensi klien sendiri diisi manual oleh admin di server mereka,
// lewat env var LICENSE_KEY atau file data/license.txt.
//
// Set LICENSE_ENFORCED=false di .env untuk menonaktifkan sementara pengecekan lisensi
// (mis. saat masih development/demo) - tinggal hapus/ubah lagi ke true untuk aktifkan.
const LICENSE_ENFORCED = process.env.LICENSE_ENFORCED !== 'false';
const LICENSE_SECRET = process.env.LICENSE_SECRET || '';
const LICENSE_FILE = path.join(DATA_DIR, 'license.txt');

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

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      // Nama file selalu di-generate ulang (bukan dari input user) untuk
      // mencegah path traversal / penimpaan file yang tidak diinginkan.
      const ext = IMAGE_MIME_TO_EXT[file.mimetype] || '.bin';
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!IMAGE_MIME_TO_EXT[file.mimetype]) {
      return cb(new Error('Gambar harus berformat PNG, JPEG, WEBP, atau GIF'));
    }
    cb(null, true);
  },
});

function deleteUploadedImage(gambarPath) {
  if (!gambarPath || !gambarPath.startsWith('/uploads/')) return;
  const filename = path.basename(gambarPath);
  const fullPath = path.join(UPLOADS_DIR, filename);
  fs.unlink(fullPath, () => {}); // best-effort, abaikan error kalau file tidak ada
}

// Resolve path gambar relatif ("/uploads/xxx.ext") -> path absolut di disk, khusus
// untuk dibaca (export Excel). basename() mencegah path traversal, sama seperti
// deleteUploadedImage di atas.
function resolveUploadedImagePath(gambarPath) {
  if (!gambarPath || !gambarPath.startsWith('/uploads/')) return undefined;
  const filename = path.basename(gambarPath);
  const fullPath = path.join(UPLOADS_DIR, filename);
  return fs.existsSync(fullPath) ? fullPath : undefined;
}

// Simpan buffer gambar ke public/uploads dengan nama acak (dipakai baik untuk upload
// manual maupun hasil auto-fetch dari link INAPROC) -> return path relatif "/uploads/xxx.ext".
function saveImageBuffer(buffer, ext) {
  const filename = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return `/uploads/${filename}`;
}

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

app.get('/api/items', (req, res) => {
  res.json(db.get('items').value());
});

app.post('/api/items', imageUpload.single('gambarFile'), (req, res) => {
  const namaItem = sanitizeField(req.body?.namaItem);
  if (!namaItem) {
    if (req.file) deleteUploadedImage(`/uploads/${req.file.filename}`);
    return res.status(400).json({ error: 'namaItem wajib diisi' });
  }

  const id = db.get('nextId').value();
  const item = {
    id,
    namaItem,
    tipe: sanitizeField(req.body?.tipe),
    merk: sanitizeField(req.body?.merk),
    link: sanitizeField(req.body?.link),
    gambar: req.file ? `/uploads/${req.file.filename}` : '',
  };
  db.get('items').push(item).write();
  db.set('nextId', id + 1).write();
  res.status(201).json(item);
});

app.put('/api/items/:id', imageUpload.single('gambarFile'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.get('items').find({ id }).value();
  if (!existing) {
    if (req.file) deleteUploadedImage(`/uploads/${req.file.filename}`);
    return res.status(404).json({ error: 'Item tidak ditemukan' });
  }

  const namaItem = sanitizeField(req.body?.namaItem);
  if (!namaItem) {
    if (req.file) deleteUploadedImage(`/uploads/${req.file.filename}`);
    return res.status(400).json({ error: 'namaItem wajib diisi' });
  }

  const updates = {
    namaItem,
    tipe: sanitizeField(req.body?.tipe),
    merk: sanitizeField(req.body?.merk),
    link: sanitizeField(req.body?.link),
  };

  if (req.file) {
    deleteUploadedImage(existing.gambar);
    updates.gambar = `/uploads/${req.file.filename}`;
  }

  db.get('items').find({ id }).assign(updates).write();
  res.json(db.get('items').find({ id }).value());
});

app.delete('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.get('items').find({ id }).value();
  if (existing) deleteUploadedImage(existing.gambar);
  db.get('items').remove({ id }).write();
  res.status(204).end();
});

// Hapus banyak item sekaligus (checkbox terpilih di UI)
app.post('/api/items/bulk-delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'ids wajib berupa array angka' });

  const idSet = new Set(ids);
  const toDelete = db.get('items').filter((item) => idSet.has(item.id)).value();
  for (const item of toDelete) deleteUploadedImage(item.gambar);

  db.get('items').remove((item) => idSet.has(item.id)).write();
  res.json({ deleted: toDelete.length });
});

// Hapus SELURUH master data (tombol "Hapus Semua Data")
app.delete('/api/items', (req, res) => {
  const allItems = db.get('items').value();
  for (const item of allItems) deleteUploadedImage(item.gambar);

  db.set('items', []).write();
  db.set('nextId', 1).write();
  res.json({ deleted: allItems.length });
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
    let gambarBerhasil = 0;
    const gambarGagal = [];

    if (autoFetchImage) {
      await runWithConcurrency(parsedItems, 4, async (item) => {
        if (item.gambar || !item.link) return; // sudah ada gambar, atau tidak ada link
        const result = await fetchProductImage(item.link);
        if (result) {
          item.gambar = saveImageBuffer(result.buffer, result.ext);
          gambarBerhasil++;
        } else {
          gambarGagal.push({ namaItem: item.namaItem, alasan: 'Gambar tidak ditemukan / link tidak bisa diakses' });
        }
      });
    }

    let nextId = db.get('nextId').value();
    const imported = parsedItems.map((item) => ({ id: nextId++, ...item }));

    db.get('items').push(...imported).write();
    db.set('nextId', nextId).write();
    res.status(201).json({
      imported: imported.length,
      items: imported,
      gambarBerhasil,
      gambarGagal,
    });
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
    const masterItems = db.get('items').value();

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
      _imageAbsPath: resolveUploadedImagePath(r.gambar),
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Item Matcher jalan di http://localhost:${PORT}`);
});
