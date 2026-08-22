import { supabase } from './supabaseClient';

const TABLE = 'cdc_state';

/* Renvoie l'état sauvegardé pour cet utilisateur, ou null si aucune ligne
   n'existe encore (première connexion). */
export async function chargerEtat(userId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('data')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ? data.data : null;
}

/* Écrase l'état sauvegardé pour cet utilisateur (upsert : crée la ligne au
   premier appel, la met à jour ensuite). */
export async function sauvegarderEtat(userId, etat) {
  const { error } = await supabase
    .from(TABLE)
    .upsert({ user_id: userId, data: etat, updated_at: new Date().toISOString() });
  if (error) throw error;
}
