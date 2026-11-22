// Erzeugt den Leistungsauftrag als Word-Datei (.docx), ohne Server.
// Aufbau wie das PDF: Formularseite(n) im Querformat, danach je Beleg eine Seite mit Bild.
// Benötigt JSZip (vendor/jszip.min.js) und ClaimPdf (pdf.js) für Formatierungs-Helfer.
(function () {
  const { fmtAmount, fmtDateShort, KINDS, counts } = window.ClaimPdf;
  const MONTHS_LONG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const x = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const BLUE = '0099DB', RED = 'D91A1A', GREY = '595959';
  // A4 quer, Ränder 1,27 cm
  const PAGE_W = 16838, PAGE_H = 11906, MARGIN = 720, USABLE_W = PAGE_W - 2 * MARGIN, USABLE_H = PAGE_H - 2 * MARGIN;
  const EMU_PER_TWIP = 635;

  function run(text, o = {}) {
    const props = [
      o.bold ? '<w:b/>' : '', o.underline ? '<w:u w:val="single"/>' : '',
      o.color ? `<w:color w:val="${o.color}"/>` : '', o.size ? `<w:sz w:val="${o.size * 2}"/><w:szCs w:val="${o.size * 2}"/>` : '',
    ].join('');
    return String(text ?? '').split('\n').map((t, i) => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${x(t)}</w:t></w:r>`).join('');
  }
  function para(content, o = {}) {
    const pPr = [
      o.pageBreak ? '<w:pageBreakBefore/>' : '', o.keepNext ? '<w:keepNext/>' : '',
      `<w:spacing w:before="${o.before || 0}" w:after="${o.after ?? 0}"/>`,
      o.align ? `<w:jc w:val="${o.align}"/>` : '',
    ].join('');
    return `<w:p><w:pPr>${pPr}</w:pPr>${content}</w:p>`;
  }
  const border = (v = 'single') => ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="${v}" w:sz="4" w:space="0" w:color="000000"/>`).join('');
  function table(widths, rows, o = {}) {
    const grid = widths.map(w => `<w:gridCol w:w="${w}"/>`).join('');
    const body = rows.map(r => `<w:tr>${r.header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${r.cells.map((c, i) => {
      const cc = typeof c === 'object' && c && !Array.isArray(c) && 'xml' in c ? c : { xml: para(run(c, { size: o.size || 9, bold: r.bold, color: r.color })) };
      const span = cc.span ? `<w:gridSpan w:val="${cc.span}"/>` : '';
      const w = cc.span ? widths.slice(i, i + cc.span).reduce((a, b) => a + b, 0) : widths[i];
      return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span}${cc.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${cc.fill}"/>` : ''}${cc.noBorder ? '<w:tcBorders>' + border('nil') + '</w:tcBorders>' : ''}</w:tcPr>${cc.xml}</w:tc>`;
    }).join('')}</w:tr>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${border(o.noBorders ? 'nil' : 'single')}</w:tblBorders><w:tblCellMar><w:left w:w="60" w:type="dxa"/><w:right w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
  }
  function image(rid, id, wEmu, hEmu, name) {
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${wEmu}" cy="${hEmu}"/><wp:docPr id="${id}" name="${x(name)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${x(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }
  const subLabel = (i, j, n) => n <= 1 ? String(i) : `${i}${String.fromCharCode(97 + j)}`;
  const belegLabel = (i, n) => n <= 1 ? String(i) : `${i}a-${String.fromCharCode(96 + n)}`;

  // loadImage(photoId, stampText) -> { bytes:Uint8Array, width, height } (JPEG) oder null bei PDF-Belegen
  async function build(settings, entries, loadImage) {
    const zip = new JSZip();
    const media = [];
    let docPrId = 1;
    const addMedia = (bytes, ext) => { const n = media.length + 1; media.push({ name: `image${n}.${ext}`, bytes }); return `rIdImg${n}`; };

    let b = '';
    // ---- Kopf ----
    const sv = settings;
    const left = para(run('Barmenia', { bold: true, size: 20, color: BLUE }))
      + para(run('Barmenia Krankenversicherung AG · Barmenia-Allee 1 · 42119 Wuppertal', { size: 8 }))
      + para(run(`Team Leistung Firmen- und Auslandsgeschäft · ${sv.empfaengerEmail || 'leistungs-service@weltpolice.com'}`, { size: 8 }), { after: 120 })
      + para(run('Leistungsauftrag zur Barmenia-Weltpolice', { size: 16, color: BLUE }), { after: 120 })
      + table([2600], [{ cells: ['Weltpolice Vertrags-Nr.'] }, { cells: [{ xml: para(run(sv.vertragsnr, { bold: true, size: 11 }), { align: 'center' }), fill: 'DCD6F7' }] }])
      + para(run('Die Felder bitte vollständig ausfüllen. Danke.', { size: 8 }));
    const right = table([1100, 3300], [
      { cells: [{ xml: para(run('Absender Name', { size: 8, bold: true })), noBorder: true }, { xml: para(run(sv.name, { size: 9 })) }] },
      { cells: [{ xml: para(run('Anschrift', { size: 8 })), noBorder: true }, { xml: para(run(sv.anschrift, { size: 9 })) }] },
      { cells: [{ xml: para(run('E-Mail', { size: 8 })), noBorder: true }, { xml: para(run(sv.email, { size: 9 })) }] },
    ]);
    b += table([USABLE_W - 4600, 4600], [{ cells: [{ xml: left, noBorder: true }, { xml: right + para(''), noBorder: true }] }], { noBorders: true });
    b += para('', { after: 80 });

    // ---- Tabelle ----
    const widths = [800, 3000, 1500, 3700, 2400];
    widths.push(USABLE_W - widths.reduce((a, c) => a + c, 0));
    const rows = [{ header: true, bold: true, cells: ['Beleg-Nr.', 'Name, Vorname der behandelten Person', 'Behandlungs-/ Bezugsdaten', 'Diagnosen', 'Rechnungsbetrag/ Währung', 'Anmerkung'] }];
    const totals = {}, kva = {};
    entries.forEach((e, idx) => {
      const items = e.belege.filter(bb => bb.amount != null);
      const amt = items.map((bb, j) => {
        const cur = bb.currency || 'IDR';
        if (counts(bb)) totals[cur] = (totals[cur] || 0) + bb.amount; else kva[cur] = (kva[cur] || 0) + bb.amount;
        const t = `${(KINDS[bb.kind] || KINDS.rechnung).prefix}${cur} ${fmtAmount(bb.amount)}${j < items.length - 1 && counts(bb) && counts(items[j + 1]) ? '+' : ''}`;
        return run(t, { size: 9, color: counts(bb) ? undefined : GREY });
      }).join('<w:r><w:br/></w:r>');
      rows.push({ cells: [{ xml: para(run(belegLabel(idx + 1, e.belege.length), { size: 9 }), { align: 'center' }) }, e.person, fmtDateShort(e.date), e.diagnose, { xml: para(amt) }, e.anmerkung] });
    });
    const tl = Object.entries(totals).map(([c, v]) => `${c} ${fmtAmount(v)}`).join('\n');
    rows.push({ bold: true, color: RED, cells: ['', 'Gesamt/TOTAL', '', '', tl, 'TOTAL'] });
    if (Object.keys(kva).length) rows.push({ bold: true, color: GREY, cells: ['', 'Kostenvoranschläge zur Genehmigung', '', 'nicht in der Summe enthalten', Object.entries(kva).map(([c, v]) => `KVA ${c} ${fmtAmount(v)}`).join('\n'), 'Bitte um Genehmigung'] });
    b += table(widths, rows);
    b += para('', { after: 120 });

    // ---- Einwilligung ----
    const cross = v => v ? '☒' : '☐';
    const consent = para(run('Schriftliche Informationen rund um meinen Leistungsanspruch sollen grundsätzlich vom Versicherer per E-Mail an die o. g. E-Mail-Adresse versendet werden.', { bold: true, size: 7 }))
      + para(run('Einwilligung zur E-Mail-Nutzung:', { bold: true, underline: true, size: 7 }))
      + para(run('Ich bin damit einverstanden, dass meine E-Mail-Adresse auch für vertragliche Zwecke, wie z. B. Leistungsabrechnungen, Arztbelege mit Gesundheitsangaben von der Barmenia Krankenversicherung AG genutzt wird. Der Versand von Informationen per E-Mail ist kein sicherer (verschlüsselter) Kommunikationsweg. Daher kann bei der unverschlüsselten E-Mail-Versendung eine Kenntnisnahme und Veränderung von Daten durch unberechtigte Dritte nicht mit letzter Sicherheit ausgeschlossen werden. In Kenntnis dieser Umstände erkläre ich mein Einverständnis mit der unverschlüsselten elektronischen Kommunikation und der Zusendung nicht verschlüsselter E-Mails durch die Barmenia Krankenversicherung AG. Diese Einwilligung kann ich jederzeit widerrufen.', { bold: true, size: 7 }))
      + para(run('Achtung: Wird dieses Feld nicht angekreuzt und der Leistungsauftrag nicht als Zustimmung zum E-Mail-Versand von der/den versicherte/n Person/en, für die Leistungen hiermit beantragt werden, unterschrieben, erfolgt der Versand alleine auf dem Postweg.', { size: 7 }));
    b += table([700, USABLE_W - 700], [
      { cells: [{ xml: para(run(cross(sv.emailEinwilligung !== false), { size: 16 }), { align: 'center' }) }, { xml: consent }] },
      { cells: [{ span: 2, xml: para(run('Bitte beachten: Die Barmenia haftet nicht für Datenverluste oder Zugriff unberechtigter Dritter. Mit Ihrem ausdrücklichen Wunsch des E-Mail-Versandes akzeptieren Sie diese Bedingungen.', { size: 7, color: BLUE }), { align: 'center' }) }] },
    ]);

    // ---- Konto / Unterschrift / Reise ----
    let sig = '';
    if (sv.signature) {
      try {
        const bytes = Uint8Array.from(atob(sv.signature.split(',')[1]), c => c.charCodeAt(0));
        const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = sv.signature; });
        const wE = 1800 * EMU_PER_TWIP, hE = Math.round(wE * im.height / im.width);
        sig = para(image(addMedia(bytes, 'png'), docPrId++, wE, Math.min(hE, 600 * EMU_PER_TWIP), 'Unterschrift'));
      } catch (e) { console.warn(e); }
    }
    const d = new Date();
    const konto = table([1100, 3400], [['Inhaber:', sv.kontoInhaber], ['Bank:', sv.bank], ['Kto-Nr.:', sv.kontoNr], ['BLZ/BIC:', sv.bic], ['IBAN:', sv.iban]].map(r => ({ cells: r })));
    const mid = para(run('Ich bevorzuge eine Kommunikation auf', { size: 8 }), { align: 'center' })
      + para(run(`${cross((sv.sprache || 'deutsch') === 'deutsch')} deutsch        ${cross(sv.sprache === 'englisch')} englisch`, { size: 9 }), { align: 'center', after: 120 })
      + sig + para(run(`${sv.ort ? sv.ort + ', ' : ''}${d.getDate()}. ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`, { size: 9 }))
      + para(run('Ort, Datum, Unterschrift der versicherten Person/en', { size: 7 }));
    const reise = para(run('Nur bei Reisen unter 90 Tagen:', { bold: true, size: 8 }))
      + para(run(`Reisezeit (von/bis): ${sv.reisezeit || ''}`, { size: 8 })) + para(run(`Einsatzland: ${sv.einsatzland || ''}`, { size: 8 }), { after: 400 })
      + para(run('Stempel, Unterschrift des Arbeitgebers', { size: 7 }));
    const c1 = 4700, c3 = 3800;
    b += table([c1, USABLE_W - c1 - c3, c3], [{ cells: [
      { xml: para(run('Bitte erstatten Sie auf folgendes Konto:', { bold: true, size: 8 })) + konto + para('') },
      { xml: mid }, { xml: reise },
    ] }]);

    // ---- Belege ----
    const sect = (orient) => orient === 'landscape'
      ? `<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}" w:orient="landscape"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="300" w:footer="300" w:gutter="0"/></w:sectPr>`
      : `<w:sectPr><w:pgSz w:w="${PAGE_H}" w:h="${PAGE_W}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="300" w:footer="300" w:gutter="0"/></w:sectPr>`;
    // Formularteil endet mit einer Querformat-Sektion; Belege im Hochformat
    b += `<w:p><w:pPr>${sect('landscape')}</w:pPr></w:p>`;
    const pdfOnly = [];
    let first = true;
    for (let idx = 0; idx < entries.length; idx++) {
      const e = entries[idx];
      for (let j = 0; j < e.belege.length; j++) {
        const bb = e.belege[j];
        const nr = subLabel(idx + 1, j, e.belege.length);
        const kind = bb.kind && bb.kind !== 'rechnung' ? `${KINDS[bb.kind].label}  |  ` : '';
        const cap = `${kind}${e.person}  |  ${fmtDateShort(e.date)}  |  ${e.diagnose || ''}${bb.amount != null ? '  |  ' + (bb.currency || 'IDR') + ' ' + fmtAmount(bb.amount) : ''}`;
        const head = para(run(`BELEG-NR. ${nr}   `, { bold: true, size: 14, color: RED }) + run(cap, { bold: true, size: 9 }), { pageBreak: !first, keepNext: true, after: 120 });
        first = false;
        const img = await loadImage(bb.photoId, nr);
        if (!img) {
          pdfOnly.push(nr);
          b += head + para(run(`Dieser Beleg liegt als separate PDF-Datei bei (Beleg ${nr}).`, { size: 10 }));
          continue;
        }
        const maxW = (PAGE_H - 2 * MARGIN) * EMU_PER_TWIP, maxH = (PAGE_W - 2 * MARGIN - 700) * EMU_PER_TWIP;
        const sc = Math.min(maxW / img.width, maxH / img.height);
        b += head + para(image(addMedia(img.bytes, 'jpeg'), docPrId++, Math.round(img.width * sc), Math.round(img.height * sc), `Beleg ${nr}`), { align: 'center' });
      }
    }

    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${b}${sect(entries.length ? 'portrait' : 'landscape')}</w:body></w:document>`;

    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
    zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Leistungsauftrag zur Barmenia-Weltpolice</dc:title><dc:creator>${x(sv.name)}</dc:creator></cp:coreProperties>`);
    zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="18"/><w:szCs w:val="18"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`);
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${media.map((m, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')}</Relationships>`);
    zip.file('word/document.xml', docXml);
    media.forEach(m => zip.file(`word/media/${m.name}`, m.bytes));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    return { blob, pdfOnly };
  }

  window.ClaimDocx = { build };
})();
