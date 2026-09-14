// Lit un protocole de vinification (photo ou PDF d'un graphique papier type
// OENOTEAM : volume de remontage et température de consigne en fonction de
// la densité, avec quelques actions ponctuelles) et l'extrait en JSON
// structuré via l'API Gemini (gratuite). La clé Gemini reste ici, côté
// serveur — jamais exposée au navigateur.
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

const PROMPT = `Tu analyses un protocole de vinification (photo ou PDF), le plus souvent un graphique avec deux axes : la densité du moût en abscisse (décroissante, de l'encuvage jusqu'à la fin de fermentation alcoolique), et deux échelles en ordonnée — un volume de remontage exprimé en "fois le volume de la cuve" (ex. "1V", "2V") et une température de consigne en °C. Le graphique porte souvent des annotations ponctuelles (délestage, ajout d'azote, ajout d'O2/micro-oxygénation, notes manuscrites).

Réponds UNIQUEMENT avec un objet JSON strictement de cette forme, sans texte autour, sans balises markdown :
{
  "nom": "un nom court pour ce protocole si le document en donne un, sinon vide",
  "temperatures": [
    { "densite": nombre ou null (null = tout début, avant le premier palier chiffré, ex. l'encuvage), "temperature": nombre en °C }
  ],
  "remontage": [
    {
      "densiteHaute": nombre ou null (null = encuvage),
      "densiteBasse": nombre ou null (null = fin de fermentation),
      "coefficient": nombre si le volume est constant sur cette bande,
      "coefficientDebut": nombre si le volume diminue progressivement sur cette bande (valeur au début, à densiteHaute),
      "coefficientFin": nombre (valeur à la fin, à densiteBasse) — uniquement si coefficientDebut est aussi présent
    }
  ],
  "evenements": [
    {
      "type": "delestage" ou "o2" ou "produit",
      "declencheur": {
        "mode": "densite" (déclenché à une densité précise) ou "delta_densite" (déclenché après une perte de N points de densité depuis le début du suivi),
        "valeur": nombre (la densité, ou le delta — NÉGATIF pour delta_densite, ex. -10 pour "10 points perdus")
      },
      "produitNom": "nom du produit tel qu'écrit (uniquement si type=produit)",
      "dose": nombre (uniquement si type=produit et une dose est indiquée, sinon absent — n'invente aucune dose),
      "uniteDose": "g_hl" ou "g_l" ou "kg_hl" ou "mg_l" ou "ml_hl" ou "ml_l" ou "cl_hl" ou "cl_l" ou "l_hl" (uniquement si type=produit),
      "pression": nombre en bar (uniquement si type=o2 et indiqué),
      "dureeRef": nombre en minutes (uniquement si type=o2 et indiqué, ex. "4 min" dans une note du type "4 min 30hL 3 bar"),
      "volumeRef": nombre en hL (uniquement si type=o2 et indiqué, ex. "30hL" dans la même note)
    }
  ]
}

Règles importantes :
- Lis les valeurs numériques directement sur le document (positions des paliers sur l'axe des densités, valeurs écrites à côté de la courbe de température, notes manuscrites). N'invente RIEN : si une valeur n'est pas lisible ou absente, omets le champ ou l'événement plutôt que de deviner un chiffre.
- Le mot-clé pouvant désigner l'ajout d'O2/micro-oxygénation varie selon le domaine (ex. "cliquage") — reconnais-le à son contexte (une note avec une durée en minutes, un volume en hL et une pression en bar signale presque toujours cette action, quel que soit le mot utilisé) et classe-le en "type": "o2".
- "densite": une densité de moût s'écrit typiquement 990 à 1120 — si le document utilise un format différent (ex. "0.990"), convertis en l'équivalent "×1000" (990) pour rester cohérent avec le reste de l'application.
- Si le graphique ne distingue pas clairement une bande dégressive d'une bande constante, préfère "coefficient" (constant) sauf si deux valeurs différentes sont clairement indiquées aux deux bouts de la bande.`;

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
