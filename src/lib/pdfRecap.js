import PDFDocument, { registerStdFonts } from 'pdfkit';
import Helvetica from 'pdfkit/standard-fonts/Helvetica';
import HelveticaBold from 'pdfkit/standard-fonts/HelveticaBold';

// Nécessaire dans le navigateur depuis pdfkit 0.20 : les polices standard ne
// sont plus embarquées automatiquement, il faut les enregistrer explicitement.
registerStdFonts(Helvetica, HelveticaBold);

function repartirLargeurs(doc, poids) {
  const total = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const somme = poids.reduce((a, b) => a + b, 0);
  return poids.map((p) => (p / somme) * total);
}

function dessinerTableau(doc, headers, rows, poids) {
  const startX = doc.page.margins.left;
  const colWidths = repartirLargeurs(doc, poids || headers.map(() => 1));
  const rowHeight = 18;
  let y = doc.y;
  const largeurTotale = colWidths.reduce((a, b) => a + b, 0);

  doc.rect(startX, y, largeurTotale, rowHeight).fill('#3f372c');
  doc.fillColor('#fff').fontSize(9);
  let x = startX;
  headers.forEach((h, i) => {
    doc.text(h, x + 4, y + 5, { width: colWidths[i] - 8 });
    x += colWidths[i];
  });
  y += rowHeight;

  doc.fontSize(9);
  rows.forEach((row, ri) => {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    if (ri % 2 === 1) doc.rect(startX, y, largeurTotale, rowHeight).fill('#f3efe6');
    doc.fillColor('#16130f');
    x = startX;
    row.forEach((cell, i) => {
      doc.text(String(cell), x + 4, y + 5, { width: colWidths[i] - 8 });
      x += colWidths[i];
    });
    y += rowHeight;
  });

  doc.x = startX;
  doc.y = y + 12;
}

/* Dessine la courbe densité (axe gauche) / température (axe droit) au-dessus
   de la position courante du document, façon graphique de suivi de fermentation. */
function dessinerCourbe(doc, points) {
  const densites = points.map((p) => p.densite).filter((v) => v !== null && v !== undefined);
  const temps = points.map((p) => p.temperature).filter((v) => v !== null && v !== undefined);
  if (densites.length < 2 && temps.length < 2) return;

  const startX = doc.page.margins.left;
  const largeur = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const hauteur = 130;
  const padGauche = 42, padDroit = 42;
  const plotX0 = startX + padGauche;
  const plotX1 = startX + largeur - padDroit;
  const plotW = plotX1 - plotX0;
  if (doc.y + hauteur + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  const top = doc.y;
  const bas = top + hauteur;

  const dMin = densites.length ? Math.min(...densites) : 0;
  const dMax = densites.length ? Math.max(...densites) : 1;
  const dPad = (dMax - dMin) * 0.1 || 1;
  const dLo = dMin - dPad, dHi = dMax + dPad;

  const tMin = temps.length ? Math.min(...temps) : 0;
  const tMax = temps.length ? Math.max(...temps) : 1;
  const tPad = (tMax - tMin) * 0.15 || 1;
  const tLo = tMin - tPad, tHi = tMax + tPad;

  const xFor = (i) => plotX0 + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const yForD = (v) => bas - ((v - dLo) / (dHi - dLo)) * hauteur;
  const yForT = (v) => bas - ((v - tLo) / (tHi - tLo)) * hauteur;

  doc.strokeColor('#d2c7b1').lineWidth(0.5);
  for (let g = 0; g <= 4; g++) {
    const y = top + (g / 4) * hauteur;
    doc.moveTo(plotX0, y).lineTo(plotX1, y).stroke();
  }

  const tracerCourbe = (cle, yFor, couleur) => {
    if (points.filter((p) => p[cle] !== null && p[cle] !== undefined).length < 2) return;
    doc.strokeColor(couleur).lineWidth(1.5);
    let enCours = false;
    points.forEach((p, i) => {
      if (p[cle] === null || p[cle] === undefined) { enCours = false; return; }
      const x = xFor(i), y = yFor(p[cle]);
      if (!enCours) { doc.moveTo(x, y); enCours = true; } else { doc.lineTo(x, y); }
    });
    doc.stroke();
    points.forEach((p, i) => {
      if (p[cle] === null || p[cle] === undefined) return;
      doc.circle(xFor(i), yFor(p[cle]), 1.6).fill(couleur);
    });
  };
  tracerCourbe('densite', yForD, '#8c2a37');
  tracerCourbe('temperature', yForT, '#5b7482');

  doc.fontSize(7);
  if (densites.length) {
    doc.fillColor('#8c2a37');
    doc.text(dHi.toFixed(3), startX, top - 2, { width: padGauche - 4, align: 'right' });
    doc.text(dLo.toFixed(3), startX, bas - 7, { width: padGauche - 4, align: 'right' });
  }
  if (temps.length) {
    doc.fillColor('#5b7482');
    doc.text(`${tHi.toFixed(1)}°C`, plotX1 + 4, top - 2, { width: padDroit - 4 });
    doc.text(`${tLo.toFixed(1)}°C`, plotX1 + 4, bas - 7, { width: padDroit - 4 });
  }

  doc.fontSize(7).fillColor('#7d6f5b');
  doc.text(points[0].label, plotX0, bas + 3, { width: 90 });
  doc.text(points[points.length - 1].label, plotX1 - 90, bas + 3, { width: 90, align: 'right' });

  doc.fontSize(8);
  doc.fillColor('#8c2a37').text('— Densité', startX, bas + 15, { width: 90 });
  doc.fillColor('#5b7482').text('— Température (°C)', startX + 90, bas + 15, { width: 150 });

  doc.x = startX;
  doc.y = bas + 32;
}

/* Génère le récap PDF (température, densité, produits ajoutés) d'un seul lot,
   utilisé à la fin de la vinification. Renvoie une Promise<Blob>. */
export function genererPdfCuve(lot, contenants, parcelles, cepages) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const morceaux = [];
    doc.on('data', (chunk) => morceaux.push(chunk));
    doc.on('end', () => resolve(new Blob(morceaux, { type: 'application/pdf' })));
    doc.on('error', reject);

    const aujourdhui = new Date().toLocaleDateString('fr-FR');
    const volume = (lot.contenants || []).reduce((s, c) => s + (Number(c.volume) || 0), 0);
    const contenantsNoms = (lot.contenants || [])
      .map((c) => (contenants[c.contenantId] ? contenants[c.contenantId].nom : '?'))
      .join(', ');
    const composition = (lot.composition || [])
      .map((c) => {
        const p = parcelles[c.parcelleId];
        const cep = p ? cepages[p.cepageId] : null;
        return `${Math.round(c.pct)} % ${cep ? cep.nom : '?'}`;
      })
      .join(' · ');

    doc.fontSize(18).fillColor('#16130f').text('Récap de vinification — fin de fermentation');
    doc.fontSize(10).fillColor('#7d6f5b').text(`Édité le ${aujourdhui}`);
    doc.moveDown(1);

    doc.fontSize(16).fillColor('#16130f').text(`${lot.code}${lot.nom ? ' — ' + lot.nom : ''}`);
    doc.fontSize(10).fillColor('#574c3d')
      .text(`Millésime ${lot.millesime || ''}${lot.appellation ? ' · ' + lot.appellation : ''}`)
      .text(`Contenant(s) : ${contenantsNoms || '—'} · Volume actuel : ${volume} hL`);
    if (composition) doc.text(`Composition : ${composition}`);
    doc.moveDown(0.6);

    const controles = (lot.operations || []).filter((o) => o.type === 'controle');
    const analyses = (lot.operations || []).filter(
      (o) => o.type === 'analyse' && o.valeurs && (o.valeurs.temperature !== undefined || o.valeurs.densite !== undefined)
    );
    const points = [
      ...controles.map((o) => ({ date: o.date, moment: o.moment, temperature: o.temperature, densite: o.densite })),
      ...analyses.map((o) => ({
        date: o.date, moment: 'analyse',
        temperature: o.valeurs.temperature !== undefined ? o.valeurs.temperature : null,
        densite: o.valeurs.densite !== undefined ? o.valeurs.densite : null,
      })),
    ]
      .sort((a, b) => (a.date + (a.moment || '')).localeCompare(b.date + (b.moment || '')))
      .map((p) => ({ ...p, label: `${p.date.slice(5)} ${p.moment === 'matin' ? 'M' : p.moment === 'soir' ? 'S' : ''}`.trim() }));

    doc.fontSize(12).fillColor('#16130f').text('Températures et densités', { underline: true });
    doc.moveDown(0.3);
    if (points.length === 0) {
      doc.fontSize(10).fillColor('#7d6f5b').text('Aucun relevé enregistré.');
      doc.moveDown(0.8);
    } else {
      dessinerCourbe(doc, points);
      dessinerTableau(
        doc,
        ['Date', 'Moment', 'Température (°C)', 'Densité'],
        points.map((p) => [
          p.date,
          p.moment === 'matin' ? 'Matin' : p.moment === 'soir' ? 'Soir' : p.moment === 'analyse' ? 'Analyse' : 'Contrôle',
          p.temperature !== null && p.temperature !== undefined ? p.temperature : '—',
          p.densite !== null && p.densite !== undefined ? p.densite : '—',
        ]),
        [1, 1, 1, 1]
      );
    }

    const ajouts = (lot.operations || [])
      .filter((o) => o.type === 'ajout')
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    doc.fontSize(12).fillColor('#16130f').text('Produits œnologiques ajoutés', { underline: true });
    doc.moveDown(0.3);
    if (ajouts.length === 0) {
      doc.fontSize(10).fillColor('#7d6f5b').text('Aucun produit ajouté.');
    } else {
      dessinerTableau(
        doc,
        ['Date', 'Produit', 'Quantité', 'N° lot fournisseur'],
        ajouts.map((o) => [
          o.date,
          o.produitNom || '—',
          `${o.quantite !== undefined ? o.quantite : ''} ${o.unite || ''}`.trim() || '—',
          o.numeroLotFournisseur || '—',
        ]),
        [1, 1.4, 1, 1.4]
      );
    }

    doc.end();
  });
}

/* Déclenche le téléchargement du PDF dans le navigateur */
export function telechargerBlob(blob, nomFichier) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomFichier;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
