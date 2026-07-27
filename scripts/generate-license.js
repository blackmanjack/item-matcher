// Dijalankan sendiri oleh vendor (bukan bagian dari server), untuk generate kode
// lisensi yang diberikan ke klien setelah mereka bayar.
//
// Pemakaian: node scripts/generate-license.js "PT Client" 2027-01-01
// (LICENSE_SECRET dibaca dari .env, atau bisa juga: LICENSE_SECRET=xxx node scripts/generate-license.js ...)

require('dotenv').config();

const { signLicense } = require('../lib/license');

const [, , company, expiresAt] = process.argv;
const secret = process.env.LICENSE_SECRET;

if (!company || !expiresAt) {
  console.error('Pemakaian: LICENSE_SECRET=<secret> node scripts/generate-license.js "<Nama Perusahaan>" <YYYY-MM-DD>');
  process.exit(1);
}

if (!secret) {
  console.error('Env var LICENSE_SECRET wajib diisi (secret yang sama harus dipakai di server saat verifikasi).');
  process.exit(1);
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt) || Number.isNaN(new Date(expiresAt).getTime())) {
  console.error('Tanggal expired harus format YYYY-MM-DD, mis. 2027-01-01');
  process.exit(1);
}

const licenseKey = signLicense(company, expiresAt, secret);
console.log(`Perusahaan   : ${company}`);
console.log(`Expired      : ${expiresAt}`);
console.log(`Kode Lisensi : ${licenseKey}`);
