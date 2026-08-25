// Récap hebdomadaire des cuves en vinification (température, densité, produits
// ajoutés), généré en PDF et envoyé par email, accompagné d'une sauvegarde
// Excel complète du registre (indépendante de Supabase, en cas de besoin de
// restauration). Lancé chaque semaine par .github/workflows/rapport-hebdo.yml
// — jamais exécuté depuis le navigateur.
import { createClient } from '@supabase/supabase-js';
import PDFDocument from 'pdfkit';
import * as XLSX from 'xlsx';
import fs from 'fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const REPORT_EMAIL_TO = process.env.REPORT_EMAIL_TO;
const REPORT_EMAIL_FROM = process.env.REPORT_EMAIL_FROM || 'Cahier de Chai <onboarding@resend.dev>';

const PDF_PATH = '/tmp/recap-vinification.pdf';
const XLSX_PATH = '/tmp/cahier-de-chai-sauvegarde.xlsx';

const MANIP_LABELS = {
  enrichissement: 'Enrichissement', acidification: 'Acidification', desacidification: 'Désacidification',
  bois_chene: 'Bois de chêne', autres_produits: 'Autres produits', ferrocyanure: 'Ferrocyanure',
  coupage: 'Coupage 85-15',
};

/* Sauvegarde Excel complète du registre — hors Supabase, en pièce jointe de
   l'email hebdomadaire. Version simplifiée de l'export "Exporter tout en
   Excel" de l'application (un seul onglet Manipulations au lieu d'un onglet
   par type). */
function genererExcel({ domaine = {}, lieux = {}, contenants = {}, cepages = {}, parcelles = {}, produits = {}, lots = {}, conditionnements = [] }) {
  const wb = XLSX.utils.book_new();
  const nomContenant = (id) => (contenants[id] ? contenants[id].nom : '—');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['SAUVEGARDE HEBDOMADAIRE — CAHIER DE CHAI'],
    [domaine.nom || ''],
    [], ['N° CVI / EVV', domaine.cvi || ''], ['Exploitant', domaine.exploitant || ''],
    [], ['Éditée le', new Date().toISOString().slice(0, 10)],
  ]), 'Exploitation');

  const etat = [];
  Object.values(lots).filter((l) => l.statut !== 'archive').forEach((l) => {
    (l.contenants || []).forEach((c) => {
      etat.push({
        'Lot': l.code, 'Millésime': l.millesime, 'Appellation': l.appellation || '',
        'Phase': l.phase, 'Contenant': nomContenant(c.contenantId), 'Volume (hL)': c.volume,
      });
    });
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(etat), 'État de cave');

  const vendanges = [];
  Object.values(lots).forEach((l) => {
    (l.operations || []).filter((o) => o.type === 'apport').forEach((o) => {
      const parc = parcelles[o.parcelleId];
      const cep = parc ? cepages[parc.cepageId] : null;
      vendanges.push({
        'Date': o.date, 'Parcelle': parc ? parc.nom : '', 'Cépage': cep ? cep.nom : '',
        'N° cuve': nomContenant(o.contenantId), 'Volume (hL)': o.volume, 'Lot': l.code,
      });
    });
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vendanges), 'Entrées vendange');

  const manips = [];
  Object.values(lots).forEach((l) => {
    (l.operations || []).filter((o) => o.type === 'manipulation').forEach((o) => {
      manips.push({
        'Date': o.date, 'Type': MANIP_LABELS[o.manipType] || o.manipType, 'Lot': l.code,
        'Contenant': nomContenant(o.contenantId), 'Produit': o.produit || '', 'Quantité': o.quantiteProduit || '',
        'Volume concerné (hL)': o.volumeConcerne || '', 'Observations': o.notes || '',
      });
    });
  });
  if (manips.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(manips), 'Manipulations');

  const intrants = [];
  Object.values(lots).forEach((l) => {
    (l.operations || []).filter((o) => o.type === 'ajout').forEach((o) => {
      intrants.push({
        'Date': o.date, 'Lot': l.code, 'Contenant': nomContenant(o.contenantId), 'Produit': o.produitNom,
        'Quantité': o.quantite, 'Unité': o.unite || '', 'N° lot fournisseur': o.numeroLotFournisseur || '', 'DLUO': o.dluo || '',
      });
    });
  });
  if (intrants.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(intrants), 'Intrants');

  const stock = Object.values(produits).map((p) => ({
    'Produit': p.nom, 'Catégorie': p.categorie, 'Unité': p.unite,
    'Stock': (p.mouvements || []).reduce((s, m) => s + (m.sens === 'sortie' ? -m.quantite : m.quantite), 0),
    'Fournisseur': p.fournisseur || '',
  }));
  if (stock.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stock), 'Stock produits');

  if (conditionnements.length) {
    const cond = conditionnements.map((c) => ({
      'Date': c.date, 'N° de lot': c.numeroLot, 'Lot vin': c.lotCode, 'Désignation': c.designation || '',
      'Volume total (hL)': c.volumeHl,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cond), 'Conditionnement');
  }

  const releves = [];
  Object.values(lots).forEach((l) => {
    (l.operations || []).filter((o) => o.type === 'controle').forEach((o) => {
      releves.push({
        'Date': o.date, 'Moment': o.moment || '', 'Lot': l.code, 'Contenant': nomContenant(o.contenantId),
        'Température (°C)': o.temperature ?? '', 'Densité': o.densite ?? '',
      });
    });
  });
  if (releves.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(releves), 'Relevés T° densité');

  XLSX.writeFile(wb, XLSX_PATH);
}

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
    if (ri % 2 === 1) {
      doc.rect(startX, y, largeurTotale, rowHeight).fill('#f3efe6');
    }
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

function genererPDF({ lots, contenants, parcelles, cepages }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const stream = fs.createWriteStream(PDF_PATH);
    doc.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);

    const aujourdhui = new Date().toLocaleDateString('fr-FR');
    doc.fontSize(18).fillColor('#16130f').text('Récap hebdomadaire — Vinification en cours');
    doc.fontSize(10).fillColor('#7d6f5b').text(`Édité le ${aujourdhui}`);
    doc.moveDown(1.2);

    const enVinification = Object.values(lots || {})
      .filter((l) => l.statut !== 'archive' && l.phase === 'vinification')
      .sort((a, b) => (a.code || '').localeCompare(b.code || ''));

    if (enVinification.length === 0) {
      doc.fontSize(12).fillColor('#16130f').text('Aucune cuve en vinification actuellement.');
    }

    enVinification.forEach((lot, i) => {
      if (i > 0) doc.addPage();

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
      ].sort((a, b) => (a.date + (a.moment || '')).localeCompare(b.date + (b.moment || '')));

      doc.fontSize(12).fillColor('#16130f').text('Températures et densités', { underline: true });
      doc.moveDown(0.3);
      if (points.length === 0) {
        doc.fontSize(10).fillColor('#7d6f5b').text('Aucun relevé enregistré.');
        doc.moveDown(0.8);
      } else {
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
    });

    doc.end();
  });
}

async function envoyerEmail() {
  const pdfBuffer = fs.readFileSync(PDF_PATH);
  const xlsxBuffer = fs.readFileSync(XLSX_PATH);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: REPORT_EMAIL_FROM,
      to: [REPORT_EMAIL_TO],
      subject: `Récap vinification — semaine du ${new Date().toLocaleDateString('fr-FR')}`,
      text: "Récap hebdomadaire des cuves en vinification (température, densité, produits ajoutés) en pièce jointe, accompagné d'une sauvegarde Excel complète du registre.",
      attachments: [
        { filename: 'recap-vinification.pdf', content: pdfBuffer.toString('base64') },
        { filename: `cahier-de-chai-sauvegarde-${new Date().toISOString().slice(0, 10)}.xlsx`, content: xlsxBuffer.toString('base64') },
      ],
    }),
  });
  if (!res.ok) {
    const corps = await res.text();
    throw new Error(`Échec de l'envoi de l'email (${res.status}) : ${corps}`);
  }
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants');
  if (!RESEND_API_KEY || !REPORT_EMAIL_TO) throw new Error('RESEND_API_KEY / REPORT_EMAIL_TO manquants');

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: row, error } = await supabase.from('cdc_state').select('data').limit(1).maybeSingle();
  if (error) throw error;
  if (!row) {
    console.log('Aucune donnée trouvée dans cdc_state — rien à envoyer.');
    return;
  }

  await genererPDF(row.data || {});
  genererExcel(row.data || {});
  await envoyerEmail();
  console.log('Récap hebdomadaire envoyé avec succès.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
