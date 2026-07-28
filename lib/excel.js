const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const path = require('path');

// exceljs cuma bisa embed gambar dalam format ini (webp tidak didukung).
const EXCEL_IMAGE_EXT = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.gif': 'gif' };

// Kata kunci umum yang muncul di baris header tabel (nama kolom master data /
// list client). Dipakai untuk mendeteksi baris header yang sebenarnya kalau file
// punya baris judul/banner di atasnya (mis. "SET THT BASIC" atau "MASTER DATA ALAT
// KESEHATAN") sebelum baris header kolom yang asli.
const HEADER_HINT_WORDS = [
  'nama', 'item', 'produk', 'tipe', 'type', 'merk', 'merek', 'brand',
  'gambar', 'image', 'foto', 'link', 'url', 'harga', 'price', 'qty', 'no',
];

function looksLikeHeaderRow(row) {
  const cells = row.map((c) => String(c || '').trim().toLowerCase()).filter(Boolean);
  if (cells.length < 2) return false;
  const hintMatches = cells.filter((c) => HEADER_HINT_WORDS.some((w) => c.includes(w))).length;
  return hintMatches >= 2;
}

// Cari baris header yang sebenarnya di antara beberapa baris pertama, lalu pisahkan
// jadi {headers, rows}. Kalau tidak ketemu baris yang "terlihat seperti header" dalam
// 10 baris pertama, fallback ke asumsi lama: baris pertama = header.
function splitHeaderAndRows(allRows) {
  const searchLimit = Math.min(allRows.length, 10);
  for (let i = 0; i < searchLimit; i++) {
    if (looksLikeHeaderRow(allRows[i])) {
      const headers = allRows[i].map((h) => String(h || '').trim());
      const dataRows = allRows.slice(i + 1).filter((r) => r.some((cell) => String(cell).trim() !== ''));
      return { headers, rows: dataRows };
    }
  }

  const headers = (allRows[0] || []).map((h) => String(h || '').trim());
  const dataRows = allRows.slice(1).filter((r) => r.some((cell) => String(cell).trim() !== ''));
  return { headers, rows: dataRows };
}

/**
 * Baca buffer .xlsx/.xls -> {headers, rows}. rows adalah array of array (mentah),
 * biar caller bisa pilih kolom mana yang dipakai.
 */
async function readExcelBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return { headers: [], rows: [] };

  const allRows = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    // row.values[0] selalu undefined (ExcelJS 1-indexed), buang.
    const values = row.values.slice(1).map((v) => {
      if (v == null) return '';
      if (typeof v === 'object' && v.text != null) return v.text; // rich text
      if (typeof v === 'object' && v.result != null) return v.result; // formula
      return v;
    });
    allRows.push(values);
  });

  return splitHeaderAndRows(allRows);
}

/**
 * Baca buffer .csv -> {headers, rows}, format sama seperti readExcelBuffer.
 */
async function readCsvBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = await workbook.csv.read(Readable.from(buffer));

  const allRows = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values.slice(1).map((v) => (v == null ? '' : v));
    allRows.push(values);
  });

  return splitHeaderAndRows(allRows);
}

/**
 * Tulis array of object -> buffer file .xlsx
 * Kalau tiap row punya `_imageUrl` (URL https gambar, mis. dari Vercel Blob, sudah
 * divalidasi caller), gambar ditempel di kolom pertama ("Gambar"). Key `_imageUrl`
 * sendiri tidak ikut jadi kolom data.
 */
async function writeExcelBuffer(rows, sheetName = 'Hasil') {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName);

  if (rows.length > 0) {
    const hasImages = rows.some((r) => r._imageUrl);
    const dataKeys = Object.keys(rows[0]).filter((k) => k !== '_imageUrl');

    const columns = hasImages ? [{ header: 'Gambar', key: '_imageCol', width: 20 }] : [];
    columns.push(...dataKeys.map((key) => ({ header: key, key })));
    worksheet.columns = columns;

    for (const row of rows) {
      const excelRow = worksheet.addRow(row);
      if (!hasImages) continue;

      excelRow.height = 90;
      const imgUrl = row._imageUrl;
      if (!imgUrl) continue;

      const excelExt = EXCEL_IMAGE_EXT[path.extname(new URL(imgUrl).pathname).toLowerCase()];
      if (!excelExt) continue; // format tidak didukung exceljs (mis. webp) - lewati saja

      try {
        const res = await fetch(imgUrl);
        if (!res.ok) continue;
        const buffer = Buffer.from(await res.arrayBuffer());
        const imageId = workbook.addImage({ buffer, extension: excelExt });
        worksheet.addImage(imageId, {
          tl: { col: 0, row: excelRow.number - 1 },
          ext: { width: 90, height: 90 },
        });
      } catch {
        // gambar gagal diambil/rusak - lewati, jangan gagalkan seluruh export
      }
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}

module.exports = { readExcelBuffer, readCsvBuffer, writeExcelBuffer };
