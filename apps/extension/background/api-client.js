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

export async function login(email, password) {
  const config = await getApiConfig();
  const url = `${config.baseUrl}/api/extension/login`;

  console.log('[ExtAPI] Login attempt:', { url, email });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });
  } catch (netErr) {
    console.error('[ExtAPI] Erro de rede:', netErr);
    throw new Error(`Erro de rede: ${netErr.message}. Verifique a URL da API: ${url}`);
  }

  let responseText = '';
  try {
    responseText = await response.clone().text();
  } catch (e) {
    console.error('[ExtAPI] Erro ao ler response:', e);
  }

  console.log('[ExtAPI] Response status:', response.status, 'Content-Type:', response.headers.get('content-type'));

  if (!response.ok) {
    console.error('[ExtAPI] Erro na resposta:', { status: response.status, text: responseText.slice(0, 200) });
    
    let errorData;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      try {
        errorData = await response.json();
      } catch (e) {
        errorData = {};
      }
    } else {
      errorData = {};
    }

    let message = 'Erro ao fazer login';
    if (response.status === 401) {
      message = errorData.message || 'Email ou senha incorretos';
    } else if (response.status === 403) {
      message = errorData.message || 'Plano expirado. Renove sua assinatura.';
    } else if (response.status === 404) {
      message = `Endpoint não encontrado (404). Verifique a URL: ${url}`;
    } else if (response.status === 500) {
      message = 'Erro interno no servidor. Tente novamente em alguns instantes.';
    } else if (responseText.includes('<!DOCTYPE')) {
      message = `Resposta inválida do servidor (HTML em vez de JSON). Verifique a URL da API: ${url}`;
    } else {
      message = errorData.message || `Erro ${response.status}: ${responseText.slice(0, 100)}`;
    }

    throw new Error(message);
  }

  let data;
  try {
    data = await response.json();
  } catch (parseErr) {
    console.error('[ExtAPI] Erro ao fazer parse JSON:', { error: parseErr, text: responseText.slice(0, 200) });
    throw new Error(`Resposta inválida do servidor. Verifique a URL da API: ${config.baseUrl}`);
  }

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
