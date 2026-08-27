// Lit un bulletin d'analyse de laboratoire (photo ou PDF) et en extrait les
// valeurs œnologiques via l'API Gemini (gratuite). La clé Gemini reste ici,
// côté serveur — jamais exposée au navigateur.
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

function construirePrompt(contenantNom?: string, lotCode?: string) {
  const cible = contenantNom
    ? `Ce bulletin peut porter sur plusieurs échantillons/cuves à la fois. Le vin qui t'intéresse ici est celui de la cuve/du contenant nommé "${contenantNom}"${lotCode ? ` (lot ${lotCode})` : ""}. Repère la colonne, le bloc ou la ligne qui correspond à ce nom exact (ou à un nom très proche, ex. "C1" pour "Cuve C1") et n'extrais QUE les valeurs, remarques et annotations de cet échantillon précis — ignore complètement les autres cuves/échantillons du même bulletin. Si le bulletin ne contient qu'un seul échantillon (aucune ambiguïté possible), applique-lui simplement toutes les valeurs trouvées.`
    : "Si ce bulletin couvre plusieurs échantillons/cuves sans que tu saches lequel choisir, prends le premier échantillon du document.";

  return `Tu analyses un bulletin d'analyse de laboratoire œnologique (photo ou PDF). ${cible}

Réponds UNIQUEMENT avec un objet JSON strictement de cette forme, sans texte autour, sans balises markdown :
{
  "date": "date de l'analyse au format YYYY-MM-DD, vide si absente",
  "valeurs": ${CRITERES_CONNUS},
  "autres": [{ "label": "nom du critère tel qu'écrit sur le bulletin", "valeur": "valeur avec son unité, en texte" }],
  "notes": "string, vide si absent"
}

Pour "valeurs" et "autres" : donne toujours la valeur en TEXTE (jamais un nombre JSON brut), pour pouvoir garder telle quelle une mention comme "< 5", "> 200", "traces" ou "non détecté" quand c'est ce que le bulletin indique — ne remplace jamais ce genre de mention par null ou par une valeur inventée. N'invente aucune valeur non présente sur le bulletin — mets null (pour "valeurs") ou omets l'entrée (pour "autres") si un paramètre est absent ou illisible. Convertis les unités si besoin (ex. l'acidité est parfois donnée en g/L d'acide tartrique : convertis en équivalent H2SO4 si l'unité d'origine est précisée, sinon laisse la valeur telle quelle sans convertir si tu n'es pas sûr).

Pour "autres" : liste ICI tout critère analysé qui n'apparaît PAS dans la liste "valeurs" ci-dessus — par exemple (liste non limitative) acidité lactique, azote assimilable (IAN/YAN), turbidité (NTU), indice de polyphénols totaux (IPT), anthocyanes, tanins, potassium, fer, cuivre, gaz carbonique dissous, glucose/fructose séparés, acide citrique, acide ascorbique, résultat de test de stabilité (protéique, tartrique), ou tout autre paramètre présent sur ce bulletin précis. Utilise l'intitulé exact du bulletin comme "label" (garde son unité dans "valeur", ex. "180 mg N/L"). N'en invente aucun : seulement ce qui est effectivement écrit sur le document.

Pour "notes" : reprends fidèlement les remarques, annotations, appréciations ou commentaires écrits par le laboratoire concernant CETTE cuve précise (souvent en bas du bulletin ou à côté de son bloc de résultats, parfois manuscrits) — par exemple un avis sur la stabilité du vin, un risque de déviation, une recommandation de traitement. Ignore les mentions purement administratives (numéro de bulletin, date d'édition, coordonnées du labo, mode opératoire des analyses) et les remarques qui concernent explicitement une autre cuve. Laisse "" si cette cuve n'a aucune remarque de ce type.`;
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

    const { fichierBase64, mimeType, contenantNom, lotCode } = await req.json();
    if (!fichierBase64 || !mimeType) throw new Error("Fichier manquant");

    const texte = await appelerGemini(GEMINI_API_KEY, MODEL, construirePrompt(contenantNom, lotCode), fichierBase64, mimeType);
    let resultat;
    try {
      resultat = JSON.parse(texte);
    } catch {
      throw new Error("La réponse de l'IA n'était pas exploitable (document trop long ou illisible). Réessaie, ou envoie une photo plus nette.");
    }

    return reponseJson(resultat);
  } catch (e) {
    return reponseJson({ error: e instanceof Error ? e.message : "Erreur inconnue" }, 400);
  }
});
