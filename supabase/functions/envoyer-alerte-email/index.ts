// Envoie un email d'alerte quand une cuve suivie par une programmation
// s'écarte de sa consigne de température. Appelée côté client juste après
// l'enregistrement d'un relevé (voir verifierProgrammation dans App.js) —
// l'alerte in-app reste affichée même si cet envoi échoue.
//
// Protégée par l'authentification Supabase, comme les autres fonctions —
// la clé Resend reste ici, côté serveur.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const REPORT_EMAIL_TO = Deno.env.get("REPORT_EMAIL_TO");
const REPORT_EMAIL_FROM = Deno.env.get("REPORT_EMAIL_FROM") || "Cahier de Chai <onboarding@resend.dev>";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function reponseJson(corps: unknown, status = 200) {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    if (!RESEND_API_KEY || !REPORT_EMAIL_TO) throw new Error("RESEND_API_KEY / REPORT_EMAIL_TO non configurées côté serveur");

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
    const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
    if (userError || !userData?.user) {
      return reponseJson({ error: "Non authentifié" }, 401);
    }

    const { lotCode, densite, temperatureMesuree, temperatureCible, date } = await req.json();
    if (!lotCode || temperatureMesuree === undefined) throw new Error("Paramètres manquants");

    const ecart = temperatureCible !== null && temperatureCible !== undefined
      ? Math.round((temperatureMesuree - temperatureCible) * 10) / 10
      : null;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: REPORT_EMAIL_FROM,
        to: [REPORT_EMAIL_TO],
        subject: `⚠ Alerte température — ${lotCode}`,
        text: `Le relevé du ${date} sur ${lotCode} indique ${temperatureMesuree} °C`
          + (temperatureCible !== null && temperatureCible !== undefined
            ? ` pour une consigne de ${temperatureCible} °C (écart ${ecart! > 0 ? "+" : ""}${ecart} °C)`
            : "")
          + (densite !== undefined && densite !== null ? ` à une densité de ${densite}.` : "."),
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Échec de l'envoi (${res.status}) : ${detail}`);
    }

    return reponseJson({ ok: true });
  } catch (e) {
    return reponseJson({ error: e instanceof Error ? e.message : "Erreur inconnue" }, 400);
  }
});
