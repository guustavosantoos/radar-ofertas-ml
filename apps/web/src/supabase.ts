import { createClient, SupabaseClient, User, Session } from '@supabase/supabase-js';

// Busca variáveis de ambiente do Vite ou de localStorage
const metaEnv = (import.meta as any)?.env || {};
const envUrl = metaEnv.VITE_SUPABASE_URL;
const envAnonKey = metaEnv.VITE_SUPABASE_ANON_KEY;

const localUrl = localStorage.getItem('radar_supabase_url');
const localKey = localStorage.getItem('radar_supabase_key');

export const SUPABASE_URL = envUrl || localUrl || 'https://xyzcompany.supabase.co';
export const SUPABASE_ANON_KEY = envAnonKey || localKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.demo';

export const isSupabaseConfigured = Boolean((envUrl && envAnonKey) || (localUrl && localKey));

let client: SupabaseClient | null = null;

try {
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
} catch (e) {
  console.warn('[Supabase] Usando cliente fallback para autenticação local:', e);
}

export const supabase = client;

export interface AuthState {
  user: User | { id: string; email: string; user_metadata?: { full_name?: string } } | null;
  session: Session | { access_token: string } | null;
  loading: boolean;
}

export async function signInWithEmail(email: string, password: string) {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  // Fallback demo local para quando o usuário ainda não colocou as chaves do Supabase
  await new Promise(r => setTimeout(r, 400));
  const dummyUser = {
    id: 'demo-user-1',
    email,
    user_metadata: { full_name: email.split('@')[0] || 'Gustavo' },
  };
  const dummySession = { access_token: 'demo-token-' + Date.now() };
  localStorage.setItem('radar_demo_auth', JSON.stringify({ user: dummyUser, session: dummySession }));
  return { user: dummyUser, session: dummySession };
}

export async function signUpWithEmail(email: string, password: string, fullName?: string) {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName || email.split('@')[0] }
      }
    });
    if (error) throw error;
    return data;
  }

  // Fallback demo local
  await new Promise(r => setTimeout(r, 400));
  const dummyUser = {
    id: 'demo-user-' + Date.now(),
    email,
    user_metadata: { full_name: fullName || email.split('@')[0] },
  };
  const dummySession = { access_token: 'demo-token-' + Date.now() };
  localStorage.setItem('radar_demo_auth', JSON.stringify({ user: dummyUser, session: dummySession }));
  return { user: dummyUser, session: dummySession };
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
