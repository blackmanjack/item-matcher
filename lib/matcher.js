// Singkatan/istilah umum yang sering dipakai client dengan sebutan berbeda-beda.
// Kunci = varian yang mungkin muncul di list client, value = bentuk yang dipakai company.
const SYNONYMS = {
  gunting: 'gunting',
  scissor: 'gunting',
  scissors: 'gunting',
  forcep: 'forcep',
  forceps: 'forcep',
  pinset: 'forcep',
  pincet: 'forcep',
  spekulum: 'specula',
  speculum: 'specula',
  specula: 'specula',
  cermin: 'mirror',
  mirror: 'mirror',
  gagang: 'handle',
  handle: 'handle',
  telinga: 'ear',
  ear: 'ear',
  hidung: 'nasal',
  nasal: 'nasal',
  hook: 'hook',
  kait: 'hook',
  sendok: 'spoon',
  spoon: 'spoon',
  penekan: 'depressor',
  depressor: 'depressor',
  lidah: 'tongue',
  tongue: 'tongue',
  klem: 'clamp',
  clamp: 'clamp',
  jarum: 'needle',
  needle: 'needle',
  tang: 'forcep',
  jepit: 'clamp',
  pisau: 'knife',
  knife: 'knife',
  retraktor: 'retractor',
  retractor: 'retractor',
};

function normalize(text) {
  if (!text) return '';
  let t = String(text).toLowerCase();

  // Samakan pemisah ukuran: "12cm" / "12 cm" / "12,0 cm" -> "12 cm"
  t = t.replace(/(\d+)[.,](\d+)/g, '$1$2'); // 12,0 -> 120 (hindari koma desimal mengganggu tokenizer)
  t = t.replace(/(\d+)\s*mm/g, '$1 mm');
  t = t.replace(/(\d+)\s*cm/g, '$1 cm');

  // Hilangkan tanda baca kecuali spasi dan angka/huruf
  t = t.replace(/[\/\-_,.()]/g, ' ');

  // Rapikan spasi ganda
  t = t.replace(/\s+/g, ' ').trim();

  // Buang kata duplikat berurutan (mis. "tumpul tumpul" dari "tumpul/tumpul")
  const words = t.split(' ');
  const deduped = [];
  for (const w of words) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== w) {
      deduped.push(w);
    }
  }
  t = deduped.join(' ');

  // Terapkan kamus sinonim per kata
  t = t
    .split(' ')
    .map((w) => SYNONYMS[w] || w)
    .join(' ');

  return t;
}

function tokenize(text) {
  return normalize(text).split(' ').filter(Boolean);
}

function buildSearchTokens(item) {
  return tokenize([item.namaItem, item.tipe].filter(Boolean).join(' '));
}

// Levenshtein distance sederhana, dipakai untuk toleransi typo/singkatan per kata.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function wordsMatch(a, b) {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false; // kata pendek (angka, "cm") harus persis sama
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return dist / maxLen <= 0.25; // toleransi typo ringan
}

/**
 * Skor kemiripan dua kumpulan kata: Dice coefficient berdasarkan jumlah kata
 * yang berhasil dipasangkan (exact atau fuzzy), bukan levenshtein string penuh.
 * Ini lebih tahan terhadap urutan kata & panjang string yang berbeda.
 */
function tokenSimilarity(tokensA, tokensB) {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const usedB = new Array(tokensB.length).fill(false);
  let matched = 0;

  for (const wa of tokensA) {
    let matchIdx = -1;
    for (let j = 0; j < tokensB.length; j++) {
      if (usedB[j]) continue;
      if (wordsMatch(wa, tokensB[j])) {
        matchIdx = j;
        break;
      }
    }
    if (matchIdx !== -1) {
      usedB[matchIdx] = true;
      matched++;
    }
  }

  return (2 * matched) / (tokensA.length + tokensB.length);
}

function extractNumbers(tokens) {
  return tokens.filter((t) => /^\d+$/.test(t));
}

// Angka ukuran (mis. "12" dari "12 cm") adalah sinyal pembeda yang kuat antar item
// yang namanya mirip tapi ukurannya beda (mis. forcep 12cm vs forcep 14cm). Kasih
// bonus kecil kalau ada ukuran yang cocok persis, dan penalti kecil kalau client
// menyebut ukuran tapi item punya ukuran lain yang berbeda.
const SIZE_MATCH_BONUS = 0.05;
const SIZE_MISMATCH_PENALTY = 0.05;

function applySizeAdjustment(score, clientTokens, itemTokens) {
  const clientNumbers = extractNumbers(clientTokens);
  if (clientNumbers.length === 0) return score;

  const itemNumbers = extractNumbers(itemTokens);
  const hasMatch = clientNumbers.some((n) => itemNumbers.includes(n));

  if (hasMatch) return Math.min(1, score + SIZE_MATCH_BONUS);
  if (itemNumbers.length > 0) return Math.max(0, score - SIZE_MISMATCH_PENALTY);
  return score;
}

/**
 * Cari kandidat item master yang paling mirip dengan teks client.
 * @param {string} clientText - teks item yang diminta client
 * @param {Array} masterItems - daftar item master {id, namaItem, tipe, merk, gambar}
 * @param {number} topN - jumlah kandidat teratas yang dikembalikan
 * @returns {Array<{item: object, score: number}>} score 0-1, makin besar makin mirip
 */
function findMatches(clientText, masterItems, topN = 3) {
  if (!masterItems || masterItems.length === 0) return [];

  const clientTokens = tokenize(clientText);
  if (clientTokens.length === 0) return [];

  const scored = masterItems.map((item) => {
    const itemTokens = buildSearchTokens(item);
    let score = tokenSimilarity(clientTokens, itemTokens);
    score = applySizeAdjustment(score, clientTokens, itemTokens);
    return { item, score: Math.round(score * 100) / 100 };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter((s) => s.score > 0)
    .slice(0, topN)
    .map((s) => ({
      item: {
        id: s.item.id,
        namaItem: s.item.namaItem,
        tipe: s.item.tipe,
        merk: s.item.merk,
        gambar: s.item.gambar,
      },
      score: s.score,
    }));
}

module.exports = { normalize, findMatches };
