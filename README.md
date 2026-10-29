# Dashboard GESIT x WELLNESS PLN Mobile 2026

Per-person distance and calorie totals for the GESIT x WELLNESS program, grouped into two-month periods (Mei–Jun, Jul–Agu, Sep–Okt, Nov–Des) by the **activity date shown on each Bukti Olahraga**, not the form submit time.

```
index.html            dashboard page (host on GitHub Pages)
Code.gs               backend (Google Apps Script web app that reads the responses sheet)
```

How it fits together: `index.html` fetches JSON from the Apps Script web app, and the web app reads the **Form Responses 1** sheet plus a **Tanggal Bukti** sheet that holds the activity date for each submission. If the web app can't be reached, the page says so and asks you to try again.

**Live setup (Oct 2026):** Apps Script project *Dashboard GESIT x WELLNESS 2026* (bound to the responses sheet), web app `https://script.google.com/macros/s/AKfycbw_H7WLCGZjLpqgLeOU8dEgqy_sqEYaq8VlVdRR0oS_kitaQLYtS-5HKIK0ARS7ID5x/exec`.

---

## 1. Set up the Apps Script backend

Do this while signed in to the Google account that can **edit** the spreadsheet *GESIT x WELLNESS PLN Mobile 2026 (Responses)*.

1. Open the spreadsheet → **Extensions → Apps Script**.
2. Delete the sample code, paste everything from `Code.gs`, and click **Save**.
3. In the function dropdown pick **`siapkanSheetTanggalBukti`** → **Run** → allow the permissions Google asks for.
   It adds a **Tanggal Bukti** tab with the 245 activity dates already read from the proofs. Existing rows are never overwritten, so running it again is safe.
4. **Deploy → New deployment** → gear icon → **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   → **Deploy**, then copy the **Web app URL** (ends in `/exec`).
5. Open that URL in a browser. You should see JSON starting with `{"updated":...`.

Optional: run **`pasangTriggerSubmit`** once so every new form submission is added to *Tanggal Bukti* automatically.

## 2. Publish the page on GitHub Pages

1. In `index.html`, paste the URL into the setting near the top of the script:
   ```js
   const API_URL = 'https://script.google.com/macros/s/XXXXXXXX/exec';
   ```
2. Create a GitHub repository (for example `gesit-wellness-dashboard`) and upload `index.html` (and this README).
3. Repository **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → **Save**.
4. After a minute the dashboard is live at `https://<your-username>.github.io/gesit-wellness-dashboard/`.

The page is public, like the Apps Script URL. Anyone with the link can see names, units and totals.

## 3. Keeping dates up to date

New submissions appear on the dashboard right away, using the **submit date** until someone checks the proof. They are listed under **Perlu dicek**.

In the spreadsheet, menu **Dashboard GESIT → Tambah entri baru ke Tanggal Bukti** (or the automatic trigger) adds a row for each new submission. Then for each row:

| Column | What to enter |
|---|---|
| D · Tanggal bukti | Activity date from the proof, as `yyyy-mm-dd` (e.g. `2026-11-05`). `dd/mm/yyyy` also works. |
| E · Status | **Dari bukti** if the date is on the proof, **Perkiraan** if you had to estimate it |
| F · Catatan | Optional note shown on the dashboard |
| G · Dihitung? | **Tidak** to leave a duplicate out of the totals |

The dashboard caches data for 5 minutes. The **Muat ulang** button on the page, or **Dashboard GESIT → Segarkan data dashboard sekarang**, refreshes it immediately.

## Rekap in Google Sheets

The responses spreadsheet also has three tabs that recalculate automatically with formulas, so they stay current with new submissions and with dates filled in on *Tanggal Bukti*:

- **Rekap per Periode**: per person, for Mei–Jun, Jul–Agu, Sep–Okt, Nov–Des and all periods (Lari, Jalan, Sepeda, total km, kalori), with totals on row 5.
- **Rekap per Bulan**: per person per month, total km and kalori.
- **Data Rekap**: one row per form answer with the category, value, proof date used, status and period. The two tabs above are built from it.

They were created by `buatSheetRekap()`. To rebuild them (for example after changing `NAME_FIX`), use **Dashboard GESIT → Buat ulang tab rekap**.

## Updating the code later

After editing `Code.gs`: **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The `/exec` URL stays the same, so `index.html` doesn't need changing.

## Rules the dashboard applies

- **Kilometres and calories are separate.** Lari, Jalan Kaki and Bersepeda are summed as km; All Sport is summed as kcal.
- **Wrong-column entries follow the numbers.** If the category is a km one but the number was entered in the calorie field (rows 46 and 55), it counts as calories.
- **Name spellings are merged.** Spellings that differ only in capitalisation are combined automatically. Other variants are mapped in `NAME_FIX` at the top of `Code.gs` (currently Sheila → Sheilla Riesma Intani).
- **Duplicates are flagged, not removed.** Rows 138 and 113 look like duplicates of rows 100 and 110. They are still counted until you set *Dihitung?* to **Tidak**.
- **Period mapping is configurable.** To change the periods, edit `PERIODS` near the top of `index.html`.
