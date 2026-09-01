import https from 'node:https';

// Cliente Supabase Admin — usa service_role, ignora RLS
// NUNCA expor esta chave no frontend!
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rokkprgddthtyxxxaajt.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/**
 * Executa uma query REST no Supabase usando a chave service_role.
 * Ignora RLS — use apenas no backend para operações server-side.
 */
async function supabaseAdminFetch<T>(
  path: string,
  options: { method?: string; body?: object; headers?: Record<string, string> } = {}
): Promise<T> {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const method = options.method || 'GET';
  const body = options.body ? JSON.stringify(options.body) : undefined;

  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Prefer': 'return=representation',
      ...options.headers,
    };

    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: reqHeaders,
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data ? JSON.parse(data) : {} as T);
          } else {
            reject(new Error(`Supabase Admin Error [${res.statusCode}] ${path}: ${data}`));
          }
        } catch (e) {
          reject(new Error(`Supabase Admin parse error: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Profile ─────────────────────────────────────────────────────────────────

export async function getProfile(userId: string): Promise<{ affiliate_tag: string } | null> {
  try {
    const rows = await supabaseAdminFetch<any[]>(`profiles?id=eq.${userId}&select=affiliate_tag&limit=1`);
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

// ─── WhatsApp Groups ──────────────────────────────────────────────────────────

export interface DBGroup {
  id: string;
  user_id: string;
  name: string;
  participants_count: number;
  created_at: string;
}

export async function getGroupsByUser(userId: string): Promise<DBGroup[]> {
  return supabaseAdminFetch<DBGroup[]>(
    `whatsapp_groups?user_id=eq.${userId}&order=created_at.desc`
  );
}

export async function insertGroup(userId: string, id: string, name: string, participantsCount: number): Promise<DBGroup> {
  const rows = await supabaseAdminFetch<DBGroup[]>('whatsapp_groups', {
    method: 'POST',
    body: { id, user_id: userId, name, participants_count: participantsCount },
  });
  return rows[0];
}

export async function deleteGroup(userId: string, groupId: string): Promise<void> {
  await supabaseAdminFetch(`whatsapp_groups?id=eq.${groupId}&user_id=eq.${userId}`, {
    method: 'DELETE',
    headers: { 'Prefer': 'return=minimal' },
  });
}

// ─── Custom Templates ─────────────────────────────────────────────────────────

export interface DBTemplate {
  id: string;
  user_id: string;
  title: string;
  template_text: string;
  category: string;
  created_at: string;
}

export async function getTemplatesByUser(userId: string): Promise<DBTemplate[]> {
  return supabaseAdminFetch<DBTemplate[]>(
    `custom_templates?user_id=eq.${userId}&order=created_at.desc`
  );
}

export async function insertTemplate(userId: string, title: string, templateText: string): Promise<DBTemplate> {
  const rows = await supabaseAdminFetch<DBTemplate[]>('custom_templates', {
    method: 'POST',
    body: { user_id: userId, title, template_text: templateText },
  });
  return rows[0];
}

export async function deleteTemplate(userId: string, templateId: string): Promise<void> {
  await supabaseAdminFetch(`custom_templates?id=eq.${templateId}&user_id=eq.${userId}`, {
    method: 'DELETE',
    headers: { 'Prefer': 'return=minimal' },
  });
}
