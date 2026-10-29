/**
 * Dashboard GESIT x WELLNESS PLN Mobile 2026 - backend (Google Apps Script)
 *
 * Membaca sheet jawaban Google Form + sheet "Tanggal Bukti", lalu mengirim JSON
 * yang dipakai halaman dashboard di GitHub Pages.
 *
 * Periode dihitung dari TANGGAL AKTIVITAS DI BUKTI OLAHRAGA (sheet "Tanggal Bukti"),
 * bukan waktu submit. Entri yang belum diisi tanggal buktinya memakai tanggal submit
 * dan ditandai "Belum dicek" di dashboard.
 *
 * Cara pakai singkat (detail di README.md):
 *   1. Tempel file ini di Apps Script, jalankan siapkanSheetTanggalBukti() sekali.
 *   2. Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 *   3. Salin URL /exec ke API_URL di index.html.
 */

const SPREADSHEET_ID = '19MpQ2F_glcNg_kjKvneqUEsAzVp1byIPSfPDfoRtj3U';
const RESPONSE_SHEET = 'Form Responses 1';
const RESPONSE_SHEET_GID = 1735058559;     // dipakai kalau nama sheet berubah
const PROOF_SHEET = 'Tanggal Bukti';
const CACHE_SECONDS = 300;                 // data di-cache 5 menit
const CACHE_KEY = 'gesit_dashboard_v1';

// Kolom (0 = kolom A) di sheet jawaban: nilai dan upload bukti olahraga per kategori.
const SECTIONS = [
  { cat: 'Kalori', match: /all sport|kalori/i,  value: 4,  proof: 5  },
  { cat: 'Lari',   match: /berlari|lari/i,      value: 7,  proof: 8  },
  { cat: 'Jalan',  match: /jalan/i,             value: 10, proof: 11 },
  { cat: 'Sepeda', match: /sepeda/i,            value: 13, proof: 14 },
];

// Ejaan nama yang berbeda untuk orang yang sama: huruf kecil -> nama yang ditampilkan.
// Beda huruf besar/kecil saja sudah otomatis digabung, tidak perlu ditulis di sini.
const NAME_FIX = {
  'sheila riesma intani': 'Sheilla Riesma Intani',
};

const PROOF_HEADERS = ['ID file bukti', 'Waktu submit', 'Nama', 'Tanggal bukti (yyyy-mm-dd)',
                       'Status', 'Catatan', 'Dihitung?'];
const STATUS_LABEL = { b: 'Dari bukti', p: 'Perkiraan', x: 'Belum dicek' };

/* ------------------------------------------------------------------ web app */

function doGet(e) {
  const params = (e && e.parameter) || {};
  let payload;
  try {
    payload = params.fresh ? buildData_() : getCachedData_();
  } catch (err) {
    payload = { error: String(err && err.message || err) };
  }
  const json = JSON.stringify(payload);
  const cb = params.callback;
  if (cb && /^[A-Za-z_$][\w$.]*$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function getCachedData_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CACHE_KEY);
  if (hit) return JSON.parse(hit);
  const data = buildData_();
  try { cache.put(CACHE_KEY, JSON.stringify(data), CACHE_SECONDS); } catch (err) { /* >100KB: skip cache */ }
  return data;
}

function hapusCache() {
  CacheService.getScriptCache().remove(CACHE_KEY);
}

/* ------------------------------------------------------------- build data */

function buildData_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  const rows = responseSheet_(ss).getDataRange().getValues();
  const proofs = readProofSheet_(ss, tz);

  const entries = [];
  const variants = {};   // nameKey -> {ejaan: jumlah}
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0] || !String(r[1]).trim()) continue;
    const sec = pickSection_(r);
    if (!sec) continue;
    const value = toNumber_(r[sec.value]);
    if (!(value > 0)) continue;

    const submit = formatDate_(r[0], tz);
    const fileId = extractFileId_(r[sec.proof]);
    const p = fileId ? proofs[fileId] : null;
    let date = submit, status = 'x', note = '', counted = 1;
    if (p) {
      if (p.date) { date = p.date; status = p.status; }
      note = p.note;
      counted = p.counted;
    }

    const raw = String(r[1]).trim().replace(/\s+/g, ' ');
    const key = nameKey_(raw);
    variants[key] = variants[key] || {};
    variants[key][raw] = (variants[key][raw] || 0) + 1;

    entries.push([i + 1, date, submit, key, String(r[2]).trim(), sec.cat,
                  Math.round(value * 100) / 100, status, note, counted]);
  }

  const display = {};
  Object.keys(variants).forEach(function (k) { display[k] = displayName_(k, variants[k]); });
  entries.forEach(function (e) { e[3] = display[e[3]]; });

  return {
    updated: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    source: 'apps-script',
    fields: ['row', 'date', 'submit', 'name', 'unit', 'cat', 'value', 'status', 'note', 'counted'],
    entries: entries,
  };
}

function responseSheet_(ss) {
  const byName = ss.getSheetByName(RESPONSE_SHEET);
  if (byName) return byName;
  const byId = ss.getSheets().filter(function (s) { return s.getSheetId() === RESPONSE_SHEET_GID; })[0];
  if (byId) return byId;
  throw new Error('Sheet jawaban "' + RESPONSE_SHEET + '" tidak ditemukan');
}

// Pakai bagian yang sesuai kategori kalau terisi; kalau tidak, bagian pertama yang terisi.
// (Contoh: kategori "Berlari (km)" tapi angkanya diisi di kolom kalori -> dihitung kalori.)
function pickSection_(r) {
  const cat = String(r[3] || '');
  const filled = function (s) { return String(r[s.value]).trim() !== '' || String(r[s.proof]).trim() !== ''; };
  const own = SECTIONS.filter(function (s) { return s.match.test(cat); })[0];
  if (own && String(r[own.value]).trim() !== '') return own;
  return SECTIONS.filter(filled)[0] || null;
}

function readProofSheet_(ss, tz) {
  const sh = ss.getSheetByName(PROOF_SHEET);
  const map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, PROOF_HEADERS.length).getValues();
  vals.forEach(function (v) {
    const id = String(v[0]).trim();
    if (!id) return;
    const date = parseDate_(v[3], tz);
    const st = String(v[4]).toLowerCase();
    map[id] = {
      date: date,
      status: !date ? 'x' : (st.indexOf('perkiraan') === 0 ? 'p' : 'b'),
      note: String(v[5] || ''),
      counted: String(v[6]).trim().toLowerCase() === 'tidak' ? 0 : 1,
    };
  });
  return map;
}

/* ---------------------------------------------------------------- helpers */

function extractFileId_(cell) {
  const m = String(cell || '').match(/(?:id=|\/d\/)([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : '';
}

function toNumber_(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^\d,.-]/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function formatDate_(d, tz) {
  return Utilities.formatDate(d instanceof Date ? d : new Date(d), tz, 'yyyy-MM-dd');
}

// Terima Date, "2026-05-19", "19/05/2026" atau "19-5-2026".
function parseDate_(v, tz) {
  if (!v) return '';
  if (v instanceof Date) return formatDate_(v, tz);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + '-' + pad_(m[2]) + '-' + pad_(m[3]);
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) return m[3] + '-' + pad_(m[2]) + '-' + pad_(m[1]);
  return '';
}

function pad_(x) { return ('0' + x).slice(-2); }

function nameKey_(raw) {
  const low = raw.toLowerCase();
  return NAME_FIX[low] ? NAME_FIX[low].toLowerCase() : low;
}

// Nama yang ditampilkan: dari NAME_FIX, atau ejaan dengan huruf besar-kecil yang rapi
// yang paling sering dipakai, atau Title Case.
function displayName_(key, counts) {
  const fixed = Object.keys(NAME_FIX).map(function (k) { return NAME_FIX[k]; })
    .filter(function (n) { return n.toLowerCase() === key; })[0];
  if (fixed) return fixed;
  const proper = Object.keys(counts).filter(isProperCase_)
    .sort(function (a, b) { return counts[b] - counts[a]; });
  if (proper.length) return proper[0];
  const top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
  return top.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, function (_, p, c) { return p + c.toUpperCase(); });
}

function isProperCase_(name) {
  return name.split(' ').every(function (w) {
    const letters = w.replace(/[^A-Za-z]/g, '');
    if (!letters) return true;
    return /^[A-Z]/.test(letters) && (letters.length === 1 || /[a-z]/.test(letters));
  });
}

/* ------------------------------------------------- sheet "Tanggal Bukti" */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Dashboard GESIT')
    .addItem('Tambah entri baru ke Tanggal Bukti', 'tambahEntriBaru')
    .addItem('Segarkan data dashboard sekarang', 'hapusCache')
    .addSeparator()
    .addItem('Siapkan sheet Tanggal Bukti (sekali saja)', 'siapkanSheetTanggalBukti')
    .addItem('Buat ulang tab rekap', 'buatSheetRekap')
    .addToUi();
}

/**
 * Jalankan SEKALI. Membuat sheet "Tanggal Bukti" dan mengisinya dengan tanggal
 * aktivitas yang sudah dibaca dari 245 bukti olahraga (submit 18 Mei - 13 Okt 2026).
 * Baris yang sudah ada tidak ditimpa.
 */
function siapkanSheetTanggalBukti() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  const rows = responseSheet_(ss).getDataRange().getValues();
  Object.keys(SEED_CHECK).forEach(function (r) {
    const row = rows[Number(r) - 1];
    const sec = row ? pickSection_(row) : null;
    const id = sec ? extractFileId_(row[sec.proof]) : '';
    if (id.indexOf(SEED_CHECK[r]) !== 0) {
      throw new Error('Urutan baris di sheet jawaban sudah berubah (baris ' + r + '). Data awal tidak dimasukkan.');
    }
  });

  let sh = ss.getSheetByName(PROOF_SHEET);
  if (!sh) sh = ss.insertSheet(PROOF_SHEET);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, PROOF_HEADERS.length).setValues([PROOF_HEADERS])
      .setFontWeight('bold').setBackground('#125d72').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange('D:D').setNumberFormat('@');
    sh.setColumnWidth(1, 120); sh.setColumnWidth(2, 140); sh.setColumnWidth(3, 230);
    sh.setColumnWidth(4, 170); sh.setColumnWidth(5, 110); sh.setColumnWidth(6, 420); sh.setColumnWidth(7, 90);
    sh.getRange('E2:E').setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['Dari bukti', 'Perkiraan', 'Belum dicek'], true).build());
    sh.getRange('G2:G').setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['Ya', 'Tidak'], true).build());
  }

  const notes = {};
  SEED_NOTES.forEach(function (n) { n[2].forEach(function (r) { notes[r] = [n[0], n[1]]; }); });
  const existing = existingIds_(sh);
  const add = [];
  SEED_DATES.split(/\s+/).forEach(function (pair) {
    if (!pair) return;
    const r = Number(pair.split(':')[0]);
    const row = rows[r - 1];
    const sec = pickSection_(row);
    const id = sec ? extractFileId_(row[sec.proof]) : '';
    if (!id || existing[id]) return;
    const n = notes[r] || ['b', ''];
    add.push([id, Utilities.formatDate(row[0] instanceof Date ? row[0] : new Date(row[0]), tz, 'yyyy-MM-dd HH:mm'),
              String(row[1]).trim(), SEED_YEAR + '-' + pair.split(':')[1], STATUS_LABEL[n[0]], n[1], 'Ya']);
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, PROOF_HEADERS.length).setValues(add);
  const extra = tambahEntriBaru();
  const msg = add.length + ' baris tanggal bukti ditambahkan, ' + extra + ' entri baru menunggu dicek.';
  Logger.log(msg);
  return msg;
}

/**
 * Menambahkan entri form yang belum ada di "Tanggal Bukti" (tanggal kosong, status Belum dicek).
 * Isi kolom D dengan tanggal aktivitas di bukti, format yyyy-mm-dd.
 */
function tambahEntriBaru() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  const sh = ss.getSheetByName(PROOF_SHEET);
  if (!sh) throw new Error('Jalankan siapkanSheetTanggalBukti() dulu');
  const existing = existingIds_(sh);
  const info = responseInfo_(ss, tz);
  const add = Object.keys(info).filter(function (id) { return !existing[id]; }).map(function (id) {
    return [id, info[id].submit, info[id].name, '', 'Belum dicek', '', 'Ya'];
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, PROOF_HEADERS.length).setValues(add);
  hapusCache();
  return add.length;
}

/** Opsional: jalankan sekali agar entri baru otomatis masuk ke "Tanggal Bukti" tiap ada submit. */
function pasangTriggerSubmit() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'tambahEntriBaru'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tambahEntriBaru').forSpreadsheet(SPREADSHEET_ID).onFormSubmit().create();
}

function existingIds_(sh) {
  const ids = {};
  if (sh.getLastRow() < 2) return ids;
  sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
    .forEach(function (v) { if (v[0]) ids[String(v[0]).trim()] = true; });
  return ids;
}

function responseInfo_(ss, tz) {
  const rows = responseSheet_(ss).getDataRange().getValues();
  const info = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    const sec = pickSection_(r);
    const id = sec ? extractFileId_(r[sec.proof]) : '';
    if (id) info[id] = {
      submit: Utilities.formatDate(r[0] instanceof Date ? r[0] : new Date(r[0]), tz, 'yyyy-MM-dd HH:mm'),
      name: String(r[1]).trim(),
    };
  }
  return info;
}

/* ------------------------------------------ tab rekap di Google Sheet */

const REKAP_DATA = 'Data Rekap';
const REKAP_PERIODE = 'Rekap per Periode';
const REKAP_BULAN = 'Rekap per Bulan';
const REKAP_PERIODS = ['Mei–Jun', 'Jul–Agu', 'Sep–Okt', 'Nov–Des'];
const REKAP_MONTHS = [[5, 'Mei'], [6, 'Jun'], [7, 'Jul'], [8, 'Agu'], [9, 'Sep'], [10, 'Okt'], [11, 'Nov'], [12, 'Des']];

/**
 * Membuat (ulang) tab "Data Rekap", "Rekap per Periode" dan "Rekap per Bulan".
 * Isinya rumus, jadi angka ikut berubah sendiri setiap ada jawaban form baru
 * atau tanggal di "Tanggal Bukti" diisi/diubah. Cukup dijalankan sekali.
 */
function buatSheetRekap() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const R = "'" + responseSheet_(ss).getName() + "'!";
  const T = "'" + PROOF_SHEET + "'!";
  const D = "'" + REKAP_DATA + "'!";

  // ---- Data Rekap: satu baris per jawaban form
  let nameExpr = 'PROPER(TRIM(' + R + 'B2:B))';
  Object.keys(NAME_FIX).forEach(function (k) {
    nameExpr = 'IF(LOWER(TRIM(' + R + 'B2:B))="' + k + '","' + NAME_FIX[k] + '",' + nameExpr + ')';
  });
  // IFS butuh semua array sama panjang, jadi kolom Kategori dipotong sepanjang sheet jawaban.
  const pick = function (cols) {
    return 'LET(c,ARRAY_CONSTRAIN(D2:D,ROWS(' + R + 'A2:A),1),IFS(c="Kalori",' + R + cols[0] + '2:' + cols[0] +
           ',c="Lari",' + R + cols[1] + '2:' + cols[1] + ',c="Jalan",' + R + cols[2] + '2:' + cols[2] +
           ',c="Sepeda",' + R + cols[3] + '2:' + cols[3] + '))';
  };
  const data = [
    ['Baris', '=ARRAYFORMULA(IF(' + R + 'A2:A="",,ROW(' + R + 'A2:A)))'],
    ['Nama', '=ARRAYFORMULA(IF(' + R + 'A2:A="",,' + nameExpr + '))'],
    ['Unit', '=ARRAYFORMULA(IF(' + R + 'A2:A="",,TRIM(' + R + 'C2:C)))'],
    ['Kategori', '=ARRAYFORMULA(IF(' + R + 'A2:A="",,IFS(' +
      'REGEXMATCH(TO_TEXT(' + R + 'D2:D),"(?i)berlari")*(' + R + 'H2:H<>""),"Lari",' +
      'REGEXMATCH(TO_TEXT(' + R + 'D2:D),"(?i)jalan")*(' + R + 'K2:K<>""),"Jalan",' +
      'REGEXMATCH(TO_TEXT(' + R + 'D2:D),"(?i)sepeda")*(' + R + 'N2:N<>""),"Sepeda",' +
      R + 'E2:E<>"","Kalori",' + R + 'H2:H<>"","Lari",' + R + 'K2:K<>"","Jalan",' + R + 'N2:N<>"","Sepeda",TRUE,"")))'],
    ['Nilai', '=ARRAYFORMULA(IF(D2:D="",,IFERROR(VALUE(' + pick(['E', 'H', 'K', 'N']) + '),0)))'],
    ['ID file bukti', '=ARRAYFORMULA(IF(D2:D="",,IFERROR(REGEXEXTRACT(TO_TEXT(' + pick(['F', 'I', 'L', 'O']) +
      '),"(?:id=|/d/)([A-Za-z0-9_-]{20,})"),"")))'],
    ['Tanggal submit', '=ARRAYFORMULA(IF(D2:D="",,INT(' + R + 'A2:A)))'],
    ['Tanggal bukti', '=ARRAYFORMULA(IF(D2:D="",,IFERROR(LET(v,VLOOKUP(F2:F,' + T + 'A2:D,4,FALSE),' +
      'IF(ISNUMBER(v),INT(v),DATEVALUE(v))),"")))'],
    ['Tanggal dipakai', '=ARRAYFORMULA(IF(D2:D="",,IF(H2:H="",G2:G,H2:H)))'],
    ['Status', '=ARRAYFORMULA(IF(D2:D="",,IF(H2:H="","Belum dicek",LET(s,IFERROR(VLOOKUP(F2:F,' + T +
      'A2:E,5,FALSE),""),IF(s="","Dari bukti",s)))))'],
    ['Dihitung', '=ARRAYFORMULA(IF(D2:D="",,IF(IFERROR(VLOOKUP(F2:F,' + T + 'A2:G,7,FALSE),"Ya")="Tidak",0,1)))'],
    ['Bulan', '=ARRAYFORMULA(IF(D2:D="",,MONTH(I2:I)))'],
    ['Periode', '=ARRAYFORMULA(IF(D2:D="",,CHOOSE(ROUNDUP(L2:L/2),"Jan–Feb","Mar–Apr","' +
      REKAP_PERIODS.join('","') + '")))'],
    ['Catatan', '=ARRAYFORMULA(IF(D2:D="",,IFERROR(VLOOKUP(F2:F,' + T + 'A2:F,6,FALSE)&"","")))'],
  ];
  const sd = freshSheet_(ss, REKAP_DATA);
  sd.getRange(1, 1, 1, data.length).setValues([data.map(function (c) { return c[0]; })]);
  sd.getRange(2, 1, 1, data.length).setFormulas([data.map(function (c) { return c[1]; })]);
  headerStyle_(sd.getRange(1, 1, 1, data.length));
  sd.getRange('E:E').setNumberFormat('#,##0.00');
  sd.getRange('G:I').setNumberFormat('yyyy-mm-dd');
  sd.setFrozenRows(1);
  sd.setColumnWidth(2, 230); sd.setColumnWidth(6, 120); sd.setColumnWidth(14, 380);

  // ---- Rekap per Periode
  const sp = freshSheet_(ss, REKAP_PERIODE);
  const KM = '#,##0.00;-#,##0.00;"-"', KC = '#,##0;-#,##0;"-"';
  const groups = REKAP_PERIODS.concat(['Semua periode']);
  const subs = ['Lari (km)', 'Jalan (km)', 'Sepeda (km)', 'Total km', 'Kalori (kcal)'];
  const lastCol = 3 + groups.length * 5;
  sp.getRange('A1').setValue('GESIT x WELLNESS PLN Mobile 2026 - total per orang per periode').setFontSize(14).setFontWeight('bold');
  sp.getRange('A2').setValue('Dihitung otomatis dari "' + responseSheet_(ss).getName() + '" dan "' + PROOF_SHEET +
    '". Periode menurut tanggal aktivitas di bukti olahraga; entri yang belum ada tanggal buktinya memakai tanggal submit.')
    .setFontColor('#595959').setFontStyle('italic');
  sp.getRange(3, 1, 2, 3).setValues([['Nama', 'Unit', 'Entri'], ['', '', '']]);
  [1, 2, 3].forEach(function (c) { sp.getRange(3, c, 2, 1).merge(); });
  const names = 'A6:A';
  sp.getRange('A5').setValue('Total');
  sp.getRange('A6').setFormula('=SORT(UNIQUE(FILTER(' + D + 'B2:B,' + D + 'B2:B<>"")))');
  sp.getRange('B6').setFormula('=ARRAYFORMULA(IF(' + names + '="",,IFERROR(VLOOKUP(' + names + ',' + D + 'B2:C,2,FALSE),"")))');
  sp.getRange('C6').setFormula('=ARRAYFORMULA(IF(' + names + '="",,COUNTIFS(' + D + 'B2:B,' + names + ',' + D + 'K2:K,1)))');
  sp.getRange('C5').setFormula('=SUM(C6:C)');
  groups.forEach(function (g, gi) {
    const c0 = 4 + gi * 5;
    sp.getRange(3, c0, 1, 5).merge().setValue(g).setHorizontalAlignment('center');
    sp.getRange(4, c0, 1, 5).setValues([subs]);
    const per = gi < REKAP_PERIODS.length ? ',' + D + 'M2:M,' + colA1_(c0) + '$3' : '';
    ['Lari', 'Jalan', 'Sepeda'].forEach(function (cat, k) {
      sp.getRange(6, c0 + k).setFormula('=MAP(' + names + ',LAMBDA(n,IF(n="",,SUMIFS(' + D + 'E2:E,' + D + 'B2:B,n' +
        per + ',' + D + 'D2:D,"' + cat + '",' + D + 'K2:K,1))))');
    });
    const a = colA1_(c0), b = colA1_(c0 + 1), c = colA1_(c0 + 2);
    sp.getRange(6, c0 + 3).setFormula('=ARRAYFORMULA(IF(' + names + '="",,' + a + '6:' + a + '+' + b + '6:' + b + '+' + c + '6:' + c + '))');
    sp.getRange(6, c0 + 4).setFormula('=MAP(' + names + ',LAMBDA(n,IF(n="",,SUMIFS(' + D + 'E2:E,' + D + 'B2:B,n' +
      per + ',' + D + 'D2:D,"Kalori",' + D + 'K2:K,1))))');
    for (let k = 0; k < 5; k++) {
      const col = colA1_(c0 + k);
      sp.getRange(5, c0 + k).setFormula('=SUM(' + col + '6:' + col + ')');
      sp.getRange(5, c0 + k, sp.getMaxRows() - 4, 1).setNumberFormat(k === 4 ? KC : KM);
    }
    sp.getRange(6, c0 + 3, sp.getMaxRows() - 5, 1).setFontWeight('bold');
  });
  headerStyle_(sp.getRange(3, 1, 2, lastCol));
  sp.getRange(5, 1, 1, lastCol).setFontWeight('bold').setBackground('#f2f2f2');
  sp.setFrozenRows(5); sp.setFrozenColumns(1);
  sp.setColumnWidth(1, 240); sp.setColumnWidth(2, 120); sp.setColumnWidth(3, 55);
  sp.setColumnWidths(4, lastCol - 3, 82);
  sp.setRowHeight(4, 34);
  sp.getRange(4, 1, 1, lastCol).setWrap(true);

  // ---- Rekap per Bulan
  const sm = freshSheet_(ss, REKAP_BULAN);
  const nM = REKAP_MONTHS.length;
  sm.getRange('A1').setValue('Total per orang per bulan (menurut tanggal di bukti olahraga)').setFontSize(14).setFontWeight('bold');
  sm.getRange('A3').setValue('Nama'); sm.getRange(3, 1, 2, 1).merge();
  sm.getRange(3, 2, 1, nM).merge().setValue('Total km (lari + jalan + sepeda)').setHorizontalAlignment('center');
  sm.getRange(3, 2 + nM, 1, nM).merge().setValue('Kalori (kcal)').setHorizontalAlignment('center');
  sm.getRange('A5').setValue('Total');
  sm.getRange('A6').setFormula('=SORT(UNIQUE(FILTER(' + D + 'B2:B,' + D + 'B2:B<>"")))');
  [['"<>Kalori"', KM, 2], ['"Kalori"', KC, 2 + nM]].forEach(function (blk) {
    REKAP_MONTHS.forEach(function (m, i) {
      const col = blk[2] + i, L = colA1_(col);
      sm.getRange(4, col).setValue(m[1]);
      sm.getRange(6, col).setFormula('=MAP(' + names + ',LAMBDA(n,IF(n="",,SUMIFS(' + D + 'E2:E,' + D + 'B2:B,n,' +
        D + 'L2:L,' + m[0] + ',' + D + 'D2:D,' + blk[0] + ',' + D + 'K2:K,1))))');
      sm.getRange(5, col).setFormula('=SUM(' + L + '6:' + L + ')');
      sm.getRange(5, col, sm.getMaxRows() - 4, 1).setNumberFormat(blk[1]);
    });
  });
  headerStyle_(sm.getRange(3, 1, 2, 1 + 2 * nM));
  sm.getRange(5, 1, 1, 1 + 2 * nM).setFontWeight('bold').setBackground('#f2f2f2');
  sm.setFrozenRows(5); sm.setFrozenColumns(1);
  sm.setColumnWidth(1, 240); sm.setColumnWidths(2, 2 * nM, 72);

  ss.setActiveSheet(sp);
  return 'Tab rekap dibuat: ' + [REKAP_PERIODE, REKAP_BULAN, REKAP_DATA].join(', ');
}

function freshSheet_(ss, name) {
  const old = ss.getSheetByName(name);
  if (old) ss.deleteSheet(old);
  return ss.insertSheet(name, ss.getNumSheets());
}

function headerStyle_(range) {
  range.setFontWeight('bold').setBackground('#125d72').setFontColor('#ffffff')
    .setVerticalAlignment('middle').setHorizontalAlignment('center');
}

function colA1_(c) {
  let s = '';
  while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
  return s;
}

/* ------------------------------------------- data awal tanggal bukti */

const SEED_YEAR = 2026;

// Baris di sheet jawaban -> tanggal aktivitas di bukti (bulan-tanggal, tahun 2026).
const SEED_DATES = [
  '2:05-01 3:05-06 4:05-07 5:05-09 6:05-16 7:05-18 8:05-18 9:05-18 10:05-01 11:05-03 12:05-05 13:05-02',
  '14:05-08 15:05-08 16:05-08 17:05-09 18:05-09 19:05-12 20:05-12 21:05-14 22:05-14 23:05-15 24:05-13 25:05-15',
  '26:05-14 27:05-19 28:05-08 29:05-03 30:05-13 31:05-19 32:05-19 33:05-10 34:05-17 35:05-19 36:05-19 37:05-01',
  '38:05-20 39:05-20 40:05-20 41:05-08 42:05-20 43:05-20 44:05-20 45:05-21 46:05-21 47:05-21 48:05-05 49:05-21',
  '50:05-21 51:05-21 52:05-20 53:05-21 54:05-22 55:05-22 56:05-21 57:05-23 58:05-23 59:05-23 60:05-23 61:05-23',
  '62:05-24 63:05-02 64:05-25 65:05-25 66:05-02 67:05-11 68:05-28 69:05-28 70:05-29 71:05-29 72:06-01 73:06-01',
  '74:05-04 75:05-29 76:05-24 77:05-27 78:06-04 79:05-05 80:05-06 81:05-21 82:06-05 83:06-05 84:06-05 85:06-05',
  '86:06-06 87:06-06 88:05-09 89:05-14 90:05-06 91:06-10 92:06-10 93:06-11 94:06-11 95:06-12 96:06-12 97:06-11',
  '98:06-11 99:05-05 100:05-05 101:06-13 102:06-13 103:06-13 104:06-13 105:06-11 106:06-02 107:06-15 108:06-15 109:05-22',
  '110:05-04 111:06-16 112:06-16 113:05-04 114:06-16 115:06-16 116:06-16 117:06-16 118:06-16 119:06-16 120:06-17 121:06-17',
  '122:06-18 123:06-18 124:06-17 125:06-17 126:06-11 127:06-19 128:06-19 129:06-19 130:06-19 131:06-20 132:06-20 133:06-20',
  '134:06-21 135:06-21 136:06-21 137:06-21 138:05-05 139:06-20 140:06-19 141:06-20 142:06-22 143:06-22 144:06-22 145:06-22',
  '146:06-22 147:06-23 148:06-23 149:06-23 150:05-11 151:06-24 152:06-24 153:06-24 154:06-24 155:05-13 156:05-06 157:05-14',
  '158:05-09 159:05-20 160:05-23 161:05-30 162:06-28 163:06-28 164:06-26 165:06-07 166:06-10 167:06-13 168:06-27 169:05-15',
  '170:06-26 171:06-18 172:05-10 173:05-14 174:06-13 175:06-09 176:05-15 177:05-09 178:06-30 179:06-30 180:06-30 181:06-30',
  '182:07-04 183:07-09 184:07-04 185:07-01 186:07-12 187:07-12 188:07-05 189:07-14 190:07-14 191:07-02 192:07-03 193:07-05',
  '194:07-08 195:07-09 196:07-11 197:07-17 198:07-21 199:07-24 200:07-27 201:07-28 202:08-01 203:08-04 204:08-04 205:08-06',
  '206:08-07 207:08-10 208:08-11 209:08-11 210:08-12 211:08-18 212:08-18 213:08-20 214:08-21 215:08-24 216:08-26 217:08-26',
  '218:09-01 219:09-02 220:09-07 221:09-08 222:09-09 223:09-11 224:09-13 225:09-15 226:07-17 227:07-18 228:07-19 229:07-23',
  '230:07-28 231:07-31 232:08-05 233:09-15 234:09-16 235:08-07 236:08-28 237:08-30 238:09-02 239:09-03 240:09-18 241:09-22',
  '242:09-12 243:09-13 244:09-15 245:09-17 246:10-13'
].join(' ');

// [status (b = dari bukti, p = perkiraan), catatan, baris]
const SEED_NOTES = [
  ['b', 'Foto jam; tanggal dari nama file foto', [7, 117]],
  ['b', 'Bukti tertulis "Hari ini/Today"; tanggal dari nama file screenshot', [8, 9, 59, 104, 118, 119, 124, 125, 129, 130, 133, 142, 145, 179]],
  ['p', 'Bukti tertulis "Hari ini/Yesterday" tanpa tanggal file; diperkirakan dari waktu submit', [31, 36, 43, 134, 135, 136, 137, 146, 182, 197]],
  ['b', 'Kategori Berlari tapi angka diisi di kolom kalori; dihitung sebagai kalori', [46, 55]],
  ['p', 'Foto jam tanpa tanggal; diperkirakan dari waktu submit', [49]],
  ['p', 'Foto tanpa tanggal; spanduk Harkitnas ke-118 (20 Mei)', [52]],
  ['p', 'Ringkasan harian tanpa tanggal; diperkirakan dari waktu submit', [56]],
  ['b', 'Bukti tertulis "Kemarin"; dihitung dari tanggal gambar WhatsApp (28 Mei)', [77]],
  ['b', 'Bukti tertulis "05/06" (tanpa tahun)', [85]],
  ['p', 'Bukti tanpa tanggal; dari tanggal screenshot (sama dengan baris 86)', [87]],
  ['b', 'Kemungkinan dobel dengan baris 113 (tenis 4 Mei, 359 kcal)', [110]],
  ['b', 'Kemungkinan dobel dengan baris 110 (tenis 4 Mei, 359 kcal)', [113]],
  ['b', 'Kemungkinan dobel dengan baris 100 (ride 5 Mei, 620 kcal)', [138]],
  ['b', 'Bukti tertulis "Yesterday"; dihitung dari tanggal screenshot (21 Jun)', [139]],
];

// Pengaman: awal ID file bukti di beberapa baris, untuk memastikan urutan baris belum berubah.
const SEED_CHECK = { 2: '1OoTOZuQ1e', 100: '1JsVRoT_oc', 200: '1J_gxU4hv3', 246: '1z7xqSqaD-' };
