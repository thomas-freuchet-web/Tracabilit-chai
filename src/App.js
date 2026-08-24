import React, { useState, useEffect, useMemo, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import * as XLSX from 'xlsx';
import { supabase } from './lib/supabaseClient';
import { chargerEtat, sauvegarderEtat } from './lib/cloudStore';
import { genererPdfCuve, telechargerBlob } from './lib/pdfRecap';
import './App.css';

/* ==========================================================================
   RÉFÉRENTIELS FIXES
   ========================================================================== */

const COULEURS = { rouge: 'Rouge', blanc: 'Blanc', rose: 'Rosé' };

const USAGES_LIEU = {
  reception: 'Réception / Tampon',
  vinification: 'Vinification',
  elevage: 'Élevage',
  stockage: 'Stockage produits finis',
};

const CATEGORIES_PRODUIT = [
  'Levures', 'Nutriments / activateurs', 'Enzymes', 'SO2 & conservateurs',
  'Acidifiants', 'Désacidifiants', 'Collage / clarification', 'Bois œnologique',
  'Stabilisants', 'Filtration', 'Divers',
];

const PARAMS_ANALYSE = [
  { id: 'densite', label: 'Densité', unite: '' },
  { id: 'temperature', label: 'Température', unite: '°C' },
  { id: 'tav', label: 'TAV acquis', unite: '% vol' },
  { id: 'tap', label: 'TAV probable', unite: '% vol' },
  { id: 'ph', label: 'pH', unite: '' },
  { id: 'at', label: 'Acidité totale', unite: 'g/L H₂SO₄' },
  { id: 'av', label: 'Acidité volatile', unite: 'g/L H₂SO₄' },
  { id: 'so2l', label: 'SO₂ libre', unite: 'mg/L' },
  { id: 'so2t', label: 'SO₂ total', unite: 'mg/L' },
  { id: 'sucres', label: 'Sucres réducteurs', unite: 'g/L' },
  { id: 'malique', label: 'Acide malique', unite: 'g/L' },
];

const TRAVAUX = [
  'Remontage', 'Délestage', 'Pigeage', 'Écoulage', 'Pressurage', 'Soutirage',
  'Bâtonnage', 'Ouillage', 'Débourbage', 'Sulfitage', 'Filtration',
  'Contrôle température', 'Dégustation',
];

// Registre unique de manipulations — modèle FGVB (édition juillet 2025)
const MANIP_TYPES = {
  enrichissement: { label: 'Enrichissement', delai: "Inscription le jour même de l'opération", sheet: 'Enrichissement' },
  acidification: { label: 'Acidification', delai: 'Au plus tard le 1er jour ouvrable suivant', sheet: 'Acidification' },
  desacidification: { label: 'Désacidification', delai: 'Au plus tard le 1er jour ouvrable suivant', sheet: 'Désacidification' },
  bois_chene: { label: 'Morceaux de bois de chêne', delai: 'Au plus tard le 1er jour ouvrable suivant', sheet: 'Bois de chêne' },
  autres_produits: { label: 'Autres produits (charbons, DMDC…)', delai: 'Au plus tard le 1er jour ouvrable suivant', sheet: 'Autres produits' },
  ferrocyanure: { label: 'Ferrocyanure de potassium', delai: 'Déclaration préalable 8 j · inscription le 1er jour ouvrable suivant', sheet: 'Ferrocyanure' },
  coupage: { label: 'Coupage (règle du 85/15)', delai: 'Au plus tard le 1er jour ouvrable suivant', sheet: 'Coupage 85-15' },
};

const PRODUITS_REGLEMENTAIRES = {
  enrichissement: ['Saccharose (sucrage à sec)', 'Moût concentré rectifié (MCR)', 'Concentration partielle (osmose inverse)'],
  acidification: ['Acide L(+) tartrique', 'Acide L-malique', 'Acide D,L-malique ou acide lactique', 'Traitement électromembranaire', 'Échangeurs de cations'],
  desacidification: ['Tartrate neutre de potassium', 'Bicarbonate de potassium', 'Carbonate de calcium', 'Préparation acide tartrique / carbonate de calcium', 'Traitement électromembranaire'],
  bois_chene: ['Morceaux de bois de chêne (Quercus)'],
  autres_produits: ['Charbons œnologiques', 'Dicarbonate de diméthyle (DMDC)', 'Électrodialyse / échangeurs de cations', 'Contacteurs membranaires (gaz dissous)'],
  ferrocyanure: ['Ferrocyanure de potassium'],
  coupage: [],
};

const FORMATS_BOUTEILLE = [
  { id: '075', label: 'Bouteille 75 cL', litres: 0.75 },
  { id: '0375', label: 'Demi 37,5 cL', litres: 0.375 },
  { id: '150', label: 'Magnum 1,5 L', litres: 1.5 },
  { id: '300', label: 'Double magnum 3 L', litres: 3 },
  { id: 'bib5', label: 'BIB 5 L', litres: 5 },
  { id: 'bib10', label: 'BIB 10 L', litres: 10 },
];

/* ==========================================================================
   UTILITAIRES
   ========================================================================== */

const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const today = () => new Date().toISOString().split('T')[0];
const nowTime = () => new Date().toTimeString().split(' ')[0].slice(0, 5);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
// Les densités portent trois décimales : un écart de -0,025 doit rester -0,025
// et non -0,02. On garde quatre décimales pour tous les écarts de mesure.
const roundFin = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

const loadLS = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
};

/* --------------------------------------------------------------------------
   Stockage des bulletins d'analyse (PDF / images)
   Volontairement séparé de localStorage : un seul PDF suffirait à saturer le
   quota partagé avec toute la traçabilité, et ferait tout perdre.
   -------------------------------------------------------------------------- */
const DB_NOM = 'cdc_fichiers';
let _db = null;

function ouvrirDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NOM, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('bulletins')) {
        req.result.createObjectStore('bulletins', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

async function enregistrerFichier(file) {
  const db = await ouvrirDB();
  const id = uid('fic');
  const blob = new Blob([await file.arrayBuffer()], { type: file.type });
  return new Promise((resolve, reject) => {
    const tx = db.transaction('bulletins', 'readwrite');
    tx.objectStore('bulletins').put({ id, blob, nom: file.name, type: file.type, taille: file.size });
    tx.oncomplete = () => resolve({ id, nom: file.name, type: file.type, taille: file.size });
    tx.onerror = () => reject(tx.error);
  });
}

async function lireFichier(id) {
  const db = await ouvrirDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('bulletins', 'readonly').objectStore('bulletins').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function supprimerFichier(id) {
  const db = await ouvrirDB();
  return new Promise((resolve) => {
    const tx = db.transaction('bulletins', 'readwrite');
    tx.objectStore('bulletins').delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

async function ouvrirBulletin(id) {
  const f = await lireFichier(id);
  if (!f) { alert("Ce bulletin est introuvable : il a peut-être été supprimé, ou ouvert depuis un autre navigateur."); return; }
  const url = URL.createObjectURL(f.blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const formaterTaille = (o) => (o > 1048576 ? `${round2(o / 1048576)} Mo` : `${Math.round(o / 1024)} Ko`);

/* --- Volume d'un lot : somme de ses contenants (source unique de vérité) --- */
function volumeLot(lot) {
  if (!lot || !lot.contenants) return 0;
  return round2(lot.contenants.reduce((s, c) => s + (Number(c.volume) || 0), 0));
}

/* --- Mélange de deux compositions, pondéré par les volumes --- */
function melangerCompositions(compA, volA, compB, volB) {
  const total = volA + volB;
  if (total <= 0) return [];
  const map = {};
  (compA || []).forEach((c) => { map[c.parcelleId] = (map[c.parcelleId] || 0) + (c.pct / 100) * volA; });
  (compB || []).forEach((c) => { map[c.parcelleId] = (map[c.parcelleId] || 0) + (c.pct / 100) * volB; });
  return Object.keys(map)
    .map((parcelleId) => ({ parcelleId, pct: round2((map[parcelleId] / total) * 100) }))
    .sort((a, b) => b.pct - a.pct);
}

/* --- Lignage complet d'un lot : lui-même + tous ses ancêtres --- */
function lignageLot(lotId, lots, vus = new Set()) {
  if (!lotId || vus.has(lotId) || !lots[lotId]) return [];
  vus.add(lotId);
  const lot = lots[lotId];
  let out = [lot];
  (lot.parents || []).forEach((p) => { out = out.concat(lignageLot(p, lots, vus)); });
  return out;
}

/* --- Toutes les opérations d'un lot ET de ses ancêtres, triées --- */
function operationsCompletes(lotId, lots) {
  const chaine = lignageLot(lotId, lots);
  const ops = [];
  chaine.forEach((l) => {
    (l.operations || []).forEach((op) => ops.push({ ...op, _lotCode: l.code, _lotId: l.id }));
  });
  return ops.sort((a, b) => (a.date + (a.heure || '')).localeCompare(b.date + (b.heure || '')));
}

/* --- Couleur d'un lot déduite de sa composition en parcelles --- */
function couleurLot(lot, parcelles, cepages) {
  const set = new Set();
  (lot.composition || []).forEach((c) => {
    const p = parcelles[c.parcelleId];
    if (!p) return;
    const cep = cepages[p.cepageId];
    if (cep) set.add(cep.couleur);
  });
  if (set.size === 0) return lot.couleur || null;
  if (set.size > 1) return 'mixte';
  return [...set][0];
}

function libelleComposition(lot, parcelles, cepages) {
  return (lot.composition || [])
    .map((c) => {
      const p = parcelles[c.parcelleId];
      if (!p) return null;
      const cep = cepages[p.cepageId];
      return `${round2(c.pct)} % ${cep ? cep.nom : '?'} (${p.nom})`;
    })
    .filter(Boolean)
    .join(' · ');
}

/* --- Répartition par cépage, agrégée depuis les parcelles --- */
function compositionParCepage(lot, parcelles, cepages) {
  const map = {};
  (lot.composition || []).forEach((c) => {
    const p = parcelles[c.parcelleId];
    if (!p) return;
    const nom = cepages[p.cepageId] ? cepages[p.cepageId].nom : 'Inconnu';
    map[nom] = (map[nom] || 0) + c.pct;
  });
  return Object.keys(map)
    .map((nom) => ({ nom, pct: round2(map[nom]) }))
    .sort((a, b) => b.pct - a.pct);
}

/* --- Stock disponible d'un produit œnologique --- */
function stockProduit(produit) {
  if (!produit || !produit.mouvements) return 0;
  return round2(produit.mouvements.reduce((s, m) => s + (m.sens === 'sortie' ? -m.quantite : m.quantite), 0));
}

/* --- Détail du stock par lot fournisseur : chaque réception suivie séparément,
       avec sa DLUO et ce qu'il en reste réellement --- */
function stockParLotFournisseur(produit) {
  if (!produit || !produit.mouvements) return [];
  const lots = {};
  produit.mouvements.filter((m) => m.sens === 'entree').forEach((m) => {
    const cle = m.numeroLotFournisseur || '(sans n° de lot)';
    if (!lots[cle]) lots[cle] = { numeroLot: cle, entre: 0, sorti: 0, dluo: m.dluo || '', premiereEntree: m.date, fournisseur: m.fournisseur || '' };
    lots[cle].entre = round2(lots[cle].entre + m.quantite);
    if (m.dluo && (!lots[cle].dluo || m.dluo < lots[cle].dluo)) lots[cle].dluo = m.dluo;
    if (m.date < lots[cle].premiereEntree) lots[cle].premiereEntree = m.date;
  });
  produit.mouvements.filter((m) => m.sens === 'sortie').forEach((m) => {
    const cle = m.numeroLotFournisseur || '(sans n° de lot)';
    if (!lots[cle]) lots[cle] = { numeroLot: cle, entre: 0, sorti: 0, dluo: '', premiereEntree: m.date, fournisseur: '' };
    lots[cle].sorti = round2(lots[cle].sorti + m.quantite);
  });
  return Object.values(lots)
    .map((l) => ({ ...l, reste: round2(l.entre - l.sorti) }))
    .sort((a, b) => (a.dluo || '9999').localeCompare(b.dluo || '9999'));
}

/* --- Jours restants avant DLUO (négatif = périmé) --- */
function joursAvantDluo(dluo) {
  if (!dluo) return null;
  const d = new Date(dluo + 'T00:00:00');
  if (isNaN(d)) return null;
  return Math.round((d - new Date(today() + 'T00:00:00')) / 86400000);
}

/* --- Lots fournisseur périmés ou proches de la péremption, encore en stock --- */
function alertesDluo(produits, seuilJours = 60) {
  const out = [];
  Object.values(produits).forEach((p) => {
    stockParLotFournisseur(p).forEach((l) => {
      if (l.reste <= 0 || !l.dluo) return;
      const j = joursAvantDluo(l.dluo);
      if (j !== null && j <= seuilJours) out.push({ produit: p, ...l, jours: j });
    });
  });
  return out.sort((a, b) => a.jours - b.jours);
}

/* --- Numéro de lot de conditionnement suggéré (recommandation FGVB) --- */
function suggererNumeroLot(lot, conditionnements) {
  const mill = String(lot.millesime || new Date().getFullYear()).slice(-2);
  const initiale = (lot.code || 'X').replace(/[^A-Za-z]/g, '').slice(0, 1).toUpperCase() || 'X';
  const dejaVus = conditionnements.filter((c) => c.lotId === lot.id).length;
  return `L${mill}${initiale}${dejaVus + 1}`;
}

/* ==========================================================================
   PETITS COMPOSANTS
   ========================================================================== */

function ColorDot({ couleur, title }) {
  if (!couleur) return null;
  const cls = couleur === 'rouge' ? 'rouge' : couleur === 'blanc' ? 'blanc' : couleur === 'rose' ? 'rose' : 'mixte';
  return <span className={`color-dot color-dot-${cls}`} title={title || COULEURS[couleur] || couleur} />;
}

function Jauge({ volume, capacite, couleur, size = 'md' }) {
  const uidRef = React.useId();
  const dims = { sm: { w: 24, h: 38 }, md: { w: 34, h: 54 }, lg: { w: 52, h: 82 } }[size] || { w: 34, h: 54 };
  const ratio = capacite > 0 ? Math.min(volume / capacite, 1) : (volume > 0 ? 1 : 0);
  const fill = couleur === 'blanc' ? 'var(--straw-400)'
    : couleur === 'rose' ? 'var(--bordeaux-400)'
    : couleur === 'mixte' ? 'var(--steel-500)'
    : 'var(--bordeaux-500)';
  const h = Math.max(ratio * (dims.h - 5), volume > 0 ? 2 : 0);
  const clipId = `jauge-${uidRef}`;
  return (
    <svg width={dims.w} height={dims.h} viewBox={`0 0 ${dims.w} ${dims.h}`} aria-hidden="true" className="jauge">
      <rect x="1.5" y="1.5" width={dims.w - 3} height={dims.h - 3} rx={dims.w * 0.16}
        fill="var(--stone-100)" stroke="var(--stone-300)" strokeWidth="1.5" />
      <clipPath id={clipId}>
        <rect x="1.5" y="1.5" width={dims.w - 3} height={dims.h - 3} rx={dims.w * 0.16} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect x="1.5" y={dims.h - 1.5 - h} width={dims.w - 3} height={h} fill={fill} opacity="0.9" />
      </g>
    </svg>
  );
}

function PhaseBadge({ phase }) {
  const map = {
    vinification: { cls: 'straw', txt: 'Vinification' },
    elevage: { cls: 'bordeaux', txt: 'Élevage' },
    conditionne: { cls: 'steel', txt: 'Conditionné' },
  };
  const m = map[phase] || map.vinification;
  return <span className={`badge badge-${m.cls}`}><span className="dot" />{m.txt}</span>;
}

function Field({ label, children, hint }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

function Modal({ title, subtitle, onClose, children, large }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal ${large ? 'modal-lg' : ''}`} onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Fermer">✕</button>
        <h2 className="modal-title">{title}</h2>
        {subtitle && <p className="modal-sub">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

function EmptyState({ titre, texte, action }) {
  return (
    <div className="empty-state">
      <h2>{titre}</h2>
      {texte && <p>{texte}</p>}
      {action}
    </div>
  );
}

/* ==========================================================================
   FORMULAIRES (déclarés au niveau module : l'état de saisie est préservé)
   ========================================================================== */

function ModaleApport({ parcelles, cepages, contenants, lieux, occupation, lots, onValider, onFermer }) {
  const [f, setF] = useState({
    date: today(), parcelleId: '', contenantId: '', volume: '', poidsKg: '',
    millesime: new Date().getFullYear(), code: '', nom: '', appellation: '', notes: '',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const parc = parcelles[f.parcelleId];
  const cep = parc ? cepages[parc.cepageId] : null;
  const occ = f.contenantId ? occupation[f.contenantId] : null;
  const lotExistant = occ ? lots[occ.lotId] : null;

  return (
    <Modal title="Apport de vendange" subtitle="Point de départ de la traçabilité : chaque apport rattache un volume à une parcelle." onClose={onFermer}>
      <div className="field-grid">
        <Field label="Date"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label="Millésime"><input type="number" value={f.millesime} onChange={(e) => set('millesime', e.target.value)} /></Field>
      </div>
      <Field label="Parcelle d'origine">
        <select value={f.parcelleId} onChange={(e) => set('parcelleId', e.target.value)}>
          <option value="">— Sélectionner —</option>
          {Object.values(parcelles).sort((a, b) => a.nom.localeCompare(b.nom)).map((p) => {
            const c = cepages[p.cepageId];
            return <option key={p.id} value={p.id}>{p.nom} — {c ? c.nom : '?'}</option>;
          })}
        </select>
      </Field>
      {cep && <p className="inline-note"><ColorDot couleur={cep.couleur} />{cep.nom} · {COULEURS[cep.couleur]}{parc.appellation ? ` · ${parc.appellation}` : ''}</p>}

      <Field label="Contenant de réception">
        <select value={f.contenantId} onChange={(e) => set('contenantId', e.target.value)}>
          <option value="">— Sélectionner —</option>
          {Object.values(lieux).map((lieu) => (
            <optgroup key={lieu.id} label={lieu.nom}>
              {Object.values(contenants).filter((c) => c.lieuId === lieu.id)
                .sort((a, b) => a.nom.localeCompare(b.nom, undefined, { numeric: true }))
                .map((c) => {
                  const o = occupation[c.id];
                  return (
                    <option key={c.id} value={c.id}>
                      {c.nom}{c.capacite ? ` — ${c.capacite} hL` : ''}{o ? ` · occupé (${o.volume} hL)` : ' · vide'}
                    </option>
                  );
                })}
            </optgroup>
          ))}
        </select>
      </Field>
      {lotExistant && (
        <div className="inline-alert">
          Ce contenant porte déjà le lot <strong>{lotExistant.code}</strong>. L'apport sera intégré à ce lot et sa composition recalculée.
        </div>
      )}

      <div className="field-grid">
        <Field label="Volume mis en cuve (hL)"><input type="number" step="0.1" value={f.volume} onChange={(e) => set('volume', e.target.value)} /></Field>
        <Field label="Poids de vendange (kg)" hint="Optionnel"><input type="number" step="1" value={f.poidsKg} onChange={(e) => set('poidsKg', e.target.value)} /></Field>
      </div>

      {!lotExistant && (
        <>
          <div className="field-grid">
            <Field label="Code du lot" hint="Laissé vide, il est généré automatiquement">
              <input type="text" value={f.code} onChange={(e) => set('code', e.target.value)} />
            </Field>
            <Field label="Appellation revendicable">
              <input type="text" value={f.appellation} onChange={(e) => set('appellation', e.target.value)} />
            </Field>
          </div>
          <Field label="Nom du lot" hint="Optionnel — ex : nom de château, cuvée">
            <input type="text" value={f.nom} onChange={(e) => set('nom', e.target.value)} />
          </Field>
        </>
      )}
      <Field label="Observations"><textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>

      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Enregistrer l'apport</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModaleTransfert({ lot, contenants, lieux, occupation, lots, parcelles, cepages, onValider, onFermer }) {
  const [f, setF] = useState({
    lotSourceId: lot.id, contenantSourceId: (lot.contenants[0] || {}).contenantId || '',
    contenantDestId: '', volume: '', date: today(), motif: 'Transfert', note: '',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const ligneSrc = lot.contenants.find((c) => c.contenantId === f.contenantSourceId);
  const occDest = f.contenantDestId ? occupation[f.contenantDestId] : null;
  const lotDest = occDest ? lots[occDest.lotId] : null;
  const dest = contenants[f.contenantDestId];
  const vol = Number(f.volume) || 0;

  let apercu = null;
  if (lotDest && lotDest.id !== lot.id && vol > 0) {
    const nouvelle = melangerCompositions(lotDest.composition, volumeLot(lotDest), lot.composition, vol);
    apercu = (
      <div className="inline-alert">
        <strong>Assemblage.</strong> Le lot <strong>{lotDest.code}</strong> deviendra :
        <div className="apercu-comp">
          {nouvelle.map((c) => {
            const p = parcelles[c.parcelleId];
            const cep = p ? cepages[p.cepageId] : null;
            return <span key={c.parcelleId} className="chip">{round2(c.pct)} % {cep ? cep.nom : '?'} ({p ? p.nom : '?'})</span>;
          })}
        </div>
      </div>
    );
  } else if (f.contenantDestId && !occDest && vol > 0) {
    const totalite = Math.abs(vol - volumeLot(lot)) < 0.001 && lot.contenants.length === 1;
    apercu = (
      <div className="inline-alert">
        {totalite
          ? <>Le lot <strong>{lot.code}</strong> sera intégralement déplacé vers <strong>{dest ? dest.nom : ''}</strong>.</>
          : <>Un lot enfant sera créé dans <strong>{dest ? dest.nom : ''}</strong>, avec la même composition et l'historique de <strong>{lot.code}</strong>.</>}
      </div>
    );
  }

  return (
    <Modal title="Transfert / assemblage" subtitle={`Lot ${lot.code} — ${volumeLot(lot)} hL au total`} onClose={onFermer}>
      <div className="field-grid">
        <Field label="Date"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label="Nature de l'opération">
          <select value={f.motif} onChange={(e) => set('motif', e.target.value)}>
            {['Transfert', 'Soutirage', 'Écoulage', 'Assemblage', 'Entonnage', 'Décuvage', 'Ouillage'].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Depuis">
        <select value={f.contenantSourceId} onChange={(e) => set('contenantSourceId', e.target.value)}>
          {lot.contenants.map((c) => (
            <option key={c.contenantId} value={c.contenantId}>
              {contenants[c.contenantId] ? contenants[c.contenantId].nom : '?'} — {c.volume} hL disponibles
            </option>
          ))}
        </select>
      </Field>

      <Field label="Vers">
        <select value={f.contenantDestId} onChange={(e) => set('contenantDestId', e.target.value)}>
          <option value="">— Sélectionner —</option>
          {Object.values(lieux).map((lieu) => (
            <optgroup key={lieu.id} label={lieu.nom}>
              {Object.values(contenants).filter((c) => c.lieuId === lieu.id && c.id !== f.contenantSourceId)
                .sort((a, b) => a.nom.localeCompare(b.nom, undefined, { numeric: true }))
                .map((c) => {
                  const o = occupation[c.id];
                  const lo = o ? lots[o.lotId] : null;
                  return (
                    <option key={c.id} value={c.id}>
                      {c.nom}{c.capacite ? ` — ${c.capacite} hL` : ''}{lo ? ` · ${lo.code} (${o.volume} hL)` : ' · vide'}
                    </option>
                  );
                })}
            </optgroup>
          ))}
        </select>
      </Field>

      <Field label="Volume (hL)" hint={ligneSrc ? `Maximum : ${ligneSrc.volume} hL` : ''}>
        <input type="number" step="0.1" value={f.volume} onChange={(e) => set('volume', e.target.value)} />
      </Field>
      {ligneSrc && (
        <div className="quick-row">
          <button className="btn btn-ghost btn-sm" onClick={() => set('volume', String(ligneSrc.volume))}>Tout ({ligneSrc.volume} hL)</button>
          <button className="btn btn-ghost btn-sm" onClick={() => set('volume', String(round2(ligneSrc.volume / 2)))}>Moitié</button>
        </div>
      )}

      {apercu}
      <Field label="Note"><input type="text" value={f.note} onChange={(e) => set('note', e.target.value)} /></Field>

      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Valider le transfert</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModaleAjoutProduit({ lot, produits, contenants, onValider, onFermer }) {
  const [f, setF] = useState({
    lotId: lot.id, produitId: '', quantite: '', date: today(),
    contenantId: (lot.contenants[0] || {}).contenantId || '',
    numeroLotFournisseur: '', dluo: '', notes: '', manipType: '',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const prod = produits[f.produitId];
  const dispo = prod ? stockProduit(prod) : 0;
  const lotsDispo = prod ? stockParLotFournisseur(prod).filter((l) => l.reste > 0) : [];
  const lotChoisi = lotsDispo.find((l) => l.numeroLot === f.numeroLotFournisseur);
  const joursDluo = lotChoisi ? joursAvantDluo(lotChoisi.dluo) : null;

  return (
    <Modal title="Ajout de produit œnologique" subtitle={`Lot ${lot.code} — le stock sera décrémenté automatiquement`} onClose={onFermer}>
      <div className="field-grid">
        <Field label="Date"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label="Contenant concerné">
          <select value={f.contenantId} onChange={(e) => set('contenantId', e.target.value)}>
            {lot.contenants.map((c) => (
              <option key={c.contenantId} value={c.contenantId}>
                {contenants[c.contenantId] ? contenants[c.contenantId].nom : '?'} ({c.volume} hL)
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Produit">
        <select value={f.produitId} onChange={(e) => {
          const p = produits[e.target.value];
          const dispos = p ? stockParLotFournisseur(p).filter((l) => l.reste > 0) : [];
          setF((prev) => ({
            ...prev, produitId: e.target.value,
            manipType: p ? p.manipType || '' : '',
            numeroLotFournisseur: dispos.length ? dispos[0].numeroLot : '',
            dluo: dispos.length ? dispos[0].dluo || '' : '',
          }));
        }}>
          <option value="">— Sélectionner —</option>
          {CATEGORIES_PRODUIT.map((cat) => {
            const liste = Object.values(produits).filter((p) => p.categorie === cat);
            if (!liste.length) return null;
            return (
              <optgroup key={cat} label={cat}>
                {liste.map((p) => <option key={p.id} value={p.id}>{p.nom} — {stockProduit(p)} {p.unite} en stock</option>)}
              </optgroup>
            );
          })}
        </select>
      </Field>
      {prod && (
        <p className={`inline-note ${dispo <= 0 ? 'warn' : ''}`}>
          Stock disponible : {dispo} {prod.unite}
          {prod.manipType ? ` · soumis au registre « ${MANIP_TYPES[prod.manipType].label} »` : ''}
        </p>
      )}

      {prod && (
        <Field label="Lot fournisseur utilisé" hint="Classés par DLUO la plus proche — utilise le plus ancien en premier">
          {lotsDispo.length === 0 ? (
            <p className="inline-note warn">Aucun lot en stock pour ce produit. Enregistre d'abord une entrée en stock.</p>
          ) : (
            <select value={f.numeroLotFournisseur} onChange={(e) => {
              const l = lotsDispo.find((x) => x.numeroLot === e.target.value);
              setF((prev) => ({ ...prev, numeroLotFournisseur: e.target.value, dluo: l ? l.dluo || '' : '' }));
            }}>
              {lotsDispo.map((l) => (
                <option key={l.numeroLot} value={l.numeroLot}>
                  {l.numeroLot} — reste {l.reste} {prod.unite}{l.dluo ? ` · DLUO ${l.dluo}` : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      {lotChoisi && joursDluo !== null && joursDluo <= 60 && (
        <p className="inline-note warn">
          {joursDluo < 0 ? `Ce lot est périmé depuis ${-joursDluo} jour(s).` : `DLUO dans ${joursDluo} jour(s).`}
        </p>
      )}

      <div className="field-grid">
        <Field label={`Quantité${prod ? ` (${prod.unite})` : ''}`}
          hint={lotChoisi ? `Reste ${lotChoisi.reste} ${prod.unite} sur ce lot` : ''}>
          <input type="number" step="0.01" value={f.quantite} onChange={(e) => set('quantite', e.target.value)} />
        </Field>
        <Field label="Registre réglementaire" hint="Prérempli si le produit y est soumis">
          <select value={f.manipType} onChange={(e) => set('manipType', e.target.value)}>
            <option value="">Aucun</option>
            {Object.keys(MANIP_TYPES).map((t) => <option key={t} value={t}>{MANIP_TYPES[t].label}</option>)}
          </select>
        </Field>
      </div>
      {prod && volumeLot(lot) > 0 && Number(f.quantite) > 0 && (
        <p className="inline-note">
          Dose appliquée : <strong>{round2(Number(f.quantite) / volumeLot(lot))} {prod.unite}/hL</strong>
          {' '}(sur {volumeLot(lot)} hL)
        </p>
      )}
      <Field label="Notes"><textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>

      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Enregistrer l'ajout</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function EcranReleve({ lots, contenants, lieux, parcelles, cepages, onEnregistrer, onOuvrirLot }) {
  const [date, setDate] = useState(today());
  const [moment, setMoment] = useState(new Date().getHours() < 14 ? 'matin' : 'soir');
  const [filtrePhase, setFiltrePhase] = useState('vinification');
  const [saisies, setSaisies] = useState({});
  const [enregistre, setEnregistre] = useState(0);

  const lignes = [];
  Object.values(lots)
    .filter((l) => l.statut !== 'archive')
    .filter((l) => filtrePhase === 'tout' || l.phase === filtrePhase)
    .forEach((l) => {
      (l.contenants || []).forEach((c) => {
        lignes.push({ lot: l, contenantId: c.contenantId, volume: c.volume });
      });
    });

  lignes.sort((a, b) => {
    const ca = contenants[a.contenantId], cb = contenants[b.contenantId];
    if (!ca || !cb) return 0;
    if (ca.lieuId !== cb.lieuId) {
      const la = lieux[ca.lieuId], lb = lieux[cb.lieuId];
      return (la ? la.nom : '').localeCompare(lb ? lb.nom : '');
    }
    return ca.nom.localeCompare(cb.nom, undefined, { numeric: true });
  });

  const cle = (l) => `${l.lot.id}|${l.contenantId}`;
  const set = (k, champ, v) => setSaisies((p) => ({ ...p, [k]: { ...(p[k] || {}), [champ]: v } }));

  const dejaReleve = (l) => (l.lot.operations || []).some(
    (o) => o.type === 'controle' && o.date === date && o.moment === moment && o.contenantId === l.contenantId
  );

  const dernier = (l) => {
    const prec = (l.lot.operations || [])
      .filter((o) => o.type === 'controle' && o.contenantId === l.contenantId)
      .sort((a, b) => (b.date + (b.moment === 'soir' ? '2' : '1')).localeCompare(a.date + (a.moment === 'soir' ? '2' : '1')));
    return prec[0] || null;
  };

  const aSaisir = Object.keys(saisies).filter((k) => {
    const s = saisies[k];
    return s && ((s.temperature !== undefined && s.temperature !== '') || (s.densite !== undefined && s.densite !== ''));
  });

  const enregistrerTout = () => {
    if (aSaisir.length === 0) { alert('Aucune valeur saisie.'); return; }
    let n = 0;
    aSaisir.forEach((k) => {
      const [lotId, contenantId] = k.split('|');
      const s = saisies[k];
      const ok = onEnregistrer({
        lotId, contenantId, date, moment,
        temperature: s.temperature || '', densite: s.densite || '', notes: s.notes || '',
      });
      if (ok) n++;
    });
    setSaisies({});
    setEnregistre(n);
    setTimeout(() => setEnregistre(0), 4000);
  };

  return (
    <>
      <header className="page-head">
        <div className="page-head-row">
          <h1>Relevé de cave</h1>
          <button className="btn btn-primary" disabled={aSaisir.length === 0} onClick={enregistrerTout}>
            Enregistrer {aSaisir.length > 0 ? `(${aSaisir.length})` : ''}
          </button>
        </div>
        <p className="releve-intro">Passe de cuve en cuve et saisis températures et densités. Rien n'est enregistré tant que tu ne valides pas.</p>
      </header>

      {enregistre > 0 && (
        <div className="inline-alert">{enregistre} relevé{enregistre > 1 ? 's' : ''} enregistré{enregistre > 1 ? 's' : ''}.</div>
      )}

      <div className="panel">
        <div className="releve-controles">
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Moment">
            <select value={moment} onChange={(e) => setMoment(e.target.value)}>
              <option value="matin">Matin</option>
              <option value="soir">Soir</option>
              <option value="extra">Contrôle supplémentaire</option>
            </select>
          </Field>
          <Field label="Afficher">
            <select value={filtrePhase} onChange={(e) => setFiltrePhase(e.target.value)}>
              <option value="vinification">Lots en vinification</option>
              <option value="elevage">Lots en élevage</option>
              <option value="tout">Tous les lots</option>
            </select>
          </Field>
        </div>
      </div>

      {lignes.length === 0 ? (
        <EmptyState titre="Aucun lot à relever" texte="Change le filtre ou enregistre un apport de vendange." />
      ) : (
        <div className="table-wrap">
          <table className="data-table releve-table">
            <thead>
              <tr>
                <th>Contenant</th><th>Lot</th><th>Dernier relevé</th>
                <th>Température °C</th><th>Densité</th><th>Observation</th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((l) => {
                const k = cle(l);
                const ct = contenants[l.contenantId];
                const d = dernier(l);
                const fait = dejaReleve(l);
                const s = saisies[k] || {};
                const ecart = (d && s.densite !== undefined && s.densite !== '' && d.densite !== null && d.densite !== undefined)
                  ? roundFin(Number(s.densite) - d.densite) : null;
                return (
                  <tr key={k} className={fait ? 'ligne-faite' : ''}>
                    <td data-label="Contenant">
                      <strong>{ct ? ct.nom : '?'}</strong>
                      <div className="muted small">{ct && lieux[ct.lieuId] ? lieux[ct.lieuId].nom : ''} · {l.volume} hL</div>
                    </td>
                    <td data-label="Lot">
                      <button className="lien" onClick={() => onOuvrirLot(l.lot.id)}>
                        <ColorDot couleur={couleurLot(l.lot, parcelles, cepages)} />{l.lot.code}
                      </button>
                      {fait && <div className="muted small">déjà relevé</div>}
                    </td>
                    <td className="small releve-dernier">
                      {d ? (
                        <>
                          {d.temperature !== null && d.temperature !== undefined ? `${d.temperature} °C` : '—'} · {d.densite !== null && d.densite !== undefined ? d.densite : '—'}
                          <span className="muted"> · {d.date} {d.moment === 'soir' ? 'soir' : d.moment === 'matin' ? 'matin' : ''}</span>
                        </>
                      ) : <span className="muted">aucun relevé précédent</span>}
                    </td>
                    <td data-label="Température °C">
                      <input className="cell-input" type="number" step="0.1" placeholder="—"
                        value={s.temperature || ''} onChange={(e) => set(k, 'temperature', e.target.value)} />
                    </td>
                    <td data-label="Densité">
                      <input className="cell-input" type="number" step="0.001" placeholder="—"
                        value={s.densite || ''} onChange={(e) => set(k, 'densite', e.target.value)} />
                      {ecart !== null && ecart !== 0 && (
                        <div className={`delta ${ecart > 0 ? 'up' : 'down'}`}>{ecart > 0 ? '+' : ''}{ecart}</div>
                      )}
                    </td>
                    <td data-label="Observation">
                      <input className="cell-input large" type="text" placeholder="—"
                        value={s.notes || ''} onChange={(e) => set(k, 'notes', e.target.value)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {lignes.length > 0 && (
        <div className="releve-pied">
          <button className="btn btn-primary" disabled={aSaisir.length === 0} onClick={enregistrerTout}>
            Enregistrer {aSaisir.length > 0 ? `(${aSaisir.length})` : ''}
          </button>
        </div>
      )}
    </>
  );
}

function ModaleControle({ lot, contenants, onValider, onFermer }) {
  const [f, setF] = useState({
    lotId: lot.id, date: today(),
    moment: new Date().getHours() < 14 ? 'matin' : 'soir',
    contenantId: (lot.contenants[0] || {}).contenantId || '',
    temperature: '', densite: '', notes: '',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  // Dernier relevé pour situer la mesure du jour
  const precedents = (lot.operations || [])
    .filter((o) => o.type === 'controle' && o.contenantId === f.contenantId)
    .sort((a, b) => (b.date + (b.moment === 'soir' ? '2' : '1')).localeCompare(a.date + (a.moment === 'soir' ? '2' : '1')));
  const dernier = precedents[0];

  return (
    <Modal title="Relevé température & densité" subtitle={`Lot ${lot.code}`} onClose={onFermer}>
      <div className="field-grid">
        <Field label="Date"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label="Moment">
          <select value={f.moment} onChange={(e) => set('moment', e.target.value)}>
            <option value="matin">Matin</option>
            <option value="soir">Soir</option>
            <option value="extra">Contrôle supplémentaire</option>
          </select>
        </Field>
      </div>

      {lot.contenants.length > 1 && (
        <Field label="Contenant">
          <select value={f.contenantId} onChange={(e) => set('contenantId', e.target.value)}>
            {lot.contenants.map((c) => (
              <option key={c.contenantId} value={c.contenantId}>
                {contenants[c.contenantId] ? contenants[c.contenantId].nom : '?'} ({c.volume} hL)
              </option>
            ))}
          </select>
        </Field>
      )}

      {dernier && (
        <p className="inline-note">
          Dernier relevé : {dernier.date} {dernier.moment === 'soir' ? 'soir' : dernier.moment === 'matin' ? 'matin' : ''} —
          {dernier.temperature !== null && dernier.temperature !== undefined ? ` ${dernier.temperature} °C` : ' —'} ·
          densité {dernier.densite !== null && dernier.densite !== undefined ? dernier.densite : '—'}
        </p>
      )}

      <div className="field-grid">
        <Field label="Température (°C)">
          <input type="number" step="0.1" autoFocus value={f.temperature} onChange={(e) => set('temperature', e.target.value)} />
        </Field>
        <Field label="Densité">
          <input type="number" step="0.001" value={f.densite} onChange={(e) => set('densite', e.target.value)} />
        </Field>
      </div>

      {dernier && f.densite !== '' && dernier.densite !== null && dernier.densite !== undefined && (
        <p className="inline-note">
          Écart depuis le dernier relevé : <strong>{roundFin(Number(f.densite) - dernier.densite)}</strong>
        </p>
      )}

      <Field label="Observation" hint="Optionnel — odeur, aspect, incident"><input type="text" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>

      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Enregistrer</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModaleAnalyse({ lot, contenants, onValider, onFermer }) {
  const [f, setF] = useState({
    lotId: lot.id, date: today(), heure: nowTime(),
    contenantId: (lot.contenants[0] || {}).contenantId || '',
    source: 'interne', valeurs: {}, notes: '', bulletins: [],
  });
  const [chargement, setChargement] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const setVal = (id, v) => setF((p) => ({ ...p, valeurs: { ...p.valeurs, [id]: v } }));

  const importer = async (e) => {
    const fichiers = [...e.target.files];
    e.target.value = '';
    if (!fichiers.length) return;
    setChargement(true);
    try {
      const metas = [];
      for (const file of fichiers) {
        if (file.size > 12 * 1024 * 1024) { alert(`${file.name} dépasse 12 Mo et n'a pas été importé.`); continue; }
        metas.push(await enregistrerFichier(file));
      }
      setF((p) => ({ ...p, bulletins: [...p.bulletins, ...metas] }));
    } catch (err) {
      alert("Impossible d'enregistrer le fichier : " + (err && err.message ? err.message : 'erreur inconnue'));
    }
    setChargement(false);
  };

  const retirer = async (id) => {
    await supprimerFichier(id);
    setF((p) => ({ ...p, bulletins: p.bulletins.filter((b) => b.id !== id) }));
  };

  return (
    <Modal title="Analyse" subtitle={`Lot ${lot.code} — laisse vide ce que tu ne mesures pas`} onClose={onFermer} large>
      <div className="field-grid">
        <Field label="Date"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label="Heure"><input type="time" value={f.heure} onChange={(e) => set('heure', e.target.value)} /></Field>
      </div>
      <div className="field-grid">
        <Field label="Contenant">
          <select value={f.contenantId} onChange={(e) => set('contenantId', e.target.value)}>
            {lot.contenants.map((c) => (
              <option key={c.contenantId} value={c.contenantId}>
                {contenants[c.contenantId] ? contenants[c.contenantId].nom : '?'} ({c.volume} hL)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Origine">
          <select value={f.source} onChange={(e) => set('source', e.target.value)}>
            <option value="interne">Mesure interne</option>
            <option value="labo">Laboratoire</option>
          </select>
        </Field>
      </div>

      <div className="analyse-grid">
        {PARAMS_ANALYSE.map((p) => (
          <div className="analyse-cell" key={p.id}>
            <label>{p.label}{p.unite ? <span className="unite"> {p.unite}</span> : null}</label>
            <input type="number" step="any" value={f.valeurs[p.id] || ''} onChange={(e) => setVal(p.id, e.target.value)} />
          </div>
        ))}
      </div>

      <Field label="Bulletin de laboratoire" hint="PDF ou photo — 12 Mo maximum par fichier">
        <input type="file" accept="application/pdf,image/*" multiple onChange={importer} disabled={chargement} />
      </Field>
      {chargement && <p className="inline-note">Enregistrement du fichier…</p>}
      {f.bulletins.length > 0 && (
        <div className="chips-wrap" style={{ marginBottom: 13 }}>
          {f.bulletins.map((b) => (
            <span className="chip" key={b.id}>
              📄 {b.nom} <span className="muted">({formaterTaille(b.taille)})</span>
              <button onClick={() => retirer(b.id)}>✕</button>
            </span>
          ))}
        </div>
      )}

      <Field label="Notes / dégustation"><textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={chargement} onClick={() => { if (onValider(f)) onFermer(); }}>Enregistrer l'analyse</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModaleTravail({ lot, contenants, onValider, onFermer }) {
  const [f, setF] = useState({
    lotId: lot.id, date: today(), heure: nowTime(), action: '',
    contenantId: (lot.contenants[0] || {}).contenantId || '', duree: '', notes: '',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal title="Travail de cave" subtitle={`Lot ${lot.code}`} onClose={onFermer}>
      <div className="field-grid">
        <Field label="Date"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label="Heure"><input type="time" value={f.heure} onChange={(e) => set('heure', e.target.value)} /></Field>
      </div>
      <Field label="Action">
        <select value={f.action} onChange={(e) => set('action', e.target.value)}>
          <option value="">— Sélectionner —</option>
          {TRAVAUX.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </Field>
      <div className="field-grid">
        <Field label="Contenant">
          <select value={f.contenantId} onChange={(e) => set('contenantId', e.target.value)}>
            {lot.contenants.map((c) => (
              <option key={c.contenantId} value={c.contenantId}>
                {contenants[c.contenantId] ? contenants[c.contenantId].nom : '?'} ({c.volume} hL)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Durée / intensité" hint="Optionnel"><input type="text" value={f.duree} onChange={(e) => set('duree', e.target.value)} /></Field>
      </div>
      <Field label="Notes"><textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Enregistrer</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModalePerte({ lot, contenants, onValider, onFermer }) {
  const [f, setF] = useState({
    lotId: lot.id, date: today(), volume: '',
    contenantId: (lot.contenants[0] || {}).contenantId || '', motif: '',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal title="Sortie de volume" subtitle={`Lot ${lot.code} — perte, lies, échantillon, dégustation…`} onClose={onFermer}>
      <div className="field-grid">
        <Field label="Date"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label="Volume (hL)"><input type="number" step="0.01" value={f.volume} onChange={(e) => set('volume', e.target.value)} /></Field>
      </div>
      <Field label="Contenant">
        <select value={f.contenantId} onChange={(e) => set('contenantId', e.target.value)}>
          {lot.contenants.map((c) => (
            <option key={c.contenantId} value={c.contenantId}>
              {contenants[c.contenantId] ? contenants[c.contenantId].nom : '?'} ({c.volume} hL)
            </option>
          ))}
        </select>
      </Field>
      <Field label="Motif">
        <select value={f.motif} onChange={(e) => set('motif', e.target.value)}>
          <option value="">— Sélectionner —</option>
          {['Lies / bourbes', 'Perte de cave', 'Échantillon', 'Dégustation', 'Sortie vrac', 'Distillation', 'Autre'].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Enregistrer</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModaleManipulation({ lot, contenants, onValider, onFermer, typeInitial }) {
  const [f, setF] = useState({
    lotId: lot.id, manipType: typeInitial || 'enrichissement', date: today(),
    contenantId: (lot.contenants[0] || {}).contenantId || '',
    produit: '', quantiteProduit: '', volumeConcerne: String(volumeLot(lot)),
    titreAvant: '', titreApres: '', designationAvant: '', designationApres: '',
    responsable: '', dateFiltration: '', critere8515: '', notes: '',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const meta = MANIP_TYPES[f.manipType];
  const suggestions = PRODUITS_REGLEMENTAIRES[f.manipType] || [];

  return (
    <Modal title="Registre de manipulations" subtitle={`Lot ${lot.code} — inscription au registre réglementaire`} onClose={onFermer}>
      <Field label="Type de manipulation">
        <select value={f.manipType} onChange={(e) => set('manipType', e.target.value)}>
          {Object.keys(MANIP_TYPES).map((t) => <option key={t} value={t}>{MANIP_TYPES[t].label}</option>)}
        </select>
      </Field>
      <p className="delai-hint">⏱ {meta.delai}</p>

      <div className="field-grid">
        <Field label="Date de l'opération"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label="Volume concerné (hL)"><input type="number" step="0.1" value={f.volumeConcerne} onChange={(e) => set('volumeConcerne', e.target.value)} /></Field>
      </div>

      <Field label="Contenant">
        <select value={f.contenantId} onChange={(e) => set('contenantId', e.target.value)}>
          {lot.contenants.map((c) => (
            <option key={c.contenantId} value={c.contenantId}>
              {contenants[c.contenantId] ? contenants[c.contenantId].nom : '?'} ({c.volume} hL)
            </option>
          ))}
        </select>
      </Field>

      {f.manipType !== 'coupage' && (
        <div className="field-grid">
          <Field label="Produit utilisé">
            <input list="manip-produits" type="text" value={f.produit} onChange={(e) => set('produit', e.target.value)} />
            <datalist id="manip-produits">{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
          </Field>
          <Field label="Quantité"><input type="text" value={f.quantiteProduit} onChange={(e) => set('quantiteProduit', e.target.value)} /></Field>
        </div>
      )}

      {f.manipType === 'enrichissement' && (
        <div className="field-grid">
          <Field label="TAV naturel (% vol)"><input type="number" step="0.1" value={f.titreAvant} onChange={(e) => set('titreAvant', e.target.value)} /></Field>
          <Field label="TAV probable après (% vol)"><input type="number" step="0.1" value={f.titreApres} onChange={(e) => set('titreApres', e.target.value)} /></Field>
        </div>
      )}

      {['acidification', 'desacidification', 'coupage'].includes(f.manipType) && (
        <div className="field-grid">
          <Field label="Désignation avant"><input type="text" value={f.designationAvant} onChange={(e) => set('designationAvant', e.target.value)} /></Field>
          <Field label="Désignation après"><input type="text" value={f.designationApres} onChange={(e) => set('designationApres', e.target.value)} /></Field>
        </div>
      )}

      {f.manipType === 'coupage' && (
        <Field label="Concerné par la règle du 85/15">
          <select value={f.critere8515} onChange={(e) => set('critere8515', e.target.value)}>
            <option value="">—</option>
            <option value="Cépage">Oui — cépage</option>
            <option value="Millésime">Oui — millésime</option>
            <option value="Non concerné">Non concerné</option>
          </select>
        </Field>
      )}

      {f.manipType === 'ferrocyanure' && (
        <div className="field-grid">
          <Field label="Œnologue responsable"><input type="text" value={f.responsable} onChange={(e) => set('responsable', e.target.value)} /></Field>
          <Field label="Date de filtration"><input type="date" value={f.dateFiltration} onChange={(e) => set('dateFiltration', e.target.value)} /></Field>
        </div>
      )}

      <Field label="Observations"><textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Inscrire au registre</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModaleMise({ lot, contenants, conditionnements, parcelles, cepages, onValider, onFermer }) {
  const [f, setF] = useState({
    lotId: lot.id, date: today(),
    contenantId: (lot.contenants[0] || {}).contenantId || '',
    numeroLot: suggererNumeroLot(lot, conditionnements),
    lignes: FORMATS_BOUTEILLE.map((x) => ({ formatId: x.id, nb: '' })),
    embouteilleur: '', designation: `${lot.appellation || ''} ${lot.millesime || ''}`.trim(),
    fournisseurBouteilles: '', fournisseurBouchons: '', notes: '',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const setLigne = (formatId, nb) => setF((p) => ({
    ...p, lignes: p.lignes.map((l) => (l.formatId === formatId ? { ...l, nb } : l)),
  }));
  const volumeL = f.lignes.reduce((s, l) => {
    const fmt = FORMATS_BOUTEILLE.find((x) => x.id === l.formatId);
    return s + (fmt ? fmt.litres * (Number(l.nb) || 0) : 0);
  }, 0);
  const ligneCt = lot.contenants.find((c) => c.contenantId === f.contenantId);

  return (
    <Modal title="Mise en bouteille" subtitle={`Lot ${lot.code} — ${libelleComposition(lot, parcelles, cepages) || 'composition non renseignée'}`} onClose={onFermer} large>
      <div className="field-grid">
        <Field label="Date de mise"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label="N° de lot" hint="Précédé de « L » par convention réglementaire">
          <input type="text" value={f.numeroLot} onChange={(e) => set('numeroLot', e.target.value)} />
        </Field>
      </div>
      <div className="field-grid">
        <Field label="Depuis le contenant">
          <select value={f.contenantId} onChange={(e) => set('contenantId', e.target.value)}>
            {lot.contenants.map((c) => (
              <option key={c.contenantId} value={c.contenantId}>
                {contenants[c.contenantId] ? contenants[c.contenantId].nom : '?'} ({c.volume} hL)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Désignation (étiquetage)"><input type="text" value={f.designation} onChange={(e) => set('designation', e.target.value)} /></Field>
      </div>

      <div className="panel-inset">
        <h4>Répartition par format</h4>
        <div className="format-grid">
          {FORMATS_BOUTEILLE.map((fmt) => (
            <div className="format-cell" key={fmt.id}>
              <label>{fmt.label}</label>
              <input type="number" min="0" value={(f.lignes.find((l) => l.formatId === fmt.id) || {}).nb || ''}
                onChange={(e) => setLigne(fmt.id, e.target.value)} />
            </div>
          ))}
        </div>
        <p className={`inline-note ${ligneCt && volumeL / 100 > ligneCt.volume ? 'warn' : ''}`}>
          Volume mis : <strong>{round2(volumeL / 100)} hL</strong> ({round2(volumeL)} L)
          {ligneCt ? ` · disponible dans le contenant : ${ligneCt.volume} hL` : ''}
        </p>
      </div>

      <div className="field-grid">
        <Field label="Embouteilleur" hint="Si la mise est faite par un tiers"><input type="text" value={f.embouteilleur} onChange={(e) => set('embouteilleur', e.target.value)} /></Field>
        <Field label="Fournisseur bouteilles"><input type="text" value={f.fournisseurBouteilles} onChange={(e) => set('fournisseurBouteilles', e.target.value)} /></Field>
      </div>
      <Field label="Fournisseur bouchons"><input type="text" value={f.fournisseurBouchons} onChange={(e) => set('fournisseurBouchons', e.target.value)} /></Field>
      <Field label="Notes"><textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>

      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Enregistrer la mise</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModaleEditLot({ lot, onValider, onFermer }) {
  const [f, setF] = useState({
    code: lot.code, nom: lot.nom || '', millesime: lot.millesime, appellation: lot.appellation || '',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal title="Modifier le lot" subtitle="La composition parcellaire se recalcule automatiquement : elle n'est pas modifiable à la main." onClose={onFermer}>
      <div className="field-grid">
        <Field label="Code"><input type="text" value={f.code} onChange={(e) => set('code', e.target.value)} /></Field>
        <Field label="Millésime"><input type="number" value={f.millesime} onChange={(e) => set('millesime', e.target.value)} /></Field>
      </div>
      <Field label="Nom / cuvée"><input type="text" value={f.nom} onChange={(e) => set('nom', e.target.value)} /></Field>
      <Field label="Appellation"><input type="text" value={f.appellation} onChange={(e) => set('appellation', e.target.value)} /></Field>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { onValider({ ...f, millesime: Number(f.millesime) }); onFermer(); }}>Enregistrer</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModaleLieu({ onValider, onFermer }) {
  const [f, setF] = useState({ nom: '', type: 'cuverie', usage: 'vinification' });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal title="Nouveau lieu" subtitle="Une cuverie, un chai à barriques, une zone de stockage…" onClose={onFermer}>
      <Field label="Nom" hint="ex : Cuverie de vinification, Chai à barriques rouges">
        <input type="text" value={f.nom} onChange={(e) => set('nom', e.target.value)} />
      </Field>
      <div className="field-grid">
        <Field label="Type">
          <select value={f.type} onChange={(e) => set('type', e.target.value)}>
            <option value="cuverie">Cuverie</option>
            <option value="chai_barriques">Chai à barriques</option>
          </select>
        </Field>
        <Field label="Usage principal">
          <select value={f.usage} onChange={(e) => set('usage', e.target.value)}>
            {Object.keys(USAGES_LIEU).map((u) => <option key={u} value={u}>{USAGES_LIEU[u]}</option>)}
          </select>
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Créer</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModaleContenants({ lieux, lieuInitial, onValider, onFermer }) {
  const premier = lieuInitial || Object.keys(lieux)[0] || '';
  const [f, setF] = useState({
    lieuId: premier, mode: 'serie', prefixe: 'C', debut: '1', fin: '10',
    nom: '', capacite: '', materiau: '', tonnelier: '', annee: '',
    nbBarriques: '12', capaciteUnitaire: '2.25',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const lieu = lieux[f.lieuId];
  const estBarrique = lieu && lieu.type === 'chai_barriques';

  return (
    <Modal title="Ajouter des contenants" onClose={onFermer}>
      <Field label="Lieu">
        <select value={f.lieuId} onChange={(e) => set('lieuId', e.target.value)}>
          {Object.values(lieux).map((l) => <option key={l.id} value={l.id}>{l.nom}</option>)}
        </select>
      </Field>

      <Field label="Mode de création">
        <select value={f.mode} onChange={(e) => set('mode', e.target.value)}>
          <option value="serie">Série numérotée (ex : C1 à C20)</option>
          <option value="unite">Un seul contenant</option>
          {estBarrique && <option value="lot_barriques">Lot de barriques (suivi groupé)</option>}
        </select>
      </Field>

      {f.mode === 'serie' && (
        <>
          <div className="field-grid">
            <Field label="Préfixe" hint="Peut rester vide"><input type="text" value={f.prefixe} onChange={(e) => set('prefixe', e.target.value)} /></Field>
            <Field label={`Capacité unitaire (hL)`}><input type="number" step="0.01" value={f.capacite} onChange={(e) => set('capacite', e.target.value)} /></Field>
          </div>
          <div className="field-grid">
            <Field label="Du n°"><input type="number" value={f.debut} onChange={(e) => set('debut', e.target.value)} /></Field>
            <Field label="Au n°"><input type="number" value={f.fin} onChange={(e) => set('fin', e.target.value)} /></Field>
          </div>
        </>
      )}

      {f.mode === 'unite' && (
        <div className="field-grid">
          <Field label="Nom"><input type="text" value={f.nom} onChange={(e) => set('nom', e.target.value)} /></Field>
          <Field label="Capacité (hL)"><input type="number" step="0.01" value={f.capacite} onChange={(e) => set('capacite', e.target.value)} /></Field>
        </div>
      )}

      {f.mode === 'lot_barriques' && (
        <>
          <Field label="Nom du lot" hint="ex : Lot 2024 Tonnelier X"><input type="text" value={f.nom} onChange={(e) => set('nom', e.target.value)} /></Field>
          <div className="field-grid">
            <Field label="Nombre de barriques"><input type="number" value={f.nbBarriques} onChange={(e) => set('nbBarriques', e.target.value)} /></Field>
            <Field label="Capacité unitaire (hL)" hint="2,25 hL = barrique bordelaise 225 L">
              <input type="number" step="0.01" value={f.capaciteUnitaire} onChange={(e) => set('capaciteUnitaire', e.target.value)} />
            </Field>
          </div>
        </>
      )}

      <div className="field-grid">
        <Field label="Matériau"><input type="text" placeholder={estBarrique ? 'Chêne' : 'Inox, béton, bois…'} value={f.materiau} onChange={(e) => set('materiau', e.target.value)} /></Field>
        {estBarrique
          ? <Field label="Tonnelier"><input type="text" value={f.tonnelier} onChange={(e) => set('tonnelier', e.target.value)} /></Field>
          : <Field label="Année" hint="Optionnel"><input type="text" value={f.annee} onChange={(e) => set('annee', e.target.value)} /></Field>}
      </div>

      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Créer</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModaleCepage({ onValider, onFermer }) {
  const [f, setF] = useState({ nom: '', couleur: 'rouge' });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal title="Nouveau cépage" onClose={onFermer}>
      <Field label="Nom"><input type="text" value={f.nom} onChange={(e) => set('nom', e.target.value)} /></Field>
      <Field label="Couleur du vin produit" hint="Détermine la couleur affichée pour les lots issus de ce cépage">
        <select value={f.couleur} onChange={(e) => set('couleur', e.target.value)}>
          {Object.keys(COULEURS).map((c) => <option key={c} value={c}>{COULEURS[c]}</option>)}
        </select>
      </Field>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Créer</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModaleParcelles({ cepages, onValider, onFermer }) {
  const [f, setF] = useState({
    nom: '', cepageId: Object.keys(cepages)[0] || '', surface: '', appellation: '',
    anneePlantation: '', commune: '', cadastre: '',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal title="Ajouter des parcelles" onClose={onFermer}>
      <Field label="Nom(s)" hint="Sépare par des virgules pour en créer plusieurs d'un coup : P01, P02, P03">
        <input type="text" value={f.nom} onChange={(e) => set('nom', e.target.value)} />
      </Field>
      <Field label="Cépage">
        <select value={f.cepageId} onChange={(e) => set('cepageId', e.target.value)}>
          <option value="">— Sélectionner —</option>
          {Object.values(cepages).map((c) => <option key={c.id} value={c.id}>{c.nom} ({COULEURS[c.couleur]})</option>)}
        </select>
      </Field>
      <div className="field-grid">
        <Field label="Surface (ha)"><input type="number" step="0.01" value={f.surface} onChange={(e) => set('surface', e.target.value)} /></Field>
        <Field label="Année de plantation"><input type="text" value={f.anneePlantation} onChange={(e) => set('anneePlantation', e.target.value)} /></Field>
      </div>
      <div className="field-grid">
        <Field label="Appellation revendicable"><input type="text" value={f.appellation} onChange={(e) => set('appellation', e.target.value)} /></Field>
        <Field label="Commune"><input type="text" value={f.commune} onChange={(e) => set('commune', e.target.value)} /></Field>
      </div>
      <Field label="Références cadastrales / lieu-dit" hint="Repris dans le registre d'entrées de vendange">
        <input type="text" value={f.cadastre} onChange={(e) => set('cadastre', e.target.value)} />
      </Field>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Créer</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModaleProduit({ onValider, onFermer }) {
  const [f, setF] = useState({ nom: '', categorie: 'Divers', unite: 'kg', seuil: '', fournisseur: '', manipType: '' });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal title="Nouveau produit œnologique" onClose={onFermer}>
      <Field label="Nom"><input type="text" value={f.nom} onChange={(e) => set('nom', e.target.value)} /></Field>
      <div className="field-grid">
        <Field label="Catégorie">
          <select value={f.categorie} onChange={(e) => set('categorie', e.target.value)}>
            {CATEGORIES_PRODUIT.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Unité">
          <select value={f.unite} onChange={(e) => set('unite', e.target.value)}>
            {['kg', 'g', 'L', 'mL', 'unité'].map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </Field>
      </div>
      <div className="field-grid">
        <Field label="Seuil d'alerte" hint="0 = pas d'alerte"><input type="number" step="0.01" value={f.seuil} onChange={(e) => set('seuil', e.target.value)} /></Field>
        <Field label="Fournisseur habituel"><input type="text" value={f.fournisseur} onChange={(e) => set('fournisseur', e.target.value)} /></Field>
      </div>
      <Field label="Registre réglementaire associé" hint="L'ajout de ce produit proposera automatiquement l'inscription au registre">
        <select value={f.manipType} onChange={(e) => set('manipType', e.target.value)}>
          <option value="">Aucun</option>
          {Object.keys(MANIP_TYPES).map((t) => <option key={t} value={t}>{MANIP_TYPES[t].label}</option>)}
        </select>
      </Field>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Créer</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

function ModaleProduitDetail({ produit, onEntree, onFermer }) {
  const lotsF = stockParLotFournisseur(produit);
  const mvts = [...(produit.mouvements || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return (
    <Modal title={produit.nom} subtitle={`${produit.categorie} · stock actuel ${stockProduit(produit)} ${produit.unite}`} onClose={onFermer} large>
      <div className="panel-head">
        <h4 style={{ margin: 0 }}>Lots fournisseur en stock</h4>
        <button className="btn btn-primary btn-sm" onClick={onEntree}>+ Entrée en stock</button>
      </div>
      {lotsF.length === 0 ? <p className="muted">Aucun mouvement enregistré.</p> : (
        <table className="data-table compact">
          <thead><tr><th>N° de lot</th><th>Reçu</th><th>Utilisé</th><th>Reste</th><th>DLUO</th><th>Fournisseur</th></tr></thead>
          <tbody>
            {lotsF.map((l) => {
              const j = joursAvantDluo(l.dluo);
              const perime = j !== null && j < 0;
              const proche = j !== null && j >= 0 && j <= 60;
              return (
                <tr key={l.numeroLot} className={l.reste <= 0 ? 'ligne-epuisee' : ''}>
                  <td><strong>{l.numeroLot}</strong></td>
                  <td>{l.entre} {produit.unite}</td>
                  <td>{l.sorti} {produit.unite}</td>
                  <td><strong>{l.reste} {produit.unite}</strong></td>
                  <td className={perime || proche ? 'warn-text' : ''}>
                    {l.dluo || '—'}
                    {l.reste > 0 && perime ? ` · périmé` : ''}
                    {l.reste > 0 && proche ? ` · J−${j}` : ''}
                  </td>
                  <td className="small">{l.fournisseur || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h4 style={{ marginTop: 22 }}>Historique des mouvements ({mvts.length})</h4>
      {mvts.length === 0 ? <p className="muted">Aucun mouvement.</p> : (
        <table className="data-table compact">
          <thead><tr><th>Date</th><th>Sens</th><th>Quantité</th><th>N° de lot</th><th>Motif</th></tr></thead>
          <tbody>
            {mvts.map((m) => (
              <tr key={m.id}>
                <td className="nowrap">{m.date}</td>
                <td><span className={`op-tag ${m.sens === 'entree' ? 'op-apport' : 'op-perte'}`}>{m.sens === 'entree' ? 'Entrée' : 'Sortie'}</span></td>
                <td className={m.sens === 'entree' ? 'entree' : 'sortie'}>
                  {m.sens === 'entree' ? '+' : '−'}{m.quantite} {produit.unite}
                </td>
                <td className="small">{m.numeroLotFournisseur || '—'}</td>
                <td className="small">{m.motif || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="form-actions">
        <button className="btn btn-outline" onClick={onFermer}>Fermer</button>
      </div>
    </Modal>
  );
}

function ModaleEntreeStock({ produit, onValider, onFermer }) {
  const [f, setF] = useState({
    produitId: produit.id, quantite: '', date: today(),
    numeroLotFournisseur: '', dluo: '', fournisseur: produit.fournisseur || '',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal title="Entrée en stock" subtitle={`${produit.nom} — stock actuel ${stockProduit(produit)} ${produit.unite}`} onClose={onFermer}>
      <div className="field-grid">
        <Field label="Date de réception"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label={`Quantité reçue (${produit.unite})`}><input type="number" step="0.01" value={f.quantite} onChange={(e) => set('quantite', e.target.value)} /></Field>
      </div>
      <div className="field-grid">
        <Field label="N° de lot fournisseur"><input type="text" value={f.numeroLotFournisseur} onChange={(e) => set('numeroLotFournisseur', e.target.value)} /></Field>
        <Field label="DLUO"><input type="date" value={f.dluo} onChange={(e) => set('dluo', e.target.value)} /></Field>
      </div>
      <Field label="Fournisseur"><input type="text" value={f.fournisseur} onChange={(e) => set('fournisseur', e.target.value)} /></Field>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => { if (onValider(f)) onFermer(); }}>Enregistrer</button>
        <button className="btn btn-outline" onClick={onFermer}>Annuler</button>
      </div>
    </Modal>
  );
}

/* ==========================================================================
   APPLICATION
   ========================================================================== */

export default function CahierDeChai() {
  /* ---------- Authentification (compte Supabase personnel) ---------- */
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPwd, setLoginPwd] = useState('');
  const [loginErreur, setLoginErreur] = useState('');
  const [connexionEnCours, setConnexionEnCours] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session ? { id: session.user.email, uid: session.user.id } : null);
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session ? { id: session.user.email, uid: session.user.id } : null);
    });
    return () => subscription.unsubscribe();
  }, []);

  /* ---------- Données persistées ---------- */
  const [domaine, setDomaine] = useState(() => loadLS('cdc_domaine', {
    nom: '', cvi: '', adresse: '', exploitant: '', exploitantAdresse: '', setupDone: false,
  }));
  const [lieux, setLieux] = useState(() => loadLS('cdc_lieux', {}));
  const [contenants, setContenants] = useState(() => loadLS('cdc_contenants', {}));
  const [cepages, setCepages] = useState(() => loadLS('cdc_cepages', {}));
  const [parcelles, setParcelles] = useState(() => loadLS('cdc_parcelles', {}));
  const [produits, setProduits] = useState(() => loadLS('cdc_produits', {}));
  const [lots, setLots] = useState(() => loadLS('cdc_lots', {}));
  const [conditionnements, setConditionnements] = useState(() => loadLS('cdc_conditionnements', []));

  useEffect(() => { localStorage.setItem('cdc_domaine', JSON.stringify(domaine)); }, [domaine]);
  useEffect(() => { localStorage.setItem('cdc_lieux', JSON.stringify(lieux)); }, [lieux]);
  useEffect(() => { localStorage.setItem('cdc_contenants', JSON.stringify(contenants)); }, [contenants]);
  useEffect(() => { localStorage.setItem('cdc_cepages', JSON.stringify(cepages)); }, [cepages]);
  useEffect(() => { localStorage.setItem('cdc_parcelles', JSON.stringify(parcelles)); }, [parcelles]);
  useEffect(() => { localStorage.setItem('cdc_produits', JSON.stringify(produits)); }, [produits]);
  useEffect(() => { localStorage.setItem('cdc_lots', JSON.stringify(lots)); }, [lots]);
  useEffect(() => { localStorage.setItem('cdc_conditionnements', JSON.stringify(conditionnements)); }, [conditionnements]);

  /* ---------- Synchronisation Supabase (mêmes données sur tous les appareils) ---------- */
  const [syncEtat, setSyncEtat] = useState({ statut: 'inactif', quand: null }); // inactif | en_cours | synchronise | horsligne
  const chargementInitialFait = useRef(false);
  const minuteurSync = useRef(null);

  // Au login : on récupère l'état déjà en ligne, ou on y pousse l'état local
  // actuel s'il n'existe pas encore (première connexion depuis cet appareil).
  useEffect(() => {
    if (!user) { chargementInitialFait.current = false; return; }
    let annule = false;
    (async () => {
      try {
        const cloud = await chargerEtat(user.uid);
        if (annule) return;
        if (cloud) {
          if (cloud.domaine) setDomaine(cloud.domaine);
          setLieux(cloud.lieux || {});
          setContenants(cloud.contenants || {});
          setCepages(cloud.cepages || {});
          setParcelles(cloud.parcelles || {});
          setProduits(cloud.produits || {});
          setLots(cloud.lots || {});
          setConditionnements(cloud.conditionnements || []);
        } else {
          await sauvegarderEtat(user.uid, { domaine, lieux, contenants, cepages, parcelles, produits, lots, conditionnements });
        }
        chargementInitialFait.current = true;
        setSyncEtat({ statut: 'synchronise', quand: new Date() });
      } catch (e) {
        if (!annule) setSyncEtat({ statut: 'horsligne', quand: null });
      }
    })();
    return () => { annule = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // À chaque changement de données, on republie vers Supabase (débounce 1 s)
  useEffect(() => {
    if (!user || !chargementInitialFait.current) return;
    setSyncEtat((s) => ({ ...s, statut: 'en_cours' }));
    clearTimeout(minuteurSync.current);
    minuteurSync.current = setTimeout(async () => {
      try {
        await sauvegarderEtat(user.uid, { domaine, lieux, contenants, cepages, parcelles, produits, lots, conditionnements });
        setSyncEtat({ statut: 'synchronise', quand: new Date() });
      } catch (e) {
        setSyncEtat({ statut: 'horsligne', quand: null });
      }
    }, 1000);
    return () => clearTimeout(minuteurSync.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, domaine, lieux, contenants, cepages, parcelles, produits, lots, conditionnements]);

  /* ---------- Navigation ---------- */
  const [vue, setVue] = useState('accueil');          // accueil | cave | produits | registre | mise | parametres
  const [modeCave, setModeCave] = useState('contenant'); // contenant | lot
  const [lotOuvert, setLotOuvert] = useState(null);
  const [ongletLot, setOngletLot] = useState('suivi');
  const [paramsGraphe, setParamsGraphe] = useState(['densite', 'temperature']);
  const [recherche, setRecherche] = useState('');

  /* ---------- Modales ---------- */
  const [modale, setModale] = useState(null); // {type, payload}
  const ouvrir = (type, payload = {}) => setModale({ type, payload });
  const fermer = () => setModale(null);

  /* =========================================================================
     DÉRIVÉS
     ========================================================================= */

  // Quel lot occupe quel contenant
  const occupationParContenant = useMemo(() => {
    const map = {};
    Object.values(lots).forEach((lot) => {
      if (lot.statut === 'archive') return;
      (lot.contenants || []).forEach((c) => {
        if ((Number(c.volume) || 0) <= 0) return;
        map[c.contenantId] = { lotId: lot.id, volume: c.volume };
      });
    });
    return map;
  }, [lots]);

  const lotsActifs = useMemo(
    () => Object.values(lots).filter((l) => l.statut !== 'archive'),
    [lots]
  );

  const stats = useMemo(() => {
    let vRouge = 0, vBlanc = 0, vRose = 0, vAutre = 0, total = 0;
    lotsActifs.forEach((l) => {
      const v = volumeLot(l);
      total += v;
      const c = couleurLot(l, parcelles, cepages);
      if (c === 'rouge') vRouge += v;
      else if (c === 'blanc') vBlanc += v;
      else if (c === 'rose') vRose += v;
      else vAutre += v;
    });
    const capaciteTotale = Object.values(contenants).reduce((s, ct) => s + (Number(ct.capacite) || 0), 0);
    return {
      nbLots: lotsActifs.length,
      nbVinif: lotsActifs.filter((l) => l.phase === 'vinification').length,
      nbElevage: lotsActifs.filter((l) => l.phase === 'elevage').length,
      total: round2(total), vRouge: round2(vRouge), vBlanc: round2(vBlanc),
      vRose: round2(vRose), vAutre: round2(vAutre),
      capaciteTotale: round2(capaciteTotale),
      nbContenants: Object.keys(contenants).length,
      contenantsOccupes: Object.keys(occupationParContenant).length,
    };
  }, [lotsActifs, parcelles, cepages, contenants, occupationParContenant]);

  const alertesStock = useMemo(
    () => Object.values(produits).filter((p) => p.seuil > 0 && stockProduit(p) <= p.seuil),
    [produits]
  );

  const alertesPeremption = useMemo(() => alertesDluo(produits, 60), [produits]);

  /* =========================================================================
     ÉCRITURE : helper central pour ajouter une opération à un lot
     ========================================================================= */

  const ajouterOperation = (lotId, operation) => {
    setLots((prev) => {
      const lot = prev[lotId];
      if (!lot) return prev;
      return {
        ...prev,
        [lotId]: { ...lot, operations: [...(lot.operations || []), { id: uid('op'), ...operation }] },
      };
    });
  };

  /* =========================================================================
     APPORT DE VENDANGE — point d'entrée de toute la traçabilité
     ========================================================================= */

  const apporterVendange = (form) => {
    const volume = Number(form.volume);
    if (!form.parcelleId || !form.contenantId || !volume || volume <= 0) {
      alert('Parcelle, contenant et volume sont obligatoires'); return false;
    }
    const occ = occupationParContenant[form.contenantId];
    const parcelle = parcelles[form.parcelleId];
    const cep = parcelle ? cepages[parcelle.cepageId] : null;

    if (occ) {
      // Le contenant contient déjà du vin → on complète le lot existant
      const lotCible = lots[occ.lotId];
      const volAvant = volumeLot(lotCible);
      setLots((prev) => {
        const l = prev[occ.lotId];
        const nouvelleComp = melangerCompositions(
          l.composition, volAvant, [{ parcelleId: form.parcelleId, pct: 100 }], volume
        );
        return {
          ...prev,
          [occ.lotId]: {
            ...l,
            composition: nouvelleComp,
            contenants: l.contenants.map((c) =>
              c.contenantId === form.contenantId ? { ...c, volume: round2(c.volume + volume) } : c
            ),
            operations: [...(l.operations || []), {
              id: uid('op'), type: 'apport', date: form.date, parcelleId: form.parcelleId,
              volume, poidsKg: form.poidsKg ? Number(form.poidsKg) : null,
              contenantId: form.contenantId, notes: form.notes, auteur: user.id,
            }],
          },
        };
      });
      return true;
    }

    // Contenant vide → création d'un nouveau lot
    const id = uid('lot');
    const code = form.code && form.code.trim()
      ? form.code.trim()
      : `${String(form.millesime).slice(-2)}${(cep ? cep.nom : 'XX').slice(0, 3).toUpperCase()}-${parcelle ? parcelle.nom.replace(/\s+/g, '') : ''}`;
    setLots((prev) => ({
      ...prev,
      [id]: {
        id, code, nom: form.nom || '', millesime: Number(form.millesime),
        appellation: form.appellation || (parcelle ? parcelle.appellation : ''),
        composition: [{ parcelleId: form.parcelleId, pct: 100 }],
        contenants: [{ contenantId: form.contenantId, volume }],
        phase: 'vinification', statut: 'actif', parents: [],
        operations: [{
          id: uid('op'), type: 'apport', date: form.date, parcelleId: form.parcelleId,
          volume, poidsKg: form.poidsKg ? Number(form.poidsKg) : null,
          contenantId: form.contenantId, notes: form.notes, auteur: user.id,
        }],
        createdAt: new Date().toISOString(),
      },
    }));
    setLotOuvert(id);
    return true;
  };

  /* =========================================================================
     TRANSFERT / ASSEMBLAGE — le cœur du moteur
     ========================================================================= */

  const executerTransfert = (form) => {
    const volume = Number(form.volume);
    const { lotSourceId, contenantSourceId, contenantDestId, date, motif, note } = form;
    if (!lotSourceId || !contenantSourceId || !contenantDestId || !volume || volume <= 0) {
      alert('Contenant source, contenant destination et volume sont obligatoires'); return false;
    }
    if (contenantSourceId === contenantDestId) { alert('Source et destination doivent être différentes'); return false; }

    const src = lots[lotSourceId];
    const ligneSrc = (src.contenants || []).find((c) => c.contenantId === contenantSourceId);
    if (!ligneSrc || ligneSrc.volume < volume) {
      alert(`Volume insuffisant : ${ligneSrc ? ligneSrc.volume : 0} hL disponibles dans ce contenant`); return false;
    }

    const dest = contenants[contenantDestId];
    const occDest = occupationParContenant[contenantDestId];
    const volDejaDest = occDest ? occDest.volume : 0;
    if (dest && dest.capacite && volDejaDest + volume > dest.capacite + 0.001) {
      if (!window.confirm(
        `Le volume dépasse la capacité de ${dest.nom} (${dest.capacite} hL). Continuer quand même ?`
      )) return false;
    }

    const volSrcTotal = volumeLot(src);
    const totalite = Math.abs(volume - volSrcTotal) < 0.001;
    const opCommune = { date, motif: motif || 'Transfert', note: note || '', auteur: user.id };

    setLots((prev) => {
      const next = { ...prev };
      const lotSrc = { ...next[lotSourceId] };

      /* --- Cas 1 : la destination contient déjà du vin --- */
      if (occDest && occDest.lotId !== lotSourceId) {
        const lotDest = { ...next[occDest.lotId] };
        const volDestTotal = volumeLot(lotDest);
        lotDest.composition = melangerCompositions(lotDest.composition, volDestTotal, lotSrc.composition, volume);
        lotDest.contenants = lotDest.contenants.map((c) =>
          c.contenantId === contenantDestId ? { ...c, volume: round2(c.volume + volume) } : c
        );
        lotDest.parents = [...new Set([...(lotDest.parents || []), lotSourceId])];
        lotDest.operations = [...(lotDest.operations || []), {
          id: uid('op'), type: 'reception', ...opCommune, volume,
          contenantSourceId, contenantDestId, lotAutreId: lotSourceId, lotAutreCode: lotSrc.code,
        }];
        next[occDest.lotId] = lotDest;

        lotSrc.contenants = lotSrc.contenants
          .map((c) => (c.contenantId === contenantSourceId ? { ...c, volume: round2(c.volume - volume) } : c))
          .filter((c) => c.volume > 0.001);
        lotSrc.operations = [...(lotSrc.operations || []), {
          id: uid('op'), type: 'transfert', ...opCommune, volume,
          contenantSourceId, contenantDestId, lotAutreId: occDest.lotId, lotAutreCode: lotDest.code,
        }];
        if (volumeLot(lotSrc) <= 0.001) lotSrc.statut = 'archive';
        next[lotSourceId] = lotSrc;
        return next;
      }

      /* --- Cas 2 : la destination est vide, on déplace tout le lot --- */
      if (!occDest && totalite && lotSrc.contenants.length === 1) {
        lotSrc.contenants = [{ contenantId: contenantDestId, volume }];
        lotSrc.operations = [...(lotSrc.operations || []), {
          id: uid('op'), type: 'deplacement', ...opCommune, volume, contenantSourceId, contenantDestId,
        }];
        next[lotSourceId] = lotSrc;
        return next;
      }

      /* --- Cas 3 : la destination est vide, transfert partiel → lot enfant --- */
      if (!occDest) {
        const idEnfant = uid('lot');
        const suffixe = Object.values(prev).filter((l) => (l.parents || []).includes(lotSourceId)).length + 1;
        next[idEnfant] = {
          id: idEnfant,
          code: `${lotSrc.code}/${suffixe}`,
          nom: lotSrc.nom, millesime: lotSrc.millesime, appellation: lotSrc.appellation,
          composition: (lotSrc.composition || []).map((c) => ({ ...c })),
          contenants: [{ contenantId: contenantDestId, volume }],
          phase: lotSrc.phase, statut: 'actif', parents: [lotSourceId],
          operations: [{
            id: uid('op'), type: 'origine', ...opCommune, volume,
            contenantSourceId, contenantDestId, lotAutreId: lotSourceId, lotAutreCode: lotSrc.code,
          }],
          createdAt: new Date().toISOString(),
        };
        lotSrc.contenants = lotSrc.contenants
          .map((c) => (c.contenantId === contenantSourceId ? { ...c, volume: round2(c.volume - volume) } : c))
          .filter((c) => c.volume > 0.001);
        lotSrc.operations = [...(lotSrc.operations || []), {
          id: uid('op'), type: 'transfert', ...opCommune, volume,
          contenantSourceId, contenantDestId, lotAutreId: idEnfant, lotAutreCode: next[idEnfant].code,
        }];
        if (volumeLot(lotSrc) <= 0.001) lotSrc.statut = 'archive';
        next[lotSourceId] = lotSrc;
        return next;
      }

      /* --- Cas 4 : le lot occupe déjà les deux contenants → simple répartition --- */
      lotSrc.contenants = lotSrc.contenants.map((c) => {
        if (c.contenantId === contenantSourceId) return { ...c, volume: round2(c.volume - volume) };
        if (c.contenantId === contenantDestId) return { ...c, volume: round2(c.volume + volume) };
        return c;
      }).filter((c) => c.volume > 0.001);
      lotSrc.operations = [...(lotSrc.operations || []), {
        id: uid('op'), type: 'deplacement', ...opCommune, volume, contenantSourceId, contenantDestId,
      }];
      next[lotSourceId] = lotSrc;
      return next;
    });
    return true;
  };

  /* =========================================================================
     AJOUT DE PRODUIT ŒNOLOGIQUE — décrémente le stock
     ========================================================================= */

  const ajouterProduitAuLot = (form) => {
    const { lotId, produitId, quantite, date, contenantId, numeroLotFournisseur, dluo, notes, manipType } = form;
    const q = Number(quantite);
    if (!lotId || !produitId || !q || q <= 0) { alert('Produit et quantité sont obligatoires'); return false; }
    const prod = produits[produitId];
    const dispo = stockProduit(prod);
    if (q > dispo) {
      if (!window.confirm(`Stock insuffisant (${dispo} ${prod.unite} disponibles). Enregistrer quand même ?`)) return false;
    }

    setProduits((prev) => ({
      ...prev,
      [produitId]: {
        ...prev[produitId],
        mouvements: [...(prev[produitId].mouvements || []), {
          id: uid('mv'), sens: 'sortie', quantite: q, date,
          motif: `Lot ${lots[lotId] ? lots[lotId].code : ''}`, numeroLotFournisseur: numeroLotFournisseur || '',
        }],
      },
    }));

    ajouterOperation(lotId, {
      type: 'ajout', date, produitId, produitNom: prod.nom, categorie: prod.categorie,
      quantite: q, unite: prod.unite, contenantId,
      numeroLotFournisseur: numeroLotFournisseur || '', dluo: dluo || '',
      manipType: manipType || null, notes: notes || '', auteur: user.id,
    });
    return true;
  };

  /* =========================================================================
     ANALYSES, TRAVAUX, PERTES, MANIPULATIONS RÉGLEMENTAIRES
     ========================================================================= */

  const enregistrerControle = (form) => {
    const t = form.temperature === '' || form.temperature === null || form.temperature === undefined ? null : Number(form.temperature);
    const d = form.densite === '' || form.densite === null || form.densite === undefined ? null : Number(form.densite);
    if (t === null && d === null) { alert('Saisis au moins une température ou une densité'); return false; }
    ajouterOperation(form.lotId, {
      type: 'controle', date: form.date, moment: form.moment || 'matin',
      heure: nowTime(), contenantId: form.contenantId,
      temperature: t, densite: d, notes: form.notes || '', auteur: user.id,
    });
    return true;
  };

  const enregistrerAnalyse = (form) => {
    const valeurs = {};
    Object.keys(form.valeurs || {}).forEach((k) => {
      if (form.valeurs[k] !== '' && form.valeurs[k] !== null) valeurs[k] = Number(form.valeurs[k]);
    });
    if (Object.keys(valeurs).length === 0) { alert('Saisis au moins une valeur'); return false; }
    ajouterOperation(form.lotId, {
      type: 'analyse', date: form.date, heure: form.heure, contenantId: form.contenantId,
      source: form.source || 'interne', valeurs, bulletins: form.bulletins || [],
      notes: form.notes || '', auteur: user.id,
    });
    return true;
  };

  const enregistrerTravail = (form) => {
    if (!form.action) { alert('Choisis une action'); return false; }
    ajouterOperation(form.lotId, {
      type: 'travail', date: form.date, heure: form.heure, action: form.action,
      contenantId: form.contenantId, duree: form.duree || '', notes: form.notes || '', auteur: user.id,
    });
    return true;
  };

  const enregistrerPerte = (form) => {
    const v = Number(form.volume);
    if (!v || v <= 0) { alert('Volume invalide'); return false; }
    const lot = lots[form.lotId];
    const ligne = (lot.contenants || []).find((c) => c.contenantId === form.contenantId);
    if (!ligne || ligne.volume < v) { alert('Volume insuffisant dans ce contenant'); return false; }
    setLots((prev) => {
      const l = { ...prev[form.lotId] };
      l.contenants = l.contenants
        .map((c) => (c.contenantId === form.contenantId ? { ...c, volume: round2(c.volume - v) } : c))
        .filter((c) => c.volume > 0.001);
      l.operations = [...(l.operations || []), {
        id: uid('op'), type: 'perte', date: form.date, volume: v,
        contenantId: form.contenantId, motif: form.motif || '', auteur: user.id,
      }];
      if (volumeLot(l) <= 0.001) l.statut = 'archive';
      return { ...prev, [form.lotId]: l };
    });
    return true;
  };

  const enregistrerManipulation = (form) => {
    if (!form.manipType) { alert('Choisis un type de manipulation'); return false; }
    ajouterOperation(form.lotId, {
      type: 'manipulation', manipType: form.manipType, date: form.date,
      contenantId: form.contenantId, produit: form.produit || '', quantiteProduit: form.quantiteProduit || '',
      volumeConcerne: form.volumeConcerne || '', titreAvant: form.titreAvant || '', titreApres: form.titreApres || '',
      designationAvant: form.designationAvant || '', designationApres: form.designationApres || '',
      responsable: form.responsable || '', dateFiltration: form.dateFiltration || '',
      critere8515: form.critere8515 || '', notes: form.notes || '', auteur: user.id,
    });
    return true;
  };

  /* =========================================================================
     MISE EN BOUTEILLE
     ========================================================================= */

  const mettreEnBouteille = (form) => {
    const lot = lots[form.lotId];
    if (!lot) return false;
    const lignes = (form.lignes || []).filter((l) => Number(l.nb) > 0);
    if (lignes.length === 0) { alert('Indique au moins un nombre de contenants'); return false; }
    const volumeL = lignes.reduce((s, l) => {
      const f = FORMATS_BOUTEILLE.find((x) => x.id === l.formatId);
      return s + (f ? f.litres * Number(l.nb) : 0);
    }, 0);
    const volumeHl = round2(volumeL / 100);
    const ligne = (lot.contenants || []).find((c) => c.contenantId === form.contenantId);
    if (!ligne) { alert('Choisis le contenant depuis lequel tu mets en bouteille'); return false; }
    if (ligne.volume + 0.001 < volumeHl) {
      if (!window.confirm(`Le volume mis (${volumeHl} hL) dépasse le contenu du contenant (${ligne.volume} hL). Continuer ?`)) return false;
    }
    if (!form.numeroLot) { alert('Le numéro de lot est obligatoire'); return false; }

    const cond = {
      id: uid('cond'), lotId: form.lotId, lotCode: lot.code, date: form.date,
      numeroLot: form.numeroLot, contenantId: form.contenantId,
      lignes: lignes.map((l) => ({ ...l, nb: Number(l.nb) })),
      volumeHl, embouteilleur: form.embouteilleur || '',
      designation: form.designation || `${lot.appellation || ''} ${lot.millesime || ''}`.trim(),
      fournisseurBouchons: form.fournisseurBouchons || '',
      fournisseurBouteilles: form.fournisseurBouteilles || '',
      notes: form.notes || '', auteur: user.id,
      // Photographie de la traçabilité au moment de la mise
      compositionFigee: (lot.composition || []).map((c) => ({ ...c })),
    };
    setConditionnements((prev) => [...prev, cond]);

    setLots((prev) => {
      const l = { ...prev[form.lotId] };
      l.contenants = l.contenants
        .map((c) => (c.contenantId === form.contenantId ? { ...c, volume: round2(Math.max(c.volume - volumeHl, 0)) } : c))
        .filter((c) => c.volume > 0.001);
      l.operations = [...(l.operations || []), {
        id: uid('op'), type: 'mise', date: form.date, volume: volumeHl,
        contenantId: form.contenantId, numeroLot: form.numeroLot, auteur: user.id,
      }];
      if (volumeLot(l) <= 0.001) { l.phase = 'conditionne'; l.statut = 'archive'; }
      return { ...prev, [form.lotId]: l };
    });
    return true;
  };

  /* =========================================================================
     LOTS — édition, phase, suppression
     ========================================================================= */

  const majLot = (lotId, champs) => setLots((prev) => ({ ...prev, [lotId]: { ...prev[lotId], ...champs } }));

  const basculerPhase = (lotId) => {
    const l = lots[lotId];
    const suivante = l.phase === 'vinification' ? 'elevage' : 'vinification';
    if (!window.confirm(suivante === 'elevage'
      ? 'Confirmer la fin de fermentation et le passage en élevage ?'
      : 'Repasser ce lot en vinification ?')) return;
    setLots((prev) => ({
      ...prev,
      [lotId]: {
        ...prev[lotId], phase: suivante,
        operations: [...(prev[lotId].operations || []), {
          id: uid('op'), type: 'phase', date: today(),
          notes: suivante === 'elevage' ? 'Fin de fermentation — passage en élevage' : 'Retour en vinification',
          auteur: user.id,
        }],
      },
    }));
    if (suivante === 'elevage') {
      genererPdfCuve(l, contenants, parcelles, cepages)
        .then((blob) => telechargerBlob(blob, `fin-vinification-${l.code.replace(/[^\w-]/g, '')}.pdf`))
        .catch((e) => alert("Le PDF de fin de vinification n'a pas pu être généré : " + (e && e.message ? e.message : 'erreur inconnue')));
    }
  };

  const supprimerLot = (lotId) => {
    const l = lots[lotId];
    if (!window.confirm(`Supprimer définitivement le lot ${l.code} et tout son historique ? Cette action est irréversible.`)) return;
    setLots((prev) => {
      const next = { ...prev };
      delete next[lotId];
      Object.keys(next).forEach((k) => {
        if ((next[k].parents || []).includes(lotId)) {
          next[k] = { ...next[k], parents: next[k].parents.filter((p) => p !== lotId) };
        }
      });
      return next;
    });
    setLotOuvert(null);
  };

  const supprimerOperation = (lotId, opId) => {
    const op = (lots[lotId].operations || []).find((o) => o.id === opId);
    if (!op) return;
    if (['transfert', 'reception', 'origine', 'deplacement', 'apport', 'perte', 'mise'].includes(op.type)) {
      alert("Cette opération a modifié des volumes : elle ne peut pas être supprimée sans casser la traçabilité. Enregistre une opération inverse à la place.");
      return;
    }
    if (!window.confirm('Supprimer cette ligne du suivi ?')) return;    setLots((prev) => ({
      ...prev,
      [lotId]: { ...prev[lotId], operations: prev[lotId].operations.filter((o) => o.id !== opId) },
    }));
  };

  /* =========================================================================
     RÉFÉRENTIEL
     ========================================================================= */

  const ajouterLieu = (f) => {
    if (!f.nom) { alert('Nom obligatoire'); return false; }
    const id = uid('lieu');
    setLieux((p) => ({ ...p, [id]: { id, nom: f.nom, type: f.type || 'cuverie', usage: f.usage || 'vinification' } }));
    return true;
  };
  const supprimerLieu = (id) => {
    const utilise = Object.values(contenants).some((c) => c.lieuId === id);
    if (utilise) { alert('Ce lieu contient des contenants : supprime-les ou déplace-les d\'abord.'); return; }
    if (!window.confirm('Supprimer ce lieu ?')) return;
    setLieux((p) => { const n = { ...p }; delete n[id]; return n; });
  };

  const ajouterContenants = (f) => {
    if (!f.lieuId) { alert('Choisis un lieu'); return false; }
    const lieu = lieux[f.lieuId];
    const estBarrique = lieu && lieu.type === 'chai_barriques';
    const nouveaux = {};

    if (f.mode === 'serie') {
      const debut = parseInt(f.debut, 10), fin = parseInt(f.fin, 10);
      if (isNaN(debut) || isNaN(fin) || fin < debut) { alert('Plage de numéros invalide'); return false; }
      if (fin - debut > 500) { alert('Plage trop large (500 max)'); return false; }
      for (let i = debut; i <= fin; i++) {
        const nom = `${f.prefixe || ''}${i}`;
        if (Object.values(contenants).some((c) => c.nom === nom && c.lieuId === f.lieuId)) continue;
        const id = uid('ct');
        nouveaux[id] = {
          id, nom, lieuId: f.lieuId,
          type: estBarrique ? 'barrique' : 'cuve',
          capacite: Number(f.capacite) || 0,
          materiau: f.materiau || (estBarrique ? 'Chêne' : 'Inox'),
          tonnelier: estBarrique ? (f.tonnelier || '') : '',
          annee: estBarrique ? (f.annee || '') : '',
        };
      }
    } else if (f.mode === 'lot_barriques') {
      const nb = parseInt(f.nbBarriques, 10);
      if (!f.nom || !nb || nb <= 0) { alert('Nom du lot et nombre de barriques obligatoires'); return false; }
      const id = uid('ct');
      nouveaux[id] = {
        id, nom: f.nom, lieuId: f.lieuId, type: 'lot_barriques',
        nbBarriques: nb, capaciteUnitaire: Number(f.capaciteUnitaire) || 2.25,
        capacite: round2(nb * (Number(f.capaciteUnitaire) || 2.25)),
        materiau: f.materiau || 'Chêne', tonnelier: f.tonnelier || '', annee: f.annee || '',
      };
    } else {
      if (!f.nom) { alert('Nom obligatoire'); return false; }
      const id = uid('ct');
      nouveaux[id] = {
        id, nom: f.nom, lieuId: f.lieuId,
        type: estBarrique ? 'barrique' : 'cuve',
        capacite: Number(f.capacite) || 0,
        materiau: f.materiau || (estBarrique ? 'Chêne' : 'Inox'),
        tonnelier: estBarrique ? (f.tonnelier || '') : '',
        annee: estBarrique ? (f.annee || '') : '',
      };
    }

    if (Object.keys(nouveaux).length === 0) { alert('Aucun contenant créé (noms déjà existants ?)'); return false; }
    setContenants((p) => ({ ...p, ...nouveaux }));
    return true;
  };

  const supprimerContenant = (id) => {
    if (occupationParContenant[id]) { alert('Ce contenant est occupé par un lot : vide-le d\'abord.'); return; }
    if (!window.confirm('Supprimer ce contenant ?')) return;
    setContenants((p) => { const n = { ...p }; delete n[id]; return n; });
  };

  const ajouterCepage = (f) => {
    if (!f.nom) { alert('Nom obligatoire'); return false; }
    if (Object.values(cepages).some((c) => c.nom.toLowerCase() === f.nom.toLowerCase())) {
      alert('Ce cépage existe déjà'); return false;
    }
    const id = uid('cep');
    setCepages((p) => ({ ...p, [id]: { id, nom: f.nom, couleur: f.couleur || 'rouge' } }));
    return true;
  };
  const supprimerCepage = (id) => {
    if (Object.values(parcelles).some((p) => p.cepageId === id)) {
      alert('Des parcelles utilisent ce cépage.'); return;
    }
    if (!window.confirm('Supprimer ce cépage ?')) return;
    setCepages((p) => { const n = { ...p }; delete n[id]; return n; });
  };

  const ajouterParcelles = (f) => {
    if (!f.cepageId) { alert('Choisis un cépage'); return false; }
    const noms = (f.nom || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (noms.length === 0) { alert('Indique au moins un nom de parcelle'); return false; }
    const nouveaux = {};
    noms.forEach((nom) => {
      if (Object.values(parcelles).some((p) => p.nom.toLowerCase() === nom.toLowerCase())) return;
      const id = uid('parc');
      nouveaux[id] = {
        id, nom, cepageId: f.cepageId,
        surface: Number(f.surface) || 0, appellation: f.appellation || '',
        anneePlantation: f.anneePlantation || '', commune: f.commune || '', cadastre: f.cadastre || '',
      };
    });
    if (Object.keys(nouveaux).length === 0) { alert('Ces parcelles existent déjà'); return false; }
    setParcelles((p) => ({ ...p, ...nouveaux }));
    return true;
  };
  const supprimerParcelle = (id) => {
    const utilisee = Object.values(lots).some((l) => (l.composition || []).some((c) => c.parcelleId === id));
    if (utilisee) { alert('Cette parcelle est référencée dans la traçabilité d\'un lot.'); return; }
    if (!window.confirm('Supprimer cette parcelle ?')) return;
    setParcelles((p) => { const n = { ...p }; delete n[id]; return n; });
  };

  const ajouterProduit = (f) => {
    if (!f.nom) { alert('Nom obligatoire'); return false; }
    const id = uid('prod');
    setProduits((p) => ({
      ...p,
      [id]: {
        id, nom: f.nom, categorie: f.categorie || 'Divers', unite: f.unite || 'kg',
        seuil: Number(f.seuil) || 0, fournisseur: f.fournisseur || '',
        manipType: f.manipType || '', mouvements: [],
      },
    }));
    return true;
  };
  const supprimerProduit = (id) => {
    if (!window.confirm('Supprimer ce produit et son historique de stock ?')) return;
    setProduits((p) => { const n = { ...p }; delete n[id]; return n; });
  };
  const entrerStock = (f) => {
    const q = Number(f.quantite);
    if (!q || q <= 0) { alert('Quantité invalide'); return false; }
    setProduits((p) => ({
      ...p,
      [f.produitId]: {
        ...p[f.produitId],
        mouvements: [...(p[f.produitId].mouvements || []), {
          id: uid('mv'), sens: 'entree', quantite: q, date: f.date,
          numeroLotFournisseur: f.numeroLotFournisseur || '', dluo: f.dluo || '',
          fournisseur: f.fournisseur || '', motif: 'Réception',
        }],
      },
    }));
    return true;
  };

  /* =========================================================================
     ASSISTANT DE PARAMÉTRAGE
     ========================================================================= */

  const terminerSetup = () => setDomaine((d) => ({ ...d, setupDone: true }));

  const chargerJeuDemo = () => {
    if (!window.confirm('Charger un exemple type (2 cuveries, 1 chai à barriques, cépages et parcelles génériques) ? Tes données actuelles seront conservées.')) return;
    const lCuverie = uid('lieu'), lElevage = uid('lieu'), lChai = uid('lieu');
    setLieux((p) => ({
      ...p,
      [lCuverie]: { id: lCuverie, nom: 'Cuverie de vinification', type: 'cuverie', usage: 'vinification' },
      [lElevage]: { id: lElevage, nom: "Cuverie d'élevage", type: 'cuverie', usage: 'elevage' },
      [lChai]: { id: lChai, nom: 'Chai à barriques', type: 'chai_barriques', usage: 'elevage' },
    }));
    const cts = {};
    for (let i = 1; i <= 12; i++) {
      const id = uid('ct') + i;
      cts[id] = { id, nom: `C${i}`, lieuId: lCuverie, type: 'cuve', capacite: 100, materiau: 'Inox' };
    }
    for (let i = 1; i <= 6; i++) {
      const id = uid('ct') + 'e' + i;
      cts[id] = { id, nom: `E${i}`, lieuId: lElevage, type: 'cuve', capacite: 200, materiau: 'Inox' };
    }
    const idLotBq = uid('ct') + 'bq';
    cts[idLotBq] = {
      id: idLotBq, nom: 'Lot barriques A', lieuId: lChai, type: 'lot_barriques',
      nbBarriques: 12, capaciteUnitaire: 2.25, capacite: 27, materiau: 'Chêne', tonnelier: 'Tonnelier A',
    };
    setContenants((p) => ({ ...p, ...cts }));

    const cepDefs = [
      { nom: 'Merlot', couleur: 'rouge' }, { nom: 'Cabernet Sauvignon', couleur: 'rouge' },
      { nom: 'Sauvignon Blanc', couleur: 'blanc' }, { nom: 'Sémillon', couleur: 'blanc' },
    ];
    const cepIds = {};
    const nouveauxCep = {};
    cepDefs.forEach((c) => { const id = uid('cep') + c.nom.slice(0, 2); cepIds[c.nom] = id; nouveauxCep[id] = { id, ...c }; });
    setCepages((p) => ({ ...p, ...nouveauxCep }));

    const nouvellesParc = {};
    [['P01', 'Merlot'], ['P02', 'Merlot'], ['P03', 'Cabernet Sauvignon'], ['P04', 'Sauvignon Blanc'], ['P05', 'Sémillon']]
      .forEach(([nom, cep]) => {
        const id = uid('parc') + nom;
        nouvellesParc[id] = { id, nom, cepageId: cepIds[cep], surface: 1.5, appellation: '', anneePlantation: '', commune: '', cadastre: '' };
      });
    setParcelles((p) => ({ ...p, ...nouvellesParc }));

    const nouveauxProd = {};
    [['Levure sèche active', 'Levures', 'g'], ['SO2 (solution 5 %)', 'SO2 & conservateurs', 'mL'],
     ['Nutriment azoté', 'Nutriments / activateurs', 'g'], ['Bentonite', 'Collage / clarification', 'g']]
      .forEach(([nom, categorie, unite]) => {
        const id = uid('prod') + nom.slice(0, 3);
        nouveauxProd[id] = { id, nom, categorie, unite, seuil: 0, fournisseur: '', manipType: '', mouvements: [] };
      });
    setProduits((p) => ({ ...p, ...nouveauxProd }));
  };

  /* =========================================================================
     EXPORTS
     ========================================================================= */

  const nomContenant = (id) => (contenants[id] ? contenants[id].nom : '—');
  const nomLieu = (id) => (lieux[id] ? lieux[id].nom : '—');
  const nomParcelle = (id) => (parcelles[id] ? parcelles[id].nom : '—');

  const exporterExcel = () => {
    const wb = XLSX.utils.book_new();

    /* Page de garde — mentions obligatoires du registre FGVB */
    const toutesDates = [];
    Object.values(lots).forEach((l) => (l.operations || []).forEach((o) => o.date && toutesDates.push(o.date)));
    toutesDates.sort();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['REGISTRE UNIQUE DE MANIPULATIONS'],
      [domaine.nom || ''],
      [],
      ['N° CVI / EVV', domaine.cvi || ''],
      ['Adresse exploitation', domaine.adresse || ''],
      ['Exploitant', domaine.exploitant || ''],
      ['Adresse exploitant', domaine.exploitantAdresse || ''],
      [],
      ['Date première opération', toutesDates[0] || ''],
      ['Date dernière opération', toutesDates[toutesDates.length - 1] || ''],
      [],
      ['Édité le', today()],
    ]), 'Exploitation');

    /* État de cave */
    const etat = [];
    lotsActifs.forEach((l) => {
      (l.contenants || []).forEach((c) => {
        etat.push({
          'Lot': l.code, 'Nom': l.nom || '', 'Millésime': l.millesime, 'Appellation': l.appellation || '',
          'Phase': l.phase, 'Contenant': nomContenant(c.contenantId),
          'Lieu': contenants[c.contenantId] ? nomLieu(contenants[c.contenantId].lieuId) : '',
          'Volume (hL)': c.volume,
          'Composition': libelleComposition(l, parcelles, cepages),
        });
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(etat), 'État de cave');

    /* Entrées de vendange */
    const vendanges = [];
    Object.values(lots).forEach((l) => {
      (l.operations || []).filter((o) => o.type === 'apport').forEach((o) => {
        const parc = parcelles[o.parcelleId];
        const cep = parc ? cepages[parc.cepageId] : null;
        vendanges.push({
          'Date': o.date, 'Commune': parc ? parc.commune : '', 'Parcelle': parc ? parc.nom : '',
          'Références cadastrales': parc ? parc.cadastre : '',
          'Cépage': cep ? cep.nom : '', 'Couleur': cep ? COULEURS[cep.couleur] : '',
          'Appellation': parc ? parc.appellation : '',
          'N° cuve': nomContenant(o.contenantId),
          'Capacité (hL)': contenants[o.contenantId] ? contenants[o.contenantId].capacite : '',
          'Volume mis en cuve (hL)': o.volume, 'Poids (kg)': o.poidsKg || '',
          'Lot': l.code, 'Observations': o.notes || '',
        });
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vendanges), 'Entrées vendange');

    /* Suivi (analyses + travaux) */
    const suivi = [];
    Object.values(lots).forEach((l) => {
      (l.operations || []).filter((o) => o.type === 'analyse' || o.type === 'travail').forEach((o) => {
        const ligne = {
          'Date': o.date, 'Heure': o.heure || '', 'Lot': l.code,
          'Contenant': nomContenant(o.contenantId), 'Type': o.type === 'analyse' ? 'Analyse' : 'Travail',
          'Action': o.action || '', 'Notes': o.notes || '', 'Saisi par': o.auteur || '',
        };
        PARAMS_ANALYSE.forEach((p) => {
          ligne[`${p.label}${p.unite ? ` (${p.unite})` : ''}`] = o.valeurs && o.valeurs[p.id] !== undefined ? o.valeurs[p.id] : '';
        });
        suivi.push(ligne);
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(suivi), 'Suivi cuves');

    /* Mouvements */
    const mvts = [];
    Object.values(lots).forEach((l) => {
      (l.operations || []).filter((o) => ['transfert', 'reception', 'origine', 'deplacement', 'perte', 'mise'].includes(o.type)).forEach((o) => {
        mvts.push({
          'Date': o.date, 'Lot': l.code, 'Type': o.type, 'Motif': o.motif || '',
          'Contenant source': nomContenant(o.contenantSourceId || o.contenantId),
          'Contenant destination': o.contenantDestId ? nomContenant(o.contenantDestId) : '',
          'Autre lot': o.lotAutreCode || '', 'Volume (hL)': o.volume, 'Note': o.note || o.motif || '',
        });
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mvts), 'Mouvements');

    /* Intrants œnologiques */
    const intrants = [];
    Object.values(lots).forEach((l) => {
      (l.operations || []).filter((o) => o.type === 'ajout').forEach((o) => {
        intrants.push({
          'Date': o.date, 'Lot': l.code, 'Contenant': nomContenant(o.contenantId),
          'Produit': o.produitNom, 'Catégorie': o.categorie || '',
          'Quantité': o.quantite, 'Unité': o.unite || '',
          'N° lot fournisseur': o.numeroLotFournisseur || '', 'DLUO': o.dluo || '',
          'Notes': o.notes || '', 'Saisi par': o.auteur || '',
        });
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(intrants), 'Intrants');

    /* Un onglet par registre réglementaire */
    Object.keys(MANIP_TYPES).forEach((type) => {
      const lignes = [];
      Object.values(lots).forEach((l) => {
        (l.operations || []).filter((o) => o.type === 'manipulation' && o.manipType === type).forEach((o) => {
          lignes.push({
            'Date': o.date, 'N° cuve / lot barriques': nomContenant(o.contenantId), 'Lot': l.code,
            'Volume concerné (hL)': o.volumeConcerne || '',
            'Dénomination complète': `${l.appellation || ''} ${l.millesime || ''}`.trim(),
            'Produit utilisé': o.produit || '', 'Quantité produit': o.quantiteProduit || '',
            'Titre avant': o.titreAvant || '', 'Titre après': o.titreApres || '',
            'Désignation avant': o.designationAvant || '', 'Désignation après': o.designationApres || '',
            'Responsable / œnologue': o.responsable || '', 'Date filtration': o.dateFiltration || '',
            'Règle 85/15': o.critere8515 || '', 'Observations': o.notes || '',
          });
        });
      });
      if (lignes.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lignes), MANIP_TYPES[type].sheet);
    });

    /* Conditionnement / identification des lots */
    if (conditionnements.length) {
      const cond = [];
      conditionnements.forEach((c) => {
        c.lignes.forEach((li) => {
          const f = FORMATS_BOUTEILLE.find((x) => x.id === li.formatId);
          cond.push({
            'Date de mise': c.date, 'N° de lot': c.numeroLot, 'Lot vin': c.lotCode,
            'Désignation': c.designation || '', 'N° cuve': nomContenant(c.contenantId),
            'Format': f ? f.label : li.formatId, 'Nombre': li.nb,
            'Volume total (hL)': c.volumeHl, 'Embouteilleur': c.embouteilleur || '',
            'Fournisseur bouteilles': c.fournisseurBouteilles || '',
            'Fournisseur bouchons': c.fournisseurBouchons || '',
          });
        });
      });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cond), 'Conditionnement');
    }

    /* Stock produits */
    const stock = Object.values(produits).map((p) => ({
      'Produit': p.nom, 'Catégorie': p.categorie, 'Stock': stockProduit(p), 'Unité': p.unite,
      'Seuil d\'alerte': p.seuil || '', 'Fournisseur': p.fournisseur || '',
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stock), 'Stock produits');

    /* Détail par lot fournisseur — traçabilité amont des intrants */
    const lotsFournisseur = [];
    Object.values(produits).forEach((p) => {
      stockParLotFournisseur(p).forEach((l) => {
        lotsFournisseur.push({
          'Produit': p.nom, 'Catégorie': p.categorie, 'N° lot fournisseur': l.numeroLot,
          'Quantité reçue': l.entre, 'Quantité utilisée': l.sorti, 'Reste': l.reste, 'Unité': p.unite,
          'DLUO': l.dluo || '', 'Première réception': l.premiereEntree || '', 'Fournisseur': l.fournisseur || '',
        });
      });
    });
    if (lotsFournisseur.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lotsFournisseur), 'Lots fournisseur');
    }

    /* Mouvements de stock — entrées et sorties détaillées */
    const mvtStock = [];
    Object.values(produits).forEach((p) => {
      (p.mouvements || []).forEach((m) => {
        mvtStock.push({
          'Date': m.date, 'Produit': p.nom, 'Sens': m.sens === 'entree' ? 'Entrée' : 'Sortie',
          'Quantité': m.quantite, 'Unité': p.unite,
          'N° lot fournisseur': m.numeroLotFournisseur || '', 'DLUO': m.dluo || '',
          'Fournisseur': m.fournisseur || '', 'Motif / destination': m.motif || '',
        });
      });
    });
    if (mvtStock.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
        mvtStock.sort((a, b) => (b.Date || '').localeCompare(a.Date || ''))
      ), 'Mouvements stock');
    }

    /* Relevés température & densité */
    const releves = [];
    Object.values(lots).forEach((l) => {
      (l.operations || []).filter((o) => o.type === 'controle').forEach((o) => {
        releves.push({
          'Date': o.date,
          'Moment': o.moment === 'matin' ? 'Matin' : o.moment === 'soir' ? 'Soir' : 'Contrôle',
          'Heure': o.heure || '', 'Lot': l.code, 'Contenant': nomContenant(o.contenantId),
          'Température (°C)': o.temperature !== null && o.temperature !== undefined ? o.temperature : '',
          'Densité': o.densite !== null && o.densite !== undefined ? o.densite : '',
          'Observation': o.notes || '', 'Saisi par': o.auteur || '',
        });
      });
    });
    if (releves.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
        releves.sort((a, b) => (b.Date + b.Heure).localeCompare(a.Date + a.Heure))
      ), 'Relevés T° densité');
    }

    /* Analyses — une ligne par analyse, une colonne par paramètre */
    const lignesAnalyses = [];
    Object.values(lots).forEach((l) => {
      (l.operations || []).filter((o) => o.type === 'analyse').forEach((o) => {
        const ligne = {
          'Date': o.date, 'Heure': o.heure || '', 'Lot': l.code,
          'Contenant': nomContenant(o.contenantId),
          'Origine': o.source === 'labo' ? 'Laboratoire' : 'Interne',
        };
        PARAMS_ANALYSE.forEach((p) => {
          ligne[`${p.label}${p.unite ? ` (${p.unite})` : ''}`] = o.valeurs && o.valeurs[p.id] !== undefined ? o.valeurs[p.id] : '';
        });
        ligne['Bulletins joints'] = (o.bulletins || []).map((b) => b.nom).join(' · ');
        ligne['Notes'] = o.notes || '';
        lignesAnalyses.push(ligne);
      });
    });
    if (lignesAnalyses.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
        lignesAnalyses.sort((a, b) => (b.Date + b.Heure).localeCompare(a.Date + a.Heure))
      ), 'Analyses');
    }

    XLSX.writeFile(wb, `cahier-de-chai-${today()}.xlsx`);
  };

  /* Fiche de traçabilité d'un lot, au format tableur */
  const exporterTracabilite = (lotId) => {
    const lot = lots[lotId];
    if (!lot) return;
    const wb = XLSX.utils.book_new();
    const ops = operationsCompletes(lotId, lots);
    const chaine = lignageLot(lotId, lots);

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['FICHE DE TRAÇABILITÉ'],
      [domaine.nom || ''],
      [],
      ['Lot', lot.code], ['Nom', lot.nom || ''], ['Millésime', lot.millesime],
      ['Appellation', lot.appellation || ''], ['Phase', lot.phase],
      ['Volume actuel (hL)', volumeLot(lot)],
      ['Contenants actuels', (lot.contenants || []).map((c) => `${nomContenant(c.contenantId)} (${c.volume} hL)`).join(' · ')],
      [],
      ['COMPOSITION PARCELLAIRE'],
      ...(lot.composition || []).map((c) => {
        const p = parcelles[c.parcelleId];
        const cep = p ? cepages[p.cepageId] : null;
        return [p ? p.nom : '?', cep ? cep.nom : '', `${round2(c.pct)} %`, p ? p.appellation || '' : ''];
      }),
      [],
      ['LOTS D\'ORIGINE'],
      ...chaine.map((l) => [l.code, l.nom || '', `millésime ${l.millesime}`]),
      [],
      ['Édité le', today()],
    ]), 'Traçabilité');

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ops.map((o) => ({
      'Date': o.date, 'Heure': o.heure || '', 'Lot': o._lotCode, 'Opération': o.type,
      'Détail': o.action || o.produitNom || o.motif || (o.manipType ? MANIP_TYPES[o.manipType].label : '')
        || (o.type === 'controle' ? `${o.moment === 'matin' ? 'Matin' : o.moment === 'soir' ? 'Soir' : 'Contrôle'} — ${o.temperature !== null && o.temperature !== undefined ? o.temperature + ' °C' : '—'} · densité ${o.densite !== null && o.densite !== undefined ? o.densite : '—'}` : '')
        || o.notes || '',
      'Contenant': nomContenant(o.contenantId || o.contenantSourceId),
      'Vers': o.contenantDestId ? nomContenant(o.contenantDestId) : '',
      'Volume (hL)': o.volume || '',
      'Quantité produit': o.quantite ? `${o.quantite} ${o.unite || ''}` : '',
      'N° lot fournisseur': o.numeroLotFournisseur || '',
      'Analyses': o.valeurs ? Object.keys(o.valeurs).map((k) => {
        const pa = PARAMS_ANALYSE.find((x) => x.id === k);
        return `${pa ? pa.label : k} ${o.valeurs[k]}${pa && pa.unite ? ' ' + pa.unite : ''}`;
      }).join(' · ') : '',
      'Saisi par': o.auteur || '',
    }))), 'Historique complet');

    XLSX.writeFile(wb, `tracabilite-${lot.code.replace(/[^\w-]/g, '')}-${today()}.xlsx`);
  };

  /* =========================================================================
     RENDU
     ========================================================================= */

  const [setupStep, setSetupStep] = useState(1);

  /* ---------- Connexion ---------- */
  if (authLoading) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <p className="login-eyebrow">{domaine.nom || 'Cahier de chai'}</p>
          <h1 className="login-title">Cahier de Chai</h1>
          <p className="login-hint">Connexion…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    const seConnecter = async () => {
      setLoginErreur('');
      if (!loginEmail.trim() || !loginPwd) { setLoginErreur('Email et mot de passe obligatoires.'); return; }
      setConnexionEnCours(true);
      const { error } = await supabase.auth.signInWithPassword({ email: loginEmail.trim(), password: loginPwd });
      setConnexionEnCours(false);
      if (error) { setLoginErreur('Connexion refusée : email ou mot de passe incorrect.'); return; }
      setLoginPwd('');
    };
    return (
      <div className="login-screen">
        <div className="login-card">
          <p className="login-eyebrow">{domaine.nom || 'Cahier de chai'}</p>
          <h1 className="login-title">Cahier de Chai</h1>
          <p className="login-sub">De la parcelle à la bouteille</p>
          <input type="email" placeholder="Email" value={loginEmail} autoComplete="username"
            onChange={(e) => setLoginEmail(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && seConnecter()} />
          <input type="password" placeholder="Mot de passe" value={loginPwd} autoComplete="current-password"
            onChange={(e) => setLoginPwd(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && seConnecter()} />
          {loginErreur && <p className="inline-note warn" style={{ marginBottom: 12 }}>{loginErreur}</p>}
          <button className="btn btn-primary btn-block" disabled={connexionEnCours} onClick={seConnecter}>
            {connexionEnCours ? 'Connexion…' : 'Ouvrir le cahier'}
          </button>
          <p className="login-hint">Accès personnel et sécurisé</p>
        </div>
      </div>
    );
  }

  const lot = lotOuvert && lots[lotOuvert] ? lots[lotOuvert] : null;

  /* ---------- Assistant de paramétrage ---------- */
  if (!domaine.setupDone) {
    const etapes = ['Domaine', 'Lieux', 'Contenants', 'Cépages', 'Parcelles', 'Produits'];
    const peutFinir = Object.keys(contenants).length > 0 && Object.keys(parcelles).length > 0;
    return (
      <div className="setup-screen">
        <div className="setup-card">
          <p className="login-eyebrow">Première configuration</p>
          <h1 className="setup-title">Paramétrons ton chai</h1>
          <p className="setup-sub">
            Tout est modifiable ensuite dans les réglages. Tu peux aussi partir d'un exemple type et l'adapter.
          </p>

          <div className="setup-steps">
            {etapes.map((e, i) => (
              <button key={e} className={`setup-step ${setupStep === i + 1 ? 'active' : ''} `} onClick={() => setSetupStep(i + 1)}>
                <span className="setup-step-num">{i + 1}</span>{e}
              </button>
            ))}
          </div>

          <div className="setup-body">
            {setupStep === 1 && (
              <>
                <Field label="Nom du domaine"><input type="text" value={domaine.nom} onChange={(e) => setDomaine({ ...domaine, nom: e.target.value })} /></Field>
                <div className="field-grid">
                  <Field label="N° CVI / EVV"><input type="text" value={domaine.cvi} onChange={(e) => setDomaine({ ...domaine, cvi: e.target.value })} /></Field>
                  <Field label="Exploitant / raison sociale"><input type="text" value={domaine.exploitant} onChange={(e) => setDomaine({ ...domaine, exploitant: e.target.value })} /></Field>
                </div>
                <Field label="Adresse de l'exploitation" hint="Reprise en page de garde du registre réglementaire">
                  <input type="text" value={domaine.adresse} onChange={(e) => setDomaine({ ...domaine, adresse: e.target.value })} />
                </Field>
                <button className="btn btn-outline" onClick={chargerJeuDemo}>Partir d'un exemple type</button>
              </>
            )}

            {setupStep === 2 && (
              <>
                <p className="setup-help">Combien as-tu de cuveries et de chais à barriques, et à quoi sert chacun ?</p>
                <div className="ref-list">
                  {Object.values(lieux).length === 0
                    ? <p className="muted">Aucun lieu pour l'instant.</p>
                    : Object.values(lieux).map((l) => (
                      <div className="ref-list-row" key={l.id}>
                        <span>{l.nom} <span className="muted">· {l.type === 'cuverie' ? 'Cuverie' : 'Chai à barriques'} · {USAGES_LIEU[l.usage]}</span></span>
                        <button className="btn btn-danger btn-sm" onClick={() => supprimerLieu(l.id)}>Retirer</button>
                      </div>
                    ))}
                </div>
                <button className="btn btn-primary" onClick={() => ouvrir('lieu')}>+ Ajouter un lieu</button>
              </>
            )}

            {setupStep === 3 && (
              <>
                <p className="setup-help">Combien de cuves par cuverie, combien de barriques par chai ? La création en série va vite.</p>
                {Object.keys(lieux).length === 0 ? (
                  <p className="muted">Crée d'abord au moins un lieu à l'étape précédente.</p>
                ) : (
                  <>
                    {Object.values(lieux).map((l) => {
                      const liste = Object.values(contenants).filter((c) => c.lieuId === l.id);
                      return (
                        <div className="setup-group" key={l.id}>
                          <div className="setup-group-head">
                            <strong>{l.nom}</strong>
                            <span className="muted">{liste.length} contenant{liste.length > 1 ? 's' : ''} · {round2(liste.reduce((s, c) => s + (c.capacite || 0), 0))} hL</span>
                            <button className="btn btn-outline btn-sm" onClick={() => ouvrir('contenants', { lieuId: l.id })}>+ Ajouter</button>
                          </div>
                          <div className="chips-wrap">
                            {liste.map((c) => <span className="chip" key={c.id}>{c.nom}{c.capacite ? ` · ${c.capacite} hL` : ''}</span>)}
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            )}

            {setupStep === 4 && (
              <>
                <p className="setup-help">La couleur du cépage détermine celle de tes lots dans toute l'application.</p>
                <div className="chips-wrap">
                  {Object.values(cepages).map((c) => (
                    <span className="chip" key={c.id}>
                      <ColorDot couleur={c.couleur} />{c.nom}
                      <button onClick={() => supprimerCepage(c.id)}>✕</button>
                    </span>
                  ))}
                </div>
                <button className="btn btn-primary" onClick={() => ouvrir('cepage')}>+ Ajouter un cépage</button>
              </>
            )}

            {setupStep === 5 && (
              <>
                <p className="setup-help">Chaque parcelle porte un cépage. C'est le point de départ de toute la traçabilité.</p>
                {Object.keys(cepages).length === 0 ? (
                  <p className="muted">Crée d'abord au moins un cépage.</p>
                ) : (
                  <>
                    {Object.values(cepages).map((cep) => {
                      const liste = Object.values(parcelles).filter((p) => p.cepageId === cep.id);
                      return (
                        <div className="setup-group" key={cep.id}>
                          <div className="setup-group-head">
                            <strong><ColorDot couleur={cep.couleur} />{cep.nom}</strong>
                            <span className="muted">{liste.length} parcelle{liste.length > 1 ? 's' : ''}</span>
                          </div>
                          <div className="chips-wrap">
                            {liste.map((p) => (
                              <span className="chip" key={p.id}>{p.nom}<button onClick={() => supprimerParcelle(p.id)}>✕</button></span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    <button className="btn btn-primary" onClick={() => ouvrir('parcelles')}>+ Ajouter des parcelles</button>
                  </>
                )}
              </>
            )}

            {setupStep === 6 && (
              <>
                <p className="setup-help">Optionnel — tu pourras compléter au fil de l'eau. Les stocks se décrémenteront tout seuls à chaque ajout en cuve.</p>
                <div className="ref-list">
                  {Object.values(produits).length === 0
                    ? <p className="muted">Aucun produit pour l'instant.</p>
                    : Object.values(produits).map((p) => (
                      <div className="ref-list-row" key={p.id}>
                        <span>{p.nom} <span className="muted">· {p.categorie} · {p.unite}</span></span>
                        <button className="btn btn-danger btn-sm" onClick={() => supprimerProduit(p.id)}>Retirer</button>
                      </div>
                    ))}
                </div>
                <button className="btn btn-primary" onClick={() => ouvrir('produit')}>+ Ajouter un produit</button>
              </>
            )}
          </div>

          <div className="setup-footer">
            <button className="btn btn-outline" disabled={setupStep === 1} onClick={() => setSetupStep((s) => Math.max(1, s - 1))}>Précédent</button>
            {setupStep < 6
              ? <button className="btn btn-primary" onClick={() => setSetupStep((s) => Math.min(6, s + 1))}>Suivant</button>
              : <button className="btn btn-primary" disabled={!peutFinir} onClick={terminerSetup}>Terminer</button>}
          </div>
          {!peutFinir && setupStep === 6 && (
            <p className="inline-note warn">Il faut au minimum un contenant et une parcelle pour commencer.</p>
          )}
        </div>
        {rendreModales()}
      </div>
    );
  }

  /* ---------- Fonctions de rendu partagées ---------- */

  function rendreModales() {
    if (!modale) return null;
    const { type, payload } = modale;
    switch (type) {
      case 'apport':
        return <ModaleApport parcelles={parcelles} cepages={cepages} contenants={contenants} lieux={lieux}
          occupation={occupationParContenant} lots={lots} onValider={apporterVendange} onFermer={fermer} />;
      case 'transfert':
        return <ModaleTransfert lot={lots[payload.lotId]} contenants={contenants} lieux={lieux}
          occupation={occupationParContenant} lots={lots} parcelles={parcelles} cepages={cepages}
          onValider={executerTransfert} onFermer={fermer} />;
      case 'ajoutProduit':
        return <ModaleAjoutProduit lot={lots[payload.lotId]} produits={produits} contenants={contenants}
          onValider={ajouterProduitAuLot} onFermer={fermer} />;
      case 'analyse':
        return <ModaleAnalyse lot={lots[payload.lotId]} contenants={contenants} onValider={enregistrerAnalyse} onFermer={fermer} />;
      case 'controle':
        return <ModaleControle lot={lots[payload.lotId]} contenants={contenants} onValider={enregistrerControle} onFermer={fermer} />;
      case 'travail':
        return <ModaleTravail lot={lots[payload.lotId]} contenants={contenants} onValider={enregistrerTravail} onFermer={fermer} />;
      case 'perte':
        return <ModalePerte lot={lots[payload.lotId]} contenants={contenants} onValider={enregistrerPerte} onFermer={fermer} />;
      case 'manipulation':
        return <ModaleManipulation lot={lots[payload.lotId]} contenants={contenants} typeInitial={payload.manipType}
          onValider={enregistrerManipulation} onFermer={fermer} />;
      case 'mise':
        return <ModaleMise lot={lots[payload.lotId]} contenants={contenants} conditionnements={conditionnements}
          parcelles={parcelles} cepages={cepages} onValider={mettreEnBouteille} onFermer={fermer} />;
      case 'editLot':
        return <ModaleEditLot lot={lots[payload.lotId]} onValider={(f) => majLot(payload.lotId, f)} onFermer={fermer} />;
      case 'lieu':
        return <ModaleLieu onValider={ajouterLieu} onFermer={fermer} />;
      case 'contenants':
        return <ModaleContenants lieux={lieux} lieuInitial={payload.lieuId} onValider={ajouterContenants} onFermer={fermer} />;
      case 'cepage':
        return <ModaleCepage onValider={ajouterCepage} onFermer={fermer} />;
      case 'parcelles':
        return <ModaleParcelles cepages={cepages} onValider={ajouterParcelles} onFermer={fermer} />;
      case 'produit':
        return <ModaleProduit onValider={ajouterProduit} onFermer={fermer} />;
      case 'entreeStock':
        return <ModaleEntreeStock produit={produits[payload.produitId]} onValider={entrerStock} onFermer={fermer} />;
      case 'produitDetail':
        return <ModaleProduitDetail produit={produits[payload.produitId]}
          onEntree={() => ouvrir('entreeStock', { produitId: payload.produitId })} onFermer={fermer} />;
      default:
        return null;
    }
  }

  const ouvrirLot = (id) => { setLotOuvert(id); setVue('cave'); setOngletLot('suivi'); };

  /* ---------- Application ---------- */
  const NAV = [
    { id: 'accueil', label: 'Vue de la cave', icone: '◱' },
    { id: 'releve', label: 'Relevé de cave', icone: '◷' },
    { id: 'cave', label: 'Cuverie & lots', icone: '◧' },
    { id: 'produits', label: 'Produits œnologiques', icone: '◇' },
    { id: 'registre', label: 'Registre réglementaire', icone: '§' },
    { id: 'mise', label: 'Mise en bouteille', icone: '⬦' },
    { id: 'parametres', label: 'Paramètres', icone: '⚙' },
  ];

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="brand">
          <span className="brand-eyebrow">{domaine.nom || 'Domaine'}</span>
          <span className="brand-title">Cahier de Chai</span>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-primary" onClick={() => ouvrir('apport')}>+ Apport de vendange</button>
          <span className="muted small sync-status">
            {syncEtat.statut === 'en_cours' ? 'Synchronisation…'
              : syncEtat.statut === 'horsligne' ? 'Hors ligne — données locales'
              : syncEtat.quand ? `Synchronisé ${syncEtat.quand.toTimeString().slice(0, 5)}` : ''}
          </span>
          <span className="user-chip"><span className="dot" />{user.id}</span>
          <button className="btn btn-ghost light" onClick={async () => { await supabase.auth.signOut(); setLotOuvert(null); }}>Quitter</button>
        </div>
      </div>

      <div className="workspace">
        <nav className="sidebar">
          {NAV.map((n) => (
            <button key={n.id} className={`nav-item ${vue === n.id ? 'active' : ''}`}
              onClick={() => { setVue(n.id); if (n.id !== 'cave') setLotOuvert(null); }}>
              <span className="nav-icone">{n.icone}</span>{n.label}
            </button>
          ))}
          <div className="sidebar-footer">
            {alertesStock.length > 0 && (
              <button className="alerte-stock" onClick={() => setVue('produits')}>
                {alertesStock.length} produit{alertesStock.length > 1 ? 's' : ''} sous le seuil
              </button>
            )}
            {alertesPeremption.length > 0 && (
              <button className="alerte-stock" onClick={() => setVue('produits')}>
                {alertesPeremption.length} lot{alertesPeremption.length > 1 ? 's' : ''} proche{alertesPeremption.length > 1 ? 's' : ''} de la DLUO
              </button>
            )}
            <button className="btn btn-outline btn-block" onClick={exporterExcel}>Exporter le registre</button>
          </div>
        </nav>

        <main className="main-panel">
          {/* ===================== ACCUEIL ===================== */}
          {vue === 'accueil' && (
            <>
              <header className="page-head">
                <h1>Vue de la cave</h1>
                <p>{stats.nbLots} lot{stats.nbLots > 1 ? 's' : ''} en cave · {stats.contenantsOccupes} contenant{stats.contenantsOccupes > 1 ? 's' : ''} occupé{stats.contenantsOccupes > 1 ? 's' : ''} sur {stats.nbContenants}</p>
              </header>

              <div className="stat-strip">
                <div className="stat-card"><div className="stat-value">{stats.total} hL</div><div className="stat-label">Volume total en cave</div></div>
                <div className="stat-card"><div className="stat-value"><ColorDot couleur="rouge" />{stats.vRouge} hL</div><div className="stat-label">Rouge</div></div>
                <div className="stat-card"><div className="stat-value"><ColorDot couleur="blanc" />{stats.vBlanc} hL</div><div className="stat-label">Blanc</div></div>
                {stats.vRose > 0 && <div className="stat-card"><div className="stat-value"><ColorDot couleur="rose" />{stats.vRose} hL</div><div className="stat-label">Rosé</div></div>}
                <div className="stat-card"><div className="stat-value">{stats.nbVinif}</div><div className="stat-label">Lots en vinification</div></div>
                <div className="stat-card"><div className="stat-value">{stats.nbElevage}</div><div className="stat-label">Lots en élevage</div></div>
              </div>

              {stats.capaciteTotale > 0 && (
                <div className="panel">
                  <h3 className="panel-title">Remplissage de la cuverie</h3>
                  <div className="barre-remplissage">
                    <div className="barre-fill" style={{ width: `${Math.min((stats.total / stats.capaciteTotale) * 100, 100)}%` }} />
                  </div>
                  <p className="muted small">{stats.total} hL logés sur {stats.capaciteTotale} hL de capacité installée</p>
                </div>
              )}

              {alertesStock.length > 0 && (
                <div className="panel">
                  <h3 className="panel-title">Stocks sous le seuil</h3>
                  {alertesStock.map((p) => (
                    <div className="ref-list-row" key={p.id}>
                      <span>{p.nom} <span className="muted">· {p.categorie}</span></span>
                      <span className="warn-text">{stockProduit(p)} / {p.seuil} {p.unite}</span>
                    </div>
                  ))}
                </div>
              )}

              {alertesPeremption.length > 0 && (
                <div className="panel">
                  <h3 className="panel-title">DLUO à surveiller</h3>
                  {alertesPeremption.map((a) => (
                    <div className="ref-list-row" key={a.produit.id + a.numeroLot}>
                      <span>{a.produit.nom} <span className="muted">· lot {a.numeroLot} · reste {a.reste} {a.produit.unite}</span></span>
                      <span className="warn-text">{a.jours < 0 ? `périmé depuis ${-a.jours} j` : `dans ${a.jours} j`}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="panel">
                <div className="panel-head">
                  <h3 className="panel-title">Lots actifs</h3>
                  <button className="btn btn-outline btn-sm" onClick={() => setVue('cave')}>Tout voir</button>
                </div>
                {lotsActifs.length === 0 ? (
                  <EmptyState titre="La cave est vide"
                    texte="Enregistre un apport de vendange pour créer ton premier lot."
                    action={<button className="btn btn-primary" onClick={() => ouvrir('apport')}>+ Apport de vendange</button>} />
                ) : (
                  <div className="lot-grid">
                    {lotsActifs.slice(0, 8).map((l) => (
                      <button className="lot-card" key={l.id} onClick={() => ouvrirLot(l.id)}>
                        <Jauge volume={volumeLot(l)} capacite={(l.contenants || []).reduce((s, c) => s + ((contenants[c.contenantId] || {}).capacite || 0), 0)}
                          couleur={couleurLot(l, parcelles, cepages)} size="lg" />
                        <div className="lot-card-body">
                          <div className="lot-card-code"><ColorDot couleur={couleurLot(l, parcelles, cepages)} />{l.code}</div>
                          <div className="muted small">{(l.contenants || []).map((c) => nomContenant(c.contenantId)).join(', ')}</div>
                          <PhaseBadge phase={l.phase} />
                          <div className="lot-card-vol">{volumeLot(l)} hL</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ===================== RELEVÉ DE CAVE ===================== */}
          {vue === 'releve' && (
            <EcranReleve lots={lots} contenants={contenants} lieux={lieux} parcelles={parcelles} cepages={cepages}
              onEnregistrer={enregistrerControle} onOuvrirLot={ouvrirLot} />
          )}

          {/* ===================== CAVE ===================== */}
          {vue === 'cave' && !lot && (
            <>
              <header className="page-head">
                <div className="page-head-row">
                  <h1>Cuverie & lots</h1>
                  <div className="toggle">
                    <button className={modeCave === 'contenant' ? 'active' : ''} onClick={() => setModeCave('contenant')}>Par contenant</button>
                    <button className={modeCave === 'lot' ? 'active' : ''} onClick={() => setModeCave('lot')}>Par lot de vin</button>
                  </div>
                </div>
                <input className="recherche" placeholder="Rechercher un contenant, un lot, un cépage, une parcelle…"
                  value={recherche} onChange={(e) => setRecherche(e.target.value)} />
              </header>

              {modeCave === 'contenant' ? (
                Object.values(lieux).length === 0 ? (
                  <EmptyState titre="Aucun lieu configuré" texte="Ajoute une cuverie dans les paramètres."
                    action={<button className="btn btn-primary" onClick={() => setVue('parametres')}>Ouvrir les paramètres</button>} />
                ) : (
                  Object.values(lieux).map((lieu) => {
                    const liste = Object.values(contenants)
                      .filter((c) => c.lieuId === lieu.id)
                      .filter((c) => {
                        const q = recherche.trim().toLowerCase();
                        if (!q) return true;
                        const o = occupationParContenant[c.id];
                        const l = o ? lots[o.lotId] : null;
                        return c.nom.toLowerCase().includes(q)
                          || (l && l.code.toLowerCase().includes(q))
                          || (l && libelleComposition(l, parcelles, cepages).toLowerCase().includes(q));
                      })
                      .sort((a, b) => a.nom.localeCompare(b.nom, undefined, { numeric: true }));
                    if (!liste.length) return null;
                    return (
                      <section className="lieu-section" key={lieu.id}>
                        <h3 className="lieu-titre">
                          {lieu.nom}
                          <span className="muted small"> · {USAGES_LIEU[lieu.usage]} · {liste.length} contenant{liste.length > 1 ? 's' : ''}</span>
                        </h3>
                        <div className="contenant-grid">
                          {liste.map((c) => {
                            const o = occupationParContenant[c.id];
                            const l = o ? lots[o.lotId] : null;
                            return (
                              <button key={c.id} className={`contenant-card ${l ? 'plein' : 'vide'}`}
                                onClick={() => l && ouvrirLot(l.id)} disabled={!l}>
                                <Jauge volume={o ? o.volume : 0} capacite={c.capacite}
                                  couleur={l ? couleurLot(l, parcelles, cepages) : null} size="md" />
                                <div className="contenant-body">
                                  <div className="contenant-nom">{c.nom}</div>
                                  {l ? (
                                    <>
                                      <div className="contenant-lot"><ColorDot couleur={couleurLot(l, parcelles, cepages)} />{l.code}</div>
                                      <div className="muted small">{o.volume} hL{c.capacite ? ` / ${c.capacite}` : ''}</div>
                                    </>
                                  ) : (
                                    <div className="muted small">Vide{c.capacite ? ` · ${c.capacite} hL` : ''}</div>
                                  )}
                                  {c.type === 'lot_barriques' && <div className="muted small">{c.nbBarriques} barriques{c.tonnelier ? ` · ${c.tonnelier}` : ''}</div>}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })
                )
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr><th>Lot</th><th>Composition</th><th>Phase</th><th>Contenants</th><th>Volume</th><th></th></tr>
                    </thead>
                    <tbody>
                      {lotsActifs
                        .filter((l) => {
                          const q = recherche.trim().toLowerCase();
                          if (!q) return true;
                          return l.code.toLowerCase().includes(q) || (l.nom || '').toLowerCase().includes(q)
                            || libelleComposition(l, parcelles, cepages).toLowerCase().includes(q);
                        })
                        .map((l) => (
                          <tr key={l.id} onClick={() => ouvrirLot(l.id)} className="ligne-cliquable">
                            <td><strong><ColorDot couleur={couleurLot(l, parcelles, cepages)} />{l.code}</strong>{l.nom ? <div className="muted small">{l.nom}</div> : null}</td>
                            <td className="small">{compositionParCepage(l, parcelles, cepages).map((c) => `${c.pct} % ${c.nom}`).join(' · ') || '—'}</td>
                            <td><PhaseBadge phase={l.phase} /></td>
                            <td className="small">{(l.contenants || []).map((c) => `${nomContenant(c.contenantId)} (${c.volume})`).join(', ')}</td>
                            <td><strong>{volumeLot(l)} hL</strong></td>
                            <td className="muted">›</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {lotsActifs.length === 0 && (
                    <EmptyState titre="Aucun lot" texte="Enregistre un apport de vendange pour démarrer."
                      action={<button className="btn btn-primary" onClick={() => ouvrir('apport')}>+ Apport de vendange</button>} />
                  )}
                </div>
              )}
            </>
          )}

          {/* ===================== FICHE LOT ===================== */}
          {vue === 'cave' && lot && (() => {
            const couleur = couleurLot(lot, parcelles, cepages);
            const ops = [...(lot.operations || [])].sort((a, b) => (b.date + (b.heure || '')).localeCompare(a.date + (a.heure || '')));
            const analyses = (lot.operations || []).filter((o) => o.type === 'analyse');
            const controles = (lot.operations || []).filter((o) => o.type === 'controle');
            const donneesGraphe = analyses
              .filter((o) => o.valeurs && (o.valeurs.densite !== undefined || o.valeurs.temperature !== undefined))
              .sort((a, b) => (a.date + (a.heure || '')).localeCompare(b.date + (b.heure || '')))
              .map((o) => ({
                label: `${o.date.slice(5)} ${o.heure || ''}`.trim(),
                densite: o.valeurs.densite !== undefined ? o.valeurs.densite : null,
                temperature: o.valeurs.temperature !== undefined ? o.valeurs.temperature : null,
              }));
            const opsCompletes = operationsCompletes(lot.id, lots);
            const chaine = lignageLot(lot.id, lots);
            const intrants = opsCompletes.filter((o) => o.type === 'ajout');
            const manips = opsCompletes.filter((o) => o.type === 'manipulation');

            return (
              <>
                <button className="retour" onClick={() => setLotOuvert(null)}>‹ Retour à la cuverie</button>

                <header className="lot-head">
                  <div>
                    <div className="lot-head-titre">
                      <ColorDot couleur={couleur} />
                      <h1>{lot.code}</h1>
                      <PhaseBadge phase={lot.phase} />
                    </div>
                    {lot.nom && <p className="lot-head-nom">{lot.nom}</p>}
                    <p className="muted">
                      Millésime {lot.millesime}{lot.appellation ? ` · ${lot.appellation}` : ''} ·
                      {' '}{(lot.contenants || []).map((c) => `${nomContenant(c.contenantId)} (${c.volume} hL)`).join(' · ') || 'aucun contenant'}
                    </p>
                    <p className="composition-ligne">{libelleComposition(lot, parcelles, cepages) || 'Composition non renseignée'}</p>
                  </div>
                  <div className="lot-head-metrique">
                    <Jauge volume={volumeLot(lot)}
                      capacite={(lot.contenants || []).reduce((s, c) => s + ((contenants[c.contenantId] || {}).capacite || 0), 0)}
                      couleur={couleur} size="lg" />
                    <div>
                      <div className="metric-value">{volumeLot(lot)} hL</div>
                      <div className="metric-label">Volume actuel</div>
                    </div>
                  </div>
                </header>

                <div className="action-bar">
                  <button className="btn btn-primary btn-sm" onClick={() => ouvrir('controle', { lotId: lot.id })}>+ T° / Densité</button>
                  <button className="btn btn-outline btn-sm" onClick={() => ouvrir('analyse', { lotId: lot.id })}>+ Analyse</button>
                  <button className="btn btn-outline btn-sm" onClick={() => ouvrir('travail', { lotId: lot.id })}>+ Travail</button>
                  <button className="btn btn-outline btn-sm" onClick={() => ouvrir('ajoutProduit', { lotId: lot.id })}>+ Produit</button>
                  <button className="btn btn-outline btn-sm" onClick={() => ouvrir('transfert', { lotId: lot.id })}>Transfert / assemblage</button>
                  <button className="btn btn-outline btn-sm" onClick={() => ouvrir('manipulation', { lotId: lot.id })}>Registre</button>
                  <button className="btn btn-outline btn-sm" onClick={() => ouvrir('perte', { lotId: lot.id })}>Sortie de volume</button>
                  <button className="btn btn-outline btn-sm" onClick={() => basculerPhase(lot.id)}>
                    {lot.phase === 'elevage' ? 'Retour en vinification' : 'Fin de fermentation →'}
                  </button>
                  <button className="btn btn-outline btn-sm" onClick={() => ouvrir('mise', { lotId: lot.id })}>Mise en bouteille</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => ouvrir('editLot', { lotId: lot.id })}>Modifier</button>
                  <button className="btn btn-danger btn-sm" onClick={() => supprimerLot(lot.id)}>Supprimer</button>
                </div>

                <div className="tabs">
                  {[['suivi', 'Suivi'], ['controle', `T° & densité (${controles.length})`],
                    ['analyses', `Analyses (${analyses.length})`], ['tracabilite', 'Traçabilité'],
                    ['intrants', `Intrants (${intrants.length})`], ['mouvements', 'Mouvements'],
                    ['registre', `Registre (${manips.length})`]].map(([id, label]) => (
                    <button key={id} className={`tab-btn ${ongletLot === id ? 'active' : ''}`} onClick={() => setOngletLot(id)}>{label}</button>
                  ))}
                </div>

                {ongletLot === 'suivi' && (
                  <>
                    {donneesGraphe.length > 1 && (
                      <div className="panel">
                        <h3 className="panel-title">Densité et température</h3>
                        <ResponsiveContainer width="100%" height={260}>
                          <LineChart data={donneesGraphe}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--stone-200)" />
                            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                            <YAxis yAxisId="d" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                            <YAxis yAxisId="t" orientation="right" tick={{ fontSize: 11 }} />
                            <Tooltip /><Legend />
                            <Line yAxisId="d" type="monotone" dataKey="densite" name="Densité" stroke="var(--bordeaux-500)" dot connectNulls isAnimationActive={false} />
                            <Line yAxisId="t" type="monotone" dataKey="temperature" name="T° (°C)" stroke="var(--steel-500)" dot connectNulls isAnimationActive={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    )}

                    {ops.length === 0 ? (
                      <EmptyState titre="Aucun suivi" texte="Enregistre une analyse ou un travail de cave." />
                    ) : (
                      <div className="timeline">
                        {ops.map((o) => (
                          <div className="timeline-item" key={o.id}>
                            <div className="timeline-date">{o.date}{o.heure ? ` · ${o.heure}` : ''}</div>
                            <div className="timeline-body">
                              <div className="timeline-head">
                                <span className={`op-tag op-${o.type}`}>{
                                  { apport: 'Apport', analyse: 'Analyse', controle: 'Relevé', travail: 'Travail', ajout: 'Produit',
                                    transfert: 'Transfert', reception: 'Réception', origine: 'Origine',
                                    deplacement: 'Déplacement', perte: 'Sortie', manipulation: 'Registre',
                                    mise: 'Mise', phase: 'Phase' }[o.type] || o.type
                                }</span>
                                {o.contenantId && <span className="muted small">{nomContenant(o.contenantId)}</span>}
                                {['analyse', 'travail', 'manipulation', 'controle'].includes(o.type) && (
                                  <button className="btn btn-ghost btn-sm supprimer-op" onClick={() => supprimerOperation(lot.id, o.id)}>✕</button>
                                )}
                              </div>
                              {o.type === 'controle' && (
                                <div>
                                  {o.moment === 'matin' ? 'Matin' : o.moment === 'soir' ? 'Soir' : 'Contrôle'} —
                                  {o.temperature !== null && o.temperature !== undefined ? ` ${o.temperature} °C` : ' —'} ·
                                  densité {o.densite !== null && o.densite !== undefined ? o.densite : '—'}
                                </div>
                              )}
                              {o.type === 'analyse' && (
                                <div className="analyse-valeurs">
                                  {Object.keys(o.valeurs || {}).map((k) => {
                                    const p = PARAMS_ANALYSE.find((x) => x.id === k);
                                    return <span className="chip" key={k}>{p ? p.label : k} <strong>{o.valeurs[k]}</strong>{p && p.unite ? ` ${p.unite}` : ''}</span>;
                                  })}
                                </div>
                              )}
                              {o.type === 'travail' && <div>{o.action}{o.duree ? ` — ${o.duree}` : ''}</div>}
                              {o.type === 'ajout' && <div>{o.produitNom} — {o.quantite} {o.unite}{o.numeroLotFournisseur ? ` · lot ${o.numeroLotFournisseur}` : ''}</div>}
                              {o.type === 'apport' && <div>{nomParcelle(o.parcelleId)} — {o.volume} hL{o.poidsKg ? ` (${o.poidsKg} kg)` : ''}</div>}
                              {['transfert', 'reception', 'origine', 'deplacement'].includes(o.type) && (
                                <div>{o.motif} — {o.volume} hL · {nomContenant(o.contenantSourceId)} → {nomContenant(o.contenantDestId)}{o.lotAutreCode ? ` · lot ${o.lotAutreCode}` : ''}</div>
                              )}
                              {o.type === 'perte' && <div>{o.motif} — {o.volume} hL</div>}
                              {o.type === 'manipulation' && <div>{MANIP_TYPES[o.manipType].label}{o.produit ? ` — ${o.produit}` : ''}{o.quantiteProduit ? ` (${o.quantiteProduit})` : ''}</div>}
                              {o.type === 'mise' && <div>Lot {o.numeroLot} — {o.volume} hL</div>}
                              {o.notes && <div className="timeline-note">{o.notes}</div>}
                              {o.auteur && <div className="muted small">saisi par {o.auteur}</div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {ongletLot === 'controle' && (() => {
                  const ordre = (o) => o.date + (o.moment === 'soir' ? '2' : o.moment === 'matin' ? '1' : '3') + (o.heure || '');
                  // On fusionne les relevés rapides et les T°/densité issues des analyses de labo
                  const points = [
                    ...controles.map((o) => ({
                      id: o.id, date: o.date, moment: o.moment, heure: o.heure,
                      temperature: o.temperature, densite: o.densite, notes: o.notes,
                      contenantId: o.contenantId, origine: 'releve',
                    })),
                    ...analyses.filter((o) => o.valeurs && (o.valeurs.temperature !== undefined || o.valeurs.densite !== undefined))
                      .map((o) => ({
                        id: o.id, date: o.date, moment: 'analyse', heure: o.heure,
                        temperature: o.valeurs.temperature !== undefined ? o.valeurs.temperature : null,
                        densite: o.valeurs.densite !== undefined ? o.valeurs.densite : null,
                        notes: o.notes, contenantId: o.contenantId, origine: 'analyse',
                      })),
                  ].sort((a, b) => ordre(a).localeCompare(ordre(b)));

                  const courbe = points.map((p) => ({
                    label: `${p.date.slice(5)} ${p.moment === 'matin' ? 'M' : p.moment === 'soir' ? 'S' : ''}`.trim(),
                    temperature: p.temperature, densite: p.densite,
                  }));

                  // Regroupement par jour pour la lecture en tableau
                  const parJour = {};
                  points.forEach((p) => {
                    if (!parJour[p.date]) parJour[p.date] = { date: p.date, matin: null, soir: null, autres: [] };
                    if (p.moment === 'matin' && !parJour[p.date].matin) parJour[p.date].matin = p;
                    else if (p.moment === 'soir' && !parJour[p.date].soir) parJour[p.date].soir = p;
                    else parJour[p.date].autres.push(p);
                  });
                  const jours = Object.values(parJour).sort((a, b) => b.date.localeCompare(a.date));

                  const avecD = points.filter((p) => p.densite !== null && p.densite !== undefined);
                  const premiere = avecD[0], derniere = avecD[avecD.length - 1];
                  const chute = premiere && derniere && premiere !== derniere ? roundFin(premiere.densite - derniere.densite) : null;
                  const temps = points.filter((p) => p.temperature !== null && p.temperature !== undefined).map((p) => p.temperature);
                  const tMax = temps.length ? Math.max(...temps) : null;
                  const tMin = temps.length ? Math.min(...temps) : null;

                  const cellule = (p) => {
                    if (!p) return <span className="muted">—</span>;
                    return (
                      <>
                        <div className="mono">{p.temperature !== null && p.temperature !== undefined ? `${p.temperature} °C` : '—'}</div>
                        <div className="mono densite-cell">{p.densite !== null && p.densite !== undefined ? p.densite : '—'}</div>
                        {p.notes ? <div className="muted small">{p.notes}</div> : null}
                      </>
                    );
                  };

                  return (
                    <>
                      {points.length === 0 ? (
                        <EmptyState titre="Aucun relevé"
                          texte="Enregistre température et densité, matin et soir, pour suivre la fermentation."
                          action={<button className="btn btn-primary" onClick={() => ouvrir('controle', { lotId: lot.id })}>+ T° / Densité</button>} />
                      ) : (
                        <>
                          <div className="stat-strip">
                            <div className="stat-card">
                              <div className="stat-value">{derniere && derniere.densite !== null ? derniere.densite : '—'}</div>
                              <div className="stat-label">Dernière densité</div>
                            </div>
                            <div className="stat-card">
                              <div className="stat-value">{points[points.length - 1].temperature !== null && points[points.length - 1].temperature !== undefined ? `${points[points.length - 1].temperature} °C` : '—'}</div>
                              <div className="stat-label">Dernière température</div>
                            </div>
                            <div className="stat-card">
                              <div className="stat-value">{chute !== null ? `−${chute}` : '—'}</div>
                              <div className="stat-label">Chute de densité totale</div>
                            </div>
                            <div className="stat-card">
                              <div className="stat-value">{tMin !== null ? `${tMin} / ${tMax}` : '—'}</div>
                              <div className="stat-label">T° mini / maxi</div>
                            </div>
                            <div className="stat-card">
                              <div className="stat-value">{points.length}</div>
                              <div className="stat-label">Relevés</div>
                            </div>
                          </div>

                          <div className="panel">
                            <div className="panel-head">
                              <h3 className="panel-title">Courbe de fermentation</h3>
                              <button className="btn btn-primary btn-sm" onClick={() => ouvrir('controle', { lotId: lot.id })}>+ Relevé</button>
                            </div>
                            <ResponsiveContainer width="100%" height={300}>
                              <LineChart data={courbe}>
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--stone-200)" />
                                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                                <YAxis yAxisId="d" tick={{ fontSize: 11 }} domain={['auto', 'auto']}
                                  label={{ value: 'Densité', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: 'var(--stone-400)' } }} />
                                <YAxis yAxisId="t" orientation="right" tick={{ fontSize: 11 }} domain={['auto', 'auto']}
                                  label={{ value: '°C', angle: 90, position: 'insideRight', style: { fontSize: 11, fill: 'var(--stone-400)' } }} />
                                <Tooltip /><Legend />
                                <Line yAxisId="d" type="monotone" dataKey="densite" name="Densité"
                                  stroke="var(--bordeaux-500)" strokeWidth={2} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
                                <Line yAxisId="t" type="monotone" dataKey="temperature" name="Température (°C)"
                                  stroke="var(--steel-500)" strokeWidth={2} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
                              </LineChart>
                            </ResponsiveContainer>
                            <p className="muted small">M = matin, S = soir. Les températures et densités saisies dans une analyse de laboratoire sont intégrées à la courbe.</p>
                          </div>

                          <div className="panel">
                            <h3 className="panel-title">Journal des relevés</h3>
                            <table className="data-table compact controle-table">
                              <thead>
                                <tr><th>Date</th><th>Matin</th><th>Soir</th><th>Autres</th><th>Δ densité / jour</th></tr>
                              </thead>
                              <tbody>
                                {jours.map((j, i) => {
                                  const jourSuivant = jours[i + 1];
                                  const dJour = j.matin || j.soir || j.autres[0];
                                  const dPrec = jourSuivant ? (jourSuivant.matin || jourSuivant.soir || jourSuivant.autres[0]) : null;
                                  const delta = dJour && dPrec && dJour.densite !== null && dJour.densite !== undefined
                                    && dPrec.densite !== null && dPrec.densite !== undefined
                                    ? roundFin(dJour.densite - dPrec.densite) : null;
                                  return (
                                    <tr key={j.date}>
                                      <td className="nowrap"><strong>{j.date}</strong></td>
                                      <td>{cellule(j.matin)}</td>
                                      <td>{cellule(j.soir)}</td>
                                      <td>{j.autres.length ? j.autres.map((p) => <div key={p.id}>{cellule(p)}</div>) : <span className="muted">—</span>}</td>
                                      <td className={`mono ${delta !== null && delta < 0 ? 'down' : ''}`}>
                                        {delta !== null ? (delta > 0 ? `+${delta}` : delta) : '—'}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                    </>
                  );
                })()}

                {ongletLot === 'analyses' && (() => {
                  const tri = [...analyses].sort((a, b) => (a.date + (a.heure || '')).localeCompare(b.date + (b.heure || '')));
                  const utilises = PARAMS_ANALYSE.filter((p) => tri.some((o) => o.valeurs && o.valeurs[p.id] !== undefined));
                  const courbe = tri.map((o) => {
                    const pt = { label: `${o.date.slice(5)}${o.heure ? ` ${o.heure}` : ''}` };
                    PARAMS_ANALYSE.forEach((p) => { pt[p.id] = o.valeurs && o.valeurs[p.id] !== undefined ? o.valeurs[p.id] : null; });
                    return pt;
                  });
                  const COULEURS_COURBE = ['var(--bordeaux-500)', 'var(--steel-500)', 'var(--straw-500)', 'var(--green-600)', '#574a75', '#a0632f'];
                  const bulletins = [];
                  opsCompletes.filter((o) => o.type === 'analyse' && (o.bulletins || []).length)
                    .forEach((o) => (o.bulletins || []).forEach((b) => bulletins.push({ ...b, date: o.date, lotCode: o._lotCode })));

                  return (
                    <>
                      {tri.length === 0 ? (
                        <EmptyState titre="Aucune analyse" texte="Saisis une analyse ou importe un bulletin de laboratoire."
                          action={<button className="btn btn-primary" onClick={() => ouvrir('analyse', { lotId: lot.id })}>+ Analyse</button>} />
                      ) : (
                        <>
                          <div className="panel">
                            <div className="panel-head">
                              <h3 className="panel-title">Évolution</h3>
                              <button className="btn btn-primary btn-sm" onClick={() => ouvrir('analyse', { lotId: lot.id })}>+ Analyse</button>
                            </div>
                            <div className="param-picker">
                              {utilises.map((p) => (
                                <button key={p.id}
                                  className={`param-chip ${paramsGraphe.includes(p.id) ? 'on' : ''}`}
                                  onClick={() => setParamsGraphe((prev) => prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id])}>
                                  {p.label}
                                </button>
                              ))}
                            </div>
                            {paramsGraphe.filter((id) => utilises.some((u) => u.id === id)).length === 0 ? (
                              <p className="muted small">Choisis au moins un paramètre à tracer.</p>
                            ) : (
                              <ResponsiveContainer width="100%" height={300}>
                                <LineChart data={courbe}>
                                  <CartesianGrid strokeDasharray="3 3" stroke="var(--stone-200)" />
                                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                                  <YAxis yAxisId="g" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                                  <Tooltip /><Legend />
                                  {paramsGraphe.filter((id) => utilises.some((u) => u.id === id)).map((id, i) => {
                                    const p = PARAMS_ANALYSE.find((x) => x.id === id);
                                    return <Line key={id} yAxisId="g" type="monotone" dataKey={id}
                                      name={`${p.label}${p.unite ? ` (${p.unite})` : ''}`}
                                      stroke={COULEURS_COURBE[i % COULEURS_COURBE.length]} dot connectNulls isAnimationActive={false} />;
                                  })}
                                </LineChart>
                              </ResponsiveContainer>
                            )}
                            <p className="muted small">
                              Les paramètres d'échelles très différentes (densité et SO₂ par exemple) se lisent mal ensemble :
                              affiche-les séparément pour comparer.
                            </p>
                          </div>

                          <div className="panel">
                            <h3 className="panel-title">Tableau de suivi</h3>
                            <div className="table-scroll">
                              <table className="data-table compact analyse-table">
                                <thead>
                                  <tr>
                                    <th className="col-fixe">Paramètre</th>
                                    {tri.map((o) => (
                                      <th key={o.id} className="nowrap">
                                        {o.date.slice(5)}
                                        <div className="muted small">{o.heure || ''}{o.source === 'labo' ? ' labo' : ''}</div>
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {utilises.map((p) => {
                                    const vals = tri.map((o) => (o.valeurs && o.valeurs[p.id] !== undefined ? o.valeurs[p.id] : null));
                                    return (
                                      <tr key={p.id}>
                                        <td className="col-fixe"><strong>{p.label}</strong>{p.unite ? <div className="muted small">{p.unite}</div> : null}</td>
                                        {vals.map((v, i) => {
                                          const prec = i > 0 ? vals.slice(0, i).reverse().find((x) => x !== null) : null;
                                          const delta = v !== null && prec !== null && prec !== undefined ? roundFin(v - prec) : null;
                                          return (
                                            <td key={i} className="mono">
                                              {v !== null ? v : '—'}
                                              {delta !== null && delta !== 0 && (
                                                <div className={`delta ${delta > 0 ? 'up' : 'down'}`}>{delta > 0 ? '+' : ''}{delta}</div>
                                              )}
                                            </td>
                                          );
                                        })}
                                      </tr>
                                    );
                                  })}
                                  <tr>
                                    <td className="col-fixe"><strong>Contenant</strong></td>
                                    {tri.map((o) => <td key={o.id} className="small">{nomContenant(o.contenantId)}</td>)}
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </>
                      )}

                      <div className="panel">
                        <div className="panel-head">
                          <h3 className="panel-title">Bulletins de laboratoire ({bulletins.length})</h3>
                          <button className="btn btn-outline btn-sm" onClick={() => ouvrir('analyse', { lotId: lot.id })}>+ Importer</button>
                        </div>
                        {bulletins.length === 0 ? (
                          <p className="muted">Aucun bulletin rattaché. Tu peux en importer un en créant une analyse.</p>
                        ) : (
                          <table className="data-table compact">
                            <thead><tr><th>Date</th><th>Fichier</th><th>Taille</th><th>Lot</th><th></th></tr></thead>
                            <tbody>
                              {bulletins.sort((a, b) => b.date.localeCompare(a.date)).map((b) => (
                                <tr key={b.id}>
                                  <td className="nowrap">{b.date}</td>
                                  <td>📄 {b.nom}</td>
                                  <td className="small">{formaterTaille(b.taille)}</td>
                                  <td className="small">{b.lotCode}</td>
                                  <td><button className="btn btn-outline btn-sm" onClick={() => ouvrirBulletin(b.id)}>Ouvrir</button></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        <p className="muted small">
                          Les bulletins sont stockés dans ce navigateur, séparément du reste. Ils ne suivent pas l'export Excel :
                          garde tes originaux archivés de ton côté.
                        </p>
                      </div>
                    </>
                  );
                })()}

                {ongletLot === 'tracabilite' && (
                  <>
                    <div className="panel">
                      <div className="panel-head">
                        <h3 className="panel-title">Composition parcellaire</h3>
                        <button className="btn btn-outline btn-sm" onClick={() => exporterTracabilite(lot.id)}>Exporter la fiche</button>
                      </div>
                      {(lot.composition || []).length === 0 ? <p className="muted">Aucune composition enregistrée.</p> : (
                        <>
                          <div className="barre-composition">
                            {(lot.composition || []).map((c) => {
                              const p = parcelles[c.parcelleId];
                              const cep = p ? cepages[p.cepageId] : null;
                              return (
                                <div key={c.parcelleId} className={`barre-seg seg-${cep ? cep.couleur : 'mixte'}`}
                                  style={{ width: `${c.pct}%` }} title={`${p ? p.nom : '?'} — ${round2(c.pct)} %`} />
                              );
                            })}
                          </div>
                          <table className="data-table compact">
                            <thead><tr><th>Parcelle</th><th>Cépage</th><th>Part</th><th>Volume</th><th>Appellation</th></tr></thead>
                            <tbody>
                              {(lot.composition || []).map((c) => {
                                const p = parcelles[c.parcelleId];
                                const cep = p ? cepages[p.cepageId] : null;
                                return (
                                  <tr key={c.parcelleId}>
                                    <td><strong>{p ? p.nom : 'Parcelle supprimée'}</strong>{p && p.commune ? <div className="muted small">{p.commune}{p.cadastre ? ` · ${p.cadastre}` : ''}</div> : null}</td>
                                    <td>{cep ? <><ColorDot couleur={cep.couleur} />{cep.nom}</> : '—'}</td>
                                    <td><strong>{round2(c.pct)} %</strong></td>
                                    <td>{round2((c.pct / 100) * volumeLot(lot))} hL</td>
                                    <td className="small">{p ? p.appellation || '—' : '—'}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          <div className="repartition-cepage">
                            {compositionParCepage(lot, parcelles, cepages).map((c) => (
                              <span className="chip" key={c.nom}>{c.nom} <strong>{c.pct} %</strong></span>
                            ))}
                          </div>
                        </>
                      )}
                    </div>

                    <div className="panel">
                      <h3 className="panel-title">Lots d'origine</h3>
                      {chaine.length <= 1 ? (
                        <p className="muted">Ce lot est issu directement de la vendange, sans assemblage.</p>
                      ) : (
                        <div className="lignage">
                          {chaine.map((l, i) => (
                            <div className={`lignage-item ${l.id === lot.id ? 'courant' : ''}`} key={l.id}>
                              <span className="lignage-puce">{i === 0 ? '●' : '↳'}</span>
                              <button className="lien" onClick={() => l.id !== lot.id && ouvrirLot(l.id)}>{l.code}</button>
                              <span className="muted small">{l.nom || ''} · millésime {l.millesime}{l.statut === 'archive' ? ' · archivé' : ''}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="panel">
                      <h3 className="panel-title">Historique complet, lots d'origine inclus</h3>
                      <p className="muted small">C'est ce que tu dois pouvoir présenter en cas de contrôle : tout ce qu'a reçu ce vin depuis la vigne.</p>
                      <table className="data-table compact">
                        <thead><tr><th>Date</th><th>Lot</th><th>Opération</th><th>Détail</th><th>Contenant</th></tr></thead>
                        <tbody>
                          {opsCompletes.map((o) => (
                            <tr key={o.id}>
                              <td className="nowrap">{o.date}</td>
                              <td className="small">{o._lotCode}</td>
                              <td><span className={`op-tag op-${o.type}`}>{o.type}</span></td>
                              <td className="small">
                                {o.type === 'apport' && `${nomParcelle(o.parcelleId)} — ${o.volume} hL`}
                                {o.type === 'ajout' && `${o.produitNom} — ${o.quantite} ${o.unite}${o.numeroLotFournisseur ? ` (lot ${o.numeroLotFournisseur})` : ''}`}
                                {o.type === 'analyse' && Object.keys(o.valeurs || {}).map((k) => {
                                  const p = PARAMS_ANALYSE.find((x) => x.id === k);
                                  return `${p ? p.label : k} ${o.valeurs[k]}`;
                                }).join(' · ')}
                                {o.type === 'travail' && o.action}
                                {o.type === 'controle' && `${o.moment === 'matin' ? 'Matin' : o.moment === 'soir' ? 'Soir' : 'Contrôle'} — ${o.temperature !== null && o.temperature !== undefined ? o.temperature + ' °C' : '—'} · densité ${o.densite !== null && o.densite !== undefined ? o.densite : '—'}`}
                                {['transfert', 'reception', 'origine', 'deplacement'].includes(o.type) && `${o.motif} ${o.volume} hL → ${nomContenant(o.contenantDestId)}`}
                                {o.type === 'perte' && `${o.motif} — ${o.volume} hL`}
                                {o.type === 'manipulation' && `${MANIP_TYPES[o.manipType].label}${o.produit ? ` — ${o.produit}` : ''}`}
                                {o.type === 'mise' && `Lot ${o.numeroLot} — ${o.volume} hL`}
                                {o.type === 'phase' && o.notes}
                              </td>
                              <td className="small">{nomContenant(o.contenantId || o.contenantSourceId)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {ongletLot === 'intrants' && (
                  <div className="panel">
                    <div className="panel-head">
                      <h3 className="panel-title">Produits œnologiques reçus</h3>
                      <button className="btn btn-primary btn-sm" onClick={() => ouvrir('ajoutProduit', { lotId: lot.id })}>+ Ajouter</button>
                    </div>
                    <p className="muted small">Lots d'origine inclus — c'est la liste complète des intrants du vin actuellement dans ce lot.</p>
                    {intrants.length === 0 ? <p className="muted">Aucun produit ajouté.</p> : (
                      <table className="data-table compact">
                        <thead><tr><th>Date</th><th>Produit</th><th>Catégorie</th><th>Quantité</th><th>N° lot fournisseur</th><th>DLUO</th><th>Lot</th></tr></thead>
                        <tbody>
                          {intrants.map((o) => (
                            <tr key={o.id}>
                              <td className="nowrap">{o.date}</td>
                              <td><strong>{o.produitNom}</strong></td>
                              <td className="small">{o.categorie}</td>
                              <td>{o.quantite} {o.unite}</td>
                              <td className="small">{o.numeroLotFournisseur || '—'}</td>
                              <td className="small">{o.dluo || '—'}</td>
                              <td className="small">{o._lotCode}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                {ongletLot === 'mouvements' && (
                  <div className="panel">
                    <div className="panel-head">
                      <h3 className="panel-title">Mouvements de volume</h3>
                      <button className="btn btn-primary btn-sm" onClick={() => ouvrir('transfert', { lotId: lot.id })}>+ Transfert</button>
                    </div>
                    <table className="data-table compact">
                      <thead><tr><th>Date</th><th>Type</th><th>Source</th><th>Destination</th><th>Volume</th><th>Lot lié</th></tr></thead>
                      <tbody>
                        {[...(lot.operations || [])]
                          .filter((o) => ['apport', 'transfert', 'reception', 'origine', 'deplacement', 'perte', 'mise'].includes(o.type))
                          .reverse()
                          .map((o) => (
                            <tr key={o.id}>
                              <td className="nowrap">{o.date}</td>
                              <td>{o.motif || { apport: 'Apport vendange', perte: 'Sortie', mise: 'Mise en bouteille' }[o.type] || o.type}</td>
                              <td className="small">{nomContenant(o.contenantSourceId || o.contenantId)}</td>
                              <td className="small">{o.contenantDestId ? nomContenant(o.contenantDestId) : '—'}</td>
                              <td className={['transfert', 'perte', 'mise'].includes(o.type) ? 'sortie' : 'entree'}>
                                {['transfert', 'perte', 'mise'].includes(o.type) ? '−' : '+'}{o.volume} hL
                              </td>
                              <td className="small">{o.lotAutreCode || '—'}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {ongletLot === 'registre' && (
                  <div className="panel">
                    <div className="panel-head">
                      <h3 className="panel-title">Manipulations réglementaires</h3>
                      <button className="btn btn-primary btn-sm" onClick={() => ouvrir('manipulation', { lotId: lot.id })}>+ Inscrire</button>
                    </div>
                    <div className="info-banner">
                      Registre unique de manipulations — à tenir à disposition en cas de contrôle et à conserver cinq ans après la clôture des comptes.
                    </div>
                    {manips.length === 0 ? <p className="muted">Aucune manipulation inscrite.</p> : (
                      <table className="data-table compact">
                        <thead><tr><th>Date</th><th>Type</th><th>Produit</th><th>Quantité</th><th>Volume</th><th>Lot</th></tr></thead>
                        <tbody>
                          {manips.map((o) => (
                            <tr key={o.id}>
                              <td className="nowrap">{o.date}</td>
                              <td><strong>{MANIP_TYPES[o.manipType].label}</strong></td>
                              <td className="small">{o.produit || '—'}</td>
                              <td className="small">{o.quantiteProduit || '—'}</td>
                              <td className="small">{o.volumeConcerne ? `${o.volumeConcerne} hL` : '—'}</td>
                              <td className="small">{o._lotCode}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </>
            );
          })()}

          {/* ===================== PRODUITS ===================== */}
          {vue === 'produits' && (
            <>
              <header className="page-head">
                <div className="page-head-row">
                  <h1>Produits œnologiques</h1>
                  <button className="btn btn-primary" onClick={() => ouvrir('produit')}>+ Nouveau produit</button>
                </div>
                <p>Le stock se décrémente automatiquement à chaque ajout en cuve.</p>
              </header>

              {Object.keys(produits).length === 0 ? (
                <EmptyState titre="Aucun produit" texte="Crée tes levures, nutriments, SO₂, produits de collage…"
                  action={<button className="btn btn-primary" onClick={() => ouvrir('produit')}>+ Nouveau produit</button>} />
              ) : (
                CATEGORIES_PRODUIT.map((cat) => {
                  const liste = Object.values(produits).filter((p) => p.categorie === cat);
                  if (!liste.length) return null;
                  return (
                    <section className="lieu-section" key={cat}>
                      <h3 className="lieu-titre">{cat}</h3>
                      <table className="data-table">
                        <thead><tr><th>Produit</th><th>Stock</th><th>Lots</th><th>DLUO la + proche</th><th>Seuil</th><th>Registre</th><th></th></tr></thead>
                        <tbody>
                          {liste.map((p) => {
                            const s = stockProduit(p);
                            const alerte = p.seuil > 0 && s <= p.seuil;
                            const lotsF = stockParLotFournisseur(p).filter((l) => l.reste > 0);
                            const prochain = lotsF.find((l) => l.dluo);
                            const j = prochain ? joursAvantDluo(prochain.dluo) : null;
                            return (
                              <tr key={p.id}>
                                <td>
                                  <button className="lien" onClick={() => ouvrir('produitDetail', { produitId: p.id })}>{p.nom}</button>
                                  {p.fournisseur ? <div className="muted small">{p.fournisseur}</div> : null}
                                </td>
                                <td className={alerte ? 'warn-text' : ''}><strong>{s}</strong> {p.unite}</td>
                                <td className="small">{lotsF.length ? `${lotsF.length} lot${lotsF.length > 1 ? 's' : ''}` : '—'}</td>
                                <td className={`small ${j !== null && j <= 60 ? 'warn-text' : ''}`}>
                                  {prochain ? `${prochain.dluo}${j !== null && j < 0 ? ' · périmé' : j !== null && j <= 60 ? ` · J−${j}` : ''}` : '—'}
                                </td>
                                <td className="small">{p.seuil || '—'}</td>
                                <td className="small">{p.manipType ? MANIP_TYPES[p.manipType].label : '—'}</td>
                                <td className="actions-cell">
                                  <button className="btn btn-outline btn-sm" onClick={() => ouvrir('entreeStock', { produitId: p.id })}>+ Entrée</button>
                                  <button className="btn btn-ghost btn-sm" onClick={() => ouvrir('produitDetail', { produitId: p.id })}>Détail</button>
                                  <button className="btn btn-danger btn-sm" onClick={() => supprimerProduit(p.id)}>Supprimer</button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </section>
                  );
                })
              )}
            </>
          )}

          {/* ===================== REGISTRE GLOBAL ===================== */}
          {vue === 'registre' && (() => {
            const toutes = [];
            Object.values(lots).forEach((l) => {
              (l.operations || []).filter((o) => o.type === 'manipulation').forEach((o) => toutes.push({ ...o, _lot: l }));
            });
            const apports = [];
            Object.values(lots).forEach((l) => {
              (l.operations || []).filter((o) => o.type === 'apport').forEach((o) => apports.push({ ...o, _lot: l }));
            });
            return (
              <>
                <header className="page-head">
                  <div className="page-head-row">
                    <h1>Registre réglementaire</h1>
                    <button className="btn btn-primary" onClick={exporterExcel}>Exporter le registre complet</button>
                  </div>
                  <p>Registre unique de manipulations, entrées de vendange et conditionnement — modèle FGVB.</p>
                </header>

                <div className="info-banner">
                  Un registre électronique n'est recevable que s'il ne permet pas de modifier une écriture a posteriori sans que la
                  modification reste apparente. Pense à imprimer et classer tes exports au fil des opérations.
                </div>

                <div className="panel">
                  <h3 className="panel-title">Entrées de vendange ({apports.length})</h3>
                  {apports.length === 0 ? <p className="muted">Aucun apport enregistré.</p> : (
                    <table className="data-table compact">
                      <thead><tr><th>Date</th><th>Parcelle</th><th>Cépage</th><th>Appellation</th><th>Contenant</th><th>Volume</th><th>Poids</th></tr></thead>
                      <tbody>
                        {apports.sort((a, b) => b.date.localeCompare(a.date)).map((o) => {
                          const p = parcelles[o.parcelleId];
                          const cep = p ? cepages[p.cepageId] : null;
                          return (
                            <tr key={o.id}>
                              <td className="nowrap">{o.date}</td>
                              <td>{p ? p.nom : '—'}{p && p.cadastre ? <div className="muted small">{p.cadastre}</div> : null}</td>
                              <td className="small">{cep ? <><ColorDot couleur={cep.couleur} />{cep.nom}</> : '—'}</td>
                              <td className="small">{p ? p.appellation || '—' : '—'}</td>
                              <td className="small">{nomContenant(o.contenantId)}</td>
                              <td>{o.volume} hL</td>
                              <td className="small">{o.poidsKg ? `${o.poidsKg} kg` : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                {Object.keys(MANIP_TYPES).map((type) => {
                  const liste = toutes.filter((o) => o.manipType === type);
                  if (!liste.length) return null;
                  return (
                    <div className="panel" key={type}>
                      <h3 className="panel-title">{MANIP_TYPES[type].label} ({liste.length})</h3>
                      <p className="delai-hint">⏱ {MANIP_TYPES[type].delai}</p>
                      <table className="data-table compact">
                        <thead><tr><th>Date</th><th>Lot</th><th>Contenant</th><th>Produit</th><th>Quantité</th><th>Volume</th><th>Détail</th></tr></thead>
                        <tbody>
                          {liste.sort((a, b) => b.date.localeCompare(a.date)).map((o) => (
                            <tr key={o.id}>
                              <td className="nowrap">{o.date}</td>
                              <td><button className="lien" onClick={() => ouvrirLot(o._lot.id)}>{o._lot.code}</button></td>
                              <td className="small">{nomContenant(o.contenantId)}</td>
                              <td className="small">{o.produit || '—'}</td>
                              <td className="small">{o.quantiteProduit || '—'}</td>
                              <td className="small">{o.volumeConcerne ? `${o.volumeConcerne} hL` : '—'}</td>
                              <td className="small">
                                {o.titreAvant || o.titreApres ? `${o.titreAvant || '—'} → ${o.titreApres || '—'} % vol` : ''}
                                {o.critere8515 ? `85/15 : ${o.critere8515}` : ''}
                                {o.responsable ? `${o.responsable}` : ''}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })}

                {toutes.length === 0 && (
                  <div className="panel"><p className="muted">Aucune manipulation réglementaire inscrite pour le moment.</p></div>
                )}
              </>
            );
          })()}

          {/* ===================== MISE EN BOUTEILLE ===================== */}
          {vue === 'mise' && (
            <>
              <header className="page-head">
                <h1>Mise en bouteille</h1>
                <p>Chaque mise fige la traçabilité du lot et lui attribue un numéro identifiable.</p>
              </header>

              <div className="panel">
                <h3 className="panel-title">Lots prêts à être mis</h3>
                {lotsActifs.length === 0 ? <p className="muted">Aucun lot en cave.</p> : (
                  <table className="data-table compact">
                    <thead><tr><th>Lot</th><th>Composition</th><th>Volume</th><th>Phase</th><th></th></tr></thead>
                    <tbody>
                      {lotsActifs.map((l) => (
                        <tr key={l.id}>
                          <td><strong><ColorDot couleur={couleurLot(l, parcelles, cepages)} />{l.code}</strong></td>
                          <td className="small">{compositionParCepage(l, parcelles, cepages).map((c) => `${c.pct} % ${c.nom}`).join(' · ')}</td>
                          <td>{volumeLot(l)} hL</td>
                          <td><PhaseBadge phase={l.phase} /></td>
                          <td className="actions-cell">
                            <button className="btn btn-outline btn-sm" onClick={() => ouvrirLot(l.id)}>Ouvrir</button>
                            <button className="btn btn-primary btn-sm" onClick={() => ouvrir('mise', { lotId: l.id })}>Mettre en bouteille</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="panel">
                <h3 className="panel-title">Mises réalisées ({conditionnements.length})</h3>
                {conditionnements.length === 0 ? <p className="muted">Aucune mise enregistrée.</p> : (
                  <table className="data-table compact">
                    <thead><tr><th>Date</th><th>N° de lot</th><th>Lot vin</th><th>Désignation</th><th>Formats</th><th>Volume</th><th></th></tr></thead>
                    <tbody>
                      {[...conditionnements].sort((a, b) => b.date.localeCompare(a.date)).map((c) => (
                        <tr key={c.id}>
                          <td className="nowrap">{c.date}</td>
                          <td><strong>{c.numeroLot}</strong></td>
                          <td className="small">{c.lotCode}</td>
                          <td className="small">{c.designation || '—'}</td>
                          <td className="small">
                            {c.lignes.map((li) => {
                              const f = FORMATS_BOUTEILLE.find((x) => x.id === li.formatId);
                              return `${li.nb} × ${f ? f.label : li.formatId}`;
                            }).join(' · ')}
                          </td>
                          <td>{c.volumeHl} hL</td>
                          <td className="actions-cell">
                            {lots[c.lotId] && <button className="btn btn-outline btn-sm" onClick={() => exporterTracabilite(c.lotId)}>Fiche traçabilité</button>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}

          {/* ===================== PARAMÈTRES ===================== */}
          {vue === 'parametres' && (
            <>
              <header className="page-head">
                <h1>Paramètres</h1>
                <p>Tout le référentiel du domaine. Les modifications n'affectent jamais l'historique déjà enregistré.</p>
              </header>

              <div className="panel">
                <h3 className="panel-title">Domaine</h3>
                <div className="field-grid">
                  <Field label="Nom du domaine"><input type="text" value={domaine.nom} onChange={(e) => setDomaine({ ...domaine, nom: e.target.value })} /></Field>
                  <Field label="N° CVI / EVV"><input type="text" value={domaine.cvi} onChange={(e) => setDomaine({ ...domaine, cvi: e.target.value })} /></Field>
                </div>
                <Field label="Exploitant"><input type="text" value={domaine.exploitant} onChange={(e) => setDomaine({ ...domaine, exploitant: e.target.value })} /></Field>
                <Field label="Adresse de l'exploitation"><input type="text" value={domaine.adresse} onChange={(e) => setDomaine({ ...domaine, adresse: e.target.value })} /></Field>
                <Field label="Adresse de l'exploitant"><input type="text" value={domaine.exploitantAdresse} onChange={(e) => setDomaine({ ...domaine, exploitantAdresse: e.target.value })} /></Field>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <h3 className="panel-title">Lieux ({Object.keys(lieux).length})</h3>
                  <button className="btn btn-primary btn-sm" onClick={() => ouvrir('lieu')}>+ Lieu</button>
                </div>
                {Object.values(lieux).map((l) => {
                  const liste = Object.values(contenants).filter((c) => c.lieuId === l.id);
                  return (
                    <div className="setup-group" key={l.id}>
                      <div className="setup-group-head">
                        <strong>{l.nom}</strong>
                        <span className="muted small">{l.type === 'cuverie' ? 'Cuverie' : 'Chai à barriques'} · {USAGES_LIEU[l.usage]} · {liste.length} contenant{liste.length > 1 ? 's' : ''} · {round2(liste.reduce((s, c) => s + (c.capacite || 0), 0))} hL</span>
                        <button className="btn btn-outline btn-sm" onClick={() => ouvrir('contenants', { lieuId: l.id })}>+ Contenants</button>
                        <button className="btn btn-danger btn-sm" onClick={() => supprimerLieu(l.id)}>Retirer</button>
                      </div>
                      <div className="chips-wrap">
                        {liste.sort((a, b) => a.nom.localeCompare(b.nom, undefined, { numeric: true })).map((c) => (
                          <span className={`chip ${occupationParContenant[c.id] ? 'occupe' : ''}`} key={c.id}>
                            {c.nom}{c.capacite ? ` · ${c.capacite} hL` : ''}
                            {c.type === 'lot_barriques' ? ` · ${c.nbBarriques} bq` : ''}
                            <button onClick={() => supprimerContenant(c.id)}>✕</button>
                          </span>
                        ))}
                        {liste.length === 0 && <span className="muted small">Aucun contenant</span>}
                      </div>
                    </div>
                  );
                })}
                {Object.keys(lieux).length === 0 && <p className="muted">Aucun lieu configuré.</p>}
              </div>

              <div className="panel">
                <div className="panel-head">
                  <h3 className="panel-title">Cépages & parcelles</h3>
                  <div className="quick-row">
                    <button className="btn btn-outline btn-sm" onClick={() => ouvrir('cepage')}>+ Cépage</button>
                    <button className="btn btn-primary btn-sm" onClick={() => ouvrir('parcelles')}>+ Parcelles</button>
                  </div>
                </div>
                {Object.values(cepages).map((cep) => {
                  const liste = Object.values(parcelles).filter((p) => p.cepageId === cep.id);
                  return (
                    <div className="setup-group" key={cep.id}>
                      <div className="setup-group-head">
                        <strong><ColorDot couleur={cep.couleur} />{cep.nom}</strong>
                        <span className="muted small">{COULEURS[cep.couleur]} · {liste.length} parcelle{liste.length > 1 ? 's' : ''} · {round2(liste.reduce((s, p) => s + (Number(p.surface) || 0), 0))} ha</span>
                        <button className="btn btn-danger btn-sm" onClick={() => supprimerCepage(cep.id)}>Retirer</button>
                      </div>
                      <div className="chips-wrap">
                        {liste.sort((a, b) => a.nom.localeCompare(b.nom, undefined, { numeric: true })).map((p) => (
                          <span className="chip" key={p.id}>
                            {p.nom}{p.surface ? ` · ${p.surface} ha` : ''}
                            <button onClick={() => supprimerParcelle(p.id)}>✕</button>
                          </span>
                        ))}
                        {liste.length === 0 && <span className="muted small">Aucune parcelle</span>}
                      </div>
                    </div>
                  );
                })}
                {Object.keys(cepages).length === 0 && <p className="muted">Aucun cépage configuré.</p>}
              </div>

              <div className="panel">
                <h3 className="panel-title">Données</h3>
                <div className="quick-row">
                  <button className="btn btn-outline" onClick={exporterExcel}>Exporter tout en Excel</button>
                  <button className="btn btn-outline" onClick={() => setDomaine({ ...domaine, setupDone: false })}>Rouvrir l'assistant de paramétrage</button>
                </div>
                <p className="muted small">
                  Toutes les données sont stockées dans ce navigateur, sur cet ordinateur. Exporte régulièrement pour garder une copie.
                </p>
              </div>
            </>
          )}
        </main>
      </div>

      {rendreModales()}
    </div>
  );
}