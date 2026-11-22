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
  'Zahnarztbesuch – Karies', 'Zahnarztbesuch – Zahnschmerzen', 'Zahnreinigung', 'Kieferorthopädie',
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
// Fingerabdruck der Originaldatei, um doppelt erfasste Belege zu erkennen
async function fileHash(file) {
  try {
    const h = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(h)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}
async function storeFile(file) {
  const id = uid();
  const hash = await fileHash(file);
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    await DB.put('files', { id, blob: new Blob([await file.arrayBuffer()], { type: 'application/pdf' }), type: 'application/pdf', thumb: '' });
    return { photoId: id, type: 'application/pdf', hash };
  }
  const { blob, thumb } = await compressImage(file);
  await DB.put('files', { id, blob, type: 'image/jpeg', thumb });
  return { photoId: id, type: 'image/jpeg', hash };
}
// Sucht mögliche Doppel: gleiche Datei, oder gleiche Person + Datum + Betrag
async function findDuplicates(e) {
  const others = (await DB.all('entries')).filter(o => o.id !== e.id);
  const desc = o => `${o.person}, ${fmtDateShort(o.date)}, ${entryTotalText(o)} (${o.status})`;
  const msgs = [];
  const seen = new Set();
  e.belege.forEach((b, i) => {
    if (!b.hash) return;
    if (seen.has(b.hash)) msgs.push(`Rechnung ${i + 1} ist in diesem Beleg zweimal enthalten.`);
    seen.add(b.hash);
    const o = others.find(o => o.belege.some(x => x.hash === b.hash));
    if (o) msgs.push(`Rechnung ${i + 1} wurde schon einmal erfasst: ${desc(o)}.`);
  });
  const amounts = e.belege.filter(b => b.amount != null).map(b => `${b.currency}|${b.amount}`);
  others.filter(o => o.person === e.person && o.date === e.date && o.belege.some(x => x.amount != null && amounts.includes(`${x.currency}|${x.amount}`)))
    .forEach(o => { if (!msgs.some(m => m.includes(desc(o)))) msgs.push(`Gleiche Person, gleiches Datum und gleicher Betrag wie: ${desc(o)}.`); });
  return msgs;
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
    <div><div class="amount">${esc(entryTotalText(e))}</div><div style="text-align:right;margin-top:4px">${e.fromPartner ? '<span class="badge">Partner</span> ' : ''}${e.belege.some(b => b.kind === 'kva') ? '<span class="badge">KVA</span> ' : ''}<span class="badge ${e.status}">${e.status}</span></div></div></div>`;
}

// ---------- Dateien übernehmen (Auswahl, Zwischenablage, Teilen) ----------
async function newEntryFromFiles(files) {
  files = files.filter(f => f && (/^image\//.test(f.type) || f.type === 'application/pdf' || /\.(pdf|jpe?g|png|heic)$/i.test(f.name || '')));
  if (!files.length) { toast('Keine Bilder oder PDFs gefunden'); return; }
  toast('Beleg wird geladen …');
  const s = await getSettings();
  const belege = [];
  for (const f of files) belege.push({ ...(await storeFile(f)), amount: null, currency: s.waehrung, kind: 'rechnung' });
  const dups = (await findDuplicates({ id: '', person: '', date: '', belege })).filter(m => !m.startsWith('Gleiche'));
  if (dups.length) alert('⚠️ Achtung, möglicherweise doppelt:\n\n' + dups.join('\n'));
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
    const dups = await findDuplicates(e);
    if (dups.length && !confirm('⚠️ Möglicherweise doppelt:\n\n' + dups.join('\n') + '\n\nTrotzdem speichern?')) return;
    for (const id of e._removed || []) await DB.del('files', id);
    delete e._removed; delete e.isNew;
    await DB.put('entries', e); toast('Gespeichert'); go('belege');
  };
  $('#cancel').onclick = async () => { if (e.isNew) for (const b of e.belege) await DB.del('files', b.photoId); go('belege'); };
  const ro = $('#reopen'); if (ro) ro.onclick = async () => { e.status = 'offen'; delete e.claimId; await DB.put('entries', e); toast('Wieder offen'); editEntry(e); };
  const del = $('#del'); if (del) del.onclick = async () => {
    if (!confirm('Beleg mit allen Fotos endgültig löschen?')) return;
    for (const b of e.belege) await DB.del('files', b.photoId);
    await DB.del('entries', e.id); toast('Gelöscht'); go('belege');
  };
}

// ---------- Tab: Abrechnen ----------
// Größenstufen für den Versand: "klein" reicht zum Lesen der Belege und hält die Mail klein.
const QUALITY = { klein: { side: 1400, q: 0.6 }, hoch: { side: 2000, q: 0.8 } };
const pref = (k, d) => { try { return localStorage.getItem('pref_' + k) || d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('pref_' + k, v); } catch {} };

async function recompress(blob, quality, stamp) {
  const { side, q } = QUALITY[quality] || QUALITY.klein;
  const bmp = await createImageBitmap(blob);
  const sc = Math.min(1, side / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0, c.width, c.height);
  if (stamp) { // Beleg-Nummer als roter Stempel ins Bild (für Word)
    const fs = Math.max(28, Math.round(c.width / 18)), pad = fs * 0.35;
    ctx.font = `bold ${fs}px Arial, sans-serif`;
    const t = stamp, small = Math.round(fs * 0.36);
    const w = Math.max(ctx.measureText(t).width, fs * 2.6) + pad * 2, h = fs + small + pad * 2.2;
    const x = c.width - w - pad, y = pad;
    ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#d91a1a'; ctx.lineWidth = Math.max(3, fs / 10); ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#d91a1a'; ctx.textAlign = 'center';
    ctx.font = `bold ${small}px Arial, sans-serif`; ctx.fillText('BELEG-NR.', x + w / 2, y + pad + small);
    ctx.font = `bold ${fs}px Arial, sans-serif`; ctx.fillText(t, x + w / 2, y + pad * 1.4 + small + fs * 0.85);
  }
  const out = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
  return { blob: out, width: c.width, height: c.height };
}

// Erzeugt die gewünschten Dateien: format = pdf | docx | beides
async function makeFiles(entries, format, quality) {
  const s = await getSettings();
  const base = window.ClaimPdf.fileName(entries).replace(/\.pdf$/, '');
  const files = [];
  if (format === 'pdf' || format === 'beides') {
    const bytes = await window.ClaimPdf.build(s, entries, async id => {
      const f = await fileRec(id); if (!f) return null;
      return f.type === 'application/pdf' ? f.blob : (await recompress(f.blob, quality)).blob;
    });
    files.push(new File([bytes], base + '.pdf', { type: 'application/pdf' }));
  }
  if (format === 'docx' || format === 'beides') {
    const pdfAttach = [];
    const { blob } = await window.ClaimDocx.build(s, entries, async (id, nr) => {
      const f = await fileRec(id); if (!f) return null;
      if (f.type === 'application/pdf') { pdfAttach.push(new File([f.blob], `${base}_Beleg_${nr}.pdf`, { type: 'application/pdf' })); return null; }
      const r = await recompress(f.blob, quality, nr);
      return { bytes: new Uint8Array(await r.blob.arrayBuffer()), width: r.width, height: r.height };
    });
    files.push(new File([blob], base + '.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    // PDF-Belege kann Word nicht als Bild zeigen: sie gehen als eigene Dateien mit (nur wenn kein Gesamt-PDF dabei ist)
    if (format === 'docx') files.push(...pdfAttach);
  }
  return files;
}
async function shareFiles(files, s) {
  const text = `Sehr geehrte Damen und Herren,\n\nanbei sende ich Ihnen den Leistungsauftrag zur Barmenia-Weltpolice (Vertrags-Nr. ${s.vertragsnr}) mit den zugehörigen Belegen.\n\nMit freundlichen Grüßen\n${s.name}`;
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title: files[0].name, text }); return true; }
    catch (err) { if (err.name === 'AbortError') return false; }
  }
  for (const file of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); }
  return true;
}
const mb = n => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const segmented = (name, opts, cur) => `<div class="filter seg" data-seg="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
function bindSegmented(name, cb) {
  document.querySelectorAll(`[data-seg="${name}"] button`).forEach(b => b.onclick = () => {
    document.querySelectorAll(`[data-seg="${name}"] button`).forEach(x => x.classList.toggle('on', x === b));
    setPref(name, b.dataset.v); cb && cb(b.dataset.v);
  });
}
const FORMAT_OPTS = [['pdf', 'PDF'], ['docx', 'Word (.docx)'], ['beides', 'Beides']];
const QUALITY_OPTS = [['klein', 'Klein (für E-Mail)'], ['hoch', 'Hohe Qualität']];
const btnLabel = f => ({ pdf: 'PDF erstellen', docx: 'Word-Datei erstellen', beides: 'PDF und Word erstellen' })[f];

function sortByDate(list) { return list.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.person || '').localeCompare(b.person || '')); }

async function renderAbrechnen() {
  setHeader('Abrechnen');
  const s = await getSettings();
  const open = sortByDate((await DB.all('entries')).filter(e => e.status === 'offen'));
  const partnerCard = `<details class="hint" id="partnerBox"><summary><b>👥 Gemeinsam abrechnen (Belege vom Partner)</b></summary>
    <p><b>Handy A (schickt):</b> „Meine offenen Belege senden“ tippen und per <b>WhatsApp</b> oder <b>AirDrop</b> an Handy B schicken.</p>
    <p><b>Handy B (rechnet ab):</b> In WhatsApp die Datei antippen → Teilen-Symbol → <b>„In Dateien sichern“</b>. Dann hier <b>„Belege vom Partner übernehmen“</b> tippen und die Datei wählen. Die Belege kommen zu deinen dazu, doppelte werden übersprungen.</p>
    <button class="btn" id="sendPartner">Meine offenen Belege senden</button>
    <label class="btn secondary" style="color:var(--ink)">Belege vom Partner übernehmen<input type="file" id="impPartner" accept="application/json,.json,text/plain" hidden></label></details>`;
  const bindPartner = () => {
    $('#sendPartner').onclick = () => exportForPartner();
    $('#impPartner').onchange = async ev => { const f = ev.target.files[0]; if (f) await importPartner(f); ev.target.value = ''; };
  };
  if (!open.length) { $('#view').innerHTML = partnerCard + `<div class="empty">Keine offenen Belege.<br><br>Erfasse zuerst Belege im Tab „Belege“ oder übernimm die Belege deines Partners.</div>`; bindPartner(); return; }
  const sel = new Set(open.map(e => e.id));
  $('#view').innerHTML = partnerCard + `
    <div class="card"><b>Diese Belege in den Leistungsauftrag aufnehmen:</b>
      <div id="chkList">${open.map(e => `<label class="chk"><input type="checkbox" data-id="${e.id}" checked>
        <div style="flex:1"><b style="color:var(--ink)">${esc(e.person)}</b> · ${esc(fmtDateShort(e.date))}<div class="small">${esc(e.diagnose)}${e.anmerkung ? ' · ' + esc(e.anmerkung) : ''}${e.fromPartner ? ' · <b>vom Partner</b>' : ''}</div></div>
        <div class="amount" style="color:var(--ink)">${esc(entryTotalText(e))}</div></label>`).join('')}</div>
      <div class="total" id="sum"></div><div class="total small" id="sumKva" style="font-weight:400"></div></div>
    <div class="card"><b>Format</b>${segmented('format', FORMAT_OPTS, pref('format', 'pdf'))}
      <b style="display:block;margin-top:12px">Dateigröße</b>${segmented('quality', QUALITY_OPTS, pref('quality', 'klein'))}
      <div class="small" style="margin-top:6px">„Klein“ verkleinert die Belegfotos, sie bleiben gut lesbar. PDF öffnet jede Krankenkasse problemlos, Word nur, wenn ihr das Dokument noch bearbeiten wollt.</div></div>
    <button class="btn" id="mk">${btnLabel(pref('format', 'pdf'))}</button>
    <div id="result"></div>`;
  const upd = () => {
    const bel = open.filter(e => sel.has(e.id)).flatMap(e => e.belege);
    const kva = fmtSums(sumBelege(bel, b => !counts(b)));
    $('#sum').innerHTML = `<span>Gesamt (${sel.size})</span><span>${fmtSums(sumBelege(bel)) || '–'}</span>`;
    $('#sumKva').innerHTML = kva ? `<span>Kostenvoranschläge (nicht in Summe)</span><span>${kva}</span>` : '';
    $('#mk').disabled = !sel.size;
  };
  bindPartner();
  document.querySelectorAll('#chkList input').forEach(c => c.onchange = () => { c.checked ? sel.add(c.dataset.id) : sel.delete(c.dataset.id); upd(); });
  upd();
  bindSegmented('format', f => { $('#mk').textContent = btnLabel(f); $('#result').innerHTML = ''; });
  bindSegmented('quality', () => { $('#result').innerHTML = ''; });
  $('#mk').onclick = async () => {
    const chosen = open.filter(e => sel.has(e.id));
    const format = pref('format', 'pdf'), quality = pref('quality', 'klein');
    $('#mk').disabled = true; $('#mk').textContent = 'Wird erstellt …';
    let files;
    try { files = await makeFiles(chosen, format, quality); }
    catch (err) { console.error(err); alert('Das Dokument konnte nicht erstellt werden: ' + err.message); $('#mk').disabled = false; $('#mk').textContent = btnLabel(format); return; }
    $('#mk').textContent = 'Neu erstellen'; $('#mk').disabled = false;
    const total = files.reduce((a, f) => a + f.size, 0);
    $('#result').innerHTML = `<div class="card">${files.map((f, i) => `<div class="chk"><div style="flex:1"><b style="color:var(--ink)">${esc(f.name)}</b><div class="small">${mb(f.size)}</div></div><button class="btn secondary" data-open="${i}" style="width:auto;margin:0;padding:8px 14px">Ansehen</button></div>`).join('')}
      <div class="small">${files.length > 1 ? `Zusammen ${mb(total)} · ` : ''}${chosen.length} Positionen${total > 15 * 1024 * 1024 ? ' · <b>Achtung: recht groß für eine E-Mail, ggf. „Klein“ wählen oder aufteilen.</b>' : ''}</div>
      <button class="btn" id="share">Teilen / per E-Mail senden</button>
      <div class="small" style="margin-top:10px">Empfänger: <b>${esc(s.empfaengerEmail)}</b> <a href="#" id="copyMail">kopieren</a></div>
      <button class="btn secondary" id="done">Als eingereicht markieren</button></div>`;
    document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => window.open(URL.createObjectURL(files[+b.dataset.open]), '_blank'));
    $('#share').onclick = () => shareFiles(files, s);
    $('#copyMail').onclick = async ev => { ev.preventDefault(); try { await navigator.clipboard.writeText(s.empfaengerEmail); toast('E-Mail-Adresse kopiert'); } catch { toast(s.empfaengerEmail); } };
    $('#done').onclick = async () => {
      const claim = { id: uid(), created: new Date().toISOString(), entryIds: chosen.map(e => e.id), filename: files[0].name.replace(/\.(pdf|docx)$/, ''), status: 'eingereicht', totals: {} };
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
      <div class="row"><button class="btn secondary" data-pdf="${c.id}">Erneut erstellen</button>
      ${c.status === 'eingereicht' ? `<button class="btn" data-paid="${c.id}">Erstattet ✓</button>` : ''}</div></div>`).join('');
  document.querySelectorAll('[data-pdf]').forEach(b => b.onclick = async () => {
    const c = claims.find(x => x.id === b.dataset.pdf);
    const entries = sortByDate((await Promise.all(c.entryIds.map(id => DB.get('entries', id)))).filter(Boolean));
    b.textContent = 'Wird erstellt …';
    const files = await makeFiles(entries, pref('format', 'pdf'), pref('quality', 'klein')); b.textContent = 'Erneut erstellen';
    await shareFiles(files, await getSettings());
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
// ---------- Gemeinsam abrechnen: offene Belege an den Partner schicken ----------
async function exportForPartner() {
  const open = (await DB.all('entries')).filter(e => e.status === 'offen');
  if (!open.length) return alert('Auf diesem Handy gibt es keine offenen Belege zum Senden.');
  toast('Datei wird erstellt …');
  const files = [];
  for (const e of open) for (const b of e.belege) {
    const f = await fileRec(b.photoId); if (!f) continue;
    // Fotos für den Versand verkleinern, damit die Datei per WhatsApp gut durchgeht
    const blob = f.type === 'application/pdf' ? f.blob : (await recompress(f.blob, 'klein')).blob;
    files.push({ id: f.id, type: f.type, thumb: f.thumb, data: await blobToB64(blob) });
  }
  const data = { app: 'weltpolice-belege', version: 1, kind: 'partner', created: new Date().toISOString(), entries: open, files };
  const name = `Belege-fuer-Partner_${todayIso()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  let sent = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); sent = true; } catch (e) { if (e.name === 'AbortError') return; }
  }
  if (!sent) { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click(); }
  if (confirm(`${open.length} Belege (${mb(file.size)}) wurden zum Senden bereitgestellt.\n\nSollen sie auf diesem Handy als „eingereicht“ markiert werden, damit sie nicht doppelt abgerechnet werden?`)) {
    for (const e of open) { e.status = 'eingereicht'; e.sentToPartner = new Date().toISOString(); await DB.put('entries', e); }
    toast('Als eingereicht markiert'); go(currentTab);
  }
}
async function importPartner(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return alert('Die Datei konnte nicht gelesen werden.'); }
  if (data.app !== 'weltpolice-belege' || !Array.isArray(data.entries)) return alert('Das ist keine Beleg-Datei dieser App.');
  const existing = await DB.all('entries');
  const ids = new Set(existing.map(e => e.id));
  const hashes = new Set(existing.flatMap(e => e.belege.map(b => b.hash).filter(Boolean)));
  const key = e => `${e.person}|${e.date}|${e.belege.map(b => `${b.currency}:${b.amount}`).sort().join(',')}`;
  const keys = new Set(existing.map(key));
  const fileById = new Map((data.files || []).map(f => [f.id, f]));
  let added = 0, skipped = 0;
  for (const e of data.entries) {
    const dupByHash = e.belege.length && e.belege.every(b => b.hash && hashes.has(b.hash));
    if (ids.has(e.id) || dupByHash || keys.has(key(e))) { skipped++; continue; }
    for (const b of e.belege) {
      const f = fileById.get(b.photoId); if (!f) continue;
      await DB.put('files', { id: f.id, type: f.type, thumb: f.thumb, blob: await (await fetch(f.data)).blob() });
    }
    const ne = { ...e, status: 'offen', fromPartner: true }; delete ne.claimId;
    await DB.put('entries', ne);
    added++;
  }
  alert(`${added} Belege übernommen${skipped ? `, ${skipped} doppelte übersprungen` : ''}.`);
  go(currentTab);
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return alert('Die Datei konnte nicht gelesen werden.'); }
  if (data.app !== 'weltpolice-belege') return alert('Das ist keine Sicherung dieser App.');
  if (data.kind === 'partner') return importPartner(file);
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
