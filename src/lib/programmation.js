// Logique pure d'une "programmation" de vinification : un protocole fourni
// par l'œnologue (souvent un graphique papier) qui indique, en fonction de
// la DENSITÉ du moût (pas d'une date — la fermentation n'avance pas à
// vitesse constante), la température de consigne, le volume de remontage à
// appliquer, et quelques actions ponctuelles (délestage, ajout de produit)
// à déclencher une fois un palier atteint. Aucune dépendance à React, pour
// rester testable indépendamment — même esprit que fusionEtat.js.

const round1 = (n) => Math.round((n + Number.EPSILON) * 10) / 10;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Température de consigne pour une densité donnée, interpolée linéairement
// entre les points de la courbe. Les points sont triés du plus haut au plus
// bas ; "densite: null" représente l'encuvage (avant le premier palier
// chiffré). Au-delà du premier ou en dessous du dernier point, la consigne
// reste celle du point le plus proche (plateau), comme sur le graphique
// papier où la courbe part à plat avant/après ses paliers connus.
export function temperatureCible(programmation, densite) {
  const points = [...(programmation?.temperatures || [])]
    .filter((p) => p && p.temperature !== null && p.temperature !== undefined)
    .sort((a, b) => (b.densite ?? Infinity) - (a.densite ?? Infinity));
  if (points.length === 0 || densite === null || densite === undefined) return null;

  const premier = points[0];
  if (premier.densite === null || densite >= premier.densite) return premier.temperature;

  const dernier = points[points.length - 1];
  if (dernier.densite === null || densite <= dernier.densite) return dernier.temperature;

  for (let i = 0; i < points.length - 1; i++) {
    const haut = points[i];
    const bas = points[i + 1];
    if (densite <= haut.densite && densite >= bas.densite) {
      const ratio = (haut.densite - densite) / (haut.densite - bas.densite);
      return round1(haut.temperature + ratio * (bas.temperature - haut.temperature));
    }
  }
  return dernier.temperature;
}

// Coefficient de volume de remontage ("1,5 fois le volume de la cuve") pour
// une densité donnée. Une bande peut être fixe (coefficient) ou dégressive
// (coefficientDebut à densiteHaute -> coefficientFin à densiteBasse),
// interpolée linéairement dans ce second cas.
export function coefficientRemontage(programmation, densite) {
  if (densite === null || densite === undefined) return null;
  const bandes = programmation?.remontage || [];

  for (const b of bandes) {
    const haut = b.densiteHaute ?? Infinity;
    const bas = b.densiteBasse ?? -Infinity;
    if (densite > haut || densite < bas) continue;
    if (b.coefficient !== undefined && b.coefficient !== null) return b.coefficient;
    if (b.coefficientDebut !== undefined && b.coefficientFin !== undefined) {
      if (!Number.isFinite(haut) || !Number.isFinite(bas)) return b.coefficientDebut;
      const ratio = (haut - densite) / (haut - bas);
      return round2(b.coefficientDebut + ratio * (b.coefficientFin - b.coefficientDebut));
    }
    return null;
  }
  return null;
}

// Événements (délestage, ajout de produit...) dont le seuil est atteint par
// la densité actuelle et qui n'ont pas déjà été traités. Volontairement
// indépendant de la notion de "programmation" : les événements peuvent venir
// du protocole (graphique importé ou saisi à la main) MAIS AUSSI d'un
// bulletin d'analyse de laboratoire, qui recommande souvent lui aussi des
// produits/doses à ajouter à une densité donnée — les deux sources sont
// fusionnées dans une seule liste avant d'appeler cette fonction (voir
// verifierProgrammation dans App.js), pour être suivies exactement de la
// même façon une fois confirmées par l'utilisateur.
//
// La densité ne fait que baisser pendant la fermentation, donc un
// déclencheur "densite" se lit comme "dès que la densité descend à ce
// niveau ou en dessous" ; un déclencheur "delta_densite" (ex. -10) se compte
// depuis densiteActivation (la densité relevée au moment de l'activation du
// protocole, ou de la confirmation de l'événement si issu d'un bulletin).
export function evenementsADeclencher(evenements, evenementsDeclenches, densiteActuelle, densiteActivation) {
  if (densiteActuelle === null || densiteActuelle === undefined) return [];
  const dejaFaits = new Set(evenementsDeclenches || []);

  return (evenements || []).filter((e) => {
    if (dejaFaits.has(e.id)) return false;
    const d = e.declencheur || {};
    if (d.mode === 'densite') return densiteActuelle <= d.valeur;
    if (d.mode === 'delta_densite') {
      if (densiteActivation === null || densiteActivation === undefined) return false;
      return densiteActuelle <= densiteActivation + d.valeur;
    }
    return false;
  });
}

// Écart entre la température mesurée et la consigne du protocole, pour
// décider si une alerte doit partir. Renvoie null si la programmation ne
// couvre pas cette densité (pas de consigne calculable).
export function ecartTemperature(programmation, densite, temperatureMesuree) {
  const cible = temperatureCible(programmation, densite);
  if (cible === null || temperatureMesuree === null || temperatureMesuree === undefined) return null;
  return round1(temperatureMesuree - cible);
}
