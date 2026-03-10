// =====================================================================
// TAMBAHKAN SEMUA KODE INI KE Code.gs KAMU (GANTIKAN fungsi doGet lama)
// =====================================================================

/**
 * doGet - melayani permintaan GET dari dashboard HTML
 * Menggantikan doGet lama yang hanya return "Webhook aktif"
 */
function doGet(e) {
  // Izinkan akses dari semua domain (CORS)
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  // Kalau tidak ada parameter action → anggap health check
  const action = (e && e.parameter && e.parameter.action) || "";

  if (!action) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "ok", message: "Webhook aktif" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const user  = (e.parameter.user  || "").toString().trim();
  const month = (e.parameter.month || "").toString().trim();
  const year  = (e.parameter.year  || "").toString().trim();

  let result;

  try {
    if (action === "data") {
      result = getDashboardSummary_(user, month, year);
    } else if (action === "history") {
      result = getDashboardHistory_(user, month, year);
    } else if (action === "trend") {
      result = getDashboardTrend_(user);
    } else {
      result = { error: "Unknown action" };
    }
  } catch (err) {
    result = { error: err.toString() };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────────────
// RINGKASAN BULAN (cards)
// Mengembalikan: { masuk, keluar, saldoTotal, jmlMasuk, jmlKeluar }
// ─────────────────────────────────────────────────────────────────────
function getDashboardSummary_(user, monthStr, yearStr) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) return { masuk: 0, keluar: 0, saldoTotal: 0, jmlMasuk: 0, jmlKeluar: 0 };

  const rows = getDataRows_(sheet);
  const now  = new Date();

  const bulan = monthStr ? Number(monthStr) - 1 : now.getMonth();
  const tahun = yearStr  ? Number(yearStr)      : now.getFullYear();

  let masuk = 0, keluar = 0, jmlMasuk = 0, jmlKeluar = 0, saldoTotal = 0;

  rows.forEach(r => {
    if (String(r[1]).trim() !== String(user).trim()) return;

    const tgl    = new Date(r[0]);
    const jenis  = (r[2] || "").toString();
    const nominal = Number(r[3]) || 0;

    // Hitung saldo total (semua waktu)
    if (jenis === "MASUK")   saldoTotal += nominal;
    else if (jenis === "KELUAR") saldoTotal -= nominal;

    // Hitung bulan yang dipilih
    if (tgl.getMonth() === bulan && tgl.getFullYear() === tahun) {
      if (jenis === "MASUK")   { masuk  += nominal; jmlMasuk++; }
      else if (jenis === "KELUAR") { keluar += nominal; jmlKeluar++; }
    }
  });

  return { masuk, keluar, saldoTotal, jmlMasuk, jmlKeluar };
}

// ─────────────────────────────────────────────────────────────────────
// RIWAYAT TRANSAKSI BULAN INI (tabel)
// Mengembalikan: { rows: [ { tanggal, jenis, nominal, keterangan } ] }
// ─────────────────────────────────────────────────────────────────────
function getDashboardHistory_(user, monthStr, yearStr) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) return { rows: [] };

  const rows  = getDataRows_(sheet);
  const now   = new Date();
  const bulan = monthStr ? Number(monthStr) - 1 : now.getMonth();
  const tahun = yearStr  ? Number(yearStr)      : now.getFullYear();

  const hasil = [];

  rows.forEach(r => {
    if (String(r[1]).trim() !== String(user).trim()) return;

    const tgl = new Date(r[0]);
    if (tgl.getMonth() !== bulan || tgl.getFullYear() !== tahun) return;

    hasil.push({
      tanggal    : tgl.getTime(),
      jenis      : (r[2] || "").toString(),
      nominal    : Number(r[3]) || 0,
      keterangan : (r[4] || "-").toString()
    });
  });

  return { rows: hasil };
}

// ─────────────────────────────────────────────────────────────────────
// TREN 6 BULAN TERAKHIR (bar chart)
// Mengembalikan: { months: [ { label, masuk, keluar } ] }
// ─────────────────────────────────────────────────────────────────────
function getDashboardTrend_(user) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) return { months: [] };

  const rows = getDataRows_(sheet);
  const now  = new Date();

  // Buat 6 slot bulan mundur dari sekarang
  const daftarBulan = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    daftarBulan.push({
      month : d.getMonth(),
      year  : d.getFullYear(),
      label : d.toLocaleString("id-ID", { month: "short", year: "2-digit" }),
      masuk : 0,
      keluar: 0
    });
  }

  rows.forEach(r => {
    if (String(r[1]).trim() !== String(user).trim()) return;

    const tgl    = new Date(r[0]);
    const jenis  = (r[2] || "").toString();
    const nominal = Number(r[3]) || 0;

    const slot = daftarBulan.find(s => s.month === tgl.getMonth() && s.year === tgl.getFullYear());
    if (!slot) return;

    if (jenis === "MASUK")       slot.masuk  += nominal;
    else if (jenis === "KELUAR") slot.keluar += nominal;
  });

  return { months: daftarBulan };
}

// =====================================================================
// CATATAN DEPLOY:
// Setelah menambahkan kode ini, lakukan:
// 1. Klik "Deploy" → "Manage Deployments"
// 2. Klik edit (ikon pensil) pada deployment yang ada
// 3. Ubah "Version" ke "New Version"
// 4. Pastikan "Who has access" = "Anyone"
// 5. Klik "Deploy" → salin URL-nya
// 6. Tempel URL tersebut ke kolom "URL Apps Script" di dashboard
// =====================================================================