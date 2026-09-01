const ENVIRONMENTS = {
  prod: 'https://radar-ofertas-ml-api.vercel.app',
  dev: 'http://localhost:3000',
};
const DEFAULT_ENV = 'prod';

async function getApiConfig() {
  const data = await chrome.storage.local.get(['apiBaseUrl', 'apiEnvironment', 'authToken', 'userId', 'affiliateTag']);
  const env = data.apiEnvironment || DEFAULT_ENV;
  const baseUrl = data.apiBaseUrl || ENVIRONMENTS[env] || ENVIRONMENTS[DEFAULT_ENV];
  return {
    baseUrl,
    token: data.authToken || null,
    userId: data.userId || null,
    affiliateTag: data.affiliateTag || null,
  };
}

function buildHeaders(token) {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function apiRequest(method, path, body = null) {
  const config = await getApiConfig();
  if (!config.token) {
    throw new Error('Não autenticado. Faça login no Achadinho PRO.');
  }

  const url = `${config.baseUrl}${path}`;
  console.log(`[API] ${method} ${url} (env: ${(await chrome.storage.local.get('apiEnvironment')).apiEnvironment || 'default'})`);
  const options = {
    method,
    headers: buildHeaders(config.token),
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (response.status === 401) {
    await chrome.storage.local.remove(['authToken', 'userId', 'userName']);
    throw new Error('Sessão expirada. Faça login novamente.');
  }

  if (!response.ok) {
    // Para 409 (conflito), retornar dados estruturados em vez de throw
    if (response.status === 409) {
      const errorData = await response.json().catch(() => ({}));
      const err = new Error(errorData.error || 'Conflito');
      err.status = 409;
      err.data = errorData;
      throw err;
    }
    const errorText = await response.text().catch(() => 'Erro desconhecido');
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

export async function autoLogin() {
  const config = await getApiConfig();
  const url = `${config.baseUrl}/api/extension/auto-login`;

  console.log('[ExtAPI] Auto-login attempt:', { url });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      credentials: 'include',
    });
  } catch (netErr) {
    console.error('[ExtAPI] Auto-login network error:', netErr);
    throw new Error('Erro de rede ao fazer auto-login');
  }

  console.log('[ExtAPI] Auto-login status:', response.status);

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    console.log('[ExtAPI] Auto-login failed:', { status: response.status, text: errorText.slice(0, 100) });
    
    let errorData = {};
    if (response.headers.get('content-type')?.includes('application/json')) {
      try {
        errorData = await response.json();
      } catch (e) {}
    }

    throw new Error(errorData.error || `Auto-login falhou (${response.status})`);
  }

  const data = await response.json();

  if (!data.token) {
    throw new Error('Resposta inválida: token não retornado');
  }

  await chrome.storage.local.set({
    authToken: data.token,
    userId: data.userId,
    userName: data.userName,
    userPlan: data.plan,
  });

  return data;
}

const SUPABASE_URL = 'https://rokkprgddthtyxxxaajt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJva2twcmdkZHRodHl4eHhhYWp0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNjQxMzUsImV4cCI6MjEwMzg0MDEzNX0.-rqqCmY1OnFqAnhjpu558_M4ejBMGSNSP8G8YVkNOEM';

export async function login(email, password) {
  const config = await getApiConfig();
  const url = `${config.baseUrl}/api/extension/login`;

  console.log('[ExtAPI] Tentativa de login:', { url, email });

  let data = null;

  // 1. Tentar login via backend da API Radar Ofertas ML
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });

    if (response.ok) {
      data = await response.json();
    } else if (response.status === 401) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || 'E-mail ou senha incorretos.');
    }
  } catch (backendErr) {
    if (backendErr.message?.includes('incorretos')) throw backendErr;
    console.warn('[ExtAPI] Falha no backend, usando conexão direta com Supabase:', backendErr);
  }

  // 2. Fallback direto com Supabase Auth se o backend estiver inicializando
  if (!data || !data.token) {
    try {
      const supaRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      const supaData = await supaRes.json();
      if (!supaRes.ok || !supaData.access_token) {
        throw new Error(supaData.error_description || supaData.msg || 'E-mail ou senha incorretos.');
      }

      // Buscar perfil para extrair nome e Tag de Afiliado
      let profile = null;
      try {
        const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${supaData.user?.id}&select=*`, {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${supaData.access_token}`,
          },
        });
        if (profRes.ok) {
          const profs = await profRes.json();
          if (Array.isArray(profs) && profs.length > 0) profile = profs[0];
        }
      } catch {}

      const userName = profile?.full_name || supaData.user?.user_metadata?.full_name || email.split('@')[0];
      const affiliateTag = profile?.affiliate_tag || '';

      data = {
        token: supaData.access_token,
        userId: supaData.user?.id,
        userName: userName,
        plan: profile?.plan || 'pro',
        affiliateTag: affiliateTag,
      };
    } catch (supaErr) {
      console.error('[ExtAPI] Erro Supabase:', supaErr);
      throw supaErr;
    }
  }

  if (!data || !data.token) {
    throw new Error('Não foi possível autenticar. Verifique suas credenciais.');
  }

  // Salvar credenciais e Tag de Afiliado no storage local da extensão
  await chrome.storage.local.set({
    authToken: data.token,
    userId: data.userId,
    userName: data.userName,
    userPlan: data.plan || 'pro',
    affiliateTag: data.affiliateTag || '',
  });

  return data;
}

export async function getKeywordSearches() {
  return apiRequest('GET', '/api/automacao/keywords');
}

export async function logout() {
  await chrome.storage.local.remove([
    'authToken', 'userId', 'userName', 'userPlan',
  ]);
}

export async function isAuthenticated() {
  const data = await chrome.storage.local.get(['authToken', 'userId']);
  return !!(data.authToken && data.userId);
}

export async function getAuthInfo() {
  const data = await chrome.storage.local.get(['authToken', 'userId', 'userName', 'userPlan']);
  return {
    isLoggedIn: !!(data.authToken && data.userId),
    userId: data.userId || null,
    userName: data.userName || null,
    plan: data.userPlan || null,
  };
}

export async function fetchTasks() {
  return apiRequest('GET', '/api/automacao/tarefas');
}

export async function saveProduct(payload) {
  return apiRequest('POST', '/api/automacao/salvar', payload);
}

export async function updateTaskStatus(taskId, status, result = null) {
  return apiRequest('PATCH', `/api/automacao/tarefas/${taskId}`, {
    status,
    result,
  });
}

export async function getConfig() {
  return apiRequest('GET', '/api/automacao/config');
}

export async function updateConfig(configData) {
  return apiRequest('PUT', '/api/automacao/config', configData);
}

export async function createTasks(tasks) {
  return apiRequest('POST', '/api/automacao/tarefas', { tasks });
}

export async function setApiBaseUrl(url) {
  await chrome.storage.local.set({ apiBaseUrl: url });
}

export async function getApiBaseUrl() {
  const data = await chrome.storage.local.get(['apiBaseUrl', 'apiEnvironment']);
  const env = data.apiEnvironment || DEFAULT_ENV;
  return data.apiBaseUrl || ENVIRONMENTS[env] || ENVIRONMENTS[DEFAULT_ENV];
}

export async function setApiEnvironment(env) {
  if (!ENVIRONMENTS[env]) return;
  await chrome.storage.local.set({
    apiEnvironment: env,
    apiBaseUrl: ENVIRONMENTS[env],
  });
}

export async function getApiEnvironment() {
  const data = await chrome.storage.local.get(['apiEnvironment']);
  return data.apiEnvironment || DEFAULT_ENV;
}

export function getEnvironments() {
  return { ...ENVIRONMENTS };
}

// ===== Custom Categories API =====

export async function getCustomCategories() {
  return apiRequest('GET', '/api/extension/custom-categories');
}

export async function getMlCategories() {
  return apiRequest('GET', '/api/extension/ml-categories');
}

export async function getAmazonCategories() {
  return apiRequest('GET', '/api/extension/amazon-categories');
}

// ===== User Lists API =====

export async function getLists() {
  return apiRequest('GET', '/api/lists');
}

export async function createList(name) {
  return apiRequest('POST', '/api/lists', { name });
}

/**
 * Cria (ou reencontra) a "Lista Cupons" de um cupom do Mercado Livre.
 *
 * Mesma rota de createList: o servidor entra no ramo de cupom só quando o corpo
 * traz `coupon`. O payload manda o TEXTO BRUTO do modal em `coupon.rawText` — quem
 * deriva mínimo, teto, tipo/valor e vencimento é o servidor. Números vindos do card
 * viajam junto apenas como fallback de exibição.
 */
export async function createCouponList(name, coupon) {
  return apiRequest('POST', '/api/lists', { name, platform: 'ml', coupon });
}

/**
 * Reconciliação opt-in: remove da lista o que não está no manifesto.
 * Só deve ser chamada depois de uma varredura COMPLETA de todas as páginas —
 * salvar uma seleção nunca remove nada (ver §3.14 do plano).
 */
export async function reconcileList(listId, eligibleItemIds, importId) {
  return apiRequest('POST', `/api/lists/${listId}/reconcile`, { eligibleItemIds, importId });
}

export async function renameList(listId, name) {
  return apiRequest('PUT', `/api/lists/${listId}`, { name });
}

export async function deleteList(listId) {
  return apiRequest('DELETE', `/api/lists/${listId}`);
}

export async function getListItems(listId) {
  return apiRequest('GET', `/api/lists/${listId}/items`);
}

export async function addListItems(listId, items) {
  return apiRequest('POST', `/api/lists/${listId}/items`, { items });
}

export async function removeListItem(listId, itemId) {
  return apiRequest('DELETE', `/api/lists/${listId}/items/${itemId}`);
}

// ===== Shopee Products API =====

export async function saveShopeeProducts(products, listId, keywordGroupId) {
  return apiRequest('POST', '/api/extension/shopee-products', { products, listId, keywordGroupId });
}

// ===== Cupons API =====

export async function saveCoupons(marketplace, coupons, exhaustedCodes = [], sourceUrl = null) {
  return apiRequest('POST', '/api/extension/coupons', { marketplace, coupons, exhaustedCodes, sourceUrl });
}

export async function saveCouponsDebug(marketplace, debug) {
  return apiRequest('POST', '/api/extension/coupons-debug', { marketplace, debug });
}

/**
 * Cupons do ML lidos numa sincronização. Rota própria — a de cima é o fluxo Shopee,
 * que exige categoria e recebe mínimo/teto prontos; aqui quem interpreta o `rawText`
 * do modal é o servidor, e ele devolve os campos derivados para o painel exibir.
 */
export async function syncMlCoupons(coupons) {
  return apiRequest('POST', '/api/extension/ml-coupons/sync', { coupons });
}

// ===== Amazon Products API =====

export async function saveAmazonProducts(products, listId, keywordGroupId) {
  return apiRequest('POST', '/api/extension/amazon-products', { products, listId, keywordGroupId });
}

// ===== Category AI Naming =====

export async function generateCategoryName(breadcrumb) {
  return apiRequest('POST', '/api/extension/category-name', { breadcrumb });
}

// ===== Schedule API =====

export async function getSchedule() {
  return apiRequest('GET', '/api/automacao/schedule');
}

export async function saveSchedule(scheduleConfig) {
  return apiRequest('PUT', '/api/automacao/schedule', scheduleConfig);
}
