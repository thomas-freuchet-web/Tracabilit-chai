// Lit un bulletin d'analyse de laboratoire (photo ou PDF) qui peut contenir
// PLUSIEURS échantillons/cuves à la fois, et détecte pour chacun à quelle
// cuve du chai il correspond, via l'API Gemini (gratuite). La clé Gemini
// reste ici, côté serveur — jamais exposée au navigateur.
//
// Protégée par l'authentification Supabase : seul le compte connecté de
// l'application peut appeler cette fonction (le dépôt est public, donc
// n'importe qui pourrait sinon consommer le quota gratuit).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appelerGemini } from "../_shared/gemini.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const MODEL = "gemini-3.6-flash";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CRITERES_CONNUS = `{
  "densite": string ou null,
  "temperature": string ou null (°C),
  "tav": string ou null (% vol, TAV acquis / titre alcoométrique),
  "tap": string ou null (% vol, TAV probable),
  "ph": string ou null,
  "at": string ou null (g/L H2SO4, acidité totale),
  "av": string ou null (g/L H2SO4, acidité volatile),
  "so2l": string ou null (mg/L, SO2 libre),
  "so2t": string ou null (mg/L, SO2 total),
  "sucres": string ou null (g/L, sucres réducteurs),
  "malique": string ou null (g/L, acide malique)
}`;

function construirePrompt(cuves: Array<{ nom: string; lotCode?: string }>) {
  const listeCuves = cuves.length
    ? cuves.map((c) => `- "${c.nom}"${c.lotCode ? ` (lot ${c.lotCode})` : ""}`).join("\n")
    : "(aucune cuve suivie actuellement dans le logiciel)";

  return `Tu analyses un bulletin d'analyse de laboratoire œnologique (photo ou PDF). Ce bulletin peut contenir les résultats d'UN OU PLUSIEURS échantillons/cuves à la fois (une colonne par cuve, un tableau récapitulatif, plusieurs blocs de résultats, plusieurs pages...). Repère TOUS les échantillons distincts présents sur le document.

Voici la liste des cuves actuellement suivies dans le logiciel de chai, telles qu'elles y sont nommées :
${listeCuves}

Pour chaque échantillon repéré sur le bulletin, essaie de déterminer à quelle cuve de cette liste il correspond, en comparant son nom/repère sur le bulletin (ex. "Cuve 3", "C1", "Merlot 2026", un numéro de cuve, un nom de lot) au nom des cuves listées. Utilise EXACTEMENT l'un des noms de la liste ci-dessus si tu es raisonnablement sûr de la correspondance ; mets null si aucune cuve de la liste ne correspond clairement (nom trop différent, cuve non suivie, ambiguïté). N'invente jamais un nom de cuve qui n'est pas dans la liste.

Réponds UNIQUEMENT avec un objet JSON strictement de cette forme, sans texte autour, sans balises markdown :
{
  "echantillons": [
    {
      "nomSurBulletin": "nom ou repère de cet échantillon tel qu'écrit sur le bulletin",
      "cuveCorrespondante": "nom exact d'une cuve de la liste, ou null",
      "date": "date de l'analyse au format YYYY-MM-DD, vide si absente",
      "valeurs": ${CRITERES_CONNUS},
      "autres": [{ "label": "nom du critère tel qu'écrit sur le bulletin", "valeur": "valeur avec son unité, en texte" }],
      "notes": "string, vide si absent"
    }
  ]
}

Pour "valeurs" et "autres" : donne toujours la valeur en TEXTE (jamais un nombre JSON brut), pour pouvoir garder telle quelle une mention comme "< 5", "> 200", "traces" ou "non détecté" quand c'est ce que le bulletin indique — ne remplace jamais ce genre de mention par null ou par une valeur inventée. N'invente aucune valeur non présente sur le bulletin — mets null (pour "valeurs") ou omets l'entrée (pour "autres") si un paramètre est absent ou illisible pour cet échantillon.

Pour "autres" : liste ICI tout critère analysé qui n'apparaît PAS dans la liste "valeurs" ci-dessus — par exemple (liste non limitative) acidité lactique, azote assimilable (IAN/YAN), turbidité (NTU), indice de polyphénols totaux (IPT), anthocyanes, tanins, potassium, fer, cuivre, gaz carbonique dissous, glucose/fructose séparés, acide citrique, acide ascorbique, résultat de test de stabilité (protéique, tartrique), ou tout autre paramètre présent pour cet échantillon précis sur ce bulletin. N'en invente aucun.

Pour "notes" : reprends fidèlement les remarques, annotations ou commentaires du laboratoire concernant SPÉCIFIQUEMENT cet échantillon (souvent en bas du bulletin ou à côté de son bloc de résultats). Ignore les mentions purement administratives et les remarques qui concernent explicitement un autre échantillon. Laisse "" si cet échantillon n'a aucune remarque de ce type.`;
}

function reponseJson(corps: unknown, status = 200) {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY non configurée côté serveur");

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
    const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
    if (userError || !userData?.user) {
      return reponseJson({ error: "Non authentifié" }, 401);
    }

    const { fichierBase64, mimeType, cuves } = await req.json();
    if (!fichierBase64 || !mimeType) throw new Error("Fichier manquant");

    const texte = await appelerGemini(GEMINI_API_KEY, MODEL, construirePrompt(Array.isArray(cuves) ? cuves : []), fichierBase64, mimeType);
    let resultat;
    try {
      resultat = JSON.parse(texte);
    } catch {
      throw new Error("La réponse de l'IA n'était pas exploitable (document trop long ou illisible). Réessaie, ou envoie une photo plus nette.");
    }
    if (!resultat || !Array.isArray(resultat.echantillons)) resultat = { echantillons: [] };

    return reponseJson(resultat);
  } catch (e) {
    return reponseJson({ error: e instanceof Error ? e.message : "Erreur inconnue" }, 400);
  }
});
