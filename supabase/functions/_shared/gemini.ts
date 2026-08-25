// Appel à l'API Gemini avec re-tentatives automatiques : le modèle renvoie
// parfois une erreur 503 "UNAVAILABLE" (surcharge temporaire) ou 429 (quota),
// en particulier sur les documents un peu longs (plusieurs lignes de bon de
// livraison, plusieurs cuves...). On retente quelques fois avant d'abandonner
// plutôt que de renvoyer directement l'erreur brute à l'utilisateur.
const TENTATIVES_MAX = 3;
const DELAI_BASE_MS = 1000;

function attendre(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function appelerGemini(
  apiKey: string,
  model: string,
  prompt: string,
  fichierBase64: string,
  mimeType: string
): Promise<string> {
  let derniereErreur = "";

  for (let tentative = 1; tentative <= TENTATIVES_MAX; tentative++) {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: fichierBase64 } }] },
          ],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );

    if (geminiRes.ok) {
      const data = await geminiRes.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    }

    const detail = await geminiRes.text();
    const surcharge = geminiRes.status === 503 || geminiRes.status === 429;
    derniereErreur = surcharge
      ? "Le service d'IA est temporairement surchargé (forte demande sur ce modèle)."
      : `Gemini a répondu ${geminiRes.status} : ${detail.slice(0, 300)}`;

    if (!surcharge || tentative === TENTATIVES_MAX) break;
    await attendre(DELAI_BASE_MS * tentative);
  }

  throw new Error(`${derniereErreur} Réessaie dans quelques instants — le document n'a pas été modifié.`);
}
