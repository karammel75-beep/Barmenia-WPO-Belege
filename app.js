'use strict';
// Weltpolice Belege – alle Daten bleiben lokal in IndexedDB auf dem Gerät.

// ---------- Vorschläge ----------
const ANMERKUNG_VORSCHLAEGE = [
  'Arztbesuch', 'Arztbesuch und Medikamente', 'Facharztbesuch', 'Kontrolluntersuchung',
  'Medikamente (Apotheke)', 'Laboruntersuchung', 'Röntgen / Ultraschall', 'MRT / CT',
  'Notaufnahme', 'Krankenhaus ambulant', 'Krankenhaus stationär',
  'Wundbehandlung und Naht', 'Verbandwechsel & Wundbehandlung', 'Fäden ziehen und Wundbehandlung',
  'Zahnarzt', 'Zahnreinigung (Prophylaxe)', 'Kariesbehandlung / Füllung', 'Inlay', 'Wurzelbehandlung',
  'Zahnextraktion', 'Zahnorthopäde', 'Zahnspange Kostenvoranschlag',
  'Kostenvoranschlag – Bitte um Genehmigung', 'Anzahlung (Teilbetrag) laut Kostenvoranschlag',
  'Kostenvoranschlag mit Anzahlung – Bitte um Genehmigung und Erstattung der Anzahlung', 'Restzahlung laut genehmigtem Kostenvoranschlag',
  'Augenarzt und Neuverschreibung', 'Brille / Kontaktlinsen',
  'Physiotherapie (ärztlich verordnet)', 'Impfung', 'Vorsorgeuntersuchung', 'Hilfsmittel', 'Krankentransport',
];
const DIAGNOSE_VORSCHLAEGE = [
  'Erkältung / grippaler Infekt', 'Halsschmerzen', 'Fieber', 'Husten / Bronchitis', 'Ohrenschmerzen',
  'Magen-Darm-Infekt', 'Durchfall', 'Hautausschlag', 'Allergie', 'Insektenstich', 'Dengue-Verdacht',
  'Rückenschmerzen', 'Kopfschmerzen / Migräne', 'Unfall mit Verletzung', 'Nachbehandlung Verletzung',
  'Zahnarztbesuch – Karies', 'Zahnarztbesuch – Zahnschmerzen', 'Zahnreinigung', 'Schiefe Zähne',
  'Kontrolle Sicht und Augen', 'Bindehautentzündung', 'Vorsorge / Check-up', 'Impfung',
];
const WAEHRUNGEN = ['IDR', 'EUR', 'USD', 'SGD', 'THB', 'MYR', 'AUD', 'CHF', 'GBP'];

// ---------- IndexedDB ----------
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('weltpolice-belege', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('kv');
        d.createObjectStore('entries', { keyPath: 'id' });
        d.createObjectStore('files', { keyPath: 'id' });
        d.createObjectStore('claims', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => res(out && 'result' in out ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  return {
    get: (store, key) => tx(store, 'readonly', s => s.get(key)),
    all: (store) => tx(store, 'readonly', s => s.getAll()),
    put: (store, val, key) => tx(store, 'readwrite', s => key === undefined ? s.put(val) : s.put(val, key)),
    del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
  };
})();

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayIso = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const { fmtAmount, fmtDateShort, KINDS, counts } = window.ClaimPdf;
// Summe je Währung; Kostenvoranschläge zählen nicht mit.
function sumBelege(belege, pred = counts) {
  const by = {};
  belege.forEach(b => { if (b.amount != null && pred(b)) by[b.currency || 'IDR'] = (by[b.currency || 'IDR'] || 0) + b.amount; });
  return by;
}
const fmtSums = by => Object.entries(by).map(([c, v]) => `${c} ${fmtAmount(v)}`).join(' + ');

function parseAmount(s) {
  s = String(s ?? '').replace(/[^\d.,-]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- Einstellungen ----------
const DEFAULT_SETTINGS = {
  vertragsnr: '', name: '', anschrift: '', email: '',
  personen: '', kontoInhaber: '', bank: '', kontoNr: '', bic: '', iban: '',
  sprache: 'deutsch', emailEinwilligung: true, ort: '', reisezeit: '', einsatzland: '',
  waehrung: 'IDR', empfaengerEmail: 'leistungs-service@weltpolice.com', signature: '',
};
async function getSettings() { return { ...DEFAULT_SETTINGS, ...(await DB.get('kv', 'settings') || {}) }; }
async function saveSettings(s) { await DB.put('kv', s, 'settings'); }
const personList = s => s.personen.split('\n').map(x => x.trim()).filter(Boolean);

// ---------- Bilder ----------
async function compressImage(file) {
  const maxSide = 2000;
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch {
    bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  }
  const w0 = bmp.width, h0 = bmp.height, sc = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas'); c.width = Math.round(w0 * sc); c.height = Math.round(h0 * sc);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
  const t = document.createElement('canvas'); const ts = 200 / Math.max(c.width, c.height);
  t.width = Math.round(c.width * ts); t.height = Math.round(c.height * ts);
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  return { blob, thumb: t.toDataURL('image/jpeg', 0.7) };
}
async function storeFile(file) {
  const id = uid();
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    await DB.put('files', { id, blob: new Blob([await file.arrayBuffer()], { type: 'application/pdf' }), type: 'application/pdf', thumb: '' });
    return { photoId: id, type: 'application/pdf' };
  }
  const { blob, thumb } = await compressImage(file);
  await DB.put('files', { id, blob, type: 'image/jpeg', thumb });
  return { photoId: id, type: 'image/jpeg' };
}
async function fileRec(id) { return DB.get('files', id); }

// ---------- Navigation ----------
let currentTab = 'belege';
let belegFilter = 'offen';
document.querySelectorAll('nav button').forEach(b => b.onclick = () => go(b.dataset.tab));
function go(tab) {
  currentTab = tab;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo(0, 0);
  ({ belege: renderBelege, abrechnen: renderAbrechnen, archiv: renderArchiv, einstellungen: renderSettings })[tab]();
}
function setHeader(title, actionHtml = '') { $('#title').textContent = title; $('#headAction').innerHTML = actionHtml; }

function entryTotalText(e) {
  const paid = fmtSums(sumBelege(e.belege));
  const kva = fmtSums(sumBelege(e.belege, b => !counts(b)));
  return [paid, kva && `KVA ${kva}`].filter(Boolean).join(' · ') || '–';
}
async function entryCard(e) {
  const f = e.belege[0] ? await fileRec(e.belege[0].photoId) : null;
  const img = f && f.thumb ? `<img src="${f.thumb}" alt="">` : `<div class="thumbph">${f ? 'PDF' : '–'}</div>`;
  return `<div class="card entry" data-id="${e.id}">${img}
    <div class="t"><b>${esc(e.person || 'Ohne Person')}</b>
      <div class="small">${esc(fmtDateShort(e.date))} · ${esc(e.diagnose || 'keine Diagnose')}</div>
      <div class="small">${esc(e.anmerkung || '')}${e.belege.length > 1 ? ` · ${e.belege.length} Belege` : ''}</div></div>
    <div><div class="amount">${esc(entryTotalText(e))}</div><div style="text-align:right;margin-top:4px">${e.belege.some(b => b.kind === 'kva') ? '<span class="badge">KVA</span> ' : ''}<span class="badge ${e.status}">${e.status}</span></div></div></div>`;
}

// ---------- Dateien übernehmen (Auswahl, Zwischenablage, Teilen) ----------
async function newEntryFromFiles(files) {
  files = files.filter(f => f && (/^image\//.test(f.type) || f.type === 'application/pdf' || /\.(pdf|jpe?g|png|heic)$/i.test(f.name || '')));
  if (!files.length) { toast('Keine Bilder oder PDFs gefunden'); return; }
  toast('Beleg wird geladen …');
  const s = await getSettings();
  const belege = [];
  for (const f of files) belege.push({ ...(await storeFile(f)), amount: null, currency: s.waehrung, kind: 'rechnung' });
  editEntry({ id: uid(), person: personList(s)[0] || '', date: todayIso(), diagnose: '', anmerkung: '', belege, status: 'offen', isNew: true });
}
async function filesFromClipboard() {
  const out = [];
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(t => t === 'application/pdf') || item.types.find(t => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      out.push(new File([blob], `Anhang-${Date.now()}.${type === 'application/pdf' ? 'pdf' : type.split('/')[1]}`, { type }));
    }
  } catch (e) { console.warn(e); }
  if (!out.length) alert('In der Zwischenablage ist kein Bild oder PDF. In der Mail das Bild gedrückt halten und „Kopieren“ wählen, dann hier erneut tippen. PDF-Anhänge bitte über „In Dateien sichern“ übernehmen.');
  return out;
}
// Einfügen per Tastatur (z. B. am Computer): Strg/Cmd+V auf der Belegliste
document.addEventListener('paste', ev => {
  if (currentTab !== 'belege' || !$('#mailHint')) return;
  const files = [...(ev.clipboardData?.files || [])];
  if (files.length) { ev.preventDefault(); newEntryFromFiles(files); }
});
// Über das Teilen-Menü (Android) empfangene Dateien abholen
async function takeSharedFiles() {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('shared-inbox');
    const keys = await cache.keys();
    if (!keys.length) return;
    const files = [];
    for (const k of keys) {
      const r = await cache.match(k);
      const blob = await r.blob();
      files.push(new File([blob], decodeURIComponent(r.headers.get('X-Name') || 'Anhang'), { type: blob.type }));
      await cache.delete(k);
    }
    history.replaceState(null, '', location.pathname);
    await newEntryFromFiles(files);
  } catch (e) { console.warn(e); }
}

// ---------- Tab: Belege ----------
async function renderBelege() {
  setHeader('Belege', `<button class="iconbtn" id="addBtn" aria-label="Neuer Beleg">+</button>
    <input type="file" id="quickAdd" accept="image/*,application/pdf" multiple hidden>`);
  $('#addBtn').onclick = () => $('#quickAdd').click();
  $('#quickAdd').onchange = ev => newEntryFromFiles([...ev.target.files]);
  const all = (await DB.all('entries')).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const list = belegFilter === 'alle' ? all : all.filter(e => e.status === belegFilter);
  const counts = { offen: 0, eingereicht: 0, erstattet: 0 }; all.forEach(e => counts[e.status]++);
  const s = await getSettings();
  let html = '';
  if (!s.name || !s.vertragsnr) html += `<div class="hint">Bitte zuerst unter <a href="#" id="toSettings">Einstellungen</a> Vertragsnummer, Absender und Konto eintragen (oder eine Einrichtungsdatei laden).</div>`;
  html += `<details class="hint" id="mailHint"><summary><b>📎 Anhang aus einer E-Mail übernehmen</b></summary>
    <p><b>Weg 1 (PDF oder Bild):</b> In der Mail-App den Anhang antippen → Teilen-Symbol → <b>„In Dateien sichern“</b>. Dann hier auf <b>+</b> → <b>„Datei auswählen“</b> und den Anhang wählen.</p>
    <p><b>Weg 2 (Bild):</b> In der Mail das Bild gedrückt halten → <b>„Kopieren“</b>. Dann hier auf <b>Einfügen</b> tippen.</p>
    <p class="small">Auf Android-Handys erscheint die App zusätzlich direkt im Teilen-Menü.</p>
    <button class="btn" id="pasteBtn">Aus Zwischenablage einfügen</button></details>`;
  html += `<div class="filter">${['offen', 'eingereicht', 'erstattet', 'alle'].map(f => `<button data-f="${f}" class="${f === belegFilter ? 'on' : ''}">${f[0].toUpperCase() + f.slice(1)}${f !== 'alle' ? ` (${counts[f]})` : ''}</button>`).join('')}</div>`;
  if (!list.length) html += `<div class="empty">${belegFilter === 'offen' ? 'Noch keine offenen Belege.<br><br>Tippe oben auf <b>+</b>, um eine Rechnung zu fotografieren oder aus deinen Fotos zu wählen.' : 'Keine Belege in dieser Ansicht.'}</div>`;
  for (const e of list) html += await entryCard(e);
  $('#view').innerHTML = html;
  $('#pasteBtn').onclick = async () => { const f = await filesFromClipboard(); if (f.length) newEntryFromFiles(f); };
  const ts = $('#toSettings'); if (ts) ts.onclick = ev => { ev.preventDefault(); go('einstellungen'); };
  document.querySelectorAll('.filter button').forEach(b => b.onclick = () => { belegFilter = b.dataset.f; renderBelege(); });
  document.querySelectorAll('.entry').forEach(el => el.onclick = async () => editEntry(await DB.get('entries', el.dataset.id)));
}

function suggestSelect(id, options, used) {
  const extra = used.filter(u => !options.includes(u));
  const opt = arr => arr.map(o => `<option>${esc(o)}</option>`).join('');
  return `<select class="suggest" id="${id}"><option value="">▾ Vorschlag wählen …</option>
    ${extra.length ? `<optgroup label="Zuletzt verwendet">${opt(extra)}</optgroup>` : ''}
    <optgroup label="Vorschläge">${opt(options)}</optgroup></select>`;
}

async function editEntry(e) {
  const s = await getSettings();
  const persons = personList(s);
  if (e.person && !persons.includes(e.person)) persons.push(e.person);
  const all = await DB.all('entries');
  const used = k => [...new Set(all.map(x => x[k]).filter(Boolean))].sort();
  const locked = e.status !== 'offen';
  setHeader(e.isNew ? 'Neuer Beleg' : 'Beleg bearbeiten', '');
  const personField = persons.length
    ? `<select id="fPerson">${persons.map(p => `<option ${p === e.person ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>`
    : `<input id="fPerson" value="${esc(e.person)}" placeholder="Name, Vorname">`;
  $('#view').innerHTML = `
    ${locked ? `<div class="hint">Dieser Beleg ist bereits <b>${e.status}</b>.</div>` : ''}
    <div class="card">
      <label>Behandelte Person</label>${personField}
      <label>Behandlungs-/Bezugsdatum</label><input type="date" id="fDate" value="${esc(e.date)}">
      <label>Diagnose</label><input id="fDiag" value="${esc(e.diagnose)}" placeholder="z. B. HNO – Halsschmerzen">
      ${suggestSelect('sDiag', DIAGNOSE_VORSCHLAEGE, used('diagnose'))}
      <label>Anmerkung (Art der Leistung)</label><input id="fAnm" value="${esc(e.anmerkung)}" placeholder="z. B. Arztbesuch und Medikamente">
      ${suggestSelect('sAnm', ANMERKUNG_VORSCHLAEGE, used('anmerkung'))}
    </div>
    <div class="card">
      <b>Belege / Rechnungen</b>
      <div class="small">Mehrere Rechnungen zum selben Arztbesuch (z. B. Arzt + Apotheke) hier zusammen erfassen, jeweils mit Betrag. Bei einem Kostenvoranschlag mit Anzahlung beide Belege hier erfassen: den Voranschlag als „Kostenvoranschlag“ (zählt nicht zur Summe) und die Quittung als „Anzahlung“.</div>
      <div class="photos" id="photos"></div>
      <div class="addrow">
        <label class="btn secondary">+ Weiteres Foto / PDF<input type="file" id="addFile" accept="image/*,application/pdf" multiple></label>
        <button class="btn secondary" id="pasteMore" style="flex:0 0 auto;width:auto;margin:0">Einfügen</button>
      </div>
    </div>
    <button class="btn" id="save">Speichern</button>
    <button class="btn secondary" id="cancel">Abbrechen</button>
    ${e.status !== 'offen' ? `<button class="btn secondary" id="reopen">Wieder auf „offen“ setzen</button>` : ''}
    ${e.isNew ? '' : `<button class="btn danger" id="del">Beleg löschen</button>`}`;

  const bind = (sel, inp) => $(sel).onchange = ev => { if (ev.target.value) { $(inp).value = ev.target.value; ev.target.value = ''; } };
  bind('#sDiag', '#fDiag'); bind('#sAnm', '#fAnm');

  async function renderPhotos() {
    let h = '';
    for (const [i, b] of e.belege.entries()) {
      const f = await fileRec(b.photoId);
      const vis = f && f.thumb ? `<img src="${f.thumb}" data-open="${i}" alt="Beleg">` : `<div class="pdf" data-open="${i}">PDF</div>`;
      h += `<div class="photo">${vis}<div class="in"><div class="small" style="margin-bottom:6px">Rechnung ${i + 1} · Foto antippen zum Vergrößern</div>
        <select data-kind="${i}" style="margin-bottom:8px">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${(b.kind || 'rechnung') === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
        <div class="row"><select data-cur="${i}">${[...new Set([b.currency || s.waehrung, ...WAEHRUNGEN])].map(c => `<option ${c === b.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <input inputmode="decimal" data-amt="${i}" placeholder="Betrag" value="${b.amount != null ? esc(fmtAmount(b.amount)) : ''}"></div>
        <button class="rm" data-rm="${i}">Entfernen</button></div></div>`;
    }
    $('#photos').innerHTML = h || '<div class="small" style="padding:10px 0">Noch kein Foto.</div>';
    document.querySelectorAll('[data-amt]').forEach(inp => inp.onchange = () => {
      const v = parseAmount(inp.value); e.belege[+inp.dataset.amt].amount = v; inp.value = v != null ? fmtAmount(v) : '';
    });
    document.querySelectorAll('[data-kind]').forEach(sel => sel.onchange = () => {
      e.belege[+sel.dataset.kind].kind = sel.value;
      const anm = $('#fAnm');
      if (!anm.value && sel.value === 'kva') anm.value = 'Kostenvoranschlag – Bitte um Genehmigung';
      if (!anm.value && sel.value === 'anzahlung') anm.value = 'Anzahlung (Teilbetrag) laut Kostenvoranschlag';
    });
    document.querySelectorAll('[data-cur]').forEach(sel => sel.onchange = () => e.belege[+sel.dataset.cur].currency = sel.value);
    document.querySelectorAll('[data-rm]').forEach(btn => btn.onclick = async () => {
      if (!confirm('Dieses Foto entfernen?')) return;
      const [b] = e.belege.splice(+btn.dataset.rm, 1); if (e.isNew) await DB.del('files', b.photoId); else e._removed = [...(e._removed || []), b.photoId];
      renderPhotos();
    });
    document.querySelectorAll('[data-open]').forEach(el => el.onclick = async () => {
      const f = await fileRec(e.belege[+el.dataset.open].photoId); if (f) window.open(URL.createObjectURL(f.blob), '_blank');
    });
  }
  renderPhotos();
  $('#pasteMore').onclick = async () => {
    for (const f of await filesFromClipboard()) e.belege.push({ ...(await storeFile(f)), amount: null, currency: s.waehrung, kind: 'rechnung' });
    renderPhotos();
  };
  $('#addFile').onchange = async ev => {
    for (const f of ev.target.files) e.belege.push({ ...(await storeFile(f)), amount: null, currency: s.waehrung });
    ev.target.value = ''; renderPhotos();
  };
  $('#save').onclick = async () => {
    document.querySelectorAll('[data-amt]').forEach(inp => e.belege[+inp.dataset.amt].amount = parseAmount(inp.value));
    e.person = $('#fPerson').value.trim(); e.date = $('#fDate').value; e.diagnose = $('#fDiag').value.trim(); e.anmerkung = $('#fAnm').value.trim();
    if (!e.belege.length) return alert('Bitte mindestens ein Foto oder PDF der Rechnung hinzufügen.');
    if (!e.person) return alert('Bitte die behandelte Person angeben.');
    if (e.belege.some(b => b.amount == null) && !confirm('Bei mindestens einem Beleg fehlt der Betrag. Trotzdem speichern?')) return;
    for (const id of e._removed || []) await DB.del('files', id);
    delete e._removed; delete e.isNew;
    await DB.put('entries', e); toast('Gespeichert'); go('belege');
takeSharedFiles();
  };
  $('#cancel').onclick = async () => { if (e.isNew) for (const b of e.belege) await DB.del('files', b.photoId); go('belege'); };
  const ro = $('#reopen'); if (ro) ro.onclick = async () => { e.status = 'offen'; delete e.claimId; await DB.put('entries', e); toast('Wieder offen'); editEntry(e); };
  const del = $('#del'); if (del) del.onclick = async () => {
    if (!confirm('Beleg mit allen Fotos endgültig löschen?')) return;
    for (const b of e.belege) await DB.del('files', b.photoId);
    await DB.del('entries', e.id); toast('Gelöscht'); go('belege');
takeSharedFiles();
  };
}

// ---------- Tab: Abrechnen ----------
async function makePdf(entries) {
  const s = await getSettings();
  const bytes = await window.ClaimPdf.build(s, entries, async id => (await fileRec(id))?.blob);
  const name = window.ClaimPdf.fileName(entries);
  return new File([bytes], name, { type: 'application/pdf' });
}
async function sharePdf(file, s) {
  const text = `Sehr geehrte Damen und Herren,\n\nanbei sende ich Ihnen den Leistungsauftrag zur Barmenia-Weltpolice (Vertrags-Nr. ${s.vertragsnr}) mit den zugehörigen Belegen.\n\nMit freundlichen Grüßen\n${s.name}`;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name, text }); return true; }
    catch (err) { if (err.name === 'AbortError') return false; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  return true;
}
function sortByDate(list) { return list.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.person || '').localeCompare(b.person || '')); }

async function renderAbrechnen() {
  setHeader('Abrechnen');
  const s = await getSettings();
  const open = sortByDate((await DB.all('entries')).filter(e => e.status === 'offen'));
  if (!open.length) { $('#view').innerHTML = `<div class="empty">Keine offenen Belege.<br><br>Erfasse zuerst Belege im Tab „Belege“.</div>`; return; }
  const sel = new Set(open.map(e => e.id));
  $('#view').innerHTML = `
    <div class="card"><b>Diese Belege in den Leistungsauftrag aufnehmen:</b>
      <div id="chkList">${open.map(e => `<label class="chk"><input type="checkbox" data-id="${e.id}" checked>
        <div style="flex:1"><b style="color:var(--ink)">${esc(e.person)}</b> · ${esc(fmtDateShort(e.date))}<div class="small">${esc(e.diagnose)}${e.anmerkung ? ' · ' + esc(e.anmerkung) : ''}</div></div>
        <div class="amount" style="color:var(--ink)">${esc(entryTotalText(e))}</div></label>`).join('')}</div>
      <div class="total" id="sum"></div><div class="total small" id="sumKva" style="font-weight:400"></div></div>
    <button class="btn" id="mk">PDF erstellen</button>
    <div id="result"></div>`;
  const upd = () => {
    const bel = open.filter(e => sel.has(e.id)).flatMap(e => e.belege);
    const kva = fmtSums(sumBelege(bel, b => !counts(b)));
    $('#sum').innerHTML = `<span>Gesamt (${sel.size})</span><span>${fmtSums(sumBelege(bel)) || '–'}</span>`;
    $('#sumKva').innerHTML = kva ? `<span>Kostenvoranschläge (nicht in Summe)</span><span>${kva}</span>` : '';
    $('#mk').disabled = !sel.size;
  };
  document.querySelectorAll('#chkList input').forEach(c => c.onchange = () => { c.checked ? sel.add(c.dataset.id) : sel.delete(c.dataset.id); upd(); });
  upd();
  $('#mk').onclick = async () => {
    const chosen = open.filter(e => sel.has(e.id));
    $('#mk').disabled = true; $('#mk').textContent = 'PDF wird erstellt …';
    let file;
    try { file = await makePdf(chosen); }
    catch (err) { console.error(err); alert('Das PDF konnte nicht erstellt werden: ' + err.message); $('#mk').disabled = false; $('#mk').textContent = 'PDF erstellen'; return; }
    $('#mk').textContent = 'PDF neu erstellen'; $('#mk').disabled = false;
    const url = URL.createObjectURL(file);
    $('#result').innerHTML = `<div class="card"><b>${esc(file.name)}</b><div class="small">${(file.size / 1024 / 1024).toFixed(1)} MB · ${chosen.length} Positionen</div>
      <button class="btn secondary" id="viewPdf">PDF ansehen</button>
      <button class="btn" id="share">Teilen / per E-Mail senden</button>
      <div class="small" style="margin-top:10px">Empfänger: <b>${esc(s.empfaengerEmail)}</b> <a href="#" id="copyMail">kopieren</a></div>
      <button class="btn secondary" id="done">Als eingereicht markieren</button></div>`;
    $("#viewPdf").onclick = () => window.open(url, '_blank');
    $('#share').onclick = () => sharePdf(file, s);
    $('#copyMail').onclick = async ev => { ev.preventDefault(); try { await navigator.clipboard.writeText(s.empfaengerEmail); toast('E-Mail-Adresse kopiert'); } catch { toast(s.empfaengerEmail); } };
    $('#done').onclick = async () => {
      const claim = { id: uid(), created: new Date().toISOString(), entryIds: chosen.map(e => e.id), filename: file.name, status: 'eingereicht', totals: {} };
      claim.totals = sumBelege(chosen.flatMap(e => e.belege));
      await DB.put('claims', claim);
      for (const e of chosen) { e.status = 'eingereicht'; e.claimId = claim.id; await DB.put('entries', e); }
      toast('Als eingereicht markiert'); go('archiv');
    };
  };
}

// ---------- Tab: Archiv ----------
async function renderArchiv() {
  setHeader('Archiv');
  const claims = (await DB.all('claims')).sort((a, b) => b.created.localeCompare(a.created));
  if (!claims.length) { $('#view').innerHTML = `<div class="empty">Noch keine eingereichten Abrechnungen.</div>`; return; }
  $('#view').innerHTML = claims.map(c => `<div class="card">
      <div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(c.filename)}</b><span class="badge ${c.status}">${c.status}</span></div>
      <div class="small">Eingereicht am ${new Date(c.created).toLocaleDateString('de-DE')} · ${c.entryIds.length} Positionen · ${Object.entries(c.totals).map(([k, v]) => `${k} ${fmtAmount(v)}`).join(' + ')}</div>
      <div class="row"><button class="btn secondary" data-pdf="${c.id}">PDF erneut erstellen</button>
      ${c.status === 'eingereicht' ? `<button class="btn" data-paid="${c.id}">Erstattet ✓</button>` : ''}</div></div>`).join('');
  document.querySelectorAll('[data-pdf]').forEach(b => b.onclick = async () => {
    const c = claims.find(x => x.id === b.dataset.pdf);
    const entries = sortByDate((await Promise.all(c.entryIds.map(id => DB.get('entries', id)))).filter(Boolean));
    b.textContent = 'Wird erstellt …';
    const file = await makePdf(entries); b.textContent = 'PDF erneut erstellen';
    await sharePdf(file, await getSettings());
  });
  document.querySelectorAll('[data-paid]').forEach(b => b.onclick = async () => {
    const c = claims.find(x => x.id === b.dataset.paid); c.status = 'erstattet'; await DB.put('claims', c);
    for (const id of c.entryIds) { const e = await DB.get('entries', id); if (e) { e.status = 'erstattet'; await DB.put('entries', e); } }
    toast('Als erstattet markiert'); renderArchiv();
  });
}

// ---------- Tab: Einstellungen ----------
async function renderSettings() {
  setHeader('Einstellungen');
  const s = await getSettings();
  const f = (k, l, o = {}) => `<label>${l}</label>${o.area ? `<textarea id="s_${k}" placeholder="${esc(o.ph || '')}">${esc(s[k])}</textarea>` : `<input id="s_${k}" value="${esc(s[k])}" placeholder="${esc(o.ph || '')}" ${o.attrs || ''}>`}`;
  $('#view').innerHTML = `
    <h2>Vertrag & Absender</h2><div class="card">
      ${f('vertragsnr', 'Weltpolice Vertrags-Nr.')}
      ${f('name', 'Absender Name')}
      ${f('anschrift', 'Anschrift (mehrzeilig)', { area: true })}
      ${f('email', 'E-Mail', { attrs: 'type="email" autocapitalize="off"' })}
      ${f('personen', 'Versicherte Personen (eine pro Zeile, „Vorname Nachname“)', { area: true })}
    </div>
    <h2>Konto für die Erstattung</h2><div class="card">
      ${f('kontoInhaber', 'Inhaber')}${f('bank', 'Bank')}${f('kontoNr', 'Kto-Nr.')}${f('bic', 'BLZ/BIC', { attrs: 'autocapitalize="characters"' })}${f('iban', 'IBAN', { attrs: 'autocapitalize="characters"' })}
    </div>
    <h2>Formular</h2><div class="card">
      <label>Kommunikation auf</label><select id="s_sprache"><option ${s.sprache === 'deutsch' ? 'selected' : ''}>deutsch</option><option ${s.sprache === 'englisch' ? 'selected' : ''}>englisch</option></select>
      <label class="chk" style="color:var(--ink);font-size:15px"><input type="checkbox" id="s_emailEinwilligung" ${s.emailEinwilligung !== false ? 'checked' : ''}> Einwilligung zur E-Mail-Nutzung ankreuzen</label>
      ${f('ort', 'Ort für „Ort, Datum, Unterschrift“', { ph: 'z. B. Jakarta' })}
      <label>Standardwährung</label><select id="s_waehrung">${WAEHRUNGEN.map(c => `<option ${c === s.waehrung ? 'selected' : ''}>${c}</option>`).join('')}</select>
      ${f('reisezeit', 'Nur bei Reisen unter 90 Tagen: Reisezeit (von/bis)')}
      ${f('einsatzland', 'Nur bei Reisen unter 90 Tagen: Einsatzland')}
      ${f('empfaengerEmail', 'E-Mail-Adresse der Barmenia', { attrs: 'type="email" autocapitalize="off"' })}
    </div>
    <h2>Unterschrift</h2><div class="card">
      <div class="small">Mit dem Finger unterschreiben. Sie wird in jedes PDF eingesetzt.</div>
      <canvas class="sig" id="sig"></canvas>
      <div class="row"><button class="btn secondary" id="sigClear">Löschen</button></div>
    </div>
    <button class="btn" id="saveS">Einstellungen speichern</button>
    <h2>Sicherung & zweites Handy</h2><div class="card">
      <div class="small">Alle Daten liegen nur auf diesem Handy. Mit einer Sicherung kannst du sie aufbewahren oder per AirDrop aufs Handy deines Partners übertragen. Einrichtungsdateien (nur Einstellungen) lädst du hier ebenfalls.</div>
      <button class="btn secondary" id="exp">Sicherung erstellen (mit Fotos)</button>
      <button class="btn secondary" id="expS">Nur Einstellungen exportieren</button>
      <label class="btn secondary" style="color:var(--ink)">Sicherung / Einrichtung laden<input type="file" id="imp" accept="application/json,.json" hidden></label>
    </div>
    <div class="small" style="text-align:center;margin:20px 0">Weltpolice Belege · Daten bleiben lokal auf dem Gerät</div>`;

  // Unterschrift
  const cv = $('#sig'); const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  ctx.scale(dpr, dpr); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0b2a6b';
  let sigData = s.signature, drawing = false, dirty = false;
  if (sigData) { const im = new Image(); im.onload = () => ctx.drawImage(im, 0, 0, cv.clientWidth, cv.clientHeight); im.src = sigData; }
  const pos = ev => { const r = cv.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  cv.onpointerdown = ev => { drawing = true; dirty = true; cv.setPointerCapture(ev.pointerId); ctx.beginPath(); ctx.moveTo(...pos(ev)); };
  cv.onpointermove = ev => { if (!drawing) return; ctx.lineTo(...pos(ev)); ctx.stroke(); };
  cv.onpointerup = cv.onpointercancel = () => { drawing = false; };
  $('#sigClear').onclick = () => { ctx.clearRect(0, 0, cv.width, cv.height); sigData = ''; dirty = false; };

  $('#saveS').onclick = async () => {
    const n = { ...s };
    for (const k of Object.keys(DEFAULT_SETTINGS)) { const el = $('#s_' + k); if (el) n[k] = el.type === 'checkbox' ? el.checked : el.value.trim(); }
    n.iban = n.iban.replace(/\s+/g, '').toUpperCase();
    n.signature = dirty ? cv.toDataURL('image/png') : sigData;
    await saveSettings(n); toast('Einstellungen gespeichert');
  };
  $('#exp').onclick = () => exportBackup(true);
  $('#expS').onclick = () => exportBackup(false);
  $('#imp').onchange = async ev => { const f = ev.target.files[0]; if (f) await importBackup(f); ev.target.value = ''; };
}

const blobToB64 = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
async function exportBackup(full) {
  const data = { app: 'weltpolice-belege', version: 1, created: new Date().toISOString(), settings: await getSettings() };
  if (full) {
    data.entries = await DB.all('entries'); data.claims = await DB.all('claims');
    data.files = await Promise.all((await DB.all('files')).map(async f => ({ id: f.id, type: f.type, thumb: f.thumb, data: await blobToB64(f.blob) })));
  }
  const name = full ? `Belege-Sicherung_${todayIso()}.json` : `Belege-Einstellungen_${todayIso()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
}
async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return alert('Die Datei konnte nicht gelesen werden.'); }
  if (data.app !== 'weltpolice-belege') return alert('Das ist keine Sicherung dieser App.');
  const parts = [data.settings && 'Einstellungen', data.entries && `${data.entries.length} Belege`].filter(Boolean).join(' und ');
  if (!confirm(`${parts} laden? Vorhandene Einträge mit gleicher Kennung werden ersetzt, alles andere bleibt erhalten.`)) return;
  if (data.settings) {
    const cur = await getSettings();
    const ns = { ...cur, ...data.settings };
    if (!data.settings.signature && cur.signature) ns.signature = cur.signature;
    await saveSettings(ns);
  }
  for (const f of data.files || []) {
    const blob = await (await fetch(f.data)).blob();
    await DB.put('files', { id: f.id, type: f.type, thumb: f.thumb, blob });
  }
  for (const e of data.entries || []) await DB.put('entries', e);
  for (const c of data.claims || []) await DB.put('claims', c);
  toast('Geladen'); go(currentTab);
}

// ---------- Start ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
go('belege');
takeSharedFiles();
