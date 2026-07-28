const { neon } = require('@neondatabase/serverless');

// Neon integration Vercel biasa mengisi DATABASE_URL, tapi beberapa varian
// integration lama pakai POSTGRES_URL - dukung keduanya.
const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL;

let sql = null;
function getSql() {
  if (!CONNECTION_STRING) {
    throw new Error('DATABASE_URL/POSTGRES_URL belum diatur - hubungkan Vercel Postgres (Neon) ke project ini.');
  }
  if (!sql) sql = neon(CONNECTION_STRING);
  return sql;
}

// Schema dibuat idempotent saat pertama kali dipakai per-instance (cold start).
// Instance lain yang cold-start bersamaan akan menjalankan ulang CREATE TABLE IF
// NOT EXISTS - aman, cuma sedikit overhead, tidak ada race condition merusak data.
let schemaReadyPromise = null;
async function ensureSchema() {
  if (!schemaReadyPromise) {
    const db = getSql();
    schemaReadyPromise = (async () => {
      await db`
        CREATE TABLE IF NOT EXISTS items (
          id SERIAL PRIMARY KEY,
          nama_item TEXT NOT NULL,
          tipe TEXT NOT NULL DEFAULT '',
          merk TEXT NOT NULL DEFAULT '',
          link TEXT NOT NULL DEFAULT '',
          gambar TEXT NOT NULL DEFAULT '',
          gambar_thumb TEXT NOT NULL DEFAULT '',
          fetch_status TEXT NOT NULL DEFAULT 'done',
          import_job_id TEXT
        )
      `;
      await db`
        CREATE TABLE IF NOT EXISTS import_jobs (
          id TEXT PRIMARY KEY,
          total INT NOT NULL,
          done INT NOT NULL DEFAULT 0,
          gambar_berhasil INT NOT NULL DEFAULT 0,
          gambar_gagal JSONB NOT NULL DEFAULT '[]',
          completed BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await db`CREATE INDEX IF NOT EXISTS idx_items_import_job ON items (import_job_id) WHERE import_job_id IS NOT NULL`;
    })();
  }
  return schemaReadyPromise;
}

// Row Postgres (snake_case) -> bentuk item yang dipakai API/frontend (camelCase),
// sama persis dengan bentuk lama dari lowdb supaya public/app.js tidak perlu berubah.
function rowToItem(row) {
  return {
    id: row.id,
    namaItem: row.nama_item,
    tipe: row.tipe,
    merk: row.merk,
    link: row.link,
    gambar: row.gambar,
    gambarThumb: row.gambar_thumb,
  };
}

async function getAllItems() {
  await ensureSchema();
  const db = getSql();
  const rows = await db`SELECT * FROM items ORDER BY id`;
  return rows.map(rowToItem);
}

async function insertItem(item) {
  await ensureSchema();
  const db = getSql();
  const [row] = await db`
    INSERT INTO items (nama_item, tipe, merk, link, gambar, gambar_thumb)
    VALUES (${item.namaItem}, ${item.tipe || ''}, ${item.merk || ''}, ${item.link || ''}, ${item.gambar || ''}, ${item.gambarThumb || ''})
    RETURNING *
  `;
  return rowToItem(row);
}

// Insert banyak item sekaligus (dipakai saat import massal) dalam SATU round-trip
// ke database lewat unnest() - penting untuk import 1000 item supaya tidak jadi
// 1000 request Postgres berurutan (neon serverless driver = 1 HTTP call per query).
// Item yang butuh auto-fetch gambar INAPROC ditandai fetch_status='pending' + import_job_id.
async function insertItemsBulk(items, jobId) {
  await ensureSchema();
  const db = getSql();
  if (items.length === 0) return [];

  const namaItems = [];
  const tipes = [];
  const merks = [];
  const links = [];
  const fetchStatuses = [];
  const importJobIds = [];

  for (const item of items) {
    const needsFetch = Boolean(jobId) && !item.gambar && item.link;
    namaItems.push(item.namaItem);
    tipes.push(item.tipe || '');
    merks.push(item.merk || '');
    links.push(item.link || '');
    fetchStatuses.push(needsFetch ? 'pending' : 'done');
    importJobIds.push(needsFetch ? jobId : null);
  }

  const rows = await db`
    INSERT INTO items (nama_item, tipe, merk, link, gambar, gambar_thumb, fetch_status, import_job_id)
    SELECT nama_item, tipe, merk, link, '', '', fetch_status, import_job_id
    FROM unnest(
      ${namaItems}::text[], ${tipes}::text[], ${merks}::text[], ${links}::text[],
      ${fetchStatuses}::text[], ${importJobIds}::text[]
    ) AS t(nama_item, tipe, merk, link, fetch_status, import_job_id)
    RETURNING *
  `;
  return rows.map(rowToItem);
}

async function updateItem(id, updates) {
  await ensureSchema();
  const db = getSql();
  const [existing] = await db`SELECT * FROM items WHERE id = ${id}`;
  if (!existing) return null;

  const merged = {
    nama_item: updates.namaItem ?? existing.nama_item,
    tipe: updates.tipe ?? existing.tipe,
    merk: updates.merk ?? existing.merk,
    link: updates.link ?? existing.link,
    gambar: updates.gambar ?? existing.gambar,
    gambar_thumb: updates.gambarThumb ?? existing.gambar_thumb,
  };
  const [row] = await db`
    UPDATE items SET
      nama_item = ${merged.nama_item},
      tipe = ${merged.tipe},
      merk = ${merged.merk},
      link = ${merged.link},
      gambar = ${merged.gambar},
      gambar_thumb = ${merged.gambar_thumb}
    WHERE id = ${id}
    RETURNING *
  `;
  return rowToItem(row);
}

async function getItem(id) {
  await ensureSchema();
  const db = getSql();
  const [row] = await db`SELECT * FROM items WHERE id = ${id}`;
  return row ? rowToItem(row) : null;
}

async function deleteItem(id) {
  await ensureSchema();
  const db = getSql();
  const [row] = await db`DELETE FROM items WHERE id = ${id} RETURNING *`;
  return row ? rowToItem(row) : null;
}

async function deleteItemsByIds(ids) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`DELETE FROM items WHERE id = ANY(${ids}::int[]) RETURNING *`;
  return rows.map(rowToItem);
}

async function deleteAllItems() {
  await ensureSchema();
  const db = getSql();
  const rows = await db`DELETE FROM items RETURNING *`;
  return rows.map(rowToItem);
}

// ---------- Import job (auto-fetch gambar INAPROC, diproses per-batch lewat polling) ----------

async function createImportJob(jobId, total) {
  await ensureSchema();
  const db = getSql();
  await db`
    INSERT INTO import_jobs (id, total, completed)
    VALUES (${jobId}, ${total}, ${total === 0})
  `;
}

async function getImportJob(jobId) {
  await ensureSchema();
  const db = getSql();
  const [row] = await db`SELECT * FROM import_jobs WHERE id = ${jobId}`;
  if (!row) return null;
  return {
    total: row.total,
    done: row.done,
    gambarBerhasil: row.gambar_berhasil,
    gambarGagal: row.gambar_gagal,
    completed: row.completed,
  };
}

async function getPendingImportItems(jobId, limit) {
  await ensureSchema();
  const db = getSql();
  const rows = await db`
    SELECT * FROM items WHERE import_job_id = ${jobId} AND fetch_status = 'pending' LIMIT ${limit}
  `;
  return rows.map(rowToItem);
}

async function saveItemFetchResult(id, result) {
  await ensureSchema();
  const db = getSql();
  if (result) {
    await db`
      UPDATE items SET gambar = ${result.gambar}, gambar_thumb = ${result.gambarThumb}, fetch_status = 'done'
      WHERE id = ${id}
    `;
  } else {
    await db`UPDATE items SET fetch_status = 'failed' WHERE id = ${id}`;
  }
}

// batchDone = jumlah item yang baru selesai diproses di batch ini (berhasil + gagal).
async function advanceImportJob(jobId, { batchDone, gambarBerhasil, gambarGagal }) {
  await ensureSchema();
  const db = getSql();
  const [row] = await db`
    UPDATE import_jobs SET
      done = done + ${batchDone},
      gambar_berhasil = gambar_berhasil + ${gambarBerhasil},
      gambar_gagal = gambar_gagal || ${JSON.stringify(gambarGagal)}::jsonb
    WHERE id = ${jobId}
    RETURNING *
  `;

  const [{ count }] = await db`
    SELECT COUNT(*)::int AS count FROM items WHERE import_job_id = ${jobId} AND fetch_status = 'pending'
  `;
  if (count === 0) {
    await db`UPDATE import_jobs SET completed = true WHERE id = ${jobId}`;
  }

  return {
    total: row.total,
    done: row.done,
    gambarBerhasil: row.gambar_berhasil,
    gambarGagal: row.gambar_gagal,
    completed: count === 0,
  };
}

module.exports = {
  getAllItems,
  insertItem,
  insertItemsBulk,
  updateItem,
  getItem,
  deleteItem,
  deleteItemsByIds,
  deleteAllItems,
  createImportJob,
  getImportJob,
  getPendingImportItems,
  saveItemFetchResult,
  advanceImportJob,
};
