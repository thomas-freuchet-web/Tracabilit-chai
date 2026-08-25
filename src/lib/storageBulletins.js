import { supabase } from './supabaseClient';

// Bulletins d'analyse (PDF/photos) stockés dans le bucket privé Supabase
// Storage "bulletins", sous un dossier par utilisateur (userId/) — les
// règles RLS du bucket restreignent chaque dossier à son propriétaire. Ainsi
// un bulletin importé depuis le téléphone reste consultable depuis
// l'ordinateur, et inversement.
const BUCKET = 'bulletins';

export async function uploaderBulletin(userId, file) {
  const id = `fic_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const nomPropre = file.name.replace(/[^\w.-]/g, '_');
  const path = `${userId}/${id}-${nomPropre}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return { id, nom: file.name, type: file.type, taille: file.size, path };
}

export async function ouvrirBulletinStorage(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 120);
  if (error) throw error;
  const w = window.open(data.signedUrl, '_blank');
  if (!w) alert('Le navigateur a bloqué l\'ouverture du bulletin (pop-up). Autorise les pop-ups pour ce site.');
}

export async function supprimerBulletinStorage(path) {
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) throw error;
}
