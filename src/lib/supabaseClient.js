import { createClient } from '@supabase/supabase-js';

const url = process.env.REACT_APP_SUPABASE_URL;
const anonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // eslint-disable-next-line no-console
  console.error(
    "Configuration Supabase manquante : REACT_APP_SUPABASE_URL et REACT_APP_SUPABASE_ANON_KEY doivent être définies (fichier .env en local, secrets du dépôt en production)."
  );
}

export const supabase = createClient(url, anonKey);
