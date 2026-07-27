const pdf = require('pdf-parse');

// Kode tipe barang company selalu berformat "NNN-NN" (mis. 273-03, 314-48).
// PDF-nya adalah tabel NO | NAMA | TIPE | QTY | GAMBAR, tapi saat teks diekstrak dari
// PDF, kolom-kolom itu jadi menyatu tanpa pemisah yang jelas (mis. "273-031" = tipe
// "273-03" + qty "1"). Anchor ke pola kode tipe ini dipakai untuk membelah teks jadi
// per baris.
const TIPE_CODE_RE = /(\d{3}-\d{2})\s*(\d+)/g;

function parseRowsFromText(text) {
  const flat = text
    .replace(/\r/g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Lewati header tabel ("NO NAMA TIPE QTY GAMBAR" biasanya menyatu jadi satu token)
  const headerIdx = flat.toUpperCase().indexOf('GAMBAR');
  const body = headerIdx !== -1 ? flat.slice(headerIdx + 'GAMBAR'.length) : flat;

  const rows = [];
  let searchPos = 0;
  let match;

  TIPE_CODE_RE.lastIndex = 0;
  while ((match = TIPE_CODE_RE.exec(body)) !== null) {
    const segment = body.slice(searchPos, match.index).trim();
    const tipe = match[1];

    // segment = "<nomor urut> <nama item...>"
    const rowMatch = segment.match(/^(\d+)\s*(.*)$/s);
    const namaItem = (rowMatch ? rowMatch[2] : segment).replace(/\s+/g, ' ').trim();

    if (namaItem) {
      rows.push({ namaItem, tipe, merk: '', gambar: '' });
    }
    searchPos = TIPE_CODE_RE.lastIndex;
  }

  return rows;
}

/**
 * Ekstrak daftar item {namaItem, tipe, merk, gambar} dari buffer PDF.
 * Catatan: gambar tidak ikut terekstrak (gambar di PDF berupa gambar per baris,
 * bukan teks/link, sehingga tidak bisa otomatis dipetakan). Isi gambar via upload
 * manual per item setelah import.
 */
async function parsePdfBuffer(buffer) {
  const data = await pdf(buffer);
  return parseRowsFromText(data.text);
}

module.exports = { parsePdfBuffer, parseRowsFromText };
