import { createClient, User, Session } from '@supabase/supabase-js';

// Credenciais oficiais do projeto Supabase
const metaEnv = (import.meta as any)?.env || {};
const envUrl = metaEnv.VITE_SUPABASE_URL;
const envAnonKey = metaEnv.VITE_SUPABASE_ANON_KEY;

const localUrl = typeof localStorage !== 'undefined' ? localStorage.getItem('radar_supabase_url') : null;
const localKey = typeof localStorage !== 'undefined' ? localStorage.getItem('radar_supabase_key') : null;

export const SUPABASE_URL =
  envUrl || localUrl || 'https://rokkprgddthtyxxxaajt.supabase.co';
export const SUPABASE_ANON_KEY =
  envAnonKey ||
  localKey ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJva2twcmdkZHRodHl4eHhhYWp0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNjQxMzUsImV4cCI6MjEwMzg0MDEzNX0.-rqqCmY1OnFqAnhjpu558_M4ejBMGSNSP8G8YVkNOEM';

export const isSupabaseConfigured = true;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export interface AuthState {
  user: User | { id: string; email: string; user_metadata?: { full_name?: string } } | null;
  session: Session | { access_token: string } | null;
  loading: boolean;
}

export async function signInWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error) {
    throw new Error(error.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : error.message);
  }

  return data;
}

export async function signUpWithEmail(email: string, password: string, fullName?: string) {
  const cleanEmail = email.trim();
  const cleanName = fullName?.trim() || cleanEmail.split('@')[0];

  const { data, error } = await supabase.auth.signUp({
    email: cleanEmail,
    password,
    options: {
      data: {
        full_name: cleanName,
      },
    },
  });

  if (error) {
    const isDuplicate = 
      error.message?.toLowerCase().includes('already') ||
      error.message?.toLowerCase().includes('registered') ||
      error.message?.toLowerCase().includes('exists') ||
      (error as any).code === 'user_already_exists';

    if (isDuplicate) {
      throw new Error('Este e-mail já está cadastrado. Faça login com suas credenciais ou utilize outro e-mail.');
    }
    throw new Error(error.message);
  }

  // Tratamento quando a proteção contra enumeração de e-mail do Supabase estiver ativa
  if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error('Este e-mail já está cadastrado. Faça login com suas credenciais ou utilize outro e-mail.');
  }

  // Tenta sincronizar imediatamente na tabela public.profiles caso o trigger não tenha rodado
  if (data.user) {
    try {
      await supabase.from('profiles').upsert({
        id: data.user.id,
        email: cleanEmail,
        full_name: cleanName,
        affiliate_tag: '',
      });
    } catch (e) {
      console.warn('Erro ao inserir perfil publico:', e);
    }
  }

  return data;
}

export async function signOutUser() {
  localStorage.removeItem('radar_demo_auth');
  if (isSupabaseConfigured && supabase) {
    await supabase.auth.signOut();
  }
}

export function getStoredSession() {
  try {
    const demo = localStorage.getItem('radar_demo_auth');
    if (demo) return JSON.parse(demo);
  } catch {}
  return null;
}

/**
 * Helper de fetch autenticado — injeta automaticamente o JWT do Supabase.
 * Use no lugar de `fetch` para todas as chamadas à API backend protegida.
 */
export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, { ...options, headers });
}
