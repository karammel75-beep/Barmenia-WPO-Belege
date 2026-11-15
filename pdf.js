// Erzeugt den "Leistungsauftrag zur Barmenia-Weltpolice" als PDF (A4 quer)
// plus alle Belege als Folgeseiten. Nutzt pdf-lib (vendor/pdf-lib.min.js).
(function () {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;

  const BLUE = rgb(0, 0.6, 0.86);
  const BLACK = rgb(0, 0, 0);
  const GREY = rgb(0.35, 0.35, 0.35);
  const RED = rgb(0.85, 0.1, 0.1);
  const LAVENDER = rgb(0.86, 0.84, 0.97);
  const PW = 842, PH = 595, M = 28, W = PW - 2 * M;

  // Art eines Belegs: normale Rechnung, Kostenvoranschlag (zur Genehmigung, nicht in der Summe)
  // oder Anzahlung/Teilzahlung (zählt zur Summe).
  const KINDS = {
    rechnung: { label: 'Rechnung', prefix: '' },
    kva: { label: 'Kostenvoranschlag – Genehmigung erbeten', prefix: 'KVA ' },
    anzahlung: { label: 'Anzahlung / Teilzahlung', prefix: 'Anzahlung ' },
  };
  const counts = b => (b.kind || 'rechnung') !== 'kva';
  const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const MONTHS_LONG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

  function fmtDateShort(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}. ${MONTHS[+m - 1]} ${y.slice(2)}`;
  }
  function fmtDateLong(date) {
    return `${date.getDate()}. ${MONTHS_LONG[date.getMonth()]} ${date.getFullYear()}`;
  }
  function fmtAmount(n) {
    if (n == null || isNaN(n)) return '';
    const dec = Math.round(n * 100) % 100 !== 0;
    return n.toLocaleString('de-DE', { minimumFractionDigits: dec ? 2 : 0, maximumFractionDigits: 2 });
  }

  // Beleg-Nummern wie in der Vorlage: 7, 7a-b, 12a-d
  function belegLabel(i, count) {
    if (count <= 1) return String(i);
    return `${i}a-${String.fromCharCode(96 + count)}`;
  }
  function subLabel(i, j, count) {
    return count <= 1 ? String(i) : `${i}${String.fromCharCode(97 + j)}`;
  }

  function makeSanitizer(font) {
    const ok = new Set(font.getCharacterSet());
    const map = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '\t': ' ' };
    return s => Array.from(String(s ?? '')).map(c => (c === '\n' || ok.has(c.codePointAt(0))) ? c : (map[c] ?? '?')).join('');
  }

  function wrap(text, font, size, maxW) {
    const out = [];
    for (const para of String(text ?? '').split('\n')) {
      let line = '';
      for (const word of para.split(/ +/)) {
        const cand = line ? line + ' ' + word : word;
        if (font.widthOfTextAtSize(cand, size) <= maxW) { line = cand; continue; }
        if (line) out.push(line);
        // Wort zu lang: hart umbrechen
        let w = word;
        while (font.widthOfTextAtSize(w, size) > maxW && w.length > 1) {
          let k = w.length;
          while (k > 1 && font.widthOfTextAtSize(w.slice(0, k), size) > maxW) k--;
          out.push(w.slice(0, k)); w = w.slice(k);
        }
        line = w;
      }
      out.push(line);
    }
    return out;
  }

  const CONSENT_BOLD = 'Schriftliche Informationen rund um meinen Leistungsanspruch sollen grundsätzlich vom Versicherer per E-Mail an die o. g. E-Mail-Adresse versendet werden.';
  const CONSENT_HEAD = 'Einwilligung zur E-Mail-Nutzung:';
  const CONSENT_TEXT = 'Ich bin damit einverstanden, dass meine E-Mail-Adresse auch für vertragliche Zwecke, wie z. B. Leistungsabrechnungen, Arztbelege mit Gesundheitsangaben von der Barmenia Krankenversicherung AG genutzt wird. Der Versand von Informationen per E-Mail ist kein sicherer (verschlüsselter) Kommunikationsweg. Daher kann bei der unverschlüsselten E-Mail-Versendung eine Kenntnisnahme und Veränderung von Daten durch unberechtigte Dritte nicht mit letzter Sicherheit ausgeschlossen werden. In Kenntnis dieser Umstände erkläre ich mein Einverständnis mit der unverschlüsselten elektronischen Kommunikation und der Zusendung nicht verschlüsselter E-Mails durch die Barmenia Krankenversicherung AG. Diese Einwilligung kann ich jederzeit widerrufen.';
  const CONSENT_NOTE = 'Achtung: Wird dieses Feld nicht angekreuzt und der Leistungsauftrag nicht als Zustimmung zum E-Mail-Versand von der/den versicherte/n Person/en, für die Leistungen hiermit beantragt werden, unterschrieben, erfolgt der Versand alleine auf dem Postweg.';
  const BLUE_NOTE = 'Bitte beachten: Die Barmenia haftet nicht für Datenverluste oder Zugriff unberechtigter Dritter. Mit Ihrem ausdrücklichen Wunsch des E-Mail-Versandes akzeptieren Sie diese Bedingungen.';

  async function build(settings, entries, loadBlob) {
    const doc = await PDFDocument.create();
    const F = await doc.embedFont(StandardFonts.Helvetica);
    const FB = await doc.embedFont(StandardFonts.HelveticaBold);
    const S = makeSanitizer(F);
    const today = new Date();
    let signature = null;
    if (settings.signature) {
      try { signature = await doc.embedPng(await (await fetch(settings.signature)).arrayBuffer()); } catch (e) { console.warn(e); }
    }

    const txt = (p, s, x, y, o = {}) => p.drawText(S(s), { x, y, size: o.size || 9, font: o.bold ? FB : F, color: o.color || BLACK });
    const rect = (p, x, y, w, h, o = {}) => p.drawRectangle({ x, y, width: w, height: h, borderColor: o.noBorder ? undefined : (o.border || BLACK), borderWidth: o.noBorder ? 0 : (o.bw ?? 0.6), color: o.fill });
    const line = (p, x1, y1, x2, y2, t = 0.6, c = BLACK) => p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: c });
    const textRight = (p, s, xr, y, o = {}) => txt(p, s, xr - (o.bold ? FB : F).widthOfTextAtSize(S(s), o.size || 9), y, o);
    const textCenter = (p, s, xc, y, o = {}) => txt(p, s, xc - (o.bold ? FB : F).widthOfTextAtSize(S(s), o.size || 9) / 2, y, o);
    const cross = (p, x, y, s) => { line(p, x, y, x + s, y + s, 0.8); line(p, x, y + s, x + s, y, 0.8); };

    // ---------- Kopf ----------
    function drawHeader(p, pageNo, pageCount) {
      let y = PH - M - 8;
      txt(p, 'Barmenia', M, y - 6, { size: 22, bold: true, color: BLUE });
      ['Barmenia Krankenversicherung AG', 'Barmenia-Allee 1', '42119 Wuppertal'].forEach((s, i) => txt(p, s, 190, y - i * 11, { size: 8.5 }));
      ['Team Leistung Firmen- und Auslandsgeschäft', settings.empfaengerEmail || 'leistungs-service@weltpolice.com'].forEach((s, i) => txt(p, s, 400, y - 6 - i * 11, { size: 8.5 }));
      txt(p, 'Leistungsauftrag zur Barmenia-Weltpolice', M, PH - 100, { size: 16, color: BLUE });
      // Vertragsnummer
      const bx = M, by = PH - 152, bw = 180;
      rect(p, bx, by, bw, 32);
      line(p, bx, by + 16, bx + bw, by + 16);
      rect(p, bx + 0.5, by + 0.5, bw - 1, 15, { fill: LAVENDER, noBorder: true });
      textCenter(p, 'Weltpolice Vertrags-Nr.', bx + bw / 2, by + 20.5, { size: 8.5 });
      textCenter(p, settings.vertragsnr || '', bx + bw / 2, by + 4, { size: 11, bold: true });
      txt(p, 'Die Felder bitte vollständig ausfüllen. Danke.', bx + bw + 8, by + 4, { size: 8.5 });
      if (pageCount > 1) textRight(p, `Seite ${pageNo} von ${pageCount}`, PW - M, PH - M + 6, { size: 7, color: GREY });
      // Absender
      const ax = 592, aTop = PH - 62, aw = PW - M - ax, ah = 104, aBot = aTop - ah;
      rect(p, ax, aBot, aw, ah);
      textRight(p, 'Absender', ax - 32, aTop - 10, { size: 8.5, bold: true });
      textRight(p, 'Name', ax - 4, aTop - 10, { size: 8.5 });
      txt(p, settings.name || '', ax + 4, aTop - 10, { size: 8.5 });
      textRight(p, 'Anschrift', ax - 4, aTop - 24, { size: 8.5 });
      const addr = wrap(S(settings.anschrift || ''), F, 8.5, aw - 8).slice(0, 6);
      addr.forEach((s, i) => txt(p, s, ax + 4, aTop - 24 - i * 10.5, { size: 8.5 }));
      textRight(p, 'E-Mail', ax - 4, aBot + 5, { size: 8.5 });
      txt(p, settings.email || '', ax + 4, aBot + 5, { size: 8.5 });
    }

    // ---------- Fuß ----------
    const consentW = W - 40 - 14;
    const consentLines = [
      ...wrap(S(CONSENT_BOLD), FB, 6.8, consentW).map(s => ({ s, bold: true })),
      ...wrap(S(CONSENT_HEAD), FB, 6.8, consentW).map(s => ({ s, bold: true, underline: true })),
      ...wrap(S(CONSENT_TEXT), FB, 6.8, consentW).map(s => ({ s, bold: true })),
    ];
    const noteLines = wrap(S(CONSENT_NOTE), F, 6.8, consentW);
    const LH = 8.4;
    const bottomH = 90, blueH = 12;
    const consentH = consentLines.length * LH + 6 + noteLines.length * LH + 6;
    const FOOTER_TOP = M + bottomH + blueH + consentH;

    function drawFooter(p) {
      // Einwilligung
      const cy = M + bottomH + blueH;
      rect(p, M, cy, W, consentH);
      line(p, M + 40, cy, M + 40, cy + consentH);
      const noteTop = cy + noteLines.length * LH + 6;
      line(p, M + 40, noteTop, M + W, noteTop);
      rect(p, M + 13, noteTop + (consentH - (noteTop - cy)) / 2 - 7, 14, 14);
      if (settings.emailEinwilligung !== false) cross(p, M + 13, noteTop + (consentH - (noteTop - cy)) / 2 - 7, 14);
      let y = cy + consentH - 4 - 6.5;
      consentLines.forEach(l => {
        txt(p, l.s, M + 46, y, { size: 6.8, bold: l.bold });
        if (l.underline) line(p, M + 46, y - 1, M + 46 + FB.widthOfTextAtSize(l.s, 6.8), y - 1, 0.4);
        y -= LH;
      });
      y = noteTop - 4 - 6.5;
      noteLines.forEach(s => { txt(p, s, M + 46, y, { size: 6.8 }); y -= LH; });
      // blauer Hinweis
      rect(p, M, M + bottomH, W, blueH);
      textCenter(p, BLUE_NOTE, M + W / 2, M + bottomH + 3.5, { size: 6.8, color: BLUE });

      // Unterer Block: Konto | Kommunikation + Unterschrift | Reisen < 90 Tage
      const c1 = 270, c3 = 200, c2 = W - c1 - c3;
      const x1 = M, x2 = M + c1, x3 = M + c1 + c2, top = M + bottomH;
      rect(p, M, M, W, bottomH);
      line(p, x2, M, x2, top); line(p, x3, M, x3, top);
      // Konto
      const rh = 15;
      txt(p, 'Bitte erstatten Sie auf folgendes Konto:', x1 + 3, top - 11, { size: 8, bold: true });
      const k = [['Inhaber:', settings.kontoInhaber], ['Bank:', settings.bank], ['Kto-Nr.:', settings.kontoNr], ['BLZ/BIC:', settings.bic], ['IBAN:', settings.iban]];
      k.forEach(([l, v], i) => {
        const ry = top - 15 - (i + 1) * rh;
        line(p, x1, ry + rh, x2, ry + rh, 0.5);
        txt(p, l, x1 + 3, ry + 4, { size: 8 });
        txt(p, v || '', x1 + 58, ry + 4, { size: 9 });
      });
      line(p, x1 + 54, M, x1 + 54, top - 15, 0.5);
      // Kommunikation
      textCenter(p, 'Ich bevorzuge eine Kommunikation auf', x2 + c2 / 2, top - 11, { size: 8 });
      const lang = settings.sprache || 'deutsch';
      rect(p, x2 + 24, top - 32, 10, 10); if (lang === 'deutsch') cross(p, x2 + 24, top - 32, 10);
      txt(p, 'deutsch', x2 + 40, top - 30, { size: 8 });
      rect(p, x2 + c2 - 90, top - 32, 10, 10); if (lang === 'englisch') cross(p, x2 + c2 - 90, top - 32, 10);
      txt(p, 'englisch', x2 + c2 - 74, top - 30, { size: 8 });
      const ortDatum = `${settings.ort ? settings.ort + ', ' : ''}${fmtDateLong(today)}`;
      txt(p, ortDatum, x2 + 6, M + 22, { size: 9 });
      if (signature) {
        const maxW = 120, maxH = 40;
        const sc = Math.min(maxW / signature.width, maxH / signature.height);
        p.drawImage(signature, { x: x2 + c2 - maxW - 10, y: M + 13, width: signature.width * sc, height: signature.height * sc });
      }
      line(p, x2 + 4, M + 15, x3 - 4, M + 15, 0.4, GREY);
      txt(p, 'Ort, Datum, Unterschrift der versicherten Person/en', x2 + 6, M + 5, { size: 7.5 });
      // Reisen < 90 Tage
      txt(p, 'Nur bei Reisen unter 90 Tagen:', x3 + 3, top - 11, { size: 8, bold: true });
      line(p, x3, top - 15, x3 + c3, top - 15, 0.5);
      line(p, x3, top - 30, x3 + c3, top - 30, 0.5);
      line(p, x3, top - 45, x3 + c3, top - 45, 0.5);
      line(p, x3 + 80, top - 45, x3 + 80, top - 15, 0.5);
      txt(p, 'Reisezeit (von/bis):', x3 + 3, top - 26, { size: 7.5 });
      txt(p, settings.reisezeit || '', x3 + 84, top - 26, { size: 8 });
      txt(p, 'Einsatzland:', x3 + 3, top - 41, { size: 7.5 });
      txt(p, settings.einsatzland || '', x3 + 84, top - 41, { size: 8 });
      txt(p, 'Stempel, Unterschrift des Arbeitgebers', x3 + 3, M + 5, { size: 7.5 });
    }

    // ---------- Tabelle ----------
    const cols = [
      { t: 'Beleg-\nNr.', w: 40, a: 'c' },
      { t: 'Name, Vorname\nder behandelten Person', w: 170 },
      { t: 'Behandlungs-/\nBezugsdaten', w: 90 },
      { t: 'Diagnosen', w: 190 },
      { t: 'Rechnungsbetrag/\nWährung', w: 120 },
      { t: 'Anmerkung', w: 0 },
    ];
    cols[5].w = W - cols.slice(0, 5).reduce((a, c) => a + c.w, 0);
    const TS = 9, TLH = 11, PAD = 3;

    const totals = {}, kvaTotals = {};
    const rows = entries.map((e, idx) => {
      const n = idx + 1;
      const amountLines = [];
      const items = e.belege.filter(b => b.amount != null && !isNaN(b.amount));
      items.forEach((b, j) => {
        const cur = b.currency || settings.waehrung || 'IDR';
        const kind = KINDS[b.kind] || KINDS.rechnung;
        if (counts(b)) totals[cur] = (totals[cur] || 0) + b.amount;
        else kvaTotals[cur] = (kvaTotals[cur] || 0) + b.amount;
        const str = `${kind.prefix}${cur} ${fmtAmount(b.amount)}${j < items.length - 1 && counts(items[j + 1]) && counts(b) ? '+' : ''}`;
        wrap(S(str), F, TS, cols[4].w - 2 * PAD).forEach(l => amountLines.push(counts(b) ? l : { s: l, color: GREY }));
      });
      const cells = [belegLabel(n, e.belege.length), e.person, fmtDateShort(e.date), e.diagnose, null, e.anmerkung];
      const wrapped = cells.map((c, i) => i === 4 ? amountLines : wrap(S(c), F, TS, cols[i].w - 2 * PAD));
      const h = Math.max(...wrapped.map(l => l.length)) * TLH + 2 * PAD + 2;
      return { wrapped, h };
    });
    const headerWrapped = cols.map(c => c.t.split('\n'));
    const headerH = 2 * TLH + 2 * PAD + 2;
    const totalLines = Object.entries(totals).map(([c, v]) => `${c} ${fmtAmount(v)}`);
    let totalH = Math.max(1, totalLines.length) * TLH + 2 * PAD + 2;
    const kvaLines = Object.entries(kvaTotals).map(([c, v]) => `KVA ${c} ${fmtAmount(v)}`);
    const kvaH = kvaLines.length ? Math.max(2, kvaLines.length) * TLH + 2 * PAD + 2 : 0;
    totalH += kvaH;
    const TABLE_TOP = PH - 166;
    const avail = TABLE_TOP - FOOTER_TOP - 6;

    // Seiten aufteilen
    const pages = [[]];
    let used = headerH;
    rows.forEach(r => {
      if (used + r.h > avail && pages[pages.length - 1].length) { pages.push([]); used = headerH; }
      pages[pages.length - 1].push(r); used += r.h;
    });
    let totalOnNewPage = used + totalH > avail;
    if (totalOnNewPage) pages.push([]);

    function drawRow(p, y, cellsLines, h, o = {}) {
      let x = M;
      cols.forEach((c, i) => {
        rect(p, x, y - h, c.w, h, { fill: o.fill });
        const lines = cellsLines[i] || [];
        lines.forEach((s, k) => {
          const ty = y - PAD - TS - k * TLH + 1;
          let color = o.colors ? o.colors[i] : BLACK;
          if (s && typeof s === 'object') { color = s.color; s = s.s; }
          const style = { size: TS, bold: o.bold, color };
          if (c.a === 'c' || o.center) textCenter(p, s, x + c.w / 2, ty, style);
          else txt(p, s, x + PAD, ty, style);
        });
        x += c.w;
      });
      return y - h;
    }

    pages.forEach((pr, pi) => {
      const p = doc.addPage([PW, PH]);
      drawHeader(p, pi + 1, pages.length);
      drawFooter(p);
      let y = TABLE_TOP;
      y = drawRow(p, y, headerWrapped, headerH, { bold: true, center: true });
      pr.forEach(r => { y = drawRow(p, y, r.wrapped, r.h); });
      if (pi === pages.length - 1) {
        y = drawRow(p, y, ['', ['Gesamt/TOTAL'], '', '', totalLines, ['TOTAL']], totalH - kvaH,
          { bold: true, colors: [RED, RED, RED, RED, RED, RED] });
        if (kvaH) drawRow(p, y, ['', ['Kostenvoranschläge', 'zur Genehmigung'], '', ['nicht in der Summe enthalten'], kvaLines, ['Bitte um Genehmigung']], kvaH,
          { bold: true, colors: [GREY, GREY, GREY, GREY, GREY, GREY] });
      }
    });

    // ---------- Belege anhängen ----------
    for (let idx = 0; idx < entries.length; idx++) {
      const e = entries[idx];
      for (let j = 0; j < e.belege.length; j++) {
        const b = e.belege[j];
        const kindTxt = (b.kind && b.kind !== 'rechnung') ? `${KINDS[b.kind].label}  |  ` : '';
        const label = `${kindTxt}Beleg ${subLabel(idx + 1, j, e.belege.length)}  |  ${e.person}  |  ${fmtDateShort(e.date)}  |  ${e.diagnose || ''}${b.amount != null ? '  |  ' + (b.currency || 'IDR') + ' ' + fmtAmount(b.amount) : ''}`;
        const nr = subLabel(idx + 1, j, e.belege.length);
        const stamp = (pg, xr, yt) => {
          const big = 26, sw = Math.max(FB.widthOfTextAtSize(nr, big), FB.widthOfTextAtSize('BELEG-NR.', 8)) + 20, sh = 48;
          pg.drawRectangle({ x: xr - sw, y: yt - sh, width: sw, height: sh, color: rgb(1, 1, 1), opacity: 0.9, borderColor: RED, borderWidth: 2.5 });
          const cx = xr - sw / 2;
          pg.drawText('BELEG-NR.', { x: cx - FB.widthOfTextAtSize('BELEG-NR.', 8) / 2, y: yt - 13, size: 8, font: FB, color: RED });
          pg.drawText(nr, { x: cx - FB.widthOfTextAtSize(nr, big) / 2, y: yt - sh + 8, size: big, font: FB, color: RED });
        };
        const blob = await loadBlob(b.photoId);
        if (!blob) continue;
        const bytes = await blob.arrayBuffer();
        if ((b.type || blob.type) === 'application/pdf') {
          try {
            const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
            const copied = await doc.copyPages(src, src.getPageIndices());
            copied.forEach(cp => {
              doc.addPage(cp);
              const { width, height } = cp.getSize();
              cp.drawRectangle({ x: 0, y: height - 18, width, height: 18, color: rgb(1, 1, 1), opacity: 0.85 });
              cp.drawText(S(label), { x: 10, y: height - 13, size: 8, font: FB });
              stamp(cp, width - 14, height - 24);
            });
          } catch (err) { console.warn('PDF-Beleg konnte nicht gelesen werden', err); }
          continue;
        }
        let img;
        try { img = (blob.type === 'image/png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes); }
        catch (err) { console.warn(err); continue; }
        const landscape = img.width > img.height * 1.15;
        const pw = landscape ? 842 : 595, ph = landscape ? 595 : 842;
        const p = doc.addPage([pw, ph]);
        txt(p, label, 24, ph - 24, { size: 9, bold: true });
        const mw = pw - 48, mh = ph - 60;
        const sc = Math.min(mw / img.width, mh / img.height);
        const w = img.width * sc, h = img.height * sc;
        p.drawImage(img, { x: (pw - w) / 2, y: 24 + (mh - h) / 2, width: w, height: h });
        stamp(p, (pw + w) / 2 - 8, 24 + (mh + h) / 2 - 8);
      }
    }

    doc.setTitle('Leistungsauftrag zur Barmenia-Weltpolice');
    doc.setAuthor(S(settings.name || ''));
    return await doc.save();
  }

  function fileName(entries) {
    const ds = entries.map(e => e.date).filter(Boolean).sort();
    if (!ds.length) return 'Barmenia_Abrechnung.pdf';
    const a = ds[0].split('-'), b = ds[ds.length - 1].split('-');
    const ma = MONTHS[+a[1] - 1].replace('ä', 'ae'), mb = MONTHS[+b[1] - 1].replace('ä', 'ae');
    const range = a[0] === b[0] ? (ma === mb ? `${ma}_${a[0].slice(2)}` : `${ma}-${mb}_${b[0].slice(2)}`) : `${ma}_${a[0].slice(2)}-${mb}_${b[0].slice(2)}`;
    return `Barmenia_Abrechnung_${range}.pdf`;
  }

  window.ClaimPdf = { build, fileName, fmtAmount, fmtDateShort, KINDS, counts };
})();
