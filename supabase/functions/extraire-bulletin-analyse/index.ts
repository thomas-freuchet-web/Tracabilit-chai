// Lit un bulletin d'analyse de laboratoire (photo ou PDF) et en extrait les
// valeurs œnologiques usuelles via l'API Gemini (gratuite). La clé Gemini
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

const PROMPT = `Tu analyses un bulletin d'analyse de laboratoire œnologique (photo ou PDF). Réponds UNIQUEMENT avec un objet JSON strictement de cette forme, sans texte autour, sans balises markdown :
{
  "date": "date de l'analyse au format YYYY-MM-DD, vide si absente",
  "valeurs": {
    "densite": nombre ou null,
    "temperature": nombre en °C ou null,
    "tav": nombre en % vol (TAV acquis / titre alcoométrique) ou null,
    "tap": nombre en % vol (TAV probable) ou null,
    "ph": nombre ou null,
    "at": nombre en g/L H2SO4 (acidité totale) ou null,
    "av": nombre en g/L H2SO4 (acidité volatile) ou null,
    "so2l": nombre en mg/L (SO2 libre) ou null,
    "so2t": nombre en mg/L (SO2 total) ou null,
    "sucres": nombre en g/L (sucres réducteurs) ou null,
    "malique": nombre en g/L (acide malique) ou null
  },
  "notes": "string, vide si absent"
}
N'invente aucune valeur non présente sur le bulletin — mets null pour tout paramètre absent ou illisible plutôt que de deviner. Convertis les unités si besoin (ex. l'acidité est parfois donnée en g/L d'acide tartrique ou d'acide sulfurique : convertis en équivalent H2SO4 si l'unité d'origine est précisée, sinon laisse la valeur telle quelle et ne la convertis pas si tu n'es pas sûr).
Pour "notes" : reprends fidèlement les remarques, annotations, appréciations ou commentaires écrits par le laboratoire (souvent en bas du bulletin, parfois manuscrits) — par exemple un avis sur la stabilité du vin, un risque de déviation, une recommandation de traitement. Ignore les mentions purement administratives (numéro de bulletin, date d'édition, coordonnées du labo, mode opératoire des analyses). Laisse "" si le bulletin n'a aucune remarque de ce type.`;

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

    const { fichierBase64, mimeType } = await req.json();
    if (!fichierBase64 || !mimeType) throw new Error("Fichier manquant");

    const texte = await appelerGemini(GEMINI_API_KEY, MODEL, PROMPT, fichierBase64, mimeType);
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
