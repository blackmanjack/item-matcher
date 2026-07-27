const AUTO_SELECT_THRESHOLD = 0.5;

// ---------- Mode Terang/Gelap ----------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('btn-theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
}

const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'dark' || savedTheme === 'light') {
  applyTheme(savedTheme);
} else {
  applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

document.getElementById('btn-theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
});

// ---------- Lisensi ----------
async function checkLicense() {
  try {
    const res = await fetch('/api/license/status');
    const data = await res.json();

    if (!data.valid) {
      document.querySelector('.app-shell').style.display = 'none';
      const lock = document.getElementById('license-lock');
      if (data.reason) {
        document.getElementById('license-lock-message').textContent = data.reason;
      }
      lock.style.display = 'flex';
      return false;
    }

    if (typeof data.daysLeft === 'number' && data.daysLeft <= 7) {
      const banner = document.getElementById('license-banner');
      banner.textContent = `Lisensi akan berakhir dalam ${data.daysLeft} hari. Hubungi vendor untuk perpanjangan.`;
      banner.style.display = 'block';
    }
    return true;
  } catch {
    return true; // gagal cek (mis. offline) - jangan blokir pemakaian, biarkan API asli yang tentukan
  }
}

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---------- Master Barang ----------
let itemsCache = [];
const selectedIds = new Set();

async function loadItems() {
  const res = await fetch('/api/items');
  itemsCache = await res.json();
  selectedIds.clear();
  renderItemsTable();
}

function renderItemsTable() {
  const tbody = document.querySelector('#table-items tbody');
  tbody.innerHTML = '';

  document.getElementById('item-count').textContent = itemsCache.length
    ? `(${itemsCache.length})`
    : '';
  document.getElementById('empty-state').style.display = itemsCache.length ? 'none' : 'block';
  document.getElementById('table-items').style.display = itemsCache.length ? 'table' : 'none';

  for (const item of itemsCache) {
    const tr = document.createElement('tr');
    const linkHtml = isSafeHttpUrl(item.link)
      ? `<a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">Lihat di INAPROC ↗</a>`
      : '';
    tr.innerHTML = `
      <td><input type="checkbox" class="row-checkbox" data-id="${item.id}" ${selectedIds.has(item.id) ? 'checked' : ''} /></td>
      <td>${item.gambar ? `<img src="${escapeHtml(item.gambar)}" alt="" class="thumb thumb-clickable" data-full="${escapeHtml(item.gambar)}" />` : ''}</td>
      <td>${escapeHtml(item.namaItem)}</td>
      <td>${escapeHtml(item.tipe)}</td>
      <td>${escapeHtml(item.merk)}</td>
      <td>${linkHtml}</td>
      <td>
        <button class="btn btn-ghost btn-sm edit-btn" data-id="${item.id}">Edit</button>
        <button class="btn btn-danger-outline btn-sm delete-btn" data-id="${item.id}">Hapus</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Hapus item ini?')) return;
      await fetch(`/api/items/${btn.dataset.id}`, { method: 'DELETE' });
      loadItems();
    });
  });
  tbody.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => startEditItem(Number(btn.dataset.id)));
  });
  tbody.querySelectorAll('.row-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.id);
      if (cb.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      updateSelectionUI();
    });
  });
  tbody.querySelectorAll('.thumb-clickable').forEach((img) => {
    img.addEventListener('click', () => openLightbox(img.dataset.full));
  });

  updateSelectionUI();
}

function isSafeHttpUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------- Lightbox (lihat gambar ukuran penuh) ----------
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');

function openLightbox(src) {
  lightboxImg.src = src;
  lightbox.style.display = 'flex';
}

function closeLightbox() {
  lightbox.style.display = 'none';
  lightboxImg.src = '';
}

document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});

function updateSelectionUI() {
  const count = selectedIds.size;
  document.getElementById('selected-count').textContent = count;
  document.getElementById('btn-delete-selected').disabled = count === 0;

  const selectAll = document.getElementById('checkbox-select-all');
  selectAll.checked = itemsCache.length > 0 && count === itemsCache.length;
  selectAll.indeterminate = count > 0 && count < itemsCache.length;
}

document.getElementById('checkbox-select-all').addEventListener('change', (e) => {
  selectedIds.clear();
  if (e.target.checked) {
    itemsCache.forEach((item) => selectedIds.add(item.id));
  }
  renderItemsTable();
});

document.getElementById('btn-delete-selected').addEventListener('click', async () => {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;
  if (!confirm(`Hapus ${ids.length} item terpilih?`)) return;

  const res = await fetch('/api/items/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (res.ok) {
    loadItems();
  } else {
    const err = await res.json();
    alert(err.error || 'Gagal menghapus item terpilih');
  }
});

document.getElementById('btn-delete-all').addEventListener('click', async () => {
  if (itemsCache.length === 0) return;
  if (!confirm(`Hapus SEMUA ${itemsCache.length} data master barang? Tindakan ini tidak bisa dibatalkan.`)) return;
  if (!confirm('Konfirmasi sekali lagi: benar-benar hapus semua data?')) return;

  const res = await fetch('/api/items', { method: 'DELETE' });
  if (res.ok) {
    loadItems();
  } else {
    const err = await res.json();
    alert(err.error || 'Gagal menghapus semua data');
  }
});

function startEditItem(id) {
  const item = itemsCache.find((i) => i.id === id);
  if (!item) return;
  document.getElementById('input-edit-id').value = item.id;
  document.getElementById('input-namaItem').value = item.namaItem;
  document.getElementById('input-tipe').value = item.tipe;
  document.getElementById('input-merk').value = item.merk;
  document.getElementById('input-link').value = item.link || '';
  document.getElementById('btn-submit-item').textContent = 'Simpan Perubahan';
  document.getElementById('btn-cancel-edit').style.display = 'inline-block';
  document.getElementById('form-heading').textContent = `Edit Item: ${item.namaItem}`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetItemForm() {
  document.getElementById('form-add-item').reset();
  document.getElementById('input-edit-id').value = '';
  document.getElementById('btn-submit-item').textContent = 'Tambah';
  document.getElementById('btn-cancel-edit').style.display = 'none';
  document.getElementById('form-heading').textContent = 'Tambah Item';
}

document.getElementById('btn-cancel-edit').addEventListener('click', resetItemForm);

document.getElementById('form-add-item').addEventListener('submit', async (e) => {
  e.preventDefault();
  const editId = document.getElementById('input-edit-id').value;
  const formData = new FormData();
  formData.append('namaItem', document.getElementById('input-namaItem').value);
  formData.append('tipe', document.getElementById('input-tipe').value);
  formData.append('merk', document.getElementById('input-merk').value);
  formData.append('link', document.getElementById('input-link').value);
  const fileInput = document.getElementById('input-gambar-file');
  if (fileInput.files.length) formData.append('gambarFile', fileInput.files[0]);

  const url = editId ? `/api/items/${editId}` : '/api/items';
  const method = editId ? 'PUT' : 'POST';

  const res = await fetch(url, { method, body: formData });
  if (res.ok) {
    resetItemForm();
    loadItems();
  } else {
    const err = await res.json();
    alert(err.error || 'Gagal menyimpan item');
  }
});

document.getElementById('form-import').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById('input-import-file');
  if (!fileInput.files.length) return;

  const autoFetchImage = document.getElementById('input-auto-fetch-image').checked;
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('autoFetchImage', autoFetchImage ? 'true' : 'false');

  const btnImport = document.getElementById('btn-submit-import');
  const statusEl = document.getElementById('import-status');
  btnImport.disabled = true;
  btnImport.textContent = autoFetchImage ? 'Mengambil gambar...' : 'Mengimport...';
  statusEl.classList.remove('error');
  statusEl.textContent = '';

  try {
    const res = await fetch('/api/items/import', { method: 'POST', body: formData });
    if (res.ok) {
      const data = await res.json();
      renderImportSummary(data);
      fileInput.value = '';
      loadItems();
    } else {
      const err = await res.json();
      statusEl.classList.add('error');
      statusEl.textContent = err.error || 'Gagal import file';
    }
  } finally {
    btnImport.disabled = false;
    btnImport.textContent = 'Import';
  }
});

function renderImportSummary(data) {
  const statusEl = document.getElementById('import-status');
  const lines = [`Berhasil import ${data.imported} item.`];

  if (data.gambarBerhasil || (data.gambarGagal && data.gambarGagal.length)) {
    const gagalCount = data.gambarGagal ? data.gambarGagal.length : 0;
    lines.push(`Gambar berhasil diambil otomatis: ${data.gambarBerhasil}, gagal: ${gagalCount}.`);
  }

  statusEl.innerHTML = lines.map((l) => escapeHtml(l)).join('<br />');

  if (data.gambarGagal && data.gambarGagal.length) {
    const list = document.createElement('ul');
    list.className = 'fail-list';
    data.gambarGagal.slice(0, 20).forEach((f) => {
      const li = document.createElement('li');
      li.textContent = `${f.namaItem} — ${f.alasan}`;
      list.appendChild(li);
    });
    statusEl.appendChild(list);
  }
}

// ---------- Cocokkan List Client ----------
let previewHeaders = [];
let matchResults = [];
let clientFile = null;

document.getElementById('form-upload-client').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById('input-client-file');
  if (!fileInput.files.length) return;
  clientFile = fileInput.files[0];

  const formData = new FormData();
  formData.append('file', clientFile);
  const res = await fetch('/api/match/preview', { method: 'POST', body: formData });
  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'Gagal membaca file');
    return;
  }
  const data = await res.json();
  previewHeaders = data.headers;

  const select = document.getElementById('select-column');
  select.innerHTML = '';
  previewHeaders.forEach((h, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = h || `Kolom ${idx + 1}`;
    select.appendChild(opt);
  });

  document.getElementById('preview-area').style.display = 'block';
  document.getElementById('match-results').style.display = 'none';
});

document.getElementById('btn-run-match').addEventListener('click', async () => {
  if (!clientFile) return;
  const colIndex = document.getElementById('select-column').value;

  const formData = new FormData();
  formData.append('file', clientFile);
  formData.append('colIndex', colIndex);

  const res = await fetch('/api/match/run', { method: 'POST', body: formData });
  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'Gagal menjalankan pencocokan');
    return;
  }
  const data = await res.json();
  matchResults = data.results;
  renderMatchResults();
});

function scoreClass(score) {
  if (score >= AUTO_SELECT_THRESHOLD) return 'score-high';
  if (score >= 0.3) return 'score-mid';
  return 'score-low';
}

function renderMatchResults() {
  const tbody = document.querySelector('#table-results tbody');
  tbody.innerHTML = '';

  matchResults.forEach((result, rowIdx) => {
    const tr = document.createElement('tr');
    const topScore = result.candidates[0] ? result.candidates[0].score : 0;
    if (topScore < AUTO_SELECT_THRESHOLD) tr.classList.add('row-needs-review');

    const candidatesHtml = result.candidates
      .map(
        (c, i) => `
        <label>
          <input type="radio" name="choice-${rowIdx}" value="${i}" ${i === 0 && topScore >= AUTO_SELECT_THRESHOLD ? 'checked' : ''} />
          ${c.item.gambar ? `<img src="${escapeHtml(c.item.gambar)}" alt="" class="thumb-result thumb-clickable" data-full="${escapeHtml(c.item.gambar)}" />` : ''}
          <span>${escapeHtml(c.item.namaItem)} ${c.item.tipe ? `(${escapeHtml(c.item.tipe)})` : ''}</span>
        </label>`
      )
      .join('');

    tr.innerHTML = `
      <td>${escapeHtml(result.clientText)}</td>
      <td><div class="candidate-list">
        ${candidatesHtml}
        <label><input type="radio" name="choice-${rowIdx}" value="none" ${result.candidates.length === 0 ? 'checked' : ''} /> Tidak ada match</label>
      </div></td>
      <td class="${scoreClass(topScore)}">${(topScore * 100).toFixed(0)}%</td>
      <td>${topScore < AUTO_SELECT_THRESHOLD ? 'Perlu review' : 'Auto'}</td>
      <td><button type="button" class="btn btn-danger-outline btn-sm delete-result-btn" data-idx="${rowIdx}">Hapus</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.thumb-clickable').forEach((img) => {
    img.addEventListener('click', (e) => {
      e.preventDefault(); // jangan biarkan klik gambar juga toggle radio di baris yang sama
      openLightbox(img.dataset.full);
    });
  });

  tbody.querySelectorAll('.delete-result-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      matchResults.splice(Number(btn.dataset.idx), 1);
      renderMatchResults();
    });
  });

  document.getElementById('match-results').style.display = 'block';
}

document.getElementById('btn-export').addEventListener('click', async () => {
  const rows = matchResults.map((result, rowIdx) => {
    const selected = document.querySelector(`input[name="choice-${rowIdx}"]:checked`);
    if (!selected || selected.value === 'none') {
      return { clientText: result.clientText, namaItem: '', tipe: '', merk: '', score: '', gambar: '' };
    }
    const candidate = result.candidates[Number(selected.value)];
    return {
      clientText: result.clientText,
      namaItem: candidate.item.namaItem,
      tipe: candidate.item.tipe,
      merk: candidate.item.merk,
      score: candidate.score,
      gambar: candidate.item.gambar || '',
    };
  });

  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) {
    alert('Gagal export');
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'hasil-matching.xlsx';
  a.click();
  URL.revokeObjectURL(url);
});

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

checkLicense().then((ok) => {
  if (ok) loadItems();
});
