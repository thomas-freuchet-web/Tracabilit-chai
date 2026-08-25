import PDFDocument, { registerStdFonts } from 'pdfkit';
import Helvetica from 'pdfkit/standard-fonts/Helvetica';
import HelveticaBold from 'pdfkit/standard-fonts/HelveticaBold';
import { dessinerTableau } from './pdfRecap';

registerStdFonts(Helvetica, HelveticaBold);

function nouvelleSection(doc, titre) {
  if (doc.y > doc.page.height - doc.page.margins.bottom - 80) doc.addPage();
  doc.fontSize(13).fillColor('#16130f').text(titre, { underline: true });
  doc.moveDown(0.3);
}

/* Génère un PDF imprimable du registre réglementaire complet (entrées de
   vendange + un tableau par type de manipulation FGVB), à classer à côté des
   exports Excel. Renvoie une Promise<Blob>. */
export function genererPdfRegistre(domaine, lots, parcelles, cepages, contenants, manipTypes) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const morceaux = [];
    doc.on('data', (chunk) => morceaux.push(chunk));
    doc.on('end', () => resolve(new Blob(morceaux, { type: 'application/pdf' })));
    doc.on('error', reject);

    const nomContenant = (id) => (contenants[id] ? contenants[id].nom : '—');
    const aujourdhui = new Date().toLocaleDateString('fr-FR');

    doc.fontSize(18).fillColor('#16130f').text('Registre unique de manipulations');
    doc.fontSize(11).fillColor('#574c3d').text(domaine.nom || '');
    doc.fontSize(9).fillColor('#7d6f5b')
      .text(`N° CVI/EVV : ${domaine.cvi || '—'}`)
      .text(`Exploitant : ${domaine.exploitant || '—'}`)
      .text(`Édité le ${aujourdhui}`);
    doc.moveDown(1);

    const apports = [];
    Object.values(lots).forEach((l) => {
      (l.operations || []).filter((o) => o.type === 'apport').forEach((o) => apports.push({ ...o, _lot: l }));
    });

    nouvelleSection(doc, `Entrées de vendange (${apports.length})`);
    if (apports.length === 0) {
      doc.fontSize(10).fillColor('#7d6f5b').text('Aucun apport enregistré.');
      doc.moveDown(0.8);
    } else {
      dessinerTableau(
        doc,
        ['Date', 'Parcelle', 'Cépage', 'N° cuve', 'Volume', 'Lot'],
        apports.sort((a, b) => a.date.localeCompare(b.date)).map((o) => {
          const p = parcelles[o.parcelleId];
          const cep = p ? cepages[p.cepageId] : null;
          return [o.date, p ? p.nom : '—', cep ? cep.nom : '—', nomContenant(o.contenantId), `${o.volume} hL`, o._lot.code];
        }),
        [1, 1.3, 1.1, 1, 0.8, 1]
      );
    }

    Object.keys(manipTypes).forEach((type) => {
      const liste = [];
      Object.values(lots).forEach((l) => {
        (l.operations || []).filter((o) => o.type === 'manipulation' && o.manipType === type).forEach((o) => liste.push({ ...o, _lot: l }));
      });
      if (!liste.length) return;
      nouvelleSection(doc, `${manipTypes[type].label} (${liste.length})`);
      doc.fontSize(8).fillColor('#a0632f').text(`Délai réglementaire : ${manipTypes[type].delai}`);
      doc.moveDown(0.2);
      dessinerTableau(
        doc,
        ['Date', 'Lot', 'Contenant', 'Produit', 'Quantité', 'Volume'],
        liste.sort((a, b) => a.date.localeCompare(b.date)).map((o) => [
          o.date, o._lot.code, nomContenant(o.contenantId), o.produit || '—',
          o.quantiteProduit || '—', o.volumeConcerne ? `${o.volumeConcerne} hL` : '—',
        ]),
        [0.8, 0.9, 1, 1.3, 0.8, 0.8]
      );
    });

    doc.end();
  });
}
