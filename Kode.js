/**
 * Bot Keuangan WhatsApp (Fonnte) + Google Sheets
 * Patch utama:
 * 1) Token tidak hardcode -> Script Properties (FONNTE_TOKEN)
 * 2) /hapus aman -> simpan fingerprint transaksi (bukan rowIndex), delete by match
 * 3) kirimPesan safe JSON parse (tidak crash kalau response bukan JSON)
 * 4) parsing command lebih robust (split regex)
 * 5) optional: Lock saat write/delete untuk menghindari race condition
 */

// ====================== CONFIG ======================
const FONNTE_API = "https://api.fonnte.com/send";
const SHEET_NAME = "BotWA";
const DATA_COLS = 5;
const CACHE_TTL_SECONDS = 300; // 5 menit

function getFonnteToken_() {
  const token = PropertiesService.getScriptProperties().getProperty("FONNTE_TOKEN");
  if (!token) throw new Error("FONNTE_TOKEN belum diset di Script Properties.");
  return token;
}

function getDataRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, DATA_COLS).getValues();
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // 10 detik
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function safeJsonParse_(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

// ====================== ENTRYPOINTS ======================
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput("No Data").setMimeType(ContentService.MimeType.TEXT);
    }

    const json = safeJsonParse_(e.postData.contents);
    if (!json) {
      return ContentService.createTextOutput("Invalid JSON").setMimeType(ContentService.MimeType.TEXT);
    }

    Logger.log(JSON.stringify(json, null, 2));

    // ===== Ambil data fleksibel (support variasi payload Fonnte) =====
    const sender = json.sender || (json.data && json.data.sender);

    const message = (
      json.message ||
      (json.data && json.data.message) ||
      ""
    ).toString().trim();

    const isGroup = Boolean(
      json.isGroup ||
      (json.data && json.data.isGroup) ||
      false
    );

    const groupId =
      json.group ||
      json.chat ||
      (json.data && (json.data.group || json.data.chat));

    if (!sender) {
      return ContentService.createTextOutput("No Sender").setMimeType(ContentService.MimeType.TEXT);
    }

    // ===== Tentukan target balasan =====
    let target = json.chat || sender;
    if (isGroup && groupId) target = groupId;

    // ===== Mode hapus (user balas angka) =====
    const hasilHapus = prosesHapusDariBalasan(sender, message);
    if (hasilHapus) {
      kirimPesan(target, hasilHapus);
      return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    }

    if (!message) {
      return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    }

    // ===== Di grup: hanya respon command =====
    if (isGroup && !message.startsWith("/")) {
      return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
    }

    const parts = message.trim().split(/\s+/);
    const command = (parts[0] || "").toLowerCase();

    // ===== 1) COMMAND MASUK / KELUAR =====
    if (command === "/masuk" || command === "/keluar") {
      if (parts.length < 2) {
        kirimPesan(target, "Format salah.\nContoh:\n/masuk 100rb gaji");
        return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
      }

      const nominal = konversiTeksKeAngka(parts[1]);
      if (isNaN(nominal) || nominal <= 0) {
        kirimPesan(target, "❌ Nominal tidak valid.");
        return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
      }

      const jenis = command.replace("/", "").toUpperCase();
      const ket = parts.slice(2).join(" ") || "-";

      // Simpan data (lock untuk aman)
      withLock_(() => simpanTransaksi(sender, jenis, nominal, ket));

      // Ambil saldo total + saldo bulan berjalan
      const saldoTotal = hitungSaldo(sender);
      const dataBulan = rekapBulananCustom(sender); // bulan berjalan (default)
      const saldoBulanIni = dataBulan.masuk - dataBulan.keluar;

      // UI Konfirmasi
      let pesan = `✅ *Berhasil Dicatat*\n\n`;
      pesan += `📝 *Detail:*\n`;
      pesan += `Jenis: ${jenis}\n`;
      pesan += `Nominal: Rp ${Number(nominal).toLocaleString("id-ID")}\n`;
      pesan += `Ket: ${ket}\n`;
      pesan += `━━━━━━━━━━━━━━━\n`;
      pesan += `📅 *Saldo ${dataBulan.namaBulan}:* Rp ${Number(saldoBulanIni).toLocaleString("id-ID")}\n`;
      pesan += `💰 *Total Saldo:* Rp ${Number(saldoTotal).toLocaleString("id-ID")}`;

      kirimPesan(target, pesan);
    }

    // ===== 2) COMMAND SALDO TOTAL =====
    else if (command === "/saldo") {
      const saldo = hitungSaldo(sender);
      kirimPesan(target, "💰 Saldo Anda:\nRp " + Number(saldo).toLocaleString("id-ID"));
    }

    // ===== 3) COMMAND SALDO BERJALAN (BULAN INI) =====
    else if (command === "/saldoberjalan") {
      const dataBulan = rekapBulananCustom(sender);
      const saldoBulanIni = dataBulan.masuk - dataBulan.keluar;

      kirimPesan(
        target,
        "📅 *Saldo Berjalan (" + dataBulan.namaBulan + "):*\n" +
          "➕ Masuk: Rp " + Number(dataBulan.masuk).toLocaleString("id-ID") + "\n" +
          "➖ Keluar: Rp " + Number(dataBulan.keluar).toLocaleString("id-ID") + "\n" +
          "────────────────\n" +
          "💰 *Saldo: Rp " + Number(saldoBulanIni).toLocaleString("id-ID") + "*"
      );
    }

    // ===== 4) COMMAND HAPUS =====
    else if (command === "/hapus") {
      kirimPesan(target, tampilkanTransaksiUntukHapus(sender));
    }

    // ===== 5) COMMAND REKAP MINGGU =====
    else if (command === "/rekapminggu") {
      kirimPesan(target, rekapMingguanDetail(sender));
    }

    // ===== 6) COMMAND REKAP BULAN (BISA PILIH) =====
    else if (command === "/rekapbulan") {
      const bulanInput = parts[1]; // contoh: 02
      const tahunInput = parts[2]; // contoh: 2025
      const data = rekapBulananCustom(sender, bulanInput, tahunInput);

      kirimPesan(
        target,
        "📅 Rekap Bulan " + data.namaBulan + " " + data.tahun + "\n\n" +
          "➕ Masuk: Rp " + Number(data.masuk).toLocaleString("id-ID") + "\n" +
          "➖ Keluar: Rp " + Number(data.keluar).toLocaleString("id-ID") + "\n" +
          "────────────────\n" +
          "💰 Saldo: Rp " + Number(data.masuk - data.keluar).toLocaleString("id-ID")
      );
    }

    // ===== 7) COMMAND DETAIL BULAN (BISA PILIH) =====
    else if (command === "/detailbulan") {
      const bulanInput = parts[1];
      const tahunInput = parts[2];
      kirimPesan(target, detailBulananCustom(sender, bulanInput, tahunInput));
    }

    // ===== 8) COMMAND HELP / MENU =====
    else if (command === "/help" || command === "/menu") {
      const helpText =
        "📖 *DAFTAR PERINTAH BOT* 📖\n\n" +
        "💰 *Transaksi:*\n" +
        "• `/masuk [nominal] [ket]`\n" +
        "  _Contoh: /masuk 50rb gaji_\n" +
        "• `/keluar [nominal] [ket]`\n" +
        "  _Contoh: /keluar 20000 makan_\n\n" +
        "📊 *Laporan:*\n" +
        "• `/saldo` : Cek total saldo saat ini\n" +
        "• `/saldoberjalan` : Saldo khusus bulan ini\n" +
        "• `/rekapminggu` : Detail seminggu ini\n" +
        "• `/rekapbulan [bln] [thn]`\n" +
        "  _Contoh: /rekapbulan 02 2025_\n" +
        "• `/detailbulan [bln] [thn]`\n" +
        "  _Contoh: /detailbulan 02 2025_\n\n" +
        "🗑 *Lain-lain:*\n" +
        "• `/hapus` : Menghapus transaksi terakhir\n" +
        "• `/help` atau `/menu` : Bantuan ini";

      kirimPesan(target, helpText);
    }

    return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    Logger.log("ERROR: " + (err && err.stack ? err.stack : err));
    return ContentService.createTextOutput("ERROR").setMimeType(ContentService.MimeType.TEXT);
  }
}

function doGet() {
  return ContentService.createTextOutput("Webhook aktif").setMimeType(ContentService.MimeType.TEXT);
}

// ====================== REPORTS ======================
function rekapMingguanDetail(user) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) return "❌ *Data tidak ditemukan.*";

  const rows = getDataRows_(sheet);
  if (rows.length === 0) return "📝 *Laporan:* Belum ada transaksi minggu ini.";

  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  let masuk = 0, keluar = 0, detail = "", ada = false;

  rows.forEach(r => {
    const tanggal = new Date(r[0]);
    if (r[1] == user && tanggal >= startOfWeek) {
      ada = true;

      const jenis = r[2];
      const nominal = Number(r[3]) || 0;
      const ket = r[4];

      const icon = (jenis === "MASUK") ? "🟢" : "🔴";

      if (jenis === "MASUK") masuk += nominal;
      else if (jenis === "KELUAR") keluar += nominal;

      const tglStr = Utilities.formatDate(tanggal, Session.getScriptTimeZone(), "dd/MM");
      detail += `${icon} \`[${tglStr}]\` Rp ${nominal.toLocaleString("id-ID")} _(${ket || "-"})_\n`;
    }
  });

  if (!ada) return "📝 *Laporan:* Belum ada transaksi minggu ini.";

  let ui = `📊 *LAPORAN MINGGUAN*\n`;
  ui += `_Periode: ${Utilities.formatDate(startOfWeek, Session.getScriptTimeZone(), "dd MMM")} - Sekarang_\n`;
  ui += `━━━━━━━━━━━━━━━━━━\n\n`;

  ui += `✅ *Pemasukan:* Rp ${masuk.toLocaleString("id-ID")}\n`;
  ui += `💸 *Pengeluaran:* Rp ${keluar.toLocaleString("id-ID")}\n`;
  ui += `──────────────────\n`;
  ui += `💰 *SELISIH : Rp ${(masuk - keluar).toLocaleString("id-ID")}*\n\n`;

  ui += `📋 *RIWAYAT*\n`;
  ui += detail;
  ui += `\n━━━━━━━━━━━━━━━━━━`;

  return ui;
}

function rekapBulananCustom(user, bulanInput, tahunInput) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) return { masuk: 0, keluar: 0, namaBulan: "-", tahun: "-" };

  const rows = getDataRows_(sheet);
  const now = new Date();

  // Tentukan bulan & tahun
  let bulan = bulanInput ? Number(bulanInput) - 1 : now.getMonth();
  let tahun = tahunInput ? Number(tahunInput) : now.getFullYear();

  if (isNaN(bulan) || bulan < 0 || bulan > 11) bulan = now.getMonth();
  if (isNaN(tahun) || tahun < 1970) tahun = now.getFullYear();

  const daftarBulanIndo = ["Jan","Feb","Maret","April","Mei","Juni","Juli","Agustus","Sept","Okt","Nov","Des"];
  const namaBulan = daftarBulanIndo[bulan];

  let masuk = 0, keluar = 0;

  rows.forEach(r => {
    const tanggal = new Date(r[0]);
    if (r[1] == user && tanggal.getMonth() === bulan && tanggal.getFullYear() === tahun) {
      if (r[2] === "MASUK") masuk += Number(r[3]) || 0;
      else if (r[2] === "KELUAR") keluar += Number(r[3]) || 0;
    }
  });

  return { masuk, keluar, namaBulan, tahun };
}

function detailBulananCustom(user, bulanInput, tahunInput) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) return "❌ *Data tidak ditemukan.*";

  const rows = getDataRows_(sheet);
  const now = new Date();

  let bulan = bulanInput ? Number(bulanInput) - 1 : now.getMonth();
  let tahun = tahunInput ? Number(tahunInput) : now.getFullYear();

  if (isNaN(bulan) || bulan < 0 || bulan > 11) return "❌ Bulan tidak valid. Gunakan 1-12.";
  if (isNaN(tahun) || tahun < 1970) tahun = now.getFullYear();

  const daftarBulanIndo = ["Jan","Feb","Maret","April","Mei","Juni","Juli","Agustus","Sept","Okt","Nov","Des"];

  let ada = false;
  let totalMasuk = 0;
  let totalKeluar = 0;
  let daftarTransaksi = "";

  rows.forEach(r => {
    const tanggal = new Date(r[0]);
    if (r[1] == user && tanggal.getMonth() === bulan && tanggal.getFullYear() === tahun) {
      ada = true;

      const jenis = r[2];
      const nominal = Number(r[3]) || 0;
      const ket = r[4];

      if (jenis === "MASUK") totalMasuk += nominal;
      else if (jenis === "KELUAR") totalKeluar += nominal;

      const tglStr = Utilities.formatDate(tanggal, Session.getScriptTimeZone(), "dd/MM");
      const icon = jenis === "MASUK" ? "🟢" : "🔴";

      daftarTransaksi += `${icon} \`[${tglStr}]\` Rp ${nominal.toLocaleString("id-ID")} _(${ket || "-"})_\n`;
    }
  });

  if (!ada) {
    return `📄 *LAPORAN BULANAN*\nStatus: Tidak ada transaksi pada bulan ${daftarBulanIndo[bulan]} ${tahun}.`;
  }

  let header = `📅 *LAPORAN: ${daftarBulanIndo[bulan].toUpperCase()} ${tahun}*\n`;
  header += `_Nomor: ${user}_\n`;
  header += `━━━━━━━━━━━━━━━━━━\n\n`;

  let body = `📝 *RIWAYAT TRANSAKSI*\n`;
  body += daftarTransaksi;
  body += `\n━━━━━━━━━━━━━━━━━━\n`;

  let footer = `📊 *RINGKASAN BULAN INI*\n`;
  footer += `──────────────────\n`;
  footer += `✅ *Pemasukan :* Rp ${totalMasuk.toLocaleString("id-ID")}\n`;
  footer += `💸 *Pengeluaran:* Rp ${totalKeluar.toLocaleString("id-ID")}\n`;
  footer += `──────────────────\n`;
  footer += `💰 *SISA SALDO  : Rp ${(totalMasuk - totalKeluar).toLocaleString("id-ID")}*`;

  return header + body + footer;
}

// ====================== FONNTE SEND ======================
function kirimPesan(target, message) {
  if (!target || !message) {
    Logger.log("Target atau message kosong");
    return;
  }

  const cleanTarget = String(target).trim();

  const payload = {
    target: cleanTarget,
    message: String(message),
    countryCode: "62",
    delay: "1"
  };

  const options = {
    method: "post",
    headers: {
      Authorization: getFonnteToken_()
    },
    payload,
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(FONNTE_API, options);
    const resText = response.getContentText();
    Logger.log("Response Fonnte: " + resText);

    // Safe parse: jangan crash jika response bukan JSON
    const resJson = safeJsonParse_(resText);
    if (resJson && resJson.status === false) {
      Logger.log("Gagal kirim! Alasan: " + resJson.reason);
    }
  } catch (e) {
    Logger.log("Error Fetch: " + e.toString());
  }
}

// ====================== SHEET OPS ======================
function hitungSaldo(user) {
  const sheet = SpreadsheetApp.getActive().getSheetByName("BotWA");
  if (!sheet) return 0;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const rows = sheet.getRange(2, 1, lastRow - 1, 5).getValues();

  let saldo = 0;

  rows.forEach(r => {
    if (r[1] == user) {
      if (r[2] === "MASUK") saldo += Number(r[3]);
      else if (r[2] === "KELUAR") saldo -= Number(r[3]);
    }
  });

  return saldo;
}

function simpanTransaksi(user, jenis, nominal, ket) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(["Tanggal", "User", "Jenis", "Nominal", "Keterangan"]);
  }

  sheet.appendRow([new Date(), user, jenis, nominal, ket]);
}

// ====================== DELETE FLOW (SAFE) ======================
/**
 * Menampilkan 10 transaksi terakhir user, simpan fingerprint (tanggal+jenis+nominal+ket)
 * Agar delete tidak salah walau ada transaksi baru masuk setelah command /hapus.
 */
function tampilkanTransaksiUntukHapus(user) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) return "Tidak ada data.";

  const rows = getDataRows_(sheet);
  if (rows.length === 0) return "Tidak ada transaksi.";

  // Kumpulkan transaksi user (fingerprint, bukan rowIndex)
  const dataUser = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];

    if (r[1] == user) {
      dataUser.push({
        // fingerprint transaksi
        tanggal: new Date(r[0]).getTime(),
        tipe: (r[2] || "").toString(),
        nominal: Number(r[3]) || 0,
        keterangan: (r[4] || "-").toString(),
      });
    }
  }

  if (dataUser.length === 0) return "Tidak ada transaksi.";

  // Ambil 10 terakhir
  const last10 = dataUser.slice(-10).reverse();

  let text = "🗑 Pilih nomor transaksi yang ingin dihapus:\n\n";
  last10.forEach((d, index) => {
    const tglStr = Utilities.formatDate(new Date(d.tanggal), Session.getScriptTimeZone(), "dd/MM/yyyy");
    text += `${index + 1}. ${tglStr} - ${d.tipe} | Rp ${d.nominal.toLocaleString("id-ID")} | ${d.keterangan}\n`;
  });

  // Simpan list fingerprint di cache (5 menit)
  const cache = CacheService.getUserCache();
  cache.put("hapus_" + user, JSON.stringify(last10), CACHE_TTL_SECONDS);

  return text + "\nBalas dengan angka (1-10).";
}

function prosesHapusDariBalasan(user, pesan) {
  const cache = CacheService.getUserCache();
  const data = cache.get("hapus_" + user);

  if (!data) return null;

  const list = safeJsonParse_(data);
  const nomor = Number(pesan);

  if (!Array.isArray(list) || isNaN(nomor) || nomor < 1 || nomor > list.length) {
    return "Nomor tidak valid.";
  }

  const target = list[nomor - 1];

  // Lock biar aman kalau ada transaksi masuk bersamaan
  return withLock_(() => {
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    if (!sheet) return "Sheet tidak ditemukan.";

    // Scan dari bawah untuk cari transaksi yang cocok (paling cepat ketemu transaksi terbaru)
    const rows = getDataRows_(sheet);
    if (rows.length === 0) {
      cache.remove("hapus_" + user);
      return "❌ Data kosong. Silakan /hapus lagi.";
    }

    let rowToDelete = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r[1] != user) continue;

      const tgl = new Date(r[0]).getTime();
      const tipe = (r[2] || "").toString();
      const nominal = Number(r[3]) || 0;
      const ket = (r[4] || "-").toString();

      if (
        tgl === target.tanggal &&
        tipe === target.tipe &&
        nominal === target.nominal &&
        ket === target.keterangan
      ) {
        rowToDelete = i + 2; // rows mulai dari baris 2 sheet
        break;
      }
    }

    cache.remove("hapus_" + user);

    if (rowToDelete === -1) {
      return "❌ Transaksi tidak ditemukan (mungkin sudah berubah). Silakan /hapus lagi.";
    }

    sheet.deleteRow(rowToDelete);
    return "✅ Transaksi berhasil dihapus.";
  });
}

// ====================== NOMINAL PARSER ======================
function konversiTeksKeAngka(teks) {
  if (!teks) return 0;

  let clean = teks
    .toLowerCase()
    .replace(/rp/g, "")
    .replace(/\./g, "")
    .replace(/,/g, "")
    .trim();

  const pengali = {
    rb: 1000,
    ribu: 1000,
    jt: 1000000,
    juta: 1000000,
    k: 1000
  };

  for (let kunci in pengali) {
    if (clean.includes(kunci)) {
      const angkaDasar = parseFloat(clean.replace(kunci, ""));
      if (!isNaN(angkaDasar)) return angkaDasar * pengali[kunci];
    }
  }

  return Number(clean.replace(/[^0-9]/g, ""));
}