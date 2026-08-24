// Lit un document (photo ou PDF) listant cuves/cuverie/cépages/parcelles et
// renvoie une extraction structurée via l'API Gemini (gratuite). La clé
// Gemini reste ici, côté serveur — jamais exposée au navigateur.
//
// Protégée par l'authentification Supabase : seul le compte connecté de
// l'application peut appeler cette fonction (le dépôt est public, donc
// n'importe qui pourrait sinon consommer le quota gratuit).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const MODEL = "gemini-2.0-flash";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PROMPT = `Tu analyses un document viticole (liste de cuves, de cuverie, de cépages ou de parcelles), fourni en photo ou en PDF. Réponds UNIQUEMENT avec un objet JSON strictement de cette forme, sans texte autour, sans balises markdown :
{
  "lieux": [{"nom": "string", "type": "cuverie ou chai_barriques"}],
  "contenants": [{"nom": "string", "lieuNom": "string (doit correspondre à un nom de lieux[] si possible)", "capacite": nombre en hL, "materiau": "string"}],
  "cepages": [{"nom": "string", "couleur": "rouge, blanc ou rose"}],
  "parcelles": [{"nom": "string", "cepageNom": "string (doit correspondre à un nom de cepages[] si possible)", "surface": nombre en hectares, "commune": "string", "appellation": "string", "cadastre": "string"}]
}
Mets un tableau vide pour toute catégorie absente du document. N'invente aucune valeur non présente dans le document — laisse "" ou 0 plutôt que de deviner. Pour la couleur d'un cépage que tu reconnais (Merlot, Cabernet Sauvignon, Sauvignon Blanc, etc.), indique la couleur de raisin réelle même si le document ne la précise pas.`;

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

    // Vérifie que l'appelant est bien authentifié (et pas un visiteur anonyme
    // du site public) avant de consommer le quota Gemini.
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
    const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
    if (userError || !userData?.user) {
      return reponseJson({ error: "Non authentifié" }, 401);
    }

    const { fichierBase64, mimeType } = await req.json();
    if (!fichierBase64 || !mimeType) throw new Error("Fichier manquant");

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: PROMPT },
                { inline_data: { mime_type: mimeType, data: fichierBase64 } },
              ],
            },
          ],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );

    if (!geminiRes.ok) {
      const detail = await geminiRes.text();
      throw new Error(`Gemini a répondu ${geminiRes.status} : ${detail.slice(0, 300)}`);
    }

    const data = await geminiRes.json();
    const texte = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const resultat = JSON.parse(texte);

    return reponseJson(resultat);
  } catch (e) {
    return reponseJson({ error: e instanceof Error ? e.message : "Erreur inconnue" }, 400);
  }
});
