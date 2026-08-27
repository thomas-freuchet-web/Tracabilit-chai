// Fusion à trois sources (base commune / local / distant) de l'état de la
// cave, pour que deux appareils (ou deux personnes) qui modifient des
// choses différentes en même temps ne s'écrasent plus l'un l'autre.
//
// Principe (comme une fusion Git à trois points) : on compare chaque valeur
// à la dernière version que cet appareil et le serveur avaient en commun
// ("base") :
//  - si seul le local a changé depuis la base → on garde le local ;
//  - si seul le distant a changé depuis la base → on adopte le distant ;
//  - si les deux ont changé la MÊME valeur différemment (conflit réel,
//    rare) → pour un objet-liste identifiable par id (ex. les opérations
//    d'un lot, les conditionnements) on fusionne par union des id, sans
//    rien perdre ; pour une valeur simple ou un tableau sans id, impossible
//    de fusionner plus finement : on garde la version distante, déjà
//    confirmée par le serveur, pour ne jamais écraser silencieusement un
//    enregistrement que quelqu'un d'autre a déjà validé.
//  - un enregistrement supprimé d'un côté mais toujours présent (inchangé
//    ou modifié) de l'autre → on le garde : mieux vaut une ligne en trop,
//    à supprimer à la main, qu'une perte de donnée réglementaire.

function estObjet(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function egal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (estObjet(a) && estObjet(b)) {
    const clesA = Object.keys(a), clesB = Object.keys(b);
    if (clesA.length !== clesB.length) return false;
    return clesA.every((k) => egal(a[k], b[k]));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => egal(v, b[i]));
  }
  return false;
}

function estListeAvecId(v) {
  return Array.isArray(v) && v.length > 0 && v.every((x) => estObjet(x) && typeof x.id === 'string');
}

function fusionnerListeAvecId(base, local, distant) {
  const parId = new Map();
  const ordre = [];
  const noter = (liste) => (liste || []).forEach((x) => {
    if (!parId.has(x.id)) { parId.set(x.id, {}); ordre.push(x.id); }
  });
  noter(base); noter(local); noter(distant);
  (base || []).forEach((x) => { parId.get(x.id).base = x; });
  (local || []).forEach((x) => { parId.get(x.id).local = x; });
  (distant || []).forEach((x) => { parId.get(x.id).distant = x; });

  const resultat = [];
  ordre.forEach((id) => {
    const { base: b, local: l, distant: d } = parId.get(id);
    if (l === undefined && d === undefined) return; // supprimé des deux côtés
    if (l === undefined) { resultat.push(d); return; } // supprimé localement, gardé côté serveur
    if (d === undefined) { resultat.push(l); return; } // ajouté localement, absent côté serveur
    resultat.push(fusionnerValeur(b, l, d));
  });
  return resultat;
}

function fusionnerObjets(base, local, distant) {
  const cles = new Set([...Object.keys(base || {}), ...Object.keys(local || {}), ...Object.keys(distant || {})]);
  const resultat = {};
  cles.forEach((cle) => {
    const b = base ? base[cle] : undefined;
    const l = local ? local[cle] : undefined;
    const d = distant ? distant[cle] : undefined;
    if (l === undefined && d === undefined) return;
    if (l === undefined) { resultat[cle] = d; return; }
    if (d === undefined) { resultat[cle] = l; return; }
    resultat[cle] = fusionnerValeur(b, l, d);
  });
  return resultat;
}

function fusionnerValeur(base, local, distant) {
  if (egal(local, distant)) return local;
  if (egal(local, base)) return distant; // rien de nouveau localement
  if (egal(distant, base)) return local; // rien de nouveau côté serveur

  // Conflit réel : les deux côtés ont changé cette même valeur.
  if (estListeAvecId(local) || estListeAvecId(distant) || estListeAvecId(base)) {
    return fusionnerListeAvecId(base, local, distant);
  }
  if (estObjet(local) && estObjet(distant)) {
    return fusionnerObjets(estObjet(base) ? base : {}, local, distant);
  }
  return distant;
}

export function fusionnerEtats(base, local, distant) {
  if (!base || !distant) return local;
  return fusionnerObjets(base, local, distant);
}
