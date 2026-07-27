const crypto = require('crypto');

// Format lisensi: "<payload-base64url>.<hmac-sha256-hex>"
// payload = "<nama perusahaan>|<tanggal expired YYYY-MM-DD>"
// Secret HMAC hanya diketahui vendor (LICENSE_SECRET), supaya klien tidak bisa
// bikin/ubah lisensi sendiri walau tahu format payload-nya.

function signLicense(company, expiresAt, secret) {
  const payload = `${company}|${expiresAt}`;
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
  return `${encoded}.${signature}`;
}

function verifyLicense(licenseKey, secret) {
  if (!licenseKey || typeof licenseKey !== 'string') {
    return { valid: false, reason: 'Lisensi belum diatur di server ini' };
  }

  const [encoded, signature] = licenseKey.trim().split('.');
  if (!encoded || !signature) {
    return { valid: false, reason: 'Format kode lisensi tidak valid' };
  }

  const expectedSignature = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
  const sigBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expectedSignature, 'hex');
  const signatureValid =
    sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);

  if (!signatureValid) {
    return { valid: false, reason: 'Kode lisensi tidak valid' };
  }

  let payload;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return { valid: false, reason: 'Format kode lisensi tidak valid' };
  }

  const [company, expiresAt] = payload.split('|');
  const expiryDate = new Date(`${expiresAt}T23:59:59`);
  if (!company || Number.isNaN(expiryDate.getTime())) {
    return { valid: false, reason: 'Format kode lisensi tidak valid' };
  }

  const daysLeft = Math.ceil((expiryDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  const valid = daysLeft >= 0;

  return {
    valid,
    company,
    expiresAt,
    daysLeft,
    reason: valid ? null : 'Lisensi sudah kadaluarsa. Hubungi vendor untuk memperpanjang.',
  };
}

module.exports = { signLicense, verifyLicense };
