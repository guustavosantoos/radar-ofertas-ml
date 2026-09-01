import * as api from './api-client.js';
import './send-queue.js'; // Side-effect: sets globalThis.sendQueue
import '../services/ml-coupon-tab-link.js'; // Side-effect: sets globalThis.MlCouponTabLink

console.log('[AchadinhoPRO] Service Worker iniciado');

const STATE = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED_FOR_CAPTCHA: 'PAUSED_FOR_CAPTCHA',
  ERROR: 'ERROR',
};

let automationState = STATE.IDLE;
let isProcessing = false;
let currentGhostTabId = null;
let shouldStop = false;
let taskStats = { total: 0, completed: 0, failed: 0, totalSaved: 0, totalSkippedNoLink: 0 };
let activityLog = [];

if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[AchadinhoPRO] Erro ao configurar sidePanel:', err));
} else {
  console.warn('[AchadinhoPRO] chrome.sidePanel API não disponível. Requer Chrome 114+.');
}

const SUPPORTED_HOSTS = [
  'mercadolivre.com.br',
  'mercadolibre.com',
  'lista.mercadolivre.com.br',
  'produto.mercadolivre.com.br',
  'shopee.com.br',
  'amazon.com.br',
];

const ML_BASE_URL = 'https://www.mercadolivre.com.br';
const ML_AFFILIATE_API = `${ML_BASE_URL}/affiliate-program/api/v2/stripe/user`;

// Platform configuration for multi-marketplace keyword search
const PLATFORM_CONFIG = {
  ml: {
    name: 'Mercado Livre',
    searchUrl: (kw) => `https://lista.mercadolivre.com.br/${encodeURIComponent(kw)}`,
    validateProduct: (p) => !!(p.mlItemId && p.productName && p.price),
    getProductId: (p) => p.mlItemId,
    extractIdFromUrl: (url) => {
      if (!url) return null;
      const match = url.match(/MLB-?\d+/i);
      return match ? match[0].replace('-', '') : null;
    },
    requiresAffiliateLink: true,
    saveBatch: false,
    cleanUrl: (url) => cleanProductUrl(url),
    loginCheck: () => checkMlLogin(),
    extraWait: 0,
    needsScroll: false,
  },
  amazon: {
    name: 'Amazon',
    searchUrl: (kw) => `https://www.amazon.com.br/s?k=${encodeURIComponent(kw)}`,
    validateProduct: (p) => !!(p.asin && p.productName && p.price),
    getProductId: (p) => p.asin || p.platformItemId,
    extractIdFromUrl: () => null,
    requiresAffiliateLink: true,
    saveBatch: true,
    cleanUrl: (url) => url,
    loginCheck: () => Promise.resolve({ loggedIn: true }),
    extraWait: 1,
    needsScroll: false,
  },
  shopee: {
    name: 'Shopee',
    searchUrl: (kw) => `https://shopee.com.br/search?keyword=${encodeURIComponent(kw)}`,
    validateProduct: (p) => !!((p.itemId || p.platformItemId) && p.productName && p.price),
    getProductId: (p) => p.itemId || p.platformItemId,
    extractIdFromUrl: () => null,
    requiresAffiliateLink: false,
    saveBatch: true,
    cleanUrl: (url) => url,
    loginCheck: () => Promise.resolve({ loggedIn: true }),
    extraWait: 3,
    needsScroll: true,
  },
};

function isSupportedSite(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return SUPPORTED_HOSTS.some((host) => hostname.includes(host));
  } catch {
    return false;
  }
}

function humanDelay(minSeconds, maxSeconds) {
  const ms = (Math.random() * (maxSeconds - minSeconds) + minSeconds) * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addLog(message, type = 'info') {
  const entry = {
    time: new Date().toLocaleTimeString('pt-BR'),
    message,
    type,
  };
  activityLog.unshift(entry);
  if (activityLog.length > 50) activityLog.length = 50;
  broadcastStateUpdate();
}

async function persistState() {
  await chrome.storage.local.set({
    automationState,
    taskStats,
  });
}

async function restoreState() {
  const data = await chrome.storage.local.get(['automationState', 'taskStats']);
  if (data.automationState && data.automationState !== STATE.RUNNING) {
    automationState = data.automationState;
  }
  if (data.taskStats) {
    taskStats = data.taskStats;
  }
}

function getStateSnapshot() {
  return {
    state: automationState,
    isProcessing,
    currentGhostTabId,
    taskStats: { ...taskStats },
    activityLog: [...activityLog],
  };
}

function broadcastStateUpdate() {
  chrome.runtime.sendMessage({
    action: 'stateUpdate',
    ...getStateSnapshot(),
  }).catch(() => {});
}

async function setState(newState) {
  const oldState = automationState;
  automationState = newState;
  console.log(`[AchadinhoPRO] Estado: ${oldState} → ${newState}`);
  await persistState();
  broadcastStateUpdate();
}

async function getMercadoLivreCookies() {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ domain: '.mercadolivre.com.br' }, (cookies) => {
      if (chrome.runtime.lastError) {
        console.error('[AchadinhoPRO] Erro ao obter cookies:', chrome.runtime.lastError);
        resolve(null);
        return;
      }

      if (!cookies || cookies.length === 0) {
        console.warn('[AchadinhoPRO] Nenhum cookie encontrado para mercadolivre.com.br');
        resolve(null);
        return;
      }

      const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      console.log('[AchadinhoPRO] Cookies ML obtidos:', cookies.length);
      resolve(cookieString);
    });
  });
}

// Tag do afiliado (cache)
let cachedAffiliateTag = null;

function getAffiliateHeaders(cookies, csrfToken = null) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Origin': ML_BASE_URL,
    'Referer': `${ML_BASE_URL}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Cookie': cookies,
  };

  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
    headers['X-XSRF-Token'] = csrfToken;
    headers['csrf-token'] = csrfToken;
  }

  return headers;
}

async function checkMlLogin() {
  const cookies = await getMercadoLivreCookies();
  if (!cookies) {
    return { loggedIn: false, error: 'Nenhum cookie ML encontrado. Faça login no Mercado Livre.' };
  }

  try {
    const headers = getAffiliateHeaders(cookies);
    const response = await fetch(`${ML_AFFILIATE_API}/tags`, {
      method: 'GET',
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      return { loggedIn: false, error: 'Não logado no ML Afiliados. Faça login em mercadolivre.com.br/affiliate-program.' };
    }

    const data = await response.json();
    const tags = data.tags || data;
    if (Array.isArray(tags) && tags.length > 0) {
      const firstTag = tags[0];
      const tag = typeof firstTag === 'object' ? (firstTag.tag || firstTag.name || firstTag.id) : firstTag;
      return { loggedIn: true, tag, cookies };
    }

    return { loggedIn: false, error: 'Nenhuma tag de afiliado encontrada. Cadastre-se no programa de afiliados.' };
  } catch (error) {
    return { loggedIn: false, error: `Erro ao verificar ML: ${error.message}` };
  }
}

// Gera link de afiliado executando a chamada API DENTRO do contexto de uma página ML
// Isso é necessário porque o fetch do service worker não tem acesso aos cookies/CSRF do ML
let linkBuilderTabId = null;
let linkBuilderReady = false;
let linkBuilderConsecutiveFailures = 0;
let linkBuilderCooldownUntil = 0;
const LINKBUILDER_MAX_FAILURES = 3;
const LINKBUILDER_COOLDOWN_MS = 60000; // 1 minute cooldown after repeated failures

async function ensureLinkBuilderTab() {
  // Check cooldown: stop opening tabs after repeated failures
  if (linkBuilderConsecutiveFailures >= LINKBUILDER_MAX_FAILURES) {
    const now = Date.now();
    if (now < linkBuilderCooldownUntil) {
      const remaining = Math.ceil((linkBuilderCooldownUntil - now) / 1000);
      throw new Error(`Linkbuilder em cooldown (${remaining}s restantes após ${linkBuilderConsecutiveFailures} falhas consecutivas)`);
    }
    // Cooldown expired, reset and allow retry
    console.log('[AchadinhoPRO] Cooldown do linkbuilder expirou, tentando novamente...');
    linkBuilderConsecutiveFailures = 0;
  }

  // Check if we already have a valid linkbuilder tab
  if (linkBuilderTabId !== null) {
    try {
      const tab = await chrome.tabs.get(linkBuilderTabId);
      if (tab && tab.url && tab.url.indexOf('mercadolivre.com.br') !== -1) {
        // A aba pode existir mas ainda estar inicializando: outra chamada a abriu
        // e continua aguardando os 2s de init do JS da página (linkBuilderReady só
        // vira true na linha do "Aba linkbuilder pronta"). Reusá-la cedo dispara a
        // geração de link contra uma página sem CSRF pronto → falha → conta como
        // falha consecutiva e pode acionar o cooldown de 60s. Espera a prontidão.
        if (!linkBuilderReady) {
          const readyDeadline = Date.now() + 20000;
          while (!linkBuilderReady && linkBuilderTabId === tab.id && Date.now() < readyDeadline) {
            await new Promise(r => setTimeout(r, 200));
          }
        }
        // Só reusa se a aba continua sendo a mesma e ficou pronta; caso contrário
        // (timeout de init ou aba trocada) cai para reabrir abaixo.
        if (linkBuilderReady && linkBuilderTabId === tab.id) {
          return linkBuilderTabId;
        }
      }
    } catch (e) {
      // Tab doesn't exist anymore
      linkBuilderTabId = null;
      linkBuilderReady = false;
    }
  }

  // Open the linkbuilder page
  console.log('[AchadinhoPRO] Abrindo aba linkbuilder para gerar links...');
  const tab = await chrome.tabs.create({
    url: `${ML_BASE_URL}/afiliados/linkbuilder`,
    active: false,
  });
  linkBuilderTabId = tab.id;
  linkBuilderReady = false;

  // Wait for tab to load
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timeout ao carregar linkbuilder'));
    }, 20000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === linkBuilderTabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });

  // Wait for page JS to initialize
  await new Promise(r => setTimeout(r, 2000));
  linkBuilderReady = true;
  console.log('[AchadinhoPRO] Aba linkbuilder pronta');
  return linkBuilderTabId;
}

async function closeLinkBuilderTab() {
  if (linkBuilderTabId !== null) {
    try { await chrome.tabs.remove(linkBuilderTabId); } catch (e) {}
    linkBuilderTabId = null;
    linkBuilderReady = false;
  }
}

async function generateAffiliateLinkViaCookies(productUrl) {
  console.log('[AchadinhoPRO] Gerando link de afiliado para:', productUrl.slice(0, 60) + '...');

  let tabId;
  try {
    tabId = await ensureLinkBuilderTab();
  } catch (e) {
    console.error('[AchadinhoPRO] Não foi possível abrir aba linkbuilder:', e.message);
    // Only increment failures and set cooldown if NOT already in cooldown
    // This prevents the cooldown from being infinitely extended by queued items
    const alreadyInCooldown = linkBuilderConsecutiveFailures >= LINKBUILDER_MAX_FAILURES && Date.now() < linkBuilderCooldownUntil;
    if (!alreadyInCooldown) {
      linkBuilderConsecutiveFailures++;
      linkBuilderCooldownUntil = Date.now() + LINKBUILDER_COOLDOWN_MS;
      console.warn(`[AchadinhoPRO] Linkbuilder falha ${linkBuilderConsecutiveFailures}/${LINKBUILDER_MAX_FAILURES}`);
      await closeLinkBuilderTab();
    }
    // Only signal cooldown to the queue when we've actually hit the threshold (3+ failures).
    // Failures 1-2 are recoverable — the linkbuilder will retry normally on the next attempt.
    const isRealCooldown = linkBuilderConsecutiveFailures >= LINKBUILDER_MAX_FAILURES;
    if (isRealCooldown) {
      const remaining = Math.ceil(Math.max(0, linkBuilderCooldownUntil - Date.now()) / 1000);
      return { success: false, error: `Linkbuilder em cooldown (${remaining}s)`, cooldown: true, cooldownMs: Math.max(0, linkBuilderCooldownUntil - Date.now()) };
    }
    return { success: false, error: 'Falha ao acessar linkbuilder, tentando novamente...' };
  }

  console.log('[AchadinhoPRO] Tentando gerar link de afiliado para:', productUrl.slice(0, 50) + '...');

  // Portão de forma da URL + normalização, num único lugar (ver parseMlProductUrl).
  const mlRef = parseMlProductUrl(productUrl);

  if (!mlRef) {
    console.warn('[AchadinhoPRO] URL não é de produto do ML — recusando gerar link (NÃO usa URL original como afiliado):', String(productUrl).slice(0, 120));
    // CRÍTICO: nunca retornar a URL original (ex.: click1.mercadolivre.com.br) como
    // "short_link". Ela não é link de afiliado e não atribui comissão. Falhar é o certo —
    // o produto não será salvo/enviado sem um short link meli.la válido.
    // notRetryable: a FORMA da URL não muda entre tentativas. Sem essa marca a fila
    // gasta 2 retries com 5s de espera cada por item (send-queue.js) num erro
    // determinístico — mesmo desperdício que b5516d83 já pagou uma vez.
    return { success: false, error: 'Não foi possível extrair o ID do produto (MLB) da URL para gerar link de afiliado meli.la', notRetryable: true };
  }

  console.log('[AchadinhoPRO] ID do produto extraído:', mlRef.itemId);

  const normalizedUrl = mlRef.url;
  if (normalizedUrl !== productUrl) {
    console.log('[AchadinhoPRO] URL normalizada:', normalizedUrl);
  }

  // Método 1: Tentar API v2 de afiliados
  try {
    // Execute the createLink API call FROM WITHIN the ML page context
    // This way fetch automatically has the correct cookies, CSRF, and origin
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (url, tag) => {
        try {
          // Step 1: Get CSRF token from the page
          let csrfToken = null;

          // Try meta tag
          const metaEl = document.querySelector('meta[name="csrf-token"]');
          if (metaEl) csrfToken = metaEl.getAttribute('content');

          // Try from scripts
          if (!csrfToken) {
            const scripts = document.querySelectorAll('script:not([src])');
            for (const script of scripts) {
              const text = script.textContent || '';
              const patterns = [
                /"csrfToken"\s*:\s*"([^"]+)"/,
                /csrfToken\s*[:=]\s*["']([^"']+)["']/,
                /"csrf"\s*:\s*"([^"]+)"/,
              ];
              for (const p of patterns) {
                const match = text.match(p);
                if (match) { csrfToken = match[1]; break; }
              }
              if (csrfToken) break;
            }
          }

          // Try from cookie as last resort
          if (!csrfToken) {
            const cookieMatch = document.cookie.match(/_csrf=([^;]+)/);
            if (cookieMatch) csrfToken = decodeURIComponent(cookieMatch[1]);
          }

          if (!csrfToken) {
            return { success: false, error: 'CSRF token não encontrado na página' };
          }

          // Step 2: If no tag provided, get it
          let affiliateTag = tag;
          if (!affiliateTag) {
            const tagsResp = await fetch('/affiliate-program/api/v2/stripe/user/tags', {
              credentials: 'include',
            });
            if (tagsResp.ok) {
              const tagsData = await tagsResp.json();
              const tags = tagsData.tags || tagsData;
              if (Array.isArray(tags) && tags.length > 0) {
                affiliateTag = typeof tags[0] === 'object' ? (tags[0].tag || tags[0].name || tags[0].id) : tags[0];
              }
            }
          }

          if (!affiliateTag) {
            return { success: false, error: 'Tag de afiliado não encontrada' };
          }

          // Step 3: Call createLink API (same origin, cookies sent automatically)
          const response = await fetch('/affiliate-program/api/v2/affiliates/createLink', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-csrf-token': csrfToken,
            },
            credentials: 'include',
            body: JSON.stringify({
              urls: [url],
              tag: affiliateTag,
            }),
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            return { success: false, error: `API retornou ${response.status}: ${errText.slice(0, 100)}`, status: response.status };
          }

          const data = await response.json();

          if (data.urls && Array.isArray(data.urls) && data.urls.length > 0) {
            const result = data.urls[0];

            // Detectar error_code 111: produto não permitido no programa de afiliados
            if (result.error_code === 111) {
              return { success: false, error: 'Produto não permitido no programa de afiliados (error 111)', notRetryable: true };
            }

            const shortLink = result.short_url || result.short_link || null;
            // Só o short link (https://meli.la/...) atribui comissão. NUNCA cair para o
            // long_url/long_link, que é a URL de redirect/produto (click1/produto.mercadolivre)
            // e não é link de afiliado.
            if (!shortLink || !shortLink.startsWith('https://meli.la/')) {
              return { success: false, error: 'API não retornou short link meli.la válido' };
            }
            return { success: true, short_link: shortLink, tag: affiliateTag };
          }

          return { success: false, error: 'Resposta inesperada da API' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
      args: [normalizedUrl, cachedAffiliateTag],
      world: 'MAIN', // Execute in page context for full cookie/CSRF access
    });

    if (results && results[0] && results[0].result) {
      const result = results[0].result;

      if (result.success) {
        // Guarda final: jamais tratar como sucesso um link que não seja short link meli.la.
        // Blinda contra qualquer caminho que devolva URL de redirect/produto como "válido".
        if (!result.short_link || !result.short_link.startsWith('https://meli.la/')) {
          console.warn('[AchadinhoPRO] Link gerado não é meli.la, descartando:', result.short_link);
          return { success: false, error: 'Link gerado não é short link de afiliado meli.la' };
        }
        // Cache the tag for future calls
        if (result.tag) cachedAffiliateTag = result.tag;
        // Reset failure counter on success
        linkBuilderConsecutiveFailures = 0;
        console.log('[AchadinhoPRO] Link de afiliado gerado:', result.short_link);
        return { success: true, short_link: result.short_link };
      } else {
        // If session expired or CSRF failed, invalidate tab so next call opens a fresh one
        if (result.status === 403 || result.status === 404) {
          console.warn('[AchadinhoPRO] Sessão inválida (status ' + result.status + '), invalidando aba...');
          linkBuilderConsecutiveFailures++;
          linkBuilderCooldownUntil = Date.now() + LINKBUILDER_COOLDOWN_MS;
          await closeLinkBuilderTab();
        }
        console.warn('[AchadinhoPRO] Erro ao gerar link:', result.error);
        return { success: false, error: result.error, notRetryable: result.notRetryable || false };
      }
    }

    return { success: false, error: 'Sem resposta do script injetado' };
  } catch (e) {
    console.error('[AchadinhoPRO] Erro ao executar script na aba ML:', e.message);
    // Track consecutive failures to avoid infinite tab opening
    linkBuilderConsecutiveFailures++;
    linkBuilderCooldownUntil = Date.now() + LINKBUILDER_COOLDOWN_MS;
    console.warn(`[AchadinhoPRO] Linkbuilder falha ${linkBuilderConsecutiveFailures}/${LINKBUILDER_MAX_FAILURES} — cooldown ativado`);
    // Invalidate tab on error
    await closeLinkBuilderTab();
    return { success: false, error: `Erro: ${e.message}` };
  }
}

// ===== Amazon Affiliate Link Generation =====

let amazonAffiliateTabId = null;
let cachedAmazonTag = null;

/**
 * A aba ainda executa script? Sonda de uma linha.
 *
 * `chrome.tabs.get` NÃO distingue uma aba viva de uma aba parada na tela de erro
 * de rede do Chrome: nas duas o `tab.url` continua sendo o da Amazon e o status
 * é 'complete'. Sem esta sonda, `ensureAmazonTab` devolvia a aba quebrada para
 * todos os produtos do lote e cada um morria em "Frame with ID 0 is showing
 * error page" — foi o que produziu "0 enviados, 10 erros" com a fila cheia.
 */
async function abaAmazonResponde(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: () => true });
    return !!(res && res.result === true);
  } catch (e) {
    console.warn('[AchadinhoPRO] Aba Amazon não responde, será recriada:', e && e.message);
    return false;
  }
}

async function ensureAmazonTab() {
  if (amazonAffiliateTabId !== null) {
    try {
      const tab = await chrome.tabs.get(amazonAffiliateTabId);
      if (tab && tab.url && tab.url.indexOf('amazon.com.br') !== -1 && (await abaAmazonResponde(amazonAffiliateTabId))) {
        return amazonAffiliateTabId;
      }
      await closeAmazonTab();
    } catch (e) {
      amazonAffiliateTabId = null;
    }
  }

  console.log('[AchadinhoPRO] Abrindo aba Amazon para gerar links...');
  const tab = await chrome.tabs.create({
    url: 'https://www.amazon.com.br/',
    active: false,
  });
  amazonAffiliateTabId = tab.id;

  await new Promise((resolve, reject) => {
    // 15s (era 20s): com a retentativa de aba, o pior caso precisa caber no teto
    // de 60s do enriquecimento da fila — senão o item volta com "tempo esgotado"
    // em vez do motivo real. Ver enrichProductWithAffiliateLink.
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timeout ao carregar aba Amazon'));
    }, 15000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === amazonAffiliateTabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });

  await new Promise(r => setTimeout(r, 2000));
  console.log('[AchadinhoPRO] Aba Amazon pronta');
  return amazonAffiliateTabId;
}

async function closeAmazonTab() {
  if (amazonAffiliateTabId !== null) {
    try { await chrome.tabs.remove(amazonAffiliateTabId); } catch (e) {}
    amazonAffiliateTabId = null;
  }
}

// ===== Link de afiliado Amazon =====
//
// O link é LONGO e canônico: `https://www.amazon.com.br/dp/{ASIN}?tag={TAG}`.
//
// Antes era o `amzn.to` do SiteStripe, e ele custava três coisas: (1) uma chamada
// `getShortUrl` POR PRODUTO — a que respondia 503 em lote e produzia
// "Nenhum link de afiliado gerado"; (2) auditabilidade, porque a tag só aparece
// resolvendo o redirect (e cada resolução conta como clique no Associados), que é o
// que deixou o bug do `tag=status` invisível por semanas; (3) determinismo — dois
// saves do mesmo produto davam short links diferentes.
//
// Agora só a TAG vem da Amazon (uma vez por lote, com cache), e o link é montado aqui.

/**
 * A tag de afiliado Amazon (BR) tem o formato "algo-20". NUNCA adivinhar qual campo da
 * resposta é a tag: pegar o campo errado (ex.: a chave "status" do envelope JSON) gera
 * link de comissão para a CONTA ERRADA — bug financeiro/jurídico gravíssimo. Espelha o
 * `AMZ_TAG_RE` do servidor (server/marketplace-link.ts).
 */
const AMZ_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*-\d{2}$/;

/** ASIN: 10 alfanuméricos. Espelha `AMZ_ASIN_RE` do servidor — os dois têm de bater. */
const AMZ_ASIN_RE = /^[A-Z0-9]{10}$/;
const AMZ_LINK_BASE = 'https://www.amazon.com.br/dp/';
const AMZ_PRODUCT_HOSTS = ['www.amazon.com.br', 'amazon.com.br'];

/** Cache da tag: `chrome.storage.session` (morre com o navegador) + TTL. */
const AMZ_TAG_CACHE_KEY = 'amazonAffiliateTag';
const AMZ_TAG_TTL_MS = 30 * 60 * 1000;

function normalizarAsin(raw) {
  if (typeof raw !== 'string') return null;
  const asin = raw.trim().toUpperCase();
  return AMZ_ASIN_RE.test(asin) ? asin : null;
}

/**
 * ASIN embutido numa URL de produto da Amazon BR. `null` para qualquer outra coisa —
 * inclusive `amzn.to`, que é opaco. Host EXATO e https: `https://amzn.to.evil.com/dp/X`
 * e `https://www.amazon.com.br@evil.com/dp/X` não são a Amazon.
 */
function extrairAsinDaUrlAmazon(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (AMZ_PRODUCT_HOSTS.indexOf(parsed.hostname.toLowerCase()) === -1) return null;
  const m = parsed.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([A-Za-z0-9]{10})(?:[/?]|$)/i);
  return m ? normalizarAsin(m[1]) : null;
}

/** Link canônico, ou `null` se ASIN/tag não servirem. Nunca monta link "quase certo". */
function buildAmazonAffiliateLink(asin, tag) {
  const a = normalizarAsin(asin);
  if (!a || !AMZ_TAG_RE.test(String(tag || '').trim())) return null;
  return AMZ_LINK_BASE + a + '?tag=' + encodeURIComponent(String(tag).trim());
}

// Serializa as escritas do cache da tag (gravar × invalidar). Ver o listener de cookies.
let filaDoCacheDaTag = Promise.resolve();

/** Zera a tag em memória e no `storage.session`. */
async function invalidarTagAmazon(motivo) {
  cachedAmazonTag = null;
  try {
    await chrome.storage.session.remove(AMZ_TAG_CACHE_KEY);
  } catch (e) { /* storage.session pode não existir em versões antigas do Chrome */ }
  if (motivo) console.log('[AchadinhoPRO] Tag Amazon invalidada:', motivo);
}

/** Tag cacheada ainda dentro do TTL, ou `null`. */
async function lerTagDoCache() {
  try {
    const guardado = await chrome.storage.session.get(AMZ_TAG_CACHE_KEY);
    const entrada = guardado && guardado[AMZ_TAG_CACHE_KEY];
    if (!entrada || !entrada.tag || !entrada.fetchedAt) return null;
    if (Date.now() - entrada.fetchedAt > AMZ_TAG_TTL_MS) return null;
    // Revalida o FORMATO a cada leitura: cache antigo de versões que gravavam "status"
    // não pode ressuscitar por estar dentro do TTL.
    return AMZ_TAG_RE.test(String(entrada.tag)) ? entrada.tag : null;
  } catch (e) {
    return null;
  }
}

async function gravarTagNoCache(tag) {
  filaDoCacheDaTag = filaDoCacheDaTag.then(async () => {
    cachedAmazonTag = tag;
    try {
      await chrome.storage.session.set({ [AMZ_TAG_CACHE_KEY]: { tag, fetchedAt: Date.now() } });
    } catch (e) { /* sem storage.session o cache fica só em memória */ }
  }).catch(() => {});
  return filaDoCacheDaTag;
}

/**
 * Busca a tag da loja no SiteStripe, usando os cookies da sessão do Associados.
 *
 * Devolve `{ success, tag }` ou `{ success:false, reason, error }`, com `reason` em
 * 'session' | 'rate-limit' | 'tab' | 'other' — a classificação é o que permite à fila
 * pausar (sessão) em vez de queimar o lote, e esperar (throttling) em vez de errar.
 */
async function buscarTagAmazonNaAba() {
  let tabId;
  const abaJaExistia = amazonAffiliateTabId !== null;
  try {
    tabId = await ensureAmazonTab();
  } catch (e) {
    console.error('[AchadinhoPRO] Não foi possível abrir aba Amazon:', e.message);
    await closeAmazonTab();
    return { success: false, reason: 'tab', error: `Não foi possível abrir a Amazon: ${e.message}` };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        try {
          const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*-\d{2}$/;
          function findAmazonTag(node, depth) {
            if (depth > 5 || node == null) return null;
            if (typeof node === 'string') {
              const v = node.trim();
              return TAG_RE.test(v) ? v : null;
            }
            if (Array.isArray(node)) {
              for (const item of node) {
                const t = findAmazonTag(item, depth + 1);
                if (t) return t;
              }
              return null;
            }
            if (typeof node === 'object') {
              for (const k of Object.keys(node)) {
                const t = findAmazonTag(node[k], depth + 1);
                if (t) return t;
              }
              return null;
            }
            return null;
          }

          // O SiteStripe falha de tres jeitos diferentes, e tratar os tres como
          // "erro generico" foi o que deixou a fila com N itens vermelhos sem
          // motivo na tela (relato de 2026-08: "0/15, 10 erros"):
          //   - 401/403/404          -> sessao do Associados caiu, so relogar resolve;
          //   - 429/503/500          -> throttling; esperar e repetir resolve;
          //   - 200 com HTML de login -> tambem e sessao caida, e o `.json()`
          //     estourava aqui dentro com "Unexpected token '<'".
          const resp = await fetch(
            'https://www.amazon.com.br/associates/sitestripe/getStoreTagMap?marketplaceId=526970',
            {
              headers: { 'accept': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
              credentials: 'include',
            },
          );
          const body = await resp.text();
          let data = null;
          try { data = JSON.parse(body); } catch (e) { data = null; }

          if (!resp.ok || data === null) {
            const pareceLogin = data === null && /<html|ap\/signin|sign-?in/i.test(body.slice(0, 800));
            if (resp.status === 429 || resp.status === 503 || resp.status === 500) {
              return { success: false, reason: 'rate-limit', error: 'a Amazon esta limitando as requisicoes (HTTP ' + resp.status + ')' };
            }
            return {
              success: false,
              reason: 'session',
              error: 'sessao do Associados Amazon expirada (HTTP ' + resp.status + (pareceLogin ? ', tela de login' : '') + ') - abra amazon.com.br/associates, faca login e clique em Atualizar no painel',
            };
          }

          // A resposta do getStoreTagMap vem com envelope (ex.: { status, storeTagMap, ... }).
          // Extraímos APENAS um valor que case com o padrão de tag de afiliado —
          // jamais a primeira chave cega do objeto (era o que vazava "status").
          const tag = findAmazonTag(data, 0);
          if (!tag) {
            return {
              success: false,
              reason: 'session',
              error: 'Tag de afiliado Amazon válida não encontrada (esperado formato "algo-20"). Verifique se você possui uma loja aprovada no Associados Amazon.',
            };
          }
          return { success: true, tag };
        } catch (e) {
          return { success: false, reason: 'other', error: e.message };
        }
      },
      world: 'MAIN',
    });

    const result = results && results[0] && results[0].result;
    if (!result) return { success: false, reason: 'other', error: 'Sem resposta do script injetado na aba Amazon' };

    if (result.success) {
      // Defesa em profundidade: NUNCA prosseguir com tag suspeita/malformada. Cobre
      // cache antigo poluído por versões que cacheavam "status". Melhor não gerar o
      // link do que gerar para a conta errada.
      const tag = String(result.tag).trim();
      if (!AMZ_TAG_RE.test(tag)) {
        return { success: false, reason: 'other', error: `Tag de afiliado Amazon inválida ("${tag}"). Link NÃO gerado para evitar comissão para a conta errada.` };
      }
      return { success: true, tag };
    }

    if (result.reason === 'session') await invalidarTagAmazon('sessão do Associados caiu');
    return result;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.error('[AchadinhoPRO] Erro ao executar script na aba Amazon:', msg);
    await closeAmazonTab();
    return { success: false, reason: abaInutilizavel(msg) ? 'tab' : 'other', error: `Erro: ${msg}` };
  } finally {
    // A aba é um MEIO de ler o cookie, não um estado que valha manter: se ela foi
    // criada por esta chamada, fecha aqui. Antes ela só era fechada em erro ou no
    // update da extensão e ficava aberta na cara do usuário depois do lote.
    if (!abaJaExistia) await closeAmazonTab();
  }
}

/**
 * Tag da loja, do cache ou da Amazon.
 *
 * `forceRefresh` é usado no INÍCIO DE CADA LOTE e no botão "Atualizar" do painel: uma
 * chamada ao `getStoreTagMap` por lote, não por produto. Sem isso, trocar de conta do
 * Associados no meio da sessão faria o lote inteiro sair com a tag antiga — comissão
 * para a conta errada, que é o pior defeito possível deste subsistema.
 *
 * Fail-closed: busca falhou e não há cache válido → NÃO gera link.
 */
async function resolveAmazonTag(opts) {
  const forceRefresh = !!(opts && opts.forceRefresh);

  if (!forceRefresh) {
    const doCache = await lerTagDoCache();
    if (doCache) return { success: true, tag: doCache, deCache: true };
  }

  // Só exibir (barra do painel): NUNCA abre aba. Mostrar um produto na tela não pode
  // custar uma aba da Amazon em segundo plano e até ~17 s de espera — quem pede a
  // leitura de verdade é o botão "Atualizar" ou o início de um lote.
  if (opts && opts.somenteCache) {
    return { success: false, reason: 'sem-cache', error: 'Tag ainda não lida — clique em Atualizar' };
  }

  const buscada = await buscarTagAmazonNaAba();
  if (buscada.success) {
    if (cachedAmazonTag && cachedAmazonTag !== buscada.tag) {
      console.warn(`[AchadinhoPRO] Tag Amazon MUDOU: ${cachedAmazonTag} → ${buscada.tag} (conta do Associados trocada)`);
    }
    await gravarTagNoCache(buscada.tag);
    return { success: true, tag: buscada.tag, deCache: false };
  }

  // Throttling não invalida a tag: o cache ainda válido serve, e o lote não para.
  if (buscada.reason === 'rate-limit') {
    const doCache = await lerTagDoCache();
    if (doCache) return { success: true, tag: doCache, deCache: true };
  }
  return buscada;
}

/**
 * A aba de geração de link morreu ou está numa página de erro?
 *
 * "Frame with ID 0 is showing error page" é o que o Chrome devolve quando a aba
 * existe mas o documento é a tela de erro de rede — e `tab.url` CONTINUA sendo o
 * da Amazon, então `ensureAmazonTab` reaproveitava a aba quebrada indefinidamente
 * e todo produto do lote falhava. Reconhecer a assinatura é o que permite jogar a
 * aba fora e abrir outra.
 */
function abaInutilizavel(msg) {
  return /showing error page|No tab with id|No frame with id|Cannot access|Frame with ID/i.test(String(msg || ''));
}

/**
 * Gera o link de afiliado Amazon do produto.
 *
 * `opts.asin` é o ASIN que o scraper leu do card. Quando ele e o ASIN da URL existem e
 * DIVERGEM, isto é um erro — não se reconstrói `/dp/A` a partir de uma URL `/dp/B`. O
 * scraper de listagem já pegou o link do card vizinho uma vez, e um link com a tag certa
 * apontando para o produto errado é pior do que não salvar.
 *
 * `opts.forceRefresh` revalida a tag antes de gerar (início de lote / botão Atualizar).
 */
async function generateAmazonAffiliateLink(productUrl, opts) {
  const asinExplicito = normalizarAsin(opts && opts.asin);
  const asinDaUrl = extrairAsinDaUrlAmazon(productUrl);

  if (asinExplicito && asinDaUrl && asinExplicito !== asinDaUrl) {
    const erro = `ASIN divergente: payload=${asinExplicito} url=${asinDaUrl}`;
    console.warn('[AchadinhoPRO]', erro);
    return { success: false, reason: 'asin', error: erro };
  }
  const asin = asinExplicito || asinDaUrl;
  if (!asin) {
    return {
      success: false,
      reason: 'asin',
      error: `Não foi possível identificar o ASIN em ${String(productUrl || '').slice(0, 60)}`,
    };
  }

  const tagResult = await resolveAmazonTag({ forceRefresh: !!(opts && opts.forceRefresh) });
  // FALHA na resolução NÃO revalida nada: aba que não abriu (`reason: 'tab'`, o
  // "Frame with ID 0 is showing error page"), sessão caída, tag malformada. O próximo
  // item do lote precisa continuar forçando — senão ele sai com a tag do CACHE, que
  // pode ser da conta do Associados anterior. Por isso a marca fica só nos retornos
  // abaixo, depois do `success`.
  if (!tagResult.success) {
    return {
      success: false,
      reason: tagResult.reason || 'other',
      error: tagResult.error,
      cooldown: tagResult.reason === 'rate-limit',
      cooldownMs: tagResult.reason === 'rate-limit' ? 60000 : undefined,
    };
  }

  // Resolução bem-sucedida: ou a tag foi RELIDA (`deCache: false`), ou a Amazon
  // throttlou a releitura e o `resolveAmazonTag` decidiu seguir com o cache válido
  // (`deCache: true`, só possível com forceRefresh). Os dois contam como revalidação
  // gasta: insistir item a item contra um 503 multiplica o throttling e chega no mesmo
  // lugar — a política de "throttling não para o lote" é do resolveAmazonTag, não daqui.
  const tagRevalidada = true;

  const link = buildAmazonAffiliateLink(asin, tagResult.tag);
  if (!link) {
    return { success: false, reason: 'other', tagRevalidada, error: `Não foi possível montar o link (asin=${asin}, tag=${tagResult.tag})` };
  }

  console.log('[AchadinhoPRO] Link Amazon afiliado:', link, tagResult.deCache ? '(tag do cache)' : '(tag revalidada)');
  // A tag SOBE junto com o link: o servidor confere `asin × link × tag` antes de gravar
  // (ver canonicalizeAmzAffiliateLink). Contrato do campo mantido — `short_link` é nome
  // histórico, hoje carrega o link longo.
  return { success: true, short_link: link, tag: tagResult.tag, asin, tagRevalidada };
}

/**
 * Nome antigo, mantido porque `globalThis._handlers.handleGenerateAmazonShortLink` e o
 * `case 'generateAmazonShortLink'` do onMessage apontam para cá.
 */
async function generateAmazonAffiliateLinkViaCookies(productUrl, opts) {
  return generateAmazonAffiliateLink(productUrl, opts);
}

async function openGhostTab(url) {
  if (currentGhostTabId !== null) {
    await closeGhostTab();
  }
  const tab = await chrome.tabs.create({ url, active: false });
  currentGhostTabId = tab.id;
  try {
    const pathname = new URL(url).pathname.slice(0, 40);
    addLog(`Aba fantasma: ${pathname}...`);
  } catch (e) {
    addLog(`Aba fantasma aberta`);
  }
  return tab;
}

async function getTabFinalUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url || null;
  } catch (e) {
    return null;
  }
}

// ===== Portão de URL de produto do Mercado Livre =====
//
// Uma URL só vira link de afiliado se for, comprovadamente, a página de UM item.
// O padrão antigo (/MLB-?(\d+)/i em qualquer posição da string) errava dos dois lados:
//
//  - FALSO NEGATIVO: recusava a PDP de produto de vendedor (/up/MLBU<id>), porque
//    depois de "MLB" vem "U" e não dígito. É o bug relatado — a listagem funcionava
//    só porque o ml-scraper reescreve /up/ para a forma compacta antes de enviar.
//  - FALSO POSITIVO: aceitava busca, /ofertas?container_id=, /mais-vendidos/,
//    /noindex/, /c/ (categoria) e URLs de tracking click1 com item_id na query —
//    todas geram um meli.la VÁLIDO apontando para a página errada, que é pior que
//    falhar porque ninguém percebe até a comissão não aparecer. Pior ainda: slug com
//    a marca MLB (ex.: "bone-mlb-9forty") casava "mlb-9" e extraía o id lixo "9",
//    o que fazia o defeito parecer intermitente.
//
// Regras: host do ML Brasil, id ANCORADO NO PATH e com 6+ dígitos (mesmo guard do
// extractIdsFromHref em ml-price-utils.js). Query/fragmento só valem pelos campos
// que comprovadamente carregam item id (wid= e item_id=) — nunca deal= (id de
// promoção), container_id= ou category=.
//
/**
 * @param {string} rawUrl URL do produto (absoluta ou relativa)
 * @returns {{itemId: string, url: string}|null} id do item + URL a enviar à API de
 *   afiliados, ou null quando a URL não identifica um item. NUNCA deriva MLB a
 *   partir de MLBU removendo o "U": são namespaces diferentes (o mesmo card traz
 *   /up/MLBU777596893 e wid=MLB4628788660 — ids distintos do mesmo produto).
 */
function parseMlProductUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  let u;
  try {
    // Base explícita: o <link rel="canonical"> da PDP pode vir com href relativo.
    u = new URL(rawUrl, ML_BASE_URL);
  } catch (e) {
    return null;
  }

  // Host do Mercado Livre. A grafia "mercadoliBre" é a mesma coisa e o resto do
  // projeto já a trata como host de trabalho (manifest host_permissions,
  // SUPPORTED_HOSTS, normalizeUrl do ml-scraper, isPdpUrl do ml-pdp-scraper) —
  // recusá-la aqui derrubaria produto que todas as outras camadas aceitam.
  // A restrição ao Brasil vem do id: só MLB casa as regras abaixo (MLA/MLM não).
  if (!/(^|\.)mercadoli(vre|bre)\.com(\.br)?$/i.test(u.hostname)) return null;

  const absUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : u.href;
  const path = u.pathname;
  const jm = (digitos) => `https://produto.mercadolivre.com.br/MLB-${digitos}-_JM`;

  // Item id que a URL carrega em wid= / item_id= (query ou fragmento). Numa PDP
  // alcançada por clique no card é onde vive o MLB real de um produto /up/.
  let extras = '';
  try {
    extras = decodeURIComponent(u.search + u.hash);
  } catch (e) {
    extras = u.search + u.hash;
  }
  const widMatch = extras.match(/[?#&](?:wid|item_id)=(MLB\d{6,})/i)
    || extras.match(/item_id[:=](MLB\d{6,})/i);
  const doWid = () => ({ itemId: widMatch[1].toUpperCase(), url: jm(widMatch[1].replace(/^MLB/i, '')) });

  // click1/mclics é URL de TRACKING: o path não descreve produto nenhum. Ela só vale
  // se carregar o item id nos parâmetros — e aí seguimos com a PDP canônica do item,
  // NUNCA com a URL de tracking (que não atribui comissão).
  if (/^click/i.test(u.hostname) || path.indexOf('/mclics/') !== -1) {
    return widMatch ? doWid() : null;
  }

  // 1) Catálogo: /p/MLB<id>
  let m = path.match(/\/p\/MLB-?(\d{6,})/i);
  if (m) return { itemId: `MLB${m[1]}`, url: absUrl };

  // 2) Produto de vendedor: /up/MLBU<id>. O id do path é do namespace MLBU e NÃO
  //    serve para a API — por isso preferimos o MLB real do wid quando existe.
  m = path.match(/\/up\/(MLBU?)-?(\d{6,})/i);
  if (m) {
    if (widMatch) return doWid();
    return { itemId: `${m[1].toUpperCase()}${m[2]}`, url: absUrl };
  }

  // 3) produto.mercadolivre.com.br/MLB-<id>-slug-_JM
  m = path.match(/\/MLB-(\d{6,})/i);
  if (m) return { itemId: `MLB${m[1]}`, url: absUrl };

  // 4) Compacta www.mercadolivre.com.br/MLB<id> — a API não aceita essa forma; tem
  //    de virar produto.mercadolivre.com.br/MLB-<id>-_JM (b5516d83 + c9fd262d).
  //    É por aqui que passa 100% do fluxo de listagem/grid.
  m = path.match(/^\/(MLB)(\d{6,})\/?$/i);
  if (m) return { itemId: `MLB${m[2]}`, url: jm(m[2]) };

  // 5) Sem id no path, mas a URL identifica o item por wid=/item_id= (ex.: link de
  //    resultado de busca). Normaliza para a PDP do item — nunca envia a URL crua.
  if (widMatch) return doWid();

  return null;
}

function extractMlItemIdFromUrl(url) {
  const ref = parseMlProductUrl(url);
  // SÓ id de ITEM (MLB<dígitos>). O namespace MLBU (produto de vendedor) não
  // identifica um anúncio e não pode virar chave de conflito (userId, mlItemId).
  // Devolver null aqui é o que preserva o fallback `|| product.mlItemId` de quem
  // chama — que é justamente o MLB correto vindo da listagem.
  return ref && /^MLB\d+$/.test(ref.itemId) ? ref.itemId : null;
}

function isValidProductUrl(url) {
  if (!url) return false;
  return url.indexOf('mercadolivre.com.br') !== -1 &&
    (url.indexOf('/p/') !== -1 || url.match(/MLB-?\d+/) !== null || url.indexOf('/up/') !== -1);
}

function cleanProductUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.indexOf('click') !== -1 || u.pathname.indexOf('/mclics/') !== -1) {
      // Try to extract destination URL from redirect query params
      const dest = u.searchParams.get('url') || u.searchParams.get('dest') || u.searchParams.get('redirect');
      if (dest && dest.indexOf('mercadolivre') !== -1) return dest;
      return null;
    }
    return url;
  } catch (e) {
    return url;
  }
}

async function closeGhostTab() {
  if (currentGhostTabId !== null) {
    try {
      await chrome.tabs.remove(currentGhostTabId);
    } catch (e) {
      console.warn('[AchadinhoPRO] Aba já fechada:', e.message);
    }
    currentGhostTabId = null;
  }
}

function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timeout ao carregar aba'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Injeção programática = espelho EXATO da lista do manifest, na mesma ordem.
// Injetar só o *-scraper.js deixava os utilitários UMD (MlPriceUtils, MlPdpScraper,
// AmazonPriceUtils, AmazonImageUtils) indefinidos: o scraper cai nos fallbacks
// legados e a página de produto individual volta a salvar o preço cheio como
// preço atual, sem desconto, vendas nem frete — o bug que o ml-pdp-scraper corrige.
const SCRAPER_FILES = {
  ml: [
    'content/scrapers/ml-price-utils.js',
    // Sem ml-hub-scraper aqui, MlHubScraper fica indefinido na aba que já estava
    // aberta quando a extensão atualizou: o hub de afiliados deixa de ser
    // reconhecido, o acumulador e os gatilhos de scroll não ligam, e a coleta volta
    // a parar no primeiro lote — o bug original, de volta, até o usuário recarregar
    // a página. É a armadilha que o comentário acima descreve.
    'content/scrapers/ml-hub-scraper.js',
    'content/scrapers/ml-pdp-scraper.js',
    'content/scrapers/ml-scraper.js',
  ],
  shopee: ['content/scrapers/shopee-scraper.js'],
  amazon: [
    'content/scrapers/amazon-price-utils.js',
    'content/scrapers/amazon-image-utils.js',
    'content/scrapers/amazon-reviews-utils.js',
    'content/scrapers/amazon-scraper.js',
  ],
};

function getScriptsForUrl(url) {
  if (!url) return SCRAPER_FILES.ml;
  try {
    const hostname = new URL(url).hostname;
    if (hostname.includes('shopee.com.br')) return SCRAPER_FILES.shopee;
    if (hostname.includes('amazon.com.br')) return SCRAPER_FILES.amazon;
  } catch {}
  return SCRAPER_FILES.ml;
}

async function ensureContentScriptInjected(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return response?.status === 'ok';
  } catch {
    console.log('[AchadinhoPRO] Injetando content script...');
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.scripting.executeScript({
        target: { tabId },
        files: getScriptsForUrl(tab.url),
      });
      await new Promise((r) => setTimeout(r, 500));
      return true;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      // "Frame with ID 0 is showing error page" NÃO é bug da extensão: a aba
      // carregou a tela de erro do Chrome (rede caiu, a Amazon recusou a
      // requisição, a aba foi descartada). Não há script a injetar num documento
      // que não existe, e registrar isso como `console.error` enchia a aba de
      // Erros do chrome://extensions com um sintoma de ambiente — foi o que o
      // usuário viu junto do lote que falhou. Vira aviso, com o alvo no texto.
      if (abaInutilizavel(msg)) {
        console.warn(`[AchadinhoPRO] Aba ${tabId} está em página de erro — nada a injetar (${msg})`);
      } else {
        console.error('[AchadinhoPRO] Erro ao injetar script:', e);
      }
      return false;
    }
  }
}

async function injectAndExtract(tabId) {
  const injected = await ensureContentScriptInjected(tabId);
  if (!injected) {
    throw new Error('Não foi possível injetar content script');
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout na extração de dados'));
    }, 15000);

    chrome.tabs.sendMessage(tabId, { action: 'extractOffer' }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function extractAllFromTab(tabId) {
  const injected = await ensureContentScriptInjected(tabId);
  if (!injected) {
    throw new Error('Não foi possível injetar content script');
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout na extração da listagem'));
    }, 15000);

    chrome.tabs.sendMessage(tabId, { action: 'extractAllOffers' }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function handleCaptchaDetected() {
  await setState(STATE.PAUSED_FOR_CAPTCHA);
  addLog('CAPTCHA detectado! Automação pausada.', 'warning');

  chrome.notifications.create('captcha-alert', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Achadinho PRO - CAPTCHA Detectado',
    message: 'Resolva o CAPTCHA na aba aberta e clique em "Retomar" no painel.',
    requireInteraction: true,
  });

  if (currentGhostTabId !== null) {
    try {
      await chrome.tabs.update(currentGhostTabId, { active: true });
    } catch (e) {
      console.warn('[AchadinhoPRO] Erro ao ativar aba:', e.message);
    }
  }
}

function applyFilters(product, config) {
  if (config.freeShippingOnly && !product.freeShipping) return false;
  if (config.minRating && product.ratingStar && product.ratingStar < config.minRating) return false;
  if (config.minDiscount && product.discountPercent && product.discountPercent < config.minDiscount) return false;
  if (config.maxPrice && product.price && product.price > config.maxPrice) return false;
  return true;
}

async function processTask(task) {
  const { id, taskType, payload } = task;

  addLog(`Processando: ${taskType} - ${payload.keyword || payload.url || ''}`, 'info');
  await api.updateTaskStatus(id, 'processing');

  if (taskType === 'search_keyword') {
    const searchUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(payload.keyword)}`;
    const tab = await openGhostTab(searchUrl);
    await waitForTabLoad(tab.id);
    await humanDelay(2, 4);

    const extractResult = await injectAndExtract(tab.id);

    if (extractResult?.captcha) {
      await handleCaptchaDetected();
      throw new Error('CAPTCHA_DETECTED');
    }

    await closeGhostTab();

    if (extractResult?.success && extractResult.data) {
      await api.updateTaskStatus(id, 'completed', extractResult.data);
      addLog(`Busca concluída: ${payload.keyword}`, 'success');
    } else {
      throw new Error(extractResult?.error || 'Falha na extração');
    }
  } else if (taskType === 'scrape_product') {
    const tab = await openGhostTab(payload.url);
    await waitForTabLoad(tab.id);
    await humanDelay(1, 3);

    const extractResult = await injectAndExtract(tab.id);

    if (extractResult?.captcha) {
      await handleCaptchaDetected();
      throw new Error('CAPTCHA_DETECTED');
    }

    if (!extractResult?.success || !extractResult.data) {
      await closeGhostTab();
      throw new Error(extractResult?.error || 'Falha na extração do produto');
    }

    const productData = extractResult.data;
    await closeGhostTab();

    await humanDelay(1, 2);

    let affiliateLink = null;
    try {
      const linkResult = await generateAffiliateLinkViaCookies(productData.productLink || payload.url);
      if (linkResult?.success) {
        affiliateLink = linkResult.short_link;
      }
    } catch (e) {
      addLog(`Aviso: link de afiliado não gerado - ${e.message}`, 'warning');
    }

    if (!affiliateLink) {
      addLog(`Sem link de afiliado: ${productData.productName?.slice(0, 40)} — pulando`, 'warning');
      await api.updateTaskStatus(id, 'completed', { skipped: true, reason: 'Link de afiliado não gerado' });
      taskStats.totalSkippedNoLink = (taskStats.totalSkippedNoLink || 0) + 1;
      return;
    }

    const finalPayload = {
      ...productData,
      affiliateShortLink: affiliateLink,
      sourceKeyword: payload.keyword || null,
    };

    const config = await api.getConfig().catch(() => null);
    if (config) {
      const shouldFilter = applyFilters(finalPayload, config);
      if (!shouldFilter) {
        await api.updateTaskStatus(id, 'completed', { filtered: true, reason: 'Não passou nos filtros' });
        addLog(`Filtrado: ${productData.productName?.slice(0, 40)}`, 'info');
        return;
      }
    }

    await api.saveProduct(finalPayload);
    await api.updateTaskStatus(id, 'completed', finalPayload);
    addLog(`Salvo: ${productData.productName?.slice(0, 40)}`, 'success');
  } else if (taskType === 'generate_link') {
    const linkResult = await generateAffiliateLinkViaCookies(payload.url);
    if (linkResult?.success) {
      await api.updateTaskStatus(id, 'completed', { short_link: linkResult.short_link });
      addLog(`Link gerado: ${linkResult.short_link}`, 'success');
    } else {
      throw new Error(linkResult?.error || 'Falha ao gerar link');
    }
  }
}

async function processTaskQueue() {
  if (automationState !== STATE.RUNNING) return;
  if (isProcessing) return;

  isProcessing = true;

  try {
    const authenticated = await api.isAuthenticated();
    if (!authenticated) {
      addLog('Não autenticado. Faça login no Achadinho PRO.', 'error');
      await setState(STATE.ERROR);
      isProcessing = false;
      return;
    }

    const response = await api.fetchTasks();
    const tasks = response.tasks || [];

    if (tasks.length === 0) {
      addLog('Nenhuma tarefa pendente. Aguardando...', 'info');
      isProcessing = false;
      await humanDelay(15, 30);
      if (automationState === STATE.RUNNING && !shouldStop) {
        processTaskQueue();
      }
      return;
    }

    taskStats.total = tasks.length;
    taskStats.completed = 0;
    taskStats.failed = 0;
    broadcastStateUpdate();

    for (const task of tasks) {
      if (shouldStop || automationState !== STATE.RUNNING) {
        addLog('Automação interrompida pelo usuário.', 'warning');
        break;
      }

      if (automationState === STATE.PAUSED_FOR_CAPTCHA) {
        addLog('Aguardando resolução do CAPTCHA...', 'warning');
        break;
      }

      try {
        await processTask(task);
        taskStats.completed++;
      } catch (error) {
        if (error.message === 'CAPTCHA_DETECTED') break;
        taskStats.failed++;
        addLog(`Erro: ${error.message}`, 'error');
        try {
          await api.updateTaskStatus(task.id, 'failed', null);
        } catch (e) {
          console.error('[AchadinhoPRO] Erro ao atualizar status:', e);
        }
      }

      broadcastStateUpdate();

      if (automationState === STATE.RUNNING && !shouldStop) {
        const config = await api.getConfig().catch(() => null);
        const minJitter = config?.jitterMinSeconds || 4;
        const maxJitter = config?.jitterMaxSeconds || 8;
        await humanDelay(minJitter, maxJitter);
      }
    }

    await closeGhostTab();

    if (automationState === STATE.RUNNING && !shouldStop) {
      addLog('Ciclo concluído. Buscando novas tarefas...', 'info');
      await humanDelay(10, 20);
      isProcessing = false;
      processTaskQueue();
      return;
    }
  } catch (error) {
    console.error('[AchadinhoPRO] Erro no loop:', error);
    addLog(`Erro no loop: ${error.message}`, 'error');

    if (error.message.includes('Não autenticado') || error.message.includes('Sessão expirada')) {
      await setState(STATE.ERROR);
    }
  }

  isProcessing = false;
}

async function startAutomation() {
  if (automationState === STATE.RUNNING) {
    return { success: false, error: 'Automação já está rodando' };
  }

  const authenticated = await api.isAuthenticated();
  if (!authenticated) {
    return { success: false, error: 'Faça login no Achadinho PRO primeiro' };
  }

  shouldStop = false;
  taskStats = { total: 0, completed: 0, failed: 0, totalSaved: 0, totalSkippedNoLink: 0 };
  await setState(STATE.RUNNING);
  addLog('Automação iniciada', 'success');
  processTaskQueue();
  return { success: true };
}

async function stopAutomation() {
  shouldStop = true;
  await closeGhostTab();
  await closeLinkBuilderTab();
  await setState(STATE.IDLE);
  addLog('Automação parada', 'warning');
  return { success: true };
}

async function resumeAutomation() {
  if (automationState !== STATE.PAUSED_FOR_CAPTCHA) {
    return { success: false, error: 'Automação não está pausada por CAPTCHA' };
  }

  await closeGhostTab();
  shouldStop = false;
  await setState(STATE.RUNNING);
  addLog('Automação retomada após CAPTCHA', 'success');

  chrome.notifications.clear('captcha-alert');
  isProcessing = false;
  processTaskQueue();
  return { success: true };
}

async function startKeywordSearch(keywordIds, platforms = ['ml']) {
  if (!keywordIds || keywordIds.length === 0) {
    return { success: false, error: 'Nenhuma palavra-chave selecionada' };
  }

  const authenticated = await api.isAuthenticated();
  if (!authenticated) {
    return { success: false, error: 'Faça login no Achadinho PRO primeiro' };
  }

  if (automationState === STATE.RUNNING) {
    return { success: false, error: 'Automação já está rodando' };
  }

  // Check login for platforms that need it
  if (platforms.includes('ml')) {
    const mlCheck = await checkMlLogin();
    if (!mlCheck.loggedIn) {
      // If ML is the only platform and login fails, abort
      if (platforms.length === 1) {
        return { success: false, error: mlCheck.error };
      }
      // Otherwise just warn and remove ML from the list
      addLog(`ML login falhou: ${mlCheck.error}. Continuando com outras fontes.`, 'warning');
      platforms = platforms.filter(p => p !== 'ml');
    } else {
      addLog(`Login ML verificado. Tag: ${mlCheck.tag}`, 'success');
    }
  }

  if (platforms.length === 0) {
    return { success: false, error: 'Nenhuma plataforma disponível para busca' };
  }

  try {
    addLog(`Carregando ${keywordIds.length} grupo(s) de palavras-chave...`, 'info');

    const response = await api.getKeywordSearches();
    const allKeywords = response.keywords || [];
    const selected = allKeywords.filter(kw => keywordIds.includes(String(kw.id)));

    if (selected.length === 0) {
      return { success: false, error: 'Nenhuma palavra-chave encontrada' };
    }

    let totalKeywords = 0;
    const allSearchKeywords = [];

    for (const group of selected) {
      const keywords = group.keywords || [];
      for (const keyword of keywords) {
        if (keyword && keyword.trim()) {
          allSearchKeywords.push({
            keyword: keyword.trim(),
            groupName: group.name,
            groupId: group.id,
          });
          totalKeywords++;
        }
      }
    }

    if (totalKeywords === 0) {
      return { success: false, error: 'Nenhuma palavra-chave nas listas selecionadas' };
    }

    // Calculate max products per keyword based on total keyword count
    let maxProductsPerKeyword;
    if (totalKeywords <= 5) {
      maxProductsPerKeyword = 30;
    } else if (totalKeywords <= 10) {
      maxProductsPerKeyword = 15;
    } else if (totalKeywords <= 25) {
      maxProductsPerKeyword = 10;
    } else {
      maxProductsPerKeyword = 6;
    }

    addLog(`${totalKeywords} palavras-chave × ${platforms.length} fonte(s) [${platforms.join(', ')}] (máx ${maxProductsPerKeyword} produtos/palavra). Iniciando...`, 'info');

    shouldStop = false;
    taskStats = { total: totalKeywords, completed: 0, failed: 0, totalSaved: 0, totalSkippedNoLink: 0 };
    await setState(STATE.RUNNING);
    broadcastStateUpdate();

    // Run keyword search sequentially for each platform
    (async () => {
      try {
        for (const platform of platforms) {
          if (shouldStop || automationState !== STATE.RUNNING) break;

          const cfg = PLATFORM_CONFIG[platform];
          if (!cfg) {
            addLog(`Plataforma desconhecida: ${platform}, pulando`, 'warning');
            continue;
          }

          const loginResult = await cfg.loginCheck();
          if (!loginResult.loggedIn) {
            addLog(`${cfg.name}: ${loginResult.error || 'não logado'}, pulando`, 'warning');
            continue;
          }

          addLog(`Iniciando busca em ${cfg.name}...`, 'info');
          taskStats.completed = 0;
          taskStats.failed = 0;

          await runKeywordSearchLoop(allSearchKeywords, maxProductsPerKeyword, platform, platforms.length > 1);

          // Delay between platforms
          if (platforms.indexOf(platform) < platforms.length - 1) {
            addLog(`Aguardando antes da próxima fonte...`, 'info');
            await humanDelay(5, 10);
          }
        }

        // Ensure final state is IDLE
        if (automationState === STATE.RUNNING) {
          const summaryParts = [`${taskStats.totalSaved} produtos salvos no total`];
          if (taskStats.totalSkippedNoLink > 0) summaryParts.push(`${taskStats.totalSkippedNoLink} sem link`);
          addLog(`Busca multi-fonte concluída! ${summaryParts.join(', ')}.`, 'success');
          await setState(STATE.IDLE);
        }
      } catch (error) {
        console.error('[AchadinhoPRO] Erro no loop multi-plataforma:', error);
        addLog(`Erro: ${error.message}`, 'error');
        await setState(STATE.ERROR);
      }
    })();

    return { success: true, totalKeywords, platforms };
  } catch (error) {
    console.error('[AchadinhoPRO] Erro em startKeywordSearch:', error);
    return { success: false, error: error.message };
  }
}

async function runKeywordSearchLoop(searchKeywords, maxProductsPerKeyword = 15, platform = 'ml', skipIdleOnComplete = false) {
  isProcessing = true;
  const platformCfg = PLATFORM_CONFIG[platform] || PLATFORM_CONFIG.ml;

  // Uma revalidação por LOTE (não por produto): o cache da tag é zerado aqui, então a
  // primeira geração busca a tag atual no Associados e as demais reaproveitam. Sem isto,
  // quem trocou de conta do Associados geraria o lote inteiro com a tag anterior —
  // comissão para a conta errada.
  if (platform === 'amazon') await invalidarTagAmazon('início do lote de automação');

  try {
    const config = await api.getConfig().catch(() => ({}));
    const minJitter = config?.jitterMinSeconds || 4;
    const maxJitter = config?.jitterMaxSeconds || 8;

    for (const item of searchKeywords) {
      if (shouldStop || automationState !== STATE.RUNNING) {
        addLog('Busca interrompida pelo usuário.', 'warning');
        break;
      }

      if (automationState === STATE.PAUSED_FOR_CAPTCHA) {
        addLog('Aguardando resolução do CAPTCHA...', 'warning');
        break;
      }

      try {
        // Show 1-based index: "Buscando 1/3: keyword"
        const keywordIndex = taskStats.completed + taskStats.failed + 1;
        addLog(`[${platformCfg.name}] Buscando ${keywordIndex}/${taskStats.total}: "${item.keyword}" (${item.groupName})`, 'info');
        broadcastStateUpdate();

        const searchUrl = platformCfg.searchUrl(item.keyword);
        const tab = await openGhostTab(searchUrl);
        await waitForTabLoad(tab.id);
        await humanDelay(2 + (platformCfg.extraWait || 0), 4 + (platformCfg.extraWait || 0));

        // Shopee needs scroll to load lazy content
        if (platformCfg.needsScroll) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => { window.scrollBy(0, 1500); },
            });
            await humanDelay(2, 3);
          } catch (scrollErr) {
            console.warn('[AchadinhoPRO] Scroll failed:', scrollErr.message);
          }
        }

        let listResult = await extractAllFromTab(tab.id);

        if (listResult?.captcha) {
          await handleCaptchaDetected();
          break;
        }

        if (!listResult?.success || !listResult.data || listResult.data.length === 0) {
          // Retry once for Shopee (dynamic loading may need more time)
          if (platformCfg.needsScroll) {
            addLog(`[${platformCfg.name}] Nenhum produto, tentando scroll adicional...`, 'info');
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => { window.scrollBy(0, 3000); },
              });
              await humanDelay(3, 5);
              const retryResult = await extractAllFromTab(tab.id);
              if (retryResult?.success && retryResult.data?.length > 0) {
                listResult = retryResult;
              }
            } catch {}
          }

          if (!listResult?.success || !listResult.data || listResult.data.length === 0) {
            addLog(`[${platformCfg.name}] Nenhum produto encontrado para "${item.keyword}"`, 'warning');
            await closeGhostTab();
            taskStats.completed++;
            broadcastStateUpdate();
            await humanDelay(minJitter, maxJitter);
            continue;
          }
        }

        const products = listResult.data;
        addLog(`[${platformCfg.name}] ${products.length} produtos encontrados para "${item.keyword}" (máx ${maxProductsPerKeyword})`, 'success');

        await closeGhostTab();

        let savedCount = 0;
        let filteredCount = 0;
        let skippedCount = 0;
        let noLinkCount = 0;
        const batchProducts = []; // For batch-save platforms (Amazon, Shopee)

        for (let i = 0; i < products.length; i++) {
          if (shouldStop || automationState !== STATE.RUNNING) break;

          // Stop processing more products for this keyword if we reached the limit
          if (savedCount >= maxProductsPerKeyword) {
            addLog(`[${platformCfg.name}] Limite de ${maxProductsPerKeyword} produtos atingido para "${item.keyword}"`, 'info');
            break;
          }

          const product = products[i];

          if (config) {
            if (!applyFilters(product, config)) {
              filteredCount++;
              continue;
            }
          }

          // FAST PATH: If listing already has enough data, save directly
          if (platformCfg.validateProduct(product)) {
            const directProduct = { ...product };
            directProduct.sourceKeyword = item.keyword;
            directProduct.keywordGroupId = item.groupId;

            // Generate affiliate link (platform-specific)
            if (platform === 'ml') {
              const linkUrl = cleanProductUrl(product.productLink) || product.productLink;
              if (linkUrl) {
                try {
                  const linkResult = await generateAffiliateLinkViaCookies(linkUrl);
                  if (linkResult?.success) {
                    directProduct.affiliateShortLink = linkResult.short_link;
                  }
                } catch (e) {
                  console.warn(`[AchadinhoPRO] [${platform}] Link não gerado:`, e.message);
                }
                await humanDelay(0.5, 1.5);
              }
            } else if (platform === 'amazon') {
              const linkUrl = product.productLink || product.productUrl;
              if (linkUrl) {
                try {
                  // O ASIN do payload viaja junto: se ele divergir do ASIN da URL, a
                  // geração RECUSA em vez de montar link para o produto errado (o
                  // scraper de listagem já pegou o link do card vizinho uma vez).
                  const linkResult = await generateAmazonAffiliateLink(linkUrl, {
                    asin: product.asin || product.platformItemId,
                  });
                  if (linkResult?.success) {
                    directProduct.affiliateShortLink = linkResult.short_link;
                    directProduct.affiliateLink = linkResult.short_link;
                    directProduct.affiliateTag = linkResult.tag;
                  }
                } catch (e) {
                  console.warn(`[AchadinhoPRO] [${platform}] Link não gerado:`, e.message);
                }
                await humanDelay(0.5, 1.5);
              }
            }
            // Shopee: no affiliate link needed from extension (generated server-side)

            // Skip products without affiliate link (only if platform requires it)
            if (platformCfg.requiresAffiliateLink && !directProduct.affiliateShortLink) {
              noLinkCount++;
              taskStats.totalSkippedNoLink++;
              continue;
            }

            if (platformCfg.saveBatch) {
              batchProducts.push(directProduct);
              savedCount++;
              taskStats.totalSaved++;
              addLog(`[${platformCfg.name}] Coletado (${savedCount}): ${directProduct.productName?.slice(0, 35)}...`, 'success');
            } else {
              try {
                directProduct.keywordGroupId = item.groupId;
                await api.saveProduct(directProduct);
                savedCount++;
                taskStats.totalSaved++;
                addLog(`[${platformCfg.name}] Salvo (${savedCount}): ${directProduct.productName?.slice(0, 35)}...`, 'success');
              } catch (e) {
                addLog(`[${platformCfg.name}] Erro ao salvar: ${e.message}`, 'error');
              }
            }

            await humanDelay(minJitter / 2, maxJitter / 2);
            continue;
          }

          // SLOW PATH: Need to open ghost tab to get full product data
          const rawUrl = product.productLink || product.productUrl;
          const cleanUrl = platformCfg.cleanUrl(rawUrl);
          const targetUrl = cleanUrl || rawUrl;

          if (!targetUrl) {
            skippedCount++;
            continue;
          }

          await humanDelay(2, 5);

          const productTab = await openGhostTab(targetUrl);
          try {
            await waitForTabLoad(productTab.id);
          } catch (e) {
            addLog(`[${platformCfg.name}] Timeout ao abrir produto, pulando...`, 'warning');
            await closeGhostTab();
            skippedCount++;
            continue;
          }
          await humanDelay(1, 3);

          const finalUrl = await getTabFinalUrl(productTab.id);

          if (platform === 'ml' && !cleanUrl && !isValidProductUrl(finalUrl)) {
            addLog(`[${platformCfg.name}] URL inválida após redirect: ${finalUrl?.slice(0, 40)}`, 'warning');
            await closeGhostTab();
            skippedCount++;
            continue;
          }

          const detailedExtract = await injectAndExtract(productTab.id).catch(() => null);
          await closeGhostTab();

          if (detailedExtract?.captcha) {
            await handleCaptchaDetected();
            break;
          }

          const finalProduct = detailedExtract?.success && detailedExtract.data && !Array.isArray(detailedExtract.data)
            ? { ...detailedExtract.data }
            : { ...product };

          // Platform-specific ID extraction
          if (platform === 'ml') {
            if (!finalProduct.mlItemId) {
              finalProduct.mlItemId = extractMlItemIdFromUrl(finalUrl) || extractMlItemIdFromUrl(targetUrl) || product.mlItemId;
            }
            if (!finalProduct.productLink || finalProduct.productLink.indexOf('/mclics/') !== -1) {
              finalProduct.productLink = finalUrl || targetUrl;
            }
          }

          if (!platformCfg.validateProduct(finalProduct)) {
            addLog(`[${platformCfg.name}] Dados incompletos, pulando: ${finalProduct.productName?.slice(0, 30) || 'sem nome'}`, 'warning');
            skippedCount++;
            await humanDelay(1, 2);
            continue;
          }

          await humanDelay(1, 2);

          // Generate affiliate link (platform-specific, SLOW PATH)
          let affiliateLink = null;
          let affiliateTag = null;
          if (platform === 'ml') {
            const linkUrl2 = finalProduct.productLink || finalUrl || targetUrl;
            try {
              const linkResult = await generateAffiliateLinkViaCookies(linkUrl2);
              if (linkResult?.success) affiliateLink = linkResult.short_link;
            } catch (e) {
              console.warn(`[AchadinhoPRO] [${platform}] Link não gerado:`, e.message);
            }
          } else if (platform === 'amazon') {
            const linkUrl2 = finalProduct.productLink || finalUrl || targetUrl;
            try {
              const linkResult = await generateAmazonAffiliateLink(linkUrl2, {
                asin: finalProduct.asin || finalProduct.platformItemId,
              });
              if (linkResult?.success) {
                affiliateLink = linkResult.short_link;
                affiliateTag = linkResult.tag;
              }
            } catch (e) {
              console.warn(`[AchadinhoPRO] [${platform}] Link não gerado:`, e.message);
            }
          }
          // Shopee: no affiliate link needed

          // Skip products without affiliate link (only if platform requires it)
          if (platformCfg.requiresAffiliateLink && !affiliateLink) {
            noLinkCount++;
            taskStats.totalSkippedNoLink++;
            continue;
          }

          if (affiliateLink) {
            finalProduct.affiliateShortLink = affiliateLink;
            finalProduct.affiliateLink = affiliateLink;
            if (affiliateTag) finalProduct.affiliateTag = affiliateTag;
          }
          finalProduct.sourceKeyword = item.keyword;
          finalProduct.keywordGroupId = item.groupId;

          if (platformCfg.saveBatch) {
            batchProducts.push(finalProduct);
            savedCount++;
            taskStats.totalSaved++;
            addLog(`[${platformCfg.name}] Coletado (${savedCount}): ${finalProduct.productName?.slice(0, 35)}...`, 'success');
          } else {
            try {
              await api.saveProduct(finalProduct);
              savedCount++;
              taskStats.totalSaved++;
              addLog(`[${platformCfg.name}] Salvo (${savedCount}): ${finalProduct.productName?.slice(0, 35)}...`, 'success');
            } catch (e) {
              addLog(`[${platformCfg.name}] Erro ao salvar: ${e.message}`, 'error');
            }
          }

          await humanDelay(minJitter, maxJitter);
        }

        // Save batch products (Amazon, Shopee)
        if (platformCfg.saveBatch && batchProducts.length > 0) {
          try {
            if (platform === 'amazon') {
              await api.saveAmazonProducts(batchProducts, null, item.groupId);
            } else if (platform === 'shopee') {
              await api.saveShopeeProducts(batchProducts, null, item.groupId);
            }
            addLog(`[${platformCfg.name}] Batch salvo: ${batchProducts.length} produtos`, 'success');
          } catch (e) {
            addLog(`[${platformCfg.name}] Erro ao salvar batch: ${e.message}`, 'error');
          }
          batchProducts.length = 0; // Clear for next keyword
        }

        const parts = [];
        parts.push(`${savedCount} salvos`);
        if (noLinkCount > 0) parts.push(`${noLinkCount} sem link`);
        if (filteredCount > 0) parts.push(`${filteredCount} filtrados`);
        if (skippedCount > 0) parts.push(`${skippedCount} pulados`);
        addLog(`"${item.keyword}": ${parts.join(', ')}`, 'success');
        taskStats.completed++;
        broadcastStateUpdate();

        await humanDelay(minJitter, maxJitter);

      } catch (error) {
        if (error.message === 'CAPTCHA_DETECTED') break;

        taskStats.failed++;
        addLog(`Erro "${item.keyword}": ${error.message}`, 'error');
        broadcastStateUpdate();

        await closeGhostTab();
        await humanDelay(minJitter, maxJitter);
      }
    }

    await closeGhostTab();

    if (automationState === STATE.RUNNING) {
      const summaryParts = [`${taskStats.completed} grupos processados`];
      summaryParts.push(`${taskStats.totalSaved} produtos salvos`);
      if (taskStats.totalSkippedNoLink > 0) summaryParts.push(`${taskStats.totalSkippedNoLink} sem link descartados`);
      addLog(`[${platformCfg.name}] Busca concluída! ${summaryParts.join(', ')}.`, 'success');
      if (!skipIdleOnComplete) {
        await setState(STATE.IDLE);
      }
    }
  } catch (error) {
    console.error('[AchadinhoPRO] Erro no loop de keywords:', error);
    addLog(`Erro fatal: ${error.message}`, 'error');
    if (!skipIdleOnComplete) {
      await setState(STATE.ERROR);
    }
  }

  isProcessing = false;
}

async function handleManualExtract(sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !isSupportedSite(tab.url)) {
      sendResponse({ success: false, error: 'Navegue até uma página do Mercado Livre, Shopee ou Amazon' });
      return;
    }

    const injected = await ensureContentScriptInjected(tab.id);
    if (!injected) {
      sendResponse({ success: false, error: 'Não foi possível carregar o extrator. Recarregue a página.' });
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'extractOffer' }, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: 'Erro ao extrair dados. Recarregue a página.' });
        return;
      }
      sendResponse(response);
    });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleManualGenerateLink(url, sendResponse) {
  try {
    const result = await generateAffiliateLinkViaCookies(url);
    sendResponse(result);
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleManualSave(productData, sendResponse) {
  try {
    console.log('[AchadinhoPRO] Salvando produto manualmente:', productData.productName?.slice(0, 50));

    let finalProduct = { ...productData };

    // Só gera link se o produto ainda não tem um (evita chamada duplicada quando vindo da fila)
    if (!finalProduct.affiliateShortLink && productData.productLink) {
      console.log('[AchadinhoPRO] Gerando link de afiliado antes de salvar...');
      const linkResult = await generateAffiliateLinkViaCookies(productData.productLink);

      if (linkResult?.success && linkResult.short_link) {
        finalProduct.affiliateShortLink = linkResult.short_link;
        console.log('[AchadinhoPRO] ✅ Link de afiliado gerado:', linkResult.short_link);
      } else {
        console.warn('[AchadinhoPRO] ⚠️ Não foi possível gerar link de afiliado:', linkResult?.error);
      }
    } else if (finalProduct.affiliateShortLink) {
      console.log('[AchadinhoPRO] Link de afiliado já presente, pulando geração:', finalProduct.affiliateShortLink);
    }

    if (!finalProduct.affiliateShortLink) {
      sendResponse({ success: false, error: 'Link de afiliado não gerado. Verifique login no ML Afiliados.' });
      return;
    }

    const result = await api.saveProduct(finalProduct);
    console.log('[AchadinhoPRO] ✅ Produto salvo:', result?._saveStatus || 'ok', result?.id);
    sendResponse({ success: true, data: result });
  } catch (error) {
    console.error('[AchadinhoPRO] Erro ao salvar produto:', error.message || error);
    console.error('[AchadinhoPRO] Dados enviados:', JSON.stringify({ mlItemId: productData?.mlItemId, price: productData?.price, priceType: typeof productData?.price, hasLink: !!productData?.affiliateShortLink }));
    sendResponse({ success: false, error: error.message });
  }
}

async function handleSaveShopeeProducts(products, listId, sendResponse) {
  try {
    console.log('[AchadinhoPRO] Salvando', products.length, 'produtos Shopee');
    console.log('[AchadinhoPRO] Shopee sample:', JSON.stringify({
      first: products[0] ? { name: products[0].productName?.slice(0,30), platformItemId: products[0].platformItemId, price: products[0].price, priceType: typeof products[0].price, url: (products[0].productUrl || products[0].productLink || '').slice(0,50) } : null
    }));
    const result = await api.saveShopeeProducts(products, listId);
    console.log('[AchadinhoPRO] ✅ Shopee salvo:', JSON.stringify(result));
    sendResponse({ success: true, data: result });
  } catch (error) {
    console.error('[AchadinhoPRO] Erro ao salvar produtos Shopee:', error.message || error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleSaveAmazonProducts(products, listId, sendResponse) {
  try {
    console.log('[AchadinhoPRO] Salvando', products.length, 'produtos Amazon');

    // O link não depende mais do SiteStripe por produto: some o `getShortUrl` e, com
    // ele, o delay de 1,5 s e os retries de 503 que existiam só para contorná-lo. A
    // ÚNICA chamada à Amazon no lote é a revalidação da tag, feita uma vez aqui.
    //
    // `forceRefresh` no início do lote não é preciosismo: quem trocou de conta do
    // Associados no meio da sessão geraria o lote inteiro com a tag antiga — comissão
    // para a conta errada, o pior defeito possível deste subsistema.
    let primeiroDoLote = true;
    let ultimoErroDeLink = null;

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      const productUrl = product.productUrl || product.productLink || ('https://www.amazon.com.br/dp/' + product.asin);

      // Regera quando falta o link, quando ele veio sem tag conhecida, OU quando ainda é
      // um `amzn.to` (produto salvo por versão antiga): assim o re-save já sai no formato
      // longo, auditável, sem esperar backfill.
      const precisaGerar = !product.affiliateShortLink
        || !product.affiliateTag
        || /amzn\.to/i.test(String(product.affiliateShortLink));

      if (precisaGerar) {
        try {
          const linkResult = await generateAmazonAffiliateLink(productUrl, {
            asin: product.asin || product.platformItemId,
            forceRefresh: primeiroDoLote,
          });
          primeiroDoLote = false;
          if (linkResult.success) {
            product.affiliateShortLink = linkResult.short_link;
            product.affiliateLink = linkResult.short_link;
            product.affiliateTag = linkResult.tag;
          } else {
            ultimoErroDeLink = linkResult.error || null;
            console.warn(`[AchadinhoPRO] Link não gerado para "${(product.productName || '').slice(0, 40)}": ${linkResult.error}`);
          }
        } catch (err) {
          ultimoErroDeLink = err.message || String(err);
          console.warn(`[AchadinhoPRO] Falha ao gerar link do produto ${i}:`, err.message);
        }
      }

      chrome.runtime.sendMessage({
        action: 'batchSaveProgress',
        current: i + 1,
        total: products.length,
        saved: products.filter(p => p.affiliateShortLink).length,
      }).catch(() => {});
    }

    // Filter to only products with affiliate links
    const validProducts = products.filter(p => p.affiliateShortLink);
    console.log('[AchadinhoPRO] Produtos Amazon com link:', validProducts.length, '/', products.length);

    if (validProducts.length > 0) {
      const result = await api.saveAmazonProducts(validProducts, listId);
      console.log('[AchadinhoPRO] Amazon salvo:', JSON.stringify(result));
      sendResponse({ success: true, data: result });
    } else {
      // O MOTIVO real, não a suposição. "Verifique se está logado" era chute: a causa
      // podia ser throttling, aba morta ou ASIN divergente — e o usuário ficava
      // reconferindo um login que estava certo.
      sendResponse({
        success: false,
        error: ultimoErroDeLink || 'Nenhum link de afiliado gerado. Verifique se está logado no Associados Amazon.',
      });
    }
  } catch (error) {
    console.error('[AchadinhoPRO] Erro ao salvar produtos Amazon:', error.message || error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleBatchSave(products, sendResponse) {
  try {
    const results = { total: products.length, saved: 0, errors: 0, skipped: 0, details: [] };

    for (let i = 0; i < products.length; i++) {
      const product = products[i];

      // Skip products without affiliate link
      if (!product.affiliateShortLink) {
        results.skipped++;
        results.details.push({ index: i, success: false, error: 'Sem link de afiliado' });
        chrome.runtime.sendMessage({
          action: 'batchSaveProgress',
          current: i + 1,
          total: products.length,
          saved: results.saved,
          errors: results.errors,
        }).catch(() => {});
        continue;
      }

      try {
        await api.saveProduct(product);
        results.saved++;
        results.details.push({ index: i, success: true });
      } catch (err) {
        results.errors++;
        results.details.push({ index: i, success: false, error: err.message });
      }

      chrome.runtime.sendMessage({
        action: 'batchSaveProgress',
        current: i + 1,
        total: products.length,
        saved: results.saved,
        errors: results.errors,
      }).catch(() => {});
    }

    sendResponse({ success: true, data: results });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

// Export handler functions for send-queue.js to use via globalThis._handlers
globalThis._handlers = {
  handleManualSave,
  handleSaveAmazonProducts,
  handleSaveShopeeProducts,
  handleGenerateShortLink: handleManualGenerateLink,
  // `opts` carrega o ASIN do produto (conferência contra o ASIN da URL) e o
  // `forceRefresh` do primeiro item do lote.
  handleGenerateAmazonShortLink: (url, cb, opts) => {
    generateAmazonAffiliateLink(url, opts)
      .then((result) => cb(result))
      .catch((err) => cb({ success: false, error: err.message }));
  },
  handleSaveToList: (listId, items, _platform, cb) => {
    api.addListItems(listId, items)
      .then((data) => cb({ success: true, data }))
      .catch((err) => cb({ success: false, error: err.message }));
  },
  refreshLinkBuilderSession: async () => {
    console.log('[AchadinhoPRO] Refreshing linkbuilder session (closing and reopening tab)...');
    await closeLinkBuilderTab();
    linkBuilderConsecutiveFailures = 0;
    linkBuilderCooldownUntil = 0;
    // ensureLinkBuilderTab will be called on next enrichment
  },
};

// ── Cupons: fluxo ghost-tab da página de cupons do marketplace ─────────────────
// Registro POR PLATAFORMA (mesmo espírito do PLATFORM_CONFIG do keyword search):
// cada marketplace tem sua própria página de cupons e seu próprio scraper ISOLADO
// (sho-/ml-/amz-coupon-scraper.js) — ajustar o parser de um nunca toca o outro.
//
// O Mercado Livre NÃO entra aqui, de propósito (era o plano antigo). O fluxo de
// cupons do ML é outro: o usuário navega de verdade pela página de produtos do
// cupom, então precisa de ABA REAL e visível, não da janela popup deste import.
// Ver o bloco "Cupons do Mercado Livre" mais abaixo — nada dali toca isto.
const COUPON_PLATFORMS = {
  shopee: {
    name: 'Shopee',
    url: 'https://shopee.com.br/m/cupom-de-desconto',
    scraperFile: 'content/scrapers/sho-coupon-scraper.js',
  },
};

// Injeta o scraper de cupons da plataforma EXPLICITAMENTE (getScriptsForUrl apontaria
// para o scraper de PRODUTO do marketplace, que não sabe extrair cupons) e pede a extração.
async function extractCouponsFromTab(tabId, scraperFile) {
  // Falha de injeção é fatal: sem o scraper, o sendMessage abaixo só produziria um
  // "Receiving end does not exist" enganoso. Propaga a causa real.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [scraperFile] });
  } catch (e) {
    throw new Error('Falha ao injetar o leitor de cupons: ' + (e && e.message ? e.message : e));
  }
  await new Promise((r) => setTimeout(r, 500));
  return new Promise((resolve, reject) => {
    // Cobre a espera longa do scraper (45s de waitForContent + scroll + 2ª tentativa)
    // MAIS a leitura das condições de cada card, que é sequencial e tem orçamento
    // próprio de 60s no scraper (CONDITIONS_TOTAL_BUDGET_MS). Aba em segundo plano é
    // throttled e o microsite da Shopee pode demorar. O web app espera 240s.
    const timeout = setTimeout(() => reject(new Error('Timeout na extração de cupons')), 150000);
    chrome.tabs.sendMessage(tabId, { action: 'extractCoupons' }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// Trava de reentrância: dois disparos simultâneos (auto-import + clique no botão)
// abririam duas ghost tabs e uma fecharia a aba da outra (currentGhostTabId é global).
let couponImportInFlight = null;

// ── Validade dos cupons Shopee: sonda de fibers + página de detalhes ──────────
//
// Evidência de 28/jul/2026: o "Condições" do card NAVEGA para /voucher/details
// (casca CSR — 155 KB de HTML, 1 caractere de texto), então nem modal nem fetch
// produzem os termos; e a API real (api/v1/microsite/get_vouchers_by_collections)
// é POST com corpo que não conhecemos. O que resta — e é determinístico — são
// duas fontes: (1) os PROPS que o React da própria página guarda em cada card
// (promotionid + start_time/end_time), lidos por uma sonda no mundo MAIN; e
// (2) a página de detalhes RENDERIZADA, lida navegando a própria popup do
// import — o equivalente programático de "clicar nas Condições e ler".

/**
 * Roda no MUNDO DA PÁGINA (world: MAIN). Autossuficiente de propósito: é
 * serializada pelo chrome.scripting e não enxerga nada deste arquivo. Para cada
 * link de /voucher/details, sobe a árvore de fibers do React procurando o objeto
 * de voucher nos memoizedProps. Chaves __reactFiber$ (17+) e
 * __reactInternalInstance$ (16) cobrem as versões que a Shopee usa.
 */
function shopeeVoucherFiberProbe() {
  function scan(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 4) return null;
    var id = obj.promotionid != null ? obj.promotionid : obj.promotion_id;
    var end = obj.end_time != null ? obj.end_time : obj.claim_end_time;
    if (id != null && end != null) {
      return {
        promotionid: String(id),
        start: obj.start_time != null ? Number(obj.start_time)
          : obj.claim_start_time != null ? Number(obj.claim_start_time) : null,
        end: Number(end),
      };
    }
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length && i < 40; i++) {
      var v = obj[keys[i]];
      if (v && typeof v === 'object') {
        var r = scan(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }
  try {
    var out = [];
    var seen = {};
    var links = document.querySelectorAll('a[href*="/voucher/details"]');
    for (var i = 0; i < links.length; i++) {
      var el = links[i];
      var keys = Object.keys(el);
      var fiberKey = null;
      for (var k = 0; k < keys.length; k++) {
        if (keys[k].indexOf('__reactFiber$') === 0 || keys[k].indexOf('__reactInternalInstance$') === 0) {
          fiberKey = keys[k];
          break;
        }
      }
      if (!fiberKey) continue;
      var fiber = el[fiberKey];
      var hops = 0;
      var found = null;
      while (fiber && hops < 15 && !found) {
        found = scan(fiber.memoizedProps, 0);
        fiber = fiber.return;
        hops++;
      }
      if (found && !seen[found.promotionid]) {
        seen[found.promotionid] = 1;
        out.push(found);
      }
    }
    return { ok: true, vouchers: out, linksSeen: links.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Epoch (s ou ms) → frase que o parser server-side reconhece com prioridade
 * máxima. A extensão NÃO decide validade: manda texto, e o servidor interpreta —
 * mesmo contrato do modal do ML. Fora da janela plausível (>1 ano no passado,
 * >2 anos no futuro) → null, e o cupom fica sem prazo em vez de ganhar um errado.
 */
function voucherEpochToConditionsText(startS, endS) {
  function plausible(n) {
    var num = Number(n);
    if (!num || !isFinite(num)) return null;
    var ms = num > 1e12 ? num : num * 1000;
    var now = Date.now();
    if (ms < now - 366 * 864e5 || ms > now + 2 * 366 * 864e5) return null;
    return ms;
  }
  const end = plausible(endS);
  if (!end) return null;
  const start = plausible(startS);
  const fmt = (ms) => new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date(ms));
  return start
    ? `Cupom válido de ${fmt(start)} a ${fmt(end)}, incluindo ambas as datas.`
    : `Cupom válido até ${fmt(end)}.`;
}

/**
 * Preenche `conditionsText` dos cupons Shopee que a extração deixou sem validade.
 *
 * Fase 1 (uma injeção cobre tudo): sonda de fibers na página da lista, casada
 * pelo promotionId que o scraper anexou a cada cupom. Fase 2 (por cupom, até o
 * deadline): navega a PRÓPRIA popup para /voucher/details e lê o texto
 * renderizado — a lista já foi extraída, a página não faz mais falta. Cupom que
 * não couber no orçamento fica sem prazo NESTA leitura; o servidor preserva o
 * que já sabia e a próxima sincronização continua de onde parou.
 */
async function enrichShopeeCouponsValidity(tabId, coupons, deadlineMs, priorityCodes) {
  // Fila = todo cupom com URL de condições e sem texto — inclui os gift cards, que
  // não têm promotionId (o "Condições" deles aponta para /digital-product/...).
  const pendentes = coupons.filter((c) => c && c.conditionsUrl && !c.conditionsText);
  if (pendentes.length === 0) return { filled: 0, viaProbe: 0, viaPage: 0 };

  let viaProbe = 0;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: shopeeVoucherFiberProbe,
    });
    const probe = res && res[0] ? res[0].result : null;
    if (probe && probe.ok) {
      const byPromo = new Map();
      for (const c of pendentes) {
        if (c.promotionId) byPromo.set(String(c.promotionId), c);
      }
      for (const v of probe.vouchers || []) {
        const c = byPromo.get(String(v.promotionid));
        if (!c || c.conditionsText) continue;
        const text = voucherEpochToConditionsText(v.start, v.end);
        if (!text) continue;
        c.conditionsText = text;
        viaProbe++;
      }
      console.log(`[AchadinhoPRO] Sonda de vouchers: ${viaProbe} validades de ${probe.linksSeen || 0} links`);
    } else if (probe) {
      console.warn('[AchadinhoPRO] Sonda de vouchers falhou:', probe.error);
    }
  } catch (e) {
    console.warn('[AchadinhoPRO] Sonda de vouchers indisponível:', e.message);
  }

  // Quem o SERVIDOR disse que está sem validade vai primeiro: sem isso, cada
  // sincronização gastava o orçamento relendo os mesmos cupons do topo da página
  // e os últimos (gift cards) nunca eram alcançados.
  const prioridade = priorityCodes instanceof Set ? priorityCodes : new Set(priorityCodes || []);
  const fila = pendentes
    .filter((c) => !c.conditionsText)
    .sort((a, b) => {
      const pa = prioridade.has(a.code) ? 0 : 1;
      const pb = prioridade.has(b.code) ? 0 : 1;
      return pa - pb;
    });

  let viaPage = 0;
  const outcomes = [];
  for (const c of fila) {
    if (Date.now() > deadlineMs) {
      console.log('[AchadinhoPRO] Validade: orçamento esgotado — restantes ficam para a próxima sincronização');
      break;
    }
    // Uma retentativa por cupom, e só quando a leitura falhou por a aba não estar
    // na página pedida (redirecionamento, navegação atrasada). "sem-texto" já gastou
    // o orçamento inteiro do poll — repetir só tomaria o tempo do próximo cupom.
    let tentativa = 0;
    let r = null;
    while (tentativa < 2) {
      tentativa++;
      r = await readConditionsPage(tabId, c.conditionsUrl);
      if (!r || r.reason !== 'url-diferente' || Date.now() > deadlineMs) break;
    }
    outcomes.push({
      code: c.code,
      source: (r && r.reason) || 'erro',
      ms: (r && r.elapsedMs) || 0,
      len: (r && r.textLen) || 0,
    });
    // Só texto COM data vira `conditionsText`. O texto sem data (shell da página,
    // regulamento que não renderizou) fica no diagnóstico e não no cupom: gravá-lo
    // substituiria no `raw_text` do servidor um bloco de condições BOM de uma leitura
    // anterior por um rodapé — e ainda inflaria a métrica "com validade lida".
    if (r && r.text && (r.reason === 'ok' || r.reason === 'ok-instavel')) {
      c.conditionsText = r.text;
      viaPage++;
    }
  }
  return { filled: viaProbe + viaPage, viaProbe, viaPage, outcomes };
}

/**
 * Navega a aba até a página de condições e devolve o texto renderizado.
 *
 * Um `waitForTabLoad` estourado NÃO aborta a leitura: a SPA da Shopee dispara
 * 'complete' antes do conteúdo em algumas navegações e depois dele em outras — o
 * que decide é o poll do content script, que compara a URL corrente com a pedida.
 */
async function readConditionsPage(tabId, conditionsUrl) {
  const start = Date.now();
  try {
    await chrome.tabs.update(tabId, { url: conditionsUrl });
    try {
      await waitForTabLoad(tabId, 12000);
    } catch (e) {
      console.warn('[AchadinhoPRO] Página de condições demorou a carregar — lendo assim mesmo');
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/scrapers/sho-coupon-scraper.js'] });
    const resp = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 14000);
      chrome.tabs.sendMessage(
        tabId,
        { action: 'readVoucherDetailsPage', timeoutMs: 10000, expectUrl: conditionsUrl },
        (r) => {
          clearTimeout(t);
          resolve(chrome.runtime.lastError ? null : r);
        },
      );
    });
    if (!resp || !resp.success) {
      return { text: null, reason: 'sem-resposta', elapsedMs: Date.now() - start, textLen: 0 };
    }
    return {
      text: resp.text || null,
      reason: resp.reason || (resp.text ? 'ok' : 'sem-texto'),
      elapsedMs: Date.now() - start,
      textLen: resp.textLen || 0,
    };
  } catch (e) {
    console.warn('[AchadinhoPRO] Falha ao ler detalhes do cupom:', e.message);
    return { text: null, reason: 'erro', elapsedMs: Date.now() - start, textLen: 0 };
  }
}

async function importCoupons(marketplace) {
  // O ML entra por aqui só como PORTA: o web app dispara um evento só
  // ('achadinho-import-coupons') e a bridge não deveria conhecer dois protocolos. O
  // fluxo em si continua sendo o de baixo — aba real e visível, nada de ghost tab —,
  // e a resposta é normalizada no formato que a página de cupons já sabe ler.
  if (marketplace === 'ml') {
    const r = await syncMlCoupons();
    return {
      marketplace: 'ml',
      found: r.count,
      saved: (r.coupons || []).length,
      // Quantos vieram COM as condições do modal lidas: é a diferença entre um cupom
      // que calcula preço na mensagem e um que só mostra o código.
      withConditions: (r.coupons || []).filter((c) => c.conditionsParsed).length,
      warnings: r.warnings || [],
    };
  }

  const platform = COUPON_PLATFORMS[marketplace];
  if (!platform) {
    throw new Error(`Cupons de "${marketplace}" ainda não são suportados (em breve)`);
  }
  if (couponImportInFlight) return couponImportInFlight;
  couponImportInFlight = (async () => {
    let winId = null;
    let tabId = null;
    const importStart = Date.now();
    try {
      if (typeof addLog === 'function') addLog(`Importando cupons da ${platform.name}...`);
      // Janela popup VISÍVEL e sem foco — NÃO usar ghost tab aqui: o microsite de cupons
      // da Shopee depende de requestAnimationFrame, que o Chrome PAUSA por completo em
      // abas invisíveis (diagnóstico: body só com header/footer mesmo após 45s+retry).
      // Numa janela visível o render é normal; focused:false não rouba o teclado do
      // usuário e a janela se fecha sozinha ao final da leitura.
      const win = await chrome.windows.create({
        url: platform.url,
        type: 'popup',
        focused: false,
        width: 500,
        height: 760,
        left: 40,
        top: 40,
      });
      winId = win.id;
      tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
      if (tabId == null) throw new Error('Não foi possível abrir a janela de leitura de cupons');
      await waitForTabLoad(tabId, 45000);
      await new Promise((r) => setTimeout(r, 1500)); // margem para o render inicial da SPA
      const extraction = await extractCouponsFromTab(tabId, platform.scraperFile);
      if (!extraction || !extraction.success) {
        throw new Error((extraction && extraction.error) || 'Extração de cupons falhou');
      }
      const coupons = extraction.data || [];
      const exhausted = extraction.exhaustedCodes || [];

      // Fase 1 de gravação: os cupons entram JÁ, sem validade. A resposta traz
      // `semValidade` — os códigos que o BANCO ainda não tem prazo — e é isso que
      // ordena a fase de leitura: o orçamento vai primeiro para quem falta, em vez
      // de reler a cada sincronização os mesmos cupons do topo da página.
      let saveResult = await api.saveCoupons(marketplace, coupons, exhausted, extraction.sourceUrl || platform.url);

      // Fase de validade (sonda de fibers + páginas de detalhes). O deadline deixa
      // 40 s de folga para o web app (que desiste em 240 s) receber a resposta.
      let validity = { filled: 0, viaProbe: 0, viaPage: 0 };
      if (coupons.length > 0) {
        try {
          validity = await enrichShopeeCouponsValidity(
            tabId,
            coupons,
            importStart + 200000,
            saveResult.semValidade || [],
          );
        } catch (e) {
          console.warn('[AchadinhoPRO] Fase de validade falhou:', e.message);
        }
        // Fase 2: regrava com os textos lidos. Payload COMPLETO de propósito — um
        // subconjunto poderia passar do limiar de cobertura e expirar os ausentes.
        if (validity.filled > 0) {
          try {
            const save2 = await api.saveCoupons(marketplace, coupons, exhausted, extraction.sourceUrl || platform.url);
            saveResult = { ...saveResult, withValidity: save2.withValidity, semValidade: save2.semValidade };
          } catch (e) {
            console.warn('[AchadinhoPRO] Falha ao regravar validades:', e.message);
          }
        }
      }
      const comValidade = coupons.filter((c) => c.conditionsText).length;
      const validityOutcomes = validity.outcomes || [];
      // A contagem que vale é a do SERVIDOR (`withValidity`): ela conta cupom com prazo
      // NO BANCO. Contar o texto capturado dizia "18/18 lidos" mesmo quando o parser não
      // achava data nenhuma — foi assim que a falha de 28/jul/2026 passou batido no log
      // da extensão. `comValidade` fica só como piso quando o servidor não respondeu.
      const validadeReal = typeof saveResult.withValidity === 'number' ? saveResult.withValidity : comValidade;

      // Diagnóstico só quando ainda há o que calibrar: 0 cupons OU nenhuma validade
      // mesmo após a fase acima. Enviar sempre mandaria 125 KB por sincronização boa.
      if (extraction.debug && (coupons.length === 0 || validadeReal === 0)) {
        try {
          // Os dois desfechos são complementares e o servidor guarda 60: o da fase de
          // validade (por que a PÁGINA de condições não deu data) vem primeiro; o do
          // scraper (por que o CARD não deu gatilho) completa. Substituir um pelo
          // outro deixaria a calibração cega de metade do caminho.
          const outcomesDoCard = (extraction.debug && extraction.debug.conditionsOutcomes) || [];
          await api.saveCouponsDebug(marketplace, {
            ...extraction.debug,
            conditionsOutcomes: validityOutcomes.concat(outcomesDoCard).slice(0, 60),
          });
          if (typeof addLog === 'function') addLog('Cupons: diagnóstico da página enviado ao servidor (calibração)');
        } catch (e) {
          console.warn('[AchadinhoPRO] Falha ao enviar diagnóstico de cupons:', e.message);
        }
      } else if (coupons.length > validadeReal && validityOutcomes.length > 0) {
        // Sobrou cupom sem prazo, mas a leitura funcionou para outros: manda só o
        // DESFECHO por cupom (dezenas de bytes), sem o HTML. Foi a ausência desse
        // dado que fez o bug de 28/jul/2026 — leitura "instantânea" e vazia da 8ª em
        // diante — depender do relato do usuário para ser percebido.
        try {
          await api.saveCouponsDebug(marketplace, {
            url: extraction.sourceUrl || platform.url,
            title: 'validade-parcial',
            candidateCount: coupons.length,
            scraperVersion: (extraction.debug && extraction.debug.scraperVersion) || '',
            conditionsOutcomes: validityOutcomes,
          });
        } catch (e) {
          console.warn('[AchadinhoPRO] Falha ao enviar desfechos de validade:', e.message);
        }
      }
      if (typeof addLog === 'function') {
        const giftCards = extraction.giftCardsIgnored || 0;
        addLog(
          `Cupons ${platform.name}: ${coupons.length} lidos, +${saveResult.imported || 0} novos` +
            (giftCards > 0 ? ` (${giftCards} gift cards fora da importação)` : ''),
        );
        // Validade lida é o que decide se o cupom morre sozinho no vencimento; quando
        // ela não vem, o cupom entra sem prazo e só sai da lista quando desaparecer
        // da página. É informação de operação, não detalhe interno.
        if (coupons.length > 0 && validadeReal < coupons.length) {
          addLog(`Cupons ${platform.name}: ${validadeReal}/${coupons.length} com validade (sonda ${validity.viaProbe}, detalhes ${validity.viaPage})`);
        }
        if (coupons.length === 0 && extraction.pageReady === false) {
          addLog('Aviso: a página de cupons não terminou de carregar — tente novamente');
        }
      }
      return {
        found: coupons.length,
        exhausted: exhausted.length,
        pageReady: extraction.pageReady !== false,
        conditionsRead: comValidade,
        ...saveResult,
      };
    } finally {
      // Fecha a janela QUE ESTE import abriu (nunca mexe nas ghost tabs de outros fluxos).
      if (winId != null) {
        try {
          await chrome.windows.remove(winId);
        } catch (e) {
          console.warn('[AchadinhoPRO] Janela de cupons já fechada:', e.message);
        }
      }
      couponImportInFlight = null;
    }
  })();
  return couponImportInFlight;
}

// ── Cupons do Mercado Livre: "Lista Cupons" ───────────────────────────────────
//
// Bloco NOVO e independente. Não toca COUPON_PLATFORMS nem importCoupons: aquele
// fluxo lê uma página de cupons públicos numa janela popup descartável; este lê os
// cupons que o PRÓPRIO usuário gerou e depois o acompanha navegando pelos produtos
// de cada cupom, numa aba real que ele mantém aberta.

const ML_COUPONS_URL = 'https://www.mercadolivre.com.br/afiliados/coupons#hub';
const ML_COUPON_SCRAPER = 'content/scrapers/ml-coupon-scraper.js';

// Teto do sync inteiro, medido do início de `syncMlCoupons`. O web app desiste em 240 s
// (client/src/pages/cupons.tsx) — 205 s aqui deixam ~35 s de folga para a gravação no
// servidor e para o caminho de volta. Estourar significa o usuário vendo "Tempo esgotado"
// com os cupons sendo gravados atrás: o pior tipo de erro, o que mente.
const ORCAMENTO_TOTAL_MS = 205000;
// Teto e piso da sonda de clique dentro desse orçamento. Abaixo do piso ela é PULADA (com
// registro no dump): entrar com 3 s só produziria meia varredura e um diagnóstico confuso.
const CLICK_PROBE_MAX_MS = 45000;
const CLICK_PROBE_MIN_MS = 8000;
// Quanto se espera pela URL de uma aba que escapou e nasceu em `about:blank` antes de
// fechá-la assim mesmo. Constante (e não literal) para o teste poder encurtar o prazo.
const ML_COUPON_ORPHAN_TAB_MS = 5000;
// Teto de páginas do grid "Códigos gerados". Não é limite de produto: é backstop contra
// paginação que não avança e devolveria o mesmo grid para sempre.
const ML_COUPON_MAX_PAGINAS = 15;
// Reserva do orçamento para a gravação e o caminho de volta. Abaixo dela a varredura para
// de paginar — com o motivo registrado em `debug.pararPor`.
const ML_COUPON_PAGE_RESERVE_MS = 40000;

// Vínculo aba → cupom. Vive em chrome.storage.session (e não numa variável de
// módulo) porque o service worker MV3 morre em ~30 s ocioso — e o usuário fica
// minutos navegando pela lista de produtos do cupom. `let` evaporaria no meio.
const ML_COUPON_TABS_KEY = 'mlCouponTabs';
// Última leitura dos cupons, para o painel exibir sem disparar sincronização.
const ML_COUPONS_CACHE_KEY = 'mlCouponsCache';

// Chave ESTÁVEL da página de produtos de um cupom (slug|sellerId), a mesma regra que
// o sidepanel usa a cada evento de navegação. Vive em services/ml-coupon-tab-link.js
// justamente para não haver duas cópias: divergirem significa aceitar produtos de
// outra página como sendo deste cupom.
const mlContainerKey = (url) => globalThis.MlCouponTabLink.containerKeyFromUrl(url);

async function readMlCouponTabs() {
  try {
    const stored = await chrome.storage.session.get(ML_COUPON_TABS_KEY);
    return stored?.[ML_COUPON_TABS_KEY] || {};
  } catch {
    return {};
  }
}

async function writeMlCouponTabs(map) {
  try {
    await chrome.storage.session.set({ [ML_COUPON_TABS_KEY]: map });
  } catch (e) {
    console.warn('[AchadinhoPRO:MLCupons] Falha ao persistir vínculo aba↔cupom:', e.message);
  }
}

/** Contexto de cupom de uma aba, ou null. */
async function getMlCouponTabContext(tabId) {
  const map = await readMlCouponTabs();
  return map[String(tabId)] || null;
}

/**
 * Procura a URL de "Ver produtos" no MUNDO PRINCIPAL da página de cupons.
 *
 * ⚠️ Esta função é serializada e executada DENTRO da página: não pode fechar sobre nada
 * do service worker, e lá não existe `chrome.runtime` — o que atravessa a fronteira é o
 * valor de retorno.
 *
 * POR QUE EXISTE: o ML não emite `href` nesse `<a>`. Duas capturas independentes do DOM
 * (fixture das 12:28 e dump das 19:09 de 26/jul/2026) mostram 100% das âncoras de cupom
 * sem o atributo, e a segunda passada do scraper recuperou zero — o destino é resolvido
 * por JS no clique. O content script roda em mundo ISOLADO e não enxerga as props do
 * React nem o estado embutido da página; daqui, sim.
 *
 * Duas fontes, nessa ordem: (1) as props/fiber do React pendurados no próprio `<a>`;
 * (2) o estado inicial embutido (`__PRELOADED_STATE__`/`__NEXT_DATA__`), casando o
 * CÓDIGO do cupom com uma URL na mesma subárvore.
 *
 * Só devolve URL de listagem de cupom — nos DOIS formatos que o ML usa
 * (`_Container_<slug>-seller-<id>` e `_CustId_<id>?coupon_campaign_id=<id>`). É essa
 * chave que amarra os produtos ao cupom, e quem valida de novo é o chamador
 * (`mlContainerKey`). Um palpite aceito aqui viraria produto sem direito ao desconto
 * dentro da lista.
 */
function mlCouponUrlProbe(wanted) {
  var RE_URL = /https?:\/\/[^\s"'<>]*(?:_Container_[^\s"'<>]*-seller-\d+|_CustId_\d+[^\s"'<>]*[?&]coupon_campaign_id=\d+)/;
  // Chaves que levam de volta ao DOM/fiber: seguir por elas transforma a varredura num
  // passeio pelo documento inteiro.
  var PROIBIDAS = {
    stateNode: 1, _owner: 1, return: 1, child: 1, sibling: 1, alternate: 1,
    ownerDocument: 1, ref: 1, _debugOwner: 1, memoizedState: 1,
  };
  var restante = {};
  for (var w = 0; w < wanted.length; w++) restante[wanted[w]] = true;
  var found = {};
  var stats = { cards: 0, viaFiber: 0, viaState: 0, reactKeyFound: false, stateRoots: 0 };

  function limpa(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function codigoDe(valor) {
    var s = limpa(valor).replace(/^#/, '');
    return restante[s] ? s : null;
  }

  /** Primeira URL de container dentro de um valor qualquer. */
  function urlDentro(valor, orcamento) {
    var pilha = [{ v: valor, d: 0 }];
    var vistos = new Set();
    while (pilha.length && orcamento.n > 0) {
      var item = pilha.pop();
      orcamento.n -= 1;
      var v = item.v;
      if (typeof v === 'string') {
        var m = RE_URL.exec(v);
        if (m) return m[0];
        continue;
      }
      if (!v || typeof v !== 'object' || item.d > 6) continue;
      if (v.nodeType || vistos.has(v)) continue;
      vistos.add(v);
      var keys = Object.keys(v);
      for (var k = 0; k < keys.length && k < 60; k++) {
        if (PROIBIDAS[keys[k]]) continue;
        try {
          pilha.push({ v: v[keys[k]], d: item.d + 1 });
        } catch (e) { /* getter que explode: ignora */ }
      }
    }
    return null;
  }

  try {
    var cards = document.querySelectorAll('.generated-coupon-item');
    stats.cards = cards.length;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var b = card.querySelector('[class*="__inner-content"] b') || card.querySelector('b');
      var code = limpa(b && b.textContent).replace(/^#/, '');
      if (!code || !restante[code]) continue;

      var link = card.querySelector('[class*="__category-link"] a, a[class*="__link"]');
      var href = link ? link.getAttribute('href') : null;
      if (href) {
        found[code] = link.href;
        delete restante[code];
        continue;
      }

      var no = link || card;
      var url = null;
      var chaves = Object.keys(no);
      for (var c = 0; c < chaves.length && !url; c++) {
        var ehProps = chaves[c].indexOf('__reactProps$') === 0;
        var ehFiber = chaves[c].indexOf('__reactFiber$') === 0;
        if (!ehProps && !ehFiber) continue;
        stats.reactKeyFound = true;
        if (ehProps) {
          url = urlDentro(no[chaves[c]], { n: 3000 });
        } else {
          // Sobe o fiber: a URL costuma morar nas props do COMPONENTE do card, não do <a>.
          var f = no[chaves[c]];
          var subiu = 0;
          while (f && subiu < 8 && !url) {
            url = urlDentro(f.memoizedProps, { n: 3000 });
            f = f.return;
            subiu += 1;
          }
        }
      }
      if (url) {
        found[code] = url;
        stats.viaFiber += 1;
        delete restante[code];
      }
    }
  } catch (e) {
    stats.cardError = String((e && e.message) || e);
  }

  try {
    if (Object.keys(restante).length > 0) {
      var raizes = [];
      if (window.__PRELOADED_STATE__) raizes.push(window.__PRELOADED_STATE__);
      if (window.__NEXT_DATA__) raizes.push(window.__NEXT_DATA__);
      stats.stateRoots = raizes.length;

      var orc = { n: 60000 };
      var pilha2 = raizes.map(function (r) { return { v: r, d: 0 }; });
      var vistos2 = new Set();
      while (pilha2.length && orc.n > 0 && Object.keys(restante).length > 0) {
        var it = pilha2.pop();
        orc.n -= 1;
        var v2 = it.v;
        if (!v2 || typeof v2 !== 'object' || it.d > 12) continue;
        if (v2.nodeType || vistos2.has(v2)) continue;
        vistos2.add(v2);
        var keys2 = Object.keys(v2);
        var codigoAqui = null;
        for (var k2 = 0; k2 < keys2.length; k2++) {
          if (PROIBIDAS[keys2[k2]]) continue;
          var val = null;
          try { val = v2[keys2[k2]]; } catch (e2) { continue; }
          if (typeof val === 'string') {
            var achado = codigoDe(val);
            if (achado) codigoAqui = achado;
          } else if (val && typeof val === 'object') {
            pilha2.push({ v: val, d: it.d + 1 });
          }
        }
        if (codigoAqui) {
          var u = urlDentro(v2, { n: 4000 });
          if (u) {
            found[codigoAqui] = u;
            stats.viaState += 1;
            delete restante[codigoAqui];
          }
        }
      }
    }
  } catch (e) {
    stats.stateError = String((e && e.message) || e);
  }

  stats.missing = Object.keys(restante);
  return { found: found, stats: stats };
}

/** Roda a sonda acima na aba de cupons. Nunca lança: sem URL, o fluxo segue sem ela. */
async function probeMlCouponUrls(tabId, codes) {
  if (!codes || codes.length === 0) return { found: {}, stats: null };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: mlCouponUrlProbe,
      args: [codes],
    });
    return (res && res.result) || { found: {}, stats: null };
  } catch (e) {
    console.warn('[AchadinhoPRO:MLCupons] Sonda de URL no mundo principal falhou:', e.message);
    return { found: {}, stats: { error: (e && e.message) || String(e) } };
  }
}

/**
 * Sonda ATIVA: clica no "Ver produtos" de UM cupom e captura o destino — sem deixar
 * a aba abrir.
 *
 * ⚠️ Serializada e executada DENTRO da página (world MAIN): não fecha sobre nada do
 * service worker, e o que atravessa a fronteira é só o valor de retorno.
 *
 * POR QUE PRECISA CLICAR. A sonda passiva (`mlCouponUrlProbe`) procura a URL onde ela
 * poderia estar parada: no `href`, nas props/fiber do React, no estado embutido. O dump
 * de 27/jul/2026 15:32 fechou a questão — 10 cards, 10 cupons, `cardsWithHrefNow: 0`,
 * `viaFiber: 0`, `viaState: 0`, `stateRoots: 0` e os DEZ códigos em `missing`. A URL não
 * existe no cliente antes do clique: o ML a resolve no handler. Enquanto ninguém clica,
 * o cupom chega ao web app sem "Ver produtos" — que é o defeito relatado (só 4 dos 10
 * cupons tinham o botão, e esses quatro vinham de vínculos manuais gravados antes, que o
 * servidor preserva com `?? prev.productsUrl`).
 *
 * COMO CAPTURA SEM ABRIR ABA — quatro camadas, porque não se sabe qual delas o ML usa e
 * um único caminho descoberto significa uma aba de verdade aberta na cara do usuário:
 *
 *  1. `window.open` trocado por um stub que devolve um popup FALSO. Devolver o objeto (e
 *     não `null`) importa: o padrão `var w = window.open(''); fetch(...).then(r => w.location.href = r.url)`
 *     é comum, e com `null` o ML cairia no fallback de navegar a própria aba.
 *  2. `location.href/assign/replace` DESSE popup falso — é por onde a URL chega quando ela
 *     depende de uma requisição.
 *  3. Listener de `click` no `window` em BOLHA (roda depois do handler do React, que o
 *     anexa no container raiz): lê o `href` que o ML acabou de escrever no `<a>` e chama
 *     `preventDefault()` — o default do link só executa no fim do dispatch, então cancelar
 *     aqui impede a aba. O listener é escopado ao card alvo para não engolir um clique do
 *     usuário em outro ponto da página.
 *  4. `HTMLAnchorElement.prototype.click`, para o caso de o ML criar um `<a>` fora do
 *     documento e clicar nele — aí não há bolha até o `window` e a camada 3 não veria nada.
 *
 * A instrumentação é SEMPRE desfeita (`restaurar`), inclusive por um timer de segurança:
 * deixar `window.open` trocado numa página que o usuário mantém aberta quebraria a
 * navegação dele muito depois de a sincronização ter terminado.
 *
 * Só devolve URL de listagem de cupom, nos dois formatos que o ML usa — quem valida de
 * novo é o chamador (`mlContainerKey`). Palpite aceito aqui vira produto sem direito ao
 * desconto dentro da lista.
 */
function mlCouponClickProbe(code, waitMs) {
  return new Promise(function (resolve) {
    // Os dois formatos do "Ver produtos" — ver containerKeyFromUrl. O segundo apareceu
    // em 27/jul/2026: a sonda capturou 10 URLs `_CustId_…?coupon_campaign_id=…` e a
    // regex antiga recusou todas, que é o que deixou os cupons sem link de novo.
    var RE_URL = /https?:\/\/[^\s"'<>]*(?:_Container_[^\s"'<>]*-seller-\d+|_CustId_\d+[^\s"'<>]*[?&]coupon_campaign_id=\d+)/;
    var stats = { card: false, link: false, opens: 0, anchorClicks: 0, jaTinhaHref: false };
    var capturado = null;
    var via = null;
    var restaurado = false;
    var openOriginal = null;
    var anchorClickOriginal = null;
    var listener = null;
    var guarda = null;
    var card = null;
    var link = null;

    function limpa(s) {
      return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    }

    function aceita(valor, origem) {
      if (capturado || valor == null) return;
      var s = String(valor);
      var m = RE_URL.exec(s);
      if (!m) {
        // O que o clique produziu mas NÃO era listagem de cupom. Sem esta amostra,
        // "0 recuperadas" não distingue "o clique não fez nada" de "o ML passou a mandar
        // por uma URL intermediária" — e a segunda tem conserto de uma linha, desde que se
        // saiba qual é a URL. Só entra o que parece destino de navegação.
        if (/^https?:/.test(s)) {
          stats.recusadas = stats.recusadas || [];
          if (stats.recusadas.length < 5) stats.recusadas.push(origem + ': ' + s.slice(0, 200));
        }
        return;
      }
      capturado = m[0];
      via = origem;
    }

    function restaurar() {
      if (restaurado) return;
      restaurado = true;
      try { if (openOriginal) window.open = openOriginal; } catch (e) { /* página fechando */ }
      try {
        if (anchorClickOriginal) HTMLAnchorElement.prototype.click = anchorClickOriginal;
      } catch (e) { /* protótipo congelado: nada a desfazer */ }
      try { if (listener) window.removeEventListener('click', listener, false); } catch (e) { /* idem */ }
      try { if (guarda) clearTimeout(guarda); } catch (e) { /* idem */ }
    }

    function terminar() {
      restaurar();
      resolve({ url: capturado, via: via, stats: stats });
    }

    /**
     * Reencontra card e link pelo CÓDIGO no DOM ATUAL.
     *
     * Chamada de novo a cada poll porque o React remonta o grid o tempo todo nesta página
     * — o dump de 27/jul/2026 contou 9 cards substituídos numa leitura de 10. Um nó
     * fotografado antes do clique devolve o estado ANTIGO dos atributos: o href chegaria
     * no card novo e a sonda ficaria olhando para o velho até o timeout.
     */
    function localizar() {
      try {
        var cards = document.querySelectorAll('.generated-coupon-item');
        for (var i = 0; i < cards.length; i++) {
          var b =
            cards[i].querySelector('[class*="__inner-content"] b') || cards[i].querySelector('b');
          if (limpa(b && b.textContent).replace(/^#/, '') === code) {
            card = cards[i];
            link = card.querySelector('[class*="__category-link"] a, a[class*="__link"]');
            return !!link;
          }
        }
      } catch (e) {
        stats.erro = String((e && e.message) || e);
      }
      return false;
    }

    if (!localizar()) {
      stats.card = !!card;
      return terminar();
    }
    stats.card = true;
    stats.link = true;

    // O ML pode ter preenchido o href entre a leitura e agora: aí não há por que clicar.
    var jaTem = link.getAttribute('href');
    if (jaTem) {
      stats.jaTinhaHref = true;
      aceita(link.href || jaTem, 'href');
      if (capturado) return terminar();
    }

    // ⚠️ UM try POR CAMADA, de propósito. As quatro são independentes justamente porque
    // não se sabe qual delas o ML usa; encadeá-las num try só faria a falha de uma
    // desligar as seguintes — e a camada 3 (listener + preventDefault), que é a rede de
    // segurança contra abrir aba de verdade, seria desativada exatamente no caso em que
    // mais importa.
    try {
      openOriginal = window.open;
      window.open = function (url) {
        stats.opens += 1;
        aceita(url, 'window.open');
        var loc = { _h: String(url == null ? '' : url) };
        try {
          Object.defineProperty(loc, 'href', {
            configurable: true,
            get: function () { return loc._h; },
            set: function (v) { loc._h = String(v); aceita(v, 'popup.location'); },
          });
        } catch (e) { /* ambiente sem defineProperty utilizável: as demais camadas cobrem */ }
        loc.assign = function (v) { loc._h = String(v); aceita(v, 'popup.assign'); };
        loc.replace = function (v) { loc._h = String(v); aceita(v, 'popup.replace'); };
        return {
          closed: false,
          location: loc,
          opener: null,
          focus: function () {},
          blur: function () {},
          close: function () { this.closed = true; },
          postMessage: function () {},
          document: { write: function () {}, close: function () {} },
        };
      };
    } catch (e) {
      stats.erroHookOpen = String((e && e.message) || e);
    }

    try {
      anchorClickOriginal = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        stats.anchorClicks += 1;
        try { aceita(this.href || this.getAttribute('href'), 'anchor.click'); } catch (e) { /* nó exótico */ }
        // Com a URL em mãos, repassar o clique só serviria para abrir a aba que esta
        // sonda existe para evitar.
        if (capturado) return undefined;
        return anchorClickOriginal.apply(this, arguments);
      };
    } catch (e) {
      // Protótipo protegido pela página: as outras três camadas seguem valendo.
      anchorClickOriginal = null;
      stats.erroHookAnchor = String((e && e.message) || e);
    }

    try {
      listener = function (ev) {
        try {
          // Escopado ao card alvo: um clique do usuário em outro ponto da página não pode
          // ser cancelado por causa da sonda.
          if (!ev || !ev.target || !card.contains(ev.target)) return;
          var a = ev.target.closest ? ev.target.closest('a') : null;
          if (a) {
            var h = a.getAttribute('href');
            if (h) aceita(a.href || h, 'href-no-clique');
          }
          ev.preventDefault();
        } catch (e) { /* alvo sem closest: as demais camadas cobrem */ }
      };
      // Bolha, não captura: o React anexa o handler no container raiz, e ler o href antes
      // dele devolveria o `<a>` ainda vazio.
      window.addEventListener('click', listener, false);
    } catch (e) {
      listener = null;
      stats.erroHookListener = String((e && e.message) || e);
    }

    // Rede de segurança: mesmo que o poll abaixo morra, a página volta ao normal.
    try { guarda = setTimeout(terminar, (waitMs || 4000) + 3000); } catch (e) { /* idem */ }

    // pointerdown/mousedown/mouseup antes do click: `el.click()` dispara só o `click`, e
    // um handler pendurado no mousedown (padrão em componentes que pré-carregam destino)
    // nunca rodaria.
    var tipos = ['pointerdown', 'mousedown', 'mouseup', 'click'];
    for (var t = 0; t < tipos.length; t++) {
      try {
        var ev;
        try {
          ev = new MouseEvent(tipos[t], { bubbles: true, cancelable: true, view: window, button: 0 });
        } catch (e1) {
          ev = document.createEvent('MouseEvents');
          ev.initEvent(tipos[t], true, true);
        }
        link.dispatchEvent(ev);
      } catch (e2) {
        stats.erroClique = String((e2 && e2.message) || e2);
      }
    }

    var inicio = Date.now();
    (function poll() {
      if (capturado) return terminar();
      try {
        // `isConnected === false` = o React trocou o nó; o href novo está no card novo.
        if (!link || link.isConnected === false) localizar();
        var h = link && link.getAttribute('href');
        if (h) aceita(link.href || h, 'href-pos-clique');
      } catch (e) { /* card ainda sendo repintado: o próximo poll relê */ }
      if (capturado) return terminar();
      if (Date.now() - inicio > (waitMs || 4000)) return terminar();
      setTimeout(poll, 120);
    })();
  });
}

/**
 * Roda a sonda de clique, um cupom por vez, com as abas sob vigilância.
 *
 * UM POR VEZ, e não todos numa injeção só, por um motivo de correção: a associação
 * URL↔cupom precisa ser inequívoca. Se uma aba escapar de todas as camadas da sonda, o
 * service worker vê a URL nova mas não saberia de qual card ela veio — e atribuir a lista
 * errada a um cupom anuncia desconto que o checkout recusa. Clicando um por vez, a aba
 * que nascer no intervalo só pode ser daquele código.
 *
 * As duas vigias existem para o caso de o ML mudar de caminho:
 *  - `tabs.onCreated` colhe (e fecha) a aba que escapou. Se ela nascer em `about:blank` e
 *    só depois navegar, `tabs.onUpdated` a acompanha até a URL final antes de fechar.
 *  - a aba de CUPONS navegando sozinha significa que o clique virou navegação na própria
 *    página: a URL é colhida, a página de cupons é restaurada e a sonda PARA — insistir
 *    recarregaria a página a cada clique e os cupons restantes sairiam sem nada.
 *
 * Nunca lança: sem URL o fluxo segue pelo caminho manual ("Vincular esta aba").
 */
async function clickProbeMlCouponUrls(tabId, codes, budgetMs) {
  const found = {};
  const stats = {
    tentados: 0,
    naoTentados: 0,
    vias: {},
    abasFechadas: 0,
    navegouSozinha: false,
    semUrl: [],
  };
  if (!codes || codes.length === 0) return { found, stats };

  let urlDeAbaFilha = null;
  let abortar = false;
  // Código sendo clicado AGORA, ou null. Captura vinda de fora da página (aba que
  // escapou) só é aceita enquanto esta janela está aberta; fora dela a aba é apenas
  // fechada e contada.
  //
  // ⚠️ A janela + a QUARENTENA abaixo são a trava contra o pior defeito deste fluxo: o
  // clique do cupom A não produz nada, a sonda passa para B, e a aba que o clique de A
  // abriu com atraso nasce durante a vez de B. A listagem de A viraria a lista de B, e a
  // mensagem anunciaria um desconto que aqueles produtos não têm. Perder uma captura
  // atrasada custa uma sincronização; atribuí-la ao cupom errado custa a feature.
  let janela = null;
  // Enquanto true, uma aba nascida desta aba é obra da sonda e pode ser fechada. Cobre a
  // janela MAIS a quarentena; passado isso, aba nova é do usuário e não se mexe nela —
  // fechar aba alheia é estrago, e uma aba órfã é só um incômodo.
  let zonaDeAbas = false;
  // tabId → { dono, timer }. O DONO é o código que estava sendo clicado quando a aba
  // nasceu; sem ele a captura ficaria amarrada a "alguma janela está aberta agora", e a
  // aba de A que só resolve a navegação durante a vez de B entraria como lista de B.
  const filhas = new Map();

  const fecharFilha = (id) => {
    const filha = filhas.get(id);
    if (filha && filha.timer) clearTimeout(filha.timer);
    filhas.delete(id);
    stats.abasFechadas += 1;
    // Falha aqui é quase sempre "a aba já não existe", mas engolir sem contar esconderia
    // o caso em que a extensão deixa abas abertas na cara do usuário e ninguém fica
    // sabendo — a regra da skill de verificação existe por causa disso.
    chrome.tabs.remove(id).catch((e) => {
      stats.errosDeAba = (stats.errosDeAba || 0) + 1;
      stats.ultimoErroDeAba = (e && e.message) || String(e);
    });
  };

  // `dono` é o código que abriu aquela aba. A URL só é aceita se ele ainda for o código
  // em clique — é a amarração por CONSTRUÇÃO, não por probabilidade: uma aba de A que
  // resolve tarde, já durante a vez de B, é descartada em vez de virar a lista de B.
  const colher = (u, dono) => {
    if (!janela || !dono || dono !== janela) {
      stats.foraDaJanela = (stats.foraDaJanela || 0) + 1;
      return;
    }
    urlDeAbaFilha = u;
  };

  const onCreated = (tab) => {
    if (!zonaDeAbas || !tab || tab.openerTabId !== tabId) return;
    const dono = janela;
    const u = tab.pendingUrl || tab.url || '';
    if (mlContainerKey(u)) {
      colher(u, dono);
      fecharFilha(tab.id);
      return;
    }
    // about:blank: a URL chega no onUpdated. Fechar agora perderia a captura.
    //
    // O prazo é um TIMER de verdade, e não um `Date.now()` conferido dentro do onUpdated:
    // uma aba que trava em about:blank não dispara mais evento nenhum, então a conferência
    // reativa nunca rodaria e a aba ficaria aberta na cara do usuário até o fim do lote.
    filhas.set(tab.id, {
      dono,
      timer: setTimeout(() => {
        if (filhas.has(tab.id)) fecharFilha(tab.id);
      }, ML_COUPON_ORPHAN_TAB_MS),
    });
  };

  const onUpdated = (id, info) => {
    const u = (info && info.url) || '';
    if (filhas.has(id)) {
      if (mlContainerKey(u)) {
        colher(u, filhas.get(id).dono);
        fecharFilha(id);
      }
      return;
    }
    if (id === tabId && mlContainerKey(u)) {
      // A própria aba navegou: quem causou isso foi o clique em curso.
      colher(u, janela);
      // A página de cupons foi embora: seguir clicando recarregaria a aba a cada vez.
      stats.navegouSozinha = true;
      abortar = true;
      chrome.tabs.update(tabId, { url: ML_COUPONS_URL }).catch((e) => {
        stats.errosDeAba = (stats.errosDeAba || 0) + 1;
        stats.ultimoErroDeAba = (e && e.message) || String(e);
      });
    }
  };

  chrome.tabs.onCreated.addListener(onCreated);
  chrome.tabs.onUpdated.addListener(onUpdated);

  const limite = Date.now() + (budgetMs || 45000);
  try {
    for (const code of codes) {
      // O orçamento não é enfeite: 10 cupons × 4 s de espera somam ao tempo já gasto com
      // os modais, e o `sendMessage` do sync tem teto. Quem sobra fica registrado —
      // desistir em silêncio faria o dump dizer "tentou tudo" tendo tentado metade.
      if (abortar || Date.now() > limite) {
        stats.naoTentados += 1;
        continue;
      }
      stats.tentados += 1;
      urlDeAbaFilha = null;
      janela = code;
      zonaDeAbas = true;
      let url = null;
      let via = null;
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: mlCouponClickProbe,
          args: [code, 4000],
        });
        url = (res && res.result && res.result.url) || null;
        via = (res && res.result && res.result.via) || null;
        // O que o clique produziu e foi recusado (ver `aceita`): é a pista de "o ML mudou
        // o formato da URL", que de outro modo chega como um silencioso "0 recuperadas".
        const recusadas = (res && res.result && res.result.stats && res.result.stats.recusadas) || [];
        if (recusadas.length > 0) {
          stats.recusadas = stats.recusadas || [];
          if (stats.recusadas.length < 5) stats.recusadas.push(code + ' → ' + recusadas[0]);
        }
      } catch (e) {
        stats.erro = (e && e.message) || String(e);
      }
      // Folga curta quando nada foi capturado: a aba que escapou pode nascer logo DEPOIS
      // de a injeção retornar, e desistir antes dela deixaria o cupom sem link tendo a
      // URL a caminho.
      if (!url && !urlDeAbaFilha) await new Promise((r) => setTimeout(r, 400));
      janela = null;
      if (!url && urlDeAbaFilha) {
        url = urlDeAbaFilha;
        via = 'aba-filha';
      }
      if (url && mlContainerKey(url)) {
        found[code] = url;
        stats.vias[via || 'desconhecida'] = (stats.vias[via || 'desconhecida'] || 0) + 1;
      } else {
        stats.semUrl.push(code);
        // Quarentena: este clique não devolveu nada, então uma aba dele pode ainda estar
        // a caminho. Clicar no próximo cupom agora faria essa aba nascer dentro da janela
        // do cupom ERRADO — ver a nota da `janela`. Só custa tempo em quem já falhou.
        if (!abortar) await new Promise((r) => setTimeout(r, 700));
      }
      zonaDeAbas = false;
    }
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    for (const id of Array.from(filhas.keys())) fecharFilha(id);
  }

  stats.semUrl = stats.semUrl.slice(0, 20);
  return { found, stats };
}

/** Mensagem para o scraper de cupons com timeout próprio. Rejeita, nunca pendura. */
function sendMlCouponMessage(tabId, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timeout na leitura dos cupons (' + message.action + ')')),
      timeoutMs,
    );
    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(response);
    });
  });
}

/**
 * Preenche `productsUrl` dos cupons de UMA página, na ordem do mais barato para o mais
 * caro: href já no DOM → props/fiber do React (`mlCouponUrlProbe`) → clique de verdade
 * (`mlCouponClickProbe`).
 *
 * Roda por PÁGINA, e não no fim da varredura, porque as duas sondas procuram o card no
 * DOM: depois de paginar, os cards das páginas anteriores não existem mais.
 */
async function resolveCouponUrls(tabId, cupons, debug, inicioSync) {
  const semUrl = (cupons || []).filter((c) => c && !c.productsUrl);
  if (semUrl.length === 0) return;

  const probe = await probeMlCouponUrls(tabId, semUrl.map((c) => c.code));
  let recuperadas = 0;
  for (const c of semUrl) {
    const url = probe.found ? probe.found[c.code] : null;
    // A chave do container é a amarração produto↔cupom. URL que não a produz é
    // palpite — e palpite aqui vira desconto anunciado que o checkout recusa.
    if (url && mlContainerKey(url)) {
      c.productsUrl = url;
      recuperadas += 1;
    }
  }
  if (debug) {
    debug.mainWorldProbe = {
      tentados: semUrl.length,
      recuperadas,
      stats: probe.stats || null,
      // Uma amostra do que a sonda achou mas foi RECUSADO pela chave de container:
      // sem isso, "recuperadas: 0" não distingue "não achou" de "achou lixo".
      recusadas: Object.keys(probe.found || {})
        .filter((code) => !mlContainerKey(probe.found[code]))
        .slice(0, 5)
        .map((code) => code + ': ' + String(probe.found[code]).slice(0, 120)),
    };
  }
  if (recuperadas > 0 && typeof addLog === 'function') {
    addLog(`Cupons ML: ${recuperadas} URL(s) recuperadas fora do DOM`);
  }

  // Última etapa, e a única que funciona quando a URL não existe em lugar nenhum antes
  // do clique — o caso confirmado do ML (ver mlCouponClickProbe). Roda só sobre o que
  // sobrou: se o href estava lá ou o fiber entregou, ninguém clica.
  const aindaSemUrl = semUrl.filter((c) => !c.productsUrl);
  if (aindaSemUrl.length === 0) return;

  // O que ainda cabe antes de o web app desistir, guardada a folga da gravação.
  const sobra = ORCAMENTO_TOTAL_MS - (Date.now() - inicioSync);
  if (sobra < CLICK_PROBE_MIN_MS) {
    // Pular em silêncio faria o dump dizer "0 recuperadas pelo clique" como se a sonda
    // tivesse rodado e falhado — dois defeitos com correções opostas.
    if (debug) {
      debug.clickProbe = {
        tentados: 0,
        recuperadas: 0,
        stats: { pulada: 'sem tempo no orçamento do sync', sobraMs: Math.max(0, sobra) },
      };
    }
    return;
  }

  const clique = await clickProbeMlCouponUrls(
    tabId,
    aindaSemUrl.map((c) => c.code),
    Math.min(CLICK_PROBE_MAX_MS, sobra),
  );
  let porClique = 0;
  for (const c of aindaSemUrl) {
    const url = clique.found ? clique.found[c.code] : null;
    if (url && mlContainerKey(url)) {
      c.productsUrl = url;
      porClique += 1;
    }
  }
  if (debug) {
    debug.clickProbe = {
      tentados: aindaSemUrl.length,
      recuperadas: porClique,
      stats: clique.stats || null,
    };
  }
  if (porClique > 0 && typeof addLog === 'function') {
    addLog(`Cupons ML: ${porClique} link(s) "Ver produtos" gerados pelo clique`);
  }
}

/**
 * Funde o diagnóstico de uma página no acumulado da sincronização.
 *
 * A base é a PRIMEIRA página que produziu dump — inclusive o `htmlSample`, que sozinho
 * já ocupa 60 KB: guardar um por página faria o dump crescer sem trazer informação nova
 * (o layout do card é o mesmo em todas). O que interessa por página vira uma linha em
 * `paginas`, e os totais somam.
 */
function mergeCouponDebug(acumulado, novo, pagina) {
  if (!novo) return acumulado;
  const resumo = {
    pagina,
    cardsFound: novo.cardsFound || 0,
    couponsFound: novo.couponsFound || 0,
    couponsWithoutUrl: novo.couponsWithoutUrl || 0,
    couponsWithoutConditions: novo.couponsWithoutConditions || 0,
    staleCards: novo.staleCards || 0,
    foundInactive: novo.foundInactive === true,
    allInactive: novo.allInactive === true,
    hasNext: novo.hasNext === true,
    mainWorldProbe: novo.mainWorldProbe || null,
    clickProbe: novo.clickProbe || null,
    skipped: (novo.skipped || []).slice(0, 20),
    modalWarnings: (novo.modalWarnings || []).slice(0, 10),
  };
  if (!acumulado) {
    novo.paginas = [resumo];
    return novo;
  }
  acumulado.paginas = (acumulado.paginas || []).concat([resumo]);
  for (const campo of [
    'cardsFound', 'couponsWithoutConditions', 'staleCards', 'urlsRecoveredOnSecondPass',
  ]) {
    acumulado[campo] = (acumulado[campo] || 0) + (novo[campo] || 0);
  }
  acumulado.skipped = (acumulado.skipped || []).concat(novo.skipped || []).slice(0, 60);
  acumulado.modalWarnings = (acumulado.modalWarnings || [])
    .concat(novo.modalWarnings || [])
    .slice(0, 30);
  // A amostra do modal na desistência vem da página em que o cupom falhou — sem
  // acumular, só as falhas da primeira página com dump chegariam ao servidor.
  acumulado.modalFailSamples = (acumulado.modalFailSamples || [])
    .concat(novo.modalFailSamples || [])
    .slice(0, 6);
  // O último estado do modal é o que vale: `modalGaveUp` numa página tardia diz mais do
  // que o `false` da primeira.
  acumulado.modalGaveUp = novo.modalGaveUp === true || acumulado.modalGaveUp === true;
  return acumulado;
}

/**
 * Percorre o grid "Códigos gerados" PÁGINA A PÁGINA.
 *
 * A ordem — ler a página, resolver as URLs dela, só então paginar — não é arbitrária: o
 * link "Ver produtos" só existe depois que a sonda CLICA no card, e o card só existe no
 * DOM enquanto sua página está montada. Lendo o grid inteiro primeiro, a sonda chegaria
 * com as páginas anteriores desmontadas e só a última teria link.
 *
 * PARA QUANDO A PÁGINA INTEIRA É DE CUPONS INATIVOS. A regra antiga — parar no PRIMEIRO
 * inativo, apostando que o ML empurra todos os vencidos para o fim — deixou cupom válido
 * de fora: o grid intercala válidos e inativos. Agora um inativo no meio é só pulado; a
 * varredura encerra na página em que TODOS os cards estão inativos (`allInactive`),
 * lida como o começo da cauda morta do grid. Cruzar uma página dessas é barato (inativo
 * não abre modal), então o corte economiza pouco — é uma regra de intenção, não de
 * custo: se a cauda morta tiver uma página válida perdida no meio, ela fica de fora,
 * e o `pararPor` no diagnóstico é o que conta essa história.
 *
 * Recebe as operações por parâmetro (`lerPagina`, `paginar`, `resolverUrls`, `restanteMs`)
 * porque é a única parte deste fluxo que dá para exercitar sem Chrome — e é a que decide
 * quantos cupons o usuário vê. Ver tests/mlCouponPaginacao.test.ts.
 */
async function varrerPaginasDeCupons(deps) {
  const lidos = [];
  let debug = null;
  let paginas = 0;
  // null = "o laço saiu pelo teto de páginas": TODA saída por break grava seu motivo.
  // O valor fixo antigo ('fim') fazia o pós-laço reescrever o motivo real quando o
  // break acontecia justamente na página do teto — e o rótulo é o que orienta a
  // investigação neste subsistema.
  let pararPor = null;
  let sourceUrl = deps.sourceUrlPadrao || null;

  while (paginas < ML_COUPON_MAX_PAGINAS) {
    paginas += 1;
    let extraction = null;
    try {
      extraction = await deps.lerPagina(paginas === 1);
    } catch (e) {
      // Timeout ou aba morta. Na primeira página é falha do sync; nas seguintes, deixar
      // a exceção subir jogaria fora TODOS os cupons já lidos — 30 viram zero porque a
      // página 4 demorou.
      if (paginas === 1) throw e;
      pararPor = 'página ' + paginas + ': ' + ((e && e.message) || String(e));
      paginas -= 1;
      break;
    }

    if (!extraction || !extraction.success) {
      if (paginas === 1) {
        throw new Error((extraction && extraction.error) || 'Leitura dos cupons falhou');
      }
      pararPor = 'erro na página ' + paginas + ': ' + ((extraction && extraction.error) || '?');
      paginas -= 1;
      break;
    }

    const daPagina = extraction.data || [];
    if (extraction.sourceUrl) sourceUrl = extraction.sourceUrl;
    await deps.resolverUrls(daPagina, extraction.debug);
    lidos.push(...daPagina);
    debug = mergeCouponDebug(debug, extraction.debug, paginas);

    if (extraction.allInactive) { pararPor = 'página só com cupons inativos'; break; }
    if (!extraction.hasNext) { pararPor = 'fim'; break; }

    // Reserva o que a gravação e o caminho de volta ainda precisam dentro dos 240 s que
    // o web app espera antes de dizer "Tempo esgotado".
    if (deps.restanteMs() < ML_COUPON_PAGE_RESERVE_MS) {
      pararPor = 'orçamento de tempo do sync';
      break;
    }

    let nav = null;
    try {
      nav = await deps.paginar();
    } catch (e) {
      // Mesma regra da leitura: não paginar é parar, não é perder o que já foi lido.
      pararPor = 'paginação: ' + ((e && e.message) || String(e));
      break;
    }
    if (!nav || !nav.ok) {
      pararPor = 'paginação: ' + ((nav && nav.reason) || 'sem resposta');
      break;
    }
  }
  if (pararPor === null) pararPor = 'limite de ' + ML_COUPON_MAX_PAGINAS + ' páginas';

  return { lidos, debug, paginas, pararPor, sourceUrl };
}

/**
 * Sincroniza os cupons gerados. Abre (ou foca) a aba de cupons, injeta o scraper
 * e devolve os cards lidos ao sidepanel.
 */
let mlCouponSyncInFlight = null;

async function syncMlCoupons() {
  // Trava própria — a do fluxo Shopee (couponImportInFlight) é global e devolveria
  // o resultado do marketplace errado se as duas fossem a mesma.
  if (mlCouponSyncInFlight) return mlCouponSyncInFlight;

  mlCouponSyncInFlight = (async () => {
    // O relógio do sync inteiro. O web app desiste em 240 s (client/src/pages/cupons.tsx)
    // e mostra "Tempo esgotado" — com os cupons sendo gravados normalmente atrás. Como as
    // etapas são em série (load da aba até 45 s + leitura dos modais até 180 s + sondas),
    // a sonda de clique só pode gastar o que sobrar. Ver ORCAMENTO_TOTAL_MS.
    const inicioSync = Date.now();
    try {
      const existing = await chrome.tabs.query({ url: 'https://*.mercadolivre.com.br/afiliados/coupons*' });
      let tabId;
      if (existing && existing.length > 0) {
        tabId = existing[0].id;
        await chrome.tabs.update(tabId, { active: true });
        // waitForTabLoad espera uma TRANSIÇÃO para 'complete'; numa aba já carregada
        // essa transição nunca chega e a promessa só cairia no timeout.
        const tab = await chrome.tabs.get(tabId);
        if (tab.status !== 'complete') await waitForTabLoad(tabId, 45000);
      } else {
        const tab = await chrome.tabs.create({ url: ML_COUPONS_URL, active: true });
        tabId = tab.id;
        await waitForTabLoad(tabId, 45000);
      }

      // Margem para o React montar o grid antes de procurar a aba "Códigos gerados".
      await new Promise((r) => setTimeout(r, 1500));

      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: [ML_COUPON_SCRAPER] });
      } catch (e) {
        throw new Error('Falha ao injetar o leitor de cupons do ML: ' + (e && e.message ? e.message : e));
      }
      await new Promise((r) => setTimeout(r, 300));

      const varredura = await varrerPaginasDeCupons({
        lerPagina: (first) =>
          sendMlCouponMessage(
            tabId,
            { action: 'extractMlCouponsPage', first },
            // 180 s POR PÁGINA: a leitura abre o modal de condições de CADA cupom em
            // série, e o fail-fast do scraper desiste depois de 3 modais travados. Quem
            // limita o total é ORCAMENTO_TOTAL_MS, conferido a cada volta.
            180000,
          ),
        paginar: () => sendMlCouponMessage(tabId, { action: 'mlCouponNextPage' }, 30000),
        resolverUrls: (cupons, debugDaPagina) =>
          resolveCouponUrls(tabId, cupons, debugDaPagina, inicioSync),
        restanteMs: () => ORCAMENTO_TOTAL_MS - (Date.now() - inicioSync),
        sourceUrlPadrao: ML_COUPONS_URL,
      });

      const lidos = varredura.lidos;
      const debug = varredura.debug;
      const paginas = varredura.paginas;
      const pararPor = varredura.pararPor;

      const extraction = {
        data: lidos,
        count: lidos.length,
        sourceUrl: varredura.sourceUrl,
        couponsWithoutUrl: lidos.filter((c) => !c.productsUrl).length,
        debug,
      };
      if (debug) {
        debug.paginasLidas = paginas;
        debug.pararPor = pararPor;
        debug.couponsFound = lidos.length;
        debug.couponsWithoutUrl = extraction.couponsWithoutUrl;
      }
      if (typeof addLog === 'function') {
        addLog(`Cupons ML: ${paginas} página(s) lidas (parou por: ${pararPor})`);
      }

      if (extraction.debug) {
        // Mesma rede de segurança do fluxo Shopee: sem uma amostra do DOM, recalibrar
        // os seletores vira adivinhação.
        //
        // A condição NÃO é mais `count === 0`: quem decide é o scraper, que também
        // manda o dump em sucesso parcial (cupom lido porém sem URL, cards descartados).
        // Com a guarda antiga, um único cupom válido escondia o defeito dos outros nove.
        try {
          await api.saveCouponsDebug('ml', extraction.debug);
        } catch (e) {
          console.warn('[AchadinhoPRO:MLCupons] Falha ao enviar diagnóstico:', e.message);
        }
      }

      // Sincronizar agora GRAVA. Antes o resultado morria na memória do painel: o web
      // app não sabia dos cupons e, principalmente, ninguém parseava as condições do
      // modal — o parse mora no servidor (a extensão é JS puro, sem build) e o servidor
      // nunca via o `rawText`. Por isso o mínimo, o teto e a validade apareciam vazios.
      let coupons = lidos;
      let syncWarnings = [];
      if (lidos.length > 0) {
        try {
          const saved = await api.syncMlCoupons(
            lidos.map((c) => ({
              code: c.code,
              couponCategory: c.couponCategory,
              discountType: c.discountType,
              discountValue: c.discountValue,
              rawText: c.rawText,
              productsUrl: c.productsUrl,
              budgetRemainingCents: c.budgetRemainingCents,
              sourceUrl: extraction.sourceUrl || null,
            })),
          );
          syncWarnings = saved?.warnings || [];
          // Funde o que o servidor derivou com o que veio do card. O card é a fonte de
          // discountRaw/expirationRaw (rótulos de exibição); o servidor é a fonte de
          // mínimo, teto e validade real.
          const porCodigo = {};
          for (const s of saved?.coupons || []) porCodigo[s.code] = s;
          coupons = lidos.map((c) => Object.assign({}, c, porCodigo[c.code] || {}));
        } catch (e) {
          // Falha ao gravar não pode zerar a leitura: o usuário ainda consegue montar a
          // lista, que persiste o cupom pelo caminho antigo.
          console.warn('[AchadinhoPRO:MLCupons] Falha ao gravar os cupons:', e.message);
          syncWarnings = ['Os cupons foram lidos, mas não puderam ser salvos: ' + e.message];
        }
      }

      if (typeof addLog === 'function') {
        addLog(`Cupons ML: ${extraction.count} códigos gerados lidos`);
      }

      // Guarda o resultado para o PAINEL exibir sem sincronizar de novo.
      //
      // A sincronização passou a ter um lugar só — a página Cupons do web app. Sem este
      // cache, a aba Cupons da extensão ficaria vazia, e com ela sumiria o caminho
      // manual "Vincular esta aba", que é a saída quando o ML não expõe o link de um
      // cupom. `storage.local` (e não `session`) porque o painel é remontado o tempo
      // todo e o service worker MV3 morre em ~30 s ocioso.
      try {
        await chrome.storage.local.set({
          [ML_COUPONS_CACHE_KEY]: { coupons, at: Date.now() },
        });
      } catch (e) {
        console.warn('[AchadinhoPRO:MLCupons] Falha ao guardar os cupons do painel:', e.message);
      }

      return { coupons, count: extraction.count, tabId, warnings: syncWarnings };
    } finally {
      mlCouponSyncInFlight = null;
    }
  })();

  return mlCouponSyncInFlight;
}

/**
 * Abre a página "Ver produtos" de um cupom e registra o vínculo aba → cupom.
 *
 * O registro é a ÚNICA fonte dessa ligação: a URL de destino
 * (`_Container_<slug>-seller-<id>`) não carrega o código do cupom em lugar nenhum.
 */
async function openMlCouponProducts(coupon) {
  if (!coupon || !coupon.productsUrl) throw new Error('Cupom sem link "Ver produtos"');

  // A chave é a garantia de que os produtos acumulados pertencem a ESTE cupom.
  // `containerState` trata contexto sem chave como "qualquer listagem serve", então
  // seguir com null aqui deixaria produtos de outro cupom entrarem na lista. A recusa
  // importa mais desde que a chamada também vem do web app, onde a URL é a do BANCO e
  // pode ter sido gravada por uma versão antiga do scraper.
  const containerKey = mlContainerKey(coupon.productsUrl);
  if (!containerKey) {
    throw new Error('O link deste cupom não aponta para uma listagem de produtos do Mercado Livre');
  }

  // O cupom que vem do WEB APP sai do banco, onde `expirationRaw` e `discountRaw` — os
  // rótulos crus do card do ML — nunca foram persistidos. Sem reconstruí-los, o painel
  // abriria com o banner pelado e o nome da lista sem data (`suggestListName` só entende
  // "18 de agosto"). Reconstrói só o que falta: o payload da extensão continua mandando
  // o rótulo original, que é a fonte melhor.
  const enriquecido = Object.assign({}, coupon);
  if (!enriquecido.expirationRaw) {
    enriquecido.expirationRaw =
      globalThis.MlCouponTabLink.expirationRawFromDate(coupon.validUntil) || null;
  }
  if (!enriquecido.discountRaw) {
    enriquecido.discountRaw =
      globalThis.MlCouponTabLink.discountRawFromValues(coupon.discountType, coupon.discountValue) ||
      null;
  }

  const tab = await chrome.tabs.create({ url: coupon.productsUrl, active: true });
  const map = await readMlCouponTabs();
  map[String(tab.id)] = {
    coupon: enriquecido,
    containerKey,
    openedAt: Date.now(),
  };
  await writeMlCouponTabs(map);

  // Sem `await`: quem chamou está dentro do gesto do usuário e precisa responder já.
  // A preparação da aba segue em paralelo — ver primeMlCouponTab.
  primeMlCouponTab(tab.id, containerKey);

  return { tabId: tab.id, containerKey };
}

// Duas etapas de hidratação da listagem do ML, com folga entre elas. A primeira
// tentativa não é imediata de propósito: o `complete` do documento chega antes de o
// grid existir, e extrair ali devolve zero produto — que é indistinguível de "esta
// listagem está vazia".
const ML_COUPON_PRIME_DELAYS = [1500, 3000, 5000];

/**
 * Extrai a listagem de UMA aba de cupom, conferindo o container ANTES e DEPOIS.
 *
 * Existe porque `extractOffer` (handleManualExtract) resolve o alvo por
 * `tabs.query({ active: true, currentWindow: true })` — e "aba ativa" é a resposta errada
 * para este fluxo, por dois motivos independentes:
 *
 *   1. no service worker, `currentWindow` é a ÚLTIMA JANELA FOCADA, não a janela do
 *      painel: focar outra janela do Chrome com uma busca do ML aberta faria os produtos
 *      DELA entrarem na varredura do cupom;
 *   2. quem chama espera entre as tentativas (a listagem hidrata em duas etapas), e nesse
 *      intervalo o usuário navega — inclusive dentro da MESMA aba, clicando num filtro ou
 *      no breadcrumb, o que não remonta o painel e não dispara nada.
 *
 * A conferência DEPOIS não é preciosismo: a extração leva centenas de milissegundos, e
 * sem ela a URL usada como prova seria a de antes da navegação. Paginação e filtros
 * dentro da mesma listagem preservam a chave (slug|sellerId), então o caso legítimo passa
 * — só listagem de OUTRO container é recusada.
 */
async function extractFromCouponTab(tabId, containerKey) {
  if (tabId == null) return { products: [], url: null, mismatch: true };

  const antes = await chrome.tabs.get(tabId).catch(() => null);
  const chaveAntes = antes ? mlContainerKey(antes.url) : null;
  if (!chaveAntes || (containerKey && chaveAntes !== containerKey)) {
    return { products: [], url: antes ? antes.url : null, mismatch: true };
  }

  const injected = await ensureContentScriptInjected(tabId);
  if (!injected) return { products: [], url: antes.url, mismatch: false };

  const response = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'extractOffer' }, (r) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(r);
    });
  });
  const products = response && response.success && Array.isArray(response.data) ? response.data : [];

  const depois = await chrome.tabs.get(tabId).catch(() => null);
  const chaveDepois = depois ? mlContainerKey(depois.url) : null;
  if (!chaveDepois || (containerKey && chaveDepois !== containerKey)) {
    return { products: [], url: depois ? depois.url : null, mismatch: true };
  }
  return { products, url: depois.url, mismatch: false };
}

/**
 * Extração DIRIGIDA pelo service worker na aba de produtos que acabou de abrir.
 *
 * O DEFEITO QUE ISTO CONSERTA (2º E2E, 26/jul/2026): abrir os produtos pelo web app
 * deixava o painel vazio, e os produtos só entravam quando o usuário trocava de aba e
 * VOLTAVA. A causa é uma corrida que o painel não tinha como vencer:
 *
 *   1. `sidePanel.open()` roda síncrono (exigência do gesto), com a aba ativa ainda
 *      sendo a do web app;
 *   2. `tabs.create` cria a aba do cupom — nesse instante `tab.url` ainda está vazia (o
 *      destino vive em `pendingUrl`), então o bloco de recuperação do painel avalia
 *      `containerState('')` como `'suspended'`, desiste e NÃO pede extração;
 *   3. o único evento que carrega produtos (`offerExtracted`) é disparo único do content
 *      script ~1 s após o load: se o painel ainda não montou — ou se a listagem não
 *      hidratou e a extração devolve vazio — ele se perde, e nada reextrai.
 *
 * Voltar para a aba "funcionava" porque o painel é TAB-SPECIFIC (`sidePanel.setOptions`
 * por tabId a cada `complete`): o documento remontava do zero e refazia a recuperação,
 * agora com a URL commitada. O contorno tinha um preço escondido — o acumulador vive na
 * memória do painel, então cada ida e volta zerava o que já havia sido lido.
 *
 * Aqui o service worker para de depender de quem está montado: espera a aba carregar,
 * extrai com retry e GUARDA o resultado no próprio vínculo, além de anunciá-lo. O painel
 * consome quando nascer (ver o boot em ui/sidepanel.js).
 *
 * A cada tentativa a URL é reconferida contra a `containerKey`: se o usuário já saiu da
 * listagem, a extração é abandonada — produto de fora não entra na lista do cupom.
 */
async function primeMlCouponTab(tabId, containerKey) {
  try {
    const inicial = await chrome.tabs.get(tabId).catch(() => null);
    if (!inicial) return;
    // waitForTabLoad espera a TRANSIÇÃO para 'complete'; se a aba já chegou lá, esperar
    // só cairia no timeout.
    if (inicial.status !== 'complete') await waitForTabLoad(tabId, 45000);

    // RECONCILIAÇÃO DA CHAVE. O destino do "Ver produtos" é o que o ML resolveu no
    // clique; ao carregar, ele pode responder com outra forma da MESMA listagem
    // (redirect, normalização de rota, parâmetro reescrito). A chave gravada vem da URL
    // pedida, e uma divergência aqui congela o vínculo em 'suspended' para sempre: o
    // painel nunca entra em modo cupom e nenhuma página acumula produto.
    //
    // Só reconcilia enquanto a aba está intocada — nada acumulado ainda — e apenas para
    // uma chave VÁLIDA: esta é a navegação que a própria extensão iniciou para este
    // cupom, então o destino final dela é, por definição, a listagem dele. Depois disso
    // quem navega é o usuário, e aí a regra estrita volta a valer.
    const carregada = await chrome.tabs.get(tabId).catch(() => null);
    const chaveFinal = carregada && carregada.url ? mlContainerKey(carregada.url) : null;
    if (chaveFinal && chaveFinal !== containerKey) {
      const mapa = await readMlCouponTabs();
      const registro = mapa[String(tabId)];
      if (registro && registro.containerKey === containerKey && !registro.pendingProducts) {
        registro.containerKey = chaveFinal;
        // Fica no registro para o diagnóstico: sem isso, "a chave mudou" é invisível.
        registro.rechaveadoDe = containerKey;
        registro.rechaveadoUrl = String(carregada.url).slice(0, 300);
        await writeMlCouponTabs(mapa);
        containerKey = chaveFinal;
        console.log('[AchadinhoPRO:MLCupons] Chave do vínculo reconciliada:', registro.rechaveadoDe, '→', chaveFinal);
        chrome.runtime
          .sendMessage({ action: 'mlCouponContextChanged', tabId, containerKey: chaveFinal })
          .catch(() => {});
      }
    }

    for (let i = 0; i < ML_COUPON_PRIME_DELAYS.length; i++) {
      await new Promise((r) => setTimeout(r, ML_COUPON_PRIME_DELAYS[i]));

      const leitura = await extractFromCouponTab(tabId, containerKey);
      // Saiu da listagem (PDP, busca, outro cupom): abandona. Insistir aqui traria
      // produtos sem direito ao desconto para dentro da lista.
      if (leitura.mismatch) return;
      if (leitura.products.length === 0) continue;

      // O vínculo é relido agora: entre o create e este ponto o usuário pode ter fechado
      // a aba (onRemoved apaga a entrada) e recriar aqui ressuscitaria um vínculo morto.
      const map = await readMlCouponTabs();
      const entry = map[String(tabId)];
      if (!entry || entry.containerKey !== containerKey) return;
      entry.pendingProducts = leitura.products;
      entry.pendingUrl = leitura.url;
      await writeMlCouponTabs(map);

      // Para o painel que JÁ está vivo. O que não tem ouvinte cai no catch e fica
      // guardado acima — as duas vias existem porque nenhuma cobre os dois casos.
      chrome.runtime
        .sendMessage({ action: 'offerExtracted', data: leitura.products, url: leitura.url, sourceTabId: tabId })
        .catch(() => {});
      return;
    }
  } catch (e) {
    console.warn('[AchadinhoPRO:MLCupons] Extração dirigida falhou:', (e && e.message) || e);
  }
}

/**
 * Vincula um cupom à ABA ATIVA, quando ela já está na listagem de produtos dele.
 *
 * Caminho de recuperação para o cupom que o ML entrega sem `href` no "Ver produtos"
 * (26/jul/2026): sem URL, `openMlCouponProducts` não tem para onde navegar e o cupom
 * jamais viraria lista — apesar de o link funcionar quando o usuário clica nele na
 * própria página do ML. Aqui o usuário faz a navegação e a extensão só registra o
 * vínculo.
 *
 * A chave vem da URL REAL da aba, nunca de `coupon.productsUrl`. E `containerKey` nulo
 * é RECUSA, não vínculo frouxo: `containerState` trata contexto sem chave como
 * "qualquer listagem de container serve", então gravar null aqui faria os produtos de um
 * cupom entrarem na lista de outro aberto na mesma aba — e a mensagem anunciaria um
 * desconto que o checkout recusa.
 */
async function attachMlCouponToTab(coupon, tabId) {
  if (!coupon || !coupon.code) throw new Error('Cupom inválido');

  let tab;
  if (tabId) {
    tab = await chrome.tabs.get(tabId);
  } else {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active;
  }
  if (!tab || !tab.url) throw new Error('Nenhuma aba ativa para vincular');

  const containerKey = mlContainerKey(tab.url);
  if (!containerKey) {
    throw new Error(
      'Abra a listagem de produtos do cupom no Mercado Livre pelo botão "Ver produtos" do card e tente de novo — ' +
        'a página de busca ou a vitrine do vendedor não servem, porque nelas há produto sem direito ao cupom'
    );
  }

  const map = await readMlCouponTabs();
  map[String(tab.id)] = {
    // A URL descoberta agora vale como productsUrl do cupom: é exatamente a que o
    // "Ver produtos" abriria, e com ela o próximo sync já nasce vinculado.
    coupon: Object.assign({}, coupon, { productsUrl: coupon.productsUrl || tab.url }),
    containerKey,
    openedAt: Date.now(),
  };
  await writeMlCouponTabs(map);
  return { tabId: tab.id, containerKey, productsUrl: tab.url };
}

// Fechou a aba, morre o vínculo. Sem isto, um tabId reciclado pelo Chrome herdaria
// o cupom de uma aba anterior e salvaria produtos na lista errada.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const map = await readMlCouponTabs();
  if (map[String(tabId)]) {
    delete map[String(tabId)];
    await writeMlCouponTabs(map);
  }

  // A varredura persistida do painel segue a mesma sorte: `restoreScan` já confere o
  // código do cupom antes de reidratar, mas deixar o registro para trás só acumularia
  // lixo numa área de storage compartilhada.
  try {
    const stored = await chrome.storage.session.get('mlCouponScan');
    const scans = stored?.mlCouponScan || {};
    if (scans[String(tabId)]) {
      delete scans[String(tabId)];
      await chrome.storage.session.set({ mlCouponScan: scans });
    }
  } catch { /* storage indisponível: o registro caduca sozinho com a sessão */ }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[AchadinhoPRO] Mensagem recebida:', message.action);

  switch (message.action) {
    case 'autoLogin':
      api.autoLogin()
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'importCoupons':
      importCoupons(message.marketplace || 'shopee')
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    // ===== Cupons do Mercado Livre (Lista Cupons) =====
    case 'syncMlCoupons':
      syncMlCoupons()
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'openMlCouponProducts': {
      // ⚠️ ORDEM OBRIGATÓRIA: `sidePanel.open()` PRIMEIRO, de forma SÍNCRONA.
      //
      // O clique do usuário no web app viaja até aqui como "curried user gesture" —
      // caminho oficial (a doc lista "a user gesture on an extension page or content
      // script"). Mas a ativação vive só enquanto este listener roda de forma síncrona:
      // um único `await` antes do open() e ele rejeita com "may only be called in
      // response to a user gesture". Por isso não dá para abrir o painel lá dentro de
      // openMlCouponProducts, que começa com chrome.tabs.create + await.
      //
      // `windowId`, não `tabId`: a aba do cupom ainda nem existe neste instante. Painel
      // em escopo de janela continua aberto quando a aba nova vira a ativa.
      //
      // O `.catch` é encadeado na mesma expressão de propósito: rejeição não tratada
      // aqui derruba a extensão inteira, e essa falha ACONTECE — há bug conhecido do
      // Chrome em que o open() rejeita depois que o usuário fecha o painel na mão.
      // Quando isso ocorre a aba abre igual e o vínculo é gravado; só o painel fica
      // para o usuário abrir no ícone, e é isso que `panelOpened:false` comunica.
      let panelPromise = Promise.resolve(true);
      if (chrome.sidePanel && sender && sender.tab && sender.tab.windowId != null) {
        panelPromise = chrome.sidePanel
          .open({ windowId: sender.tab.windowId })
          .then(() => true)
          .catch((e) => {
            console.warn('[AchadinhoPRO:MLCupons] Painel não abriu pelo web app:', e && e.message);
            return false;
          });
      }

      openMlCouponProducts(message.coupon)
        .then(async (data) => {
          const panelOpened = await panelPromise;
          sendResponse({ success: true, data: { ...data, panelOpened } });
        })
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'attachMlCouponToTab':
      attachMlCouponToTab(message.coupon, message.tabId)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'extractCouponTabOffer':
      // O painel NUNCA extrai por "aba ativa" neste fluxo — ver extractFromCouponTab.
      extractFromCouponTab(message.tabId, message.containerKey)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'getMlCouponTabContext':
      // O sidepanel pergunta "esta aba é a de algum cupom?". Sem o vínculo, ele não
      // tem como saber: a URL da página de produtos não cita o cupom.
      getMlCouponTabContext(message.tabId)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'getMlCouponsCache':
      // Os cupons da última sincronização, para o painel LISTAR sem sincronizar. Quem
      // sincroniza é a página Cupons do web app — um lugar só.
      chrome.storage.local
        .get(ML_COUPONS_CACHE_KEY)
        .then((stored) => sendResponse({ success: true, data: stored?.[ML_COUPONS_CACHE_KEY] || null }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'createCouponList':
      api.createCouponList(message.name, message.coupon)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message, data: err.data || null }));
      return true;

    case 'reconcileCouponList':
      api.reconcileList(message.listId, message.eligibleItemIds, message.importId)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'login':
      api.login(message.email, message.password)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'logout':
      api.logout()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'checkMlLogin':
      checkMlLogin()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ loggedIn: false, error: err.message }));
      return true;

    case 'getKeywordSearches':
      api.getKeywordSearches()
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'startKeywordSearch':
      startKeywordSearch(message.keywordIds, message.platforms || ['ml'])
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'generateCategoryName':
      api.generateCategoryName(message.breadcrumb)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ name: null, error: err.message }));
      return true;

    case 'getAuthInfo':
      api.getAuthInfo()
        .then((info) => sendResponse(info))
        .catch((err) => sendResponse({ isLoggedIn: false, error: err.message }));
      return true;

    case 'getStatus':
      sendResponse(getStateSnapshot());
      return false;

    case 'startAutomation':
      startAutomation()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'stopAutomation':
      stopAutomation()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'resumeAutomation':
      resumeAutomation()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'extractOffer':
      handleManualExtract(sendResponse);
      return true;

    case 'generateShortLink':
      handleManualGenerateLink(message.url, sendResponse);
      return true;

    // Painel: exibe a tag em uso e permite forçar a releitura ("Atualizar").
    // A tag na tela é a única forma de o afiliado conferir, ANTES de salvar, que os
    // links vão sair na loja certa — antes ela só existia dentro da URL do amzn.to,
    // invisível até alguém resolver o redirect.
    case 'getAmazonTag':
      resolveAmazonTag({ forceRefresh: !!message.forceRefresh, somenteCache: !!message.somenteCache })
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'generateAmazonShortLink':
      generateAmazonAffiliateLink(message.url, { asin: message.asin, forceRefresh: message.forceRefresh })
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'saveProduct':
      handleManualSave(message.productData, sendResponse);
      return true;

    case 'saveShopeeProducts':
      handleSaveShopeeProducts(message.products, message.listId, sendResponse);
      return true;

    case 'saveAmazonProducts':
      handleSaveAmazonProducts(message.products, message.listId, sendResponse);
      return true;

    case 'saveProducts':
      handleBatchSave(message.products, sendResponse);
      return true;

    case 'getConfig':
      api.getConfig()
        .then((config) => sendResponse({ success: true, data: config }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'updateConfig':
      api.updateConfig(message.config)
        .then((config) => sendResponse({ success: true, data: config }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'setApiBaseUrl':
      api.setApiBaseUrl(message.url)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'getApiBaseUrl':
      api.getApiBaseUrl()
        .then((url) => sendResponse({ success: true, url }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'setApiEnvironment':
      api.setApiEnvironment(message.env)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'getApiEnvironment':
      api.getApiEnvironment()
        .then((env) => sendResponse({ success: true, env }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'getEnvironments':
      sendResponse({ success: true, environments: api.getEnvironments() });
      return false;

    case 'checkSupportedSite':
      sendResponse({ isSupported: isSupportedSite(message.url) });
      return false;

    // O relay descartava o sender. A aba de origem passa a viajar junto porque o
    // fluxo de Lista Cupons precisa saber DE QUAL aba veio o evento: duas abas de
    // cupons diferentes se sobrescreveriam, e o vínculo aba↔cupom é o que diz qual
    // cupom vale para os produtos que acabaram de ser lidos.
    case 'offerExtracted':
      chrome.runtime.sendMessage({ ...message, sourceTabId: sender?.tab?.id ?? null }).catch(() => {});
      sendResponse({ success: true });
      return false;

    case 'pageChanged':
      chrome.runtime.sendMessage({ ...message, sourceTabId: sender?.tab?.id ?? null }).catch(() => {});
      sendResponse({ success: true });
      return false;

    // ===== Custom Categories =====
    case 'getCustomCategories':
      api.getCustomCategories()
        .then((data) => sendResponse({ success: true, data: data?.data || [] }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'getMlCategories':
      api.getMlCategories()
        .then((data) => sendResponse({ success: true, data: data?.data || [] }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'getAmazonCategories':
      api.getAmazonCategories()
        .then((data) => sendResponse({ success: true, data: data?.data || [] }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    // ===== User Lists =====
    case 'getLists':
      api.getLists()
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'createList':
      api.createList(message.name)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({
          success: false,
          error: err.message,
          data: err.data || null,
        }));
      return true;

    case 'renameList':
      api.renameList(message.listId, message.name)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'deleteList':
      api.deleteList(message.listId)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'getListItems':
      api.getListItems(message.listId)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'addListItems':
      api.addListItems(message.listId, message.items)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    // ===== Send Queue =====
    case 'sendQueue:add':
      if (globalThis.sendQueue) {
        globalThis.sendQueue.addAndSend(message.items);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'SendQueue not loaded' });
      }
      return false;

    case 'sendQueue:pause':
      if (globalThis.sendQueue) {
        globalThis.sendQueue.pause(message.reason || 'manual');
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'SendQueue not loaded' });
      }
      return false;

    case 'sendQueue:resume':
      if (globalThis.sendQueue) {
        globalThis.sendQueue.resume();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'SendQueue not loaded' });
      }
      return false;

    case 'sendQueue:clear':
      if (globalThis.sendQueue) {
        globalThis.sendQueue.clear();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'SendQueue not loaded' });
      }
      return false;

    case 'sendQueue:getState':
      if (globalThis.sendQueue) {
        sendResponse({ success: true, data: globalThis.sendQueue.getState() });
      } else {
        sendResponse({ success: false, error: 'SendQueue not loaded' });
      }
      return false;

    case 'removeListItem':
      api.removeListItem(message.listId, message.itemId)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'getSchedule':
      getScheduleConfig()
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'saveSchedule':
      saveScheduleConfig(message.config)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    default:
      return false;
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  if (tab.url.startsWith('http')) {
    try {
      await chrome.sidePanel.setOptions({
        tabId,
        path: 'ui/sidepanel.html',
        enabled: true,
      });
    } catch (e) {
      console.error('[AchadinhoPRO] Erro sidePanel:', e);
    }
  }

  if (isSupportedSite(tab.url)) {
    chrome.runtime.sendMessage({
      action: 'tabUpdated',
      tab: { id: tabId, url: tab.url, isSupported: true },
    }).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    console.log('[AchadinhoPRO] Extensão instalada!');
  } else if (details.reason === 'update') {
    console.log('[AchadinhoPRO] Extensão atualizada:', chrome.runtime.getManifest().version);
    // Fechar abas de linkbuilder com sessão stale da versão anterior
    await closeLinkBuilderTab();
    linkBuilderConsecutiveFailures = 0;
    linkBuilderCooldownUntil = 0;
    cachedAffiliateTag = null;
    // Simétrico ao ML: a tag Amazon cacheada em memória também morre no update. Redundante
    // (a validação por TAG_RE já roda a cada chamada), mas elimina a assimetria que deixou
    // uma tag "status" sobreviver em versões antigas.
    // Zera a tag em memória E no storage.session: cache de versão anterior podia
    // carregar a tag "status" (o bug do envelope JSON), e ele sobreviveria ao update.
    await invalidarTagAmazon('extensão atualizada');
    await closeAmazonTab();
    await reinjectContentScripts();
  }
  await restoreState();
  setupScheduleAlarm();
  // Restore send queue state
  if (globalThis.sendQueue) globalThis.sendQueue.restore();
});

chrome.runtime.onStartup.addListener(async () => {
  await restoreState();
  setupScheduleAlarm();
  // Restore send queue state
  if (globalThis.sendQueue) globalThis.sendQueue.restore();
  // Check if we missed a scheduled execution while PC was off
  setTimeout(() => checkAndRunSchedule(), 10000);
});

// Cookies de AUTENTICAÇÃO da Amazon — só eles. Quando um deles muda (login, logout,
// troca de conta), a tag cacheada pode ser de outra loja, e tag errada gera comissão
// para a conta errada.
//
// `session-id` e `ubid-acbbr` ficaram DE FORA de propósito: a Amazon os renova em
// navegação comum — inclusive na aba que a própria extensão abre para ler a tag. Com
// eles na lista, navegar na Amazon durante um lote limpava o cache a cada produto e
// trazia de volta uma aba + `getStoreTagMap` por item, que é exatamente o custo que o
// cache existe para eliminar.
const AMZ_COOKIES_DE_SESSAO = ['at-acbbr', 'sess-at-acbbr', 'x-acbbr'];

if (chrome.cookies && chrome.cookies.onChanged) {
  chrome.cookies.onChanged.addListener((info) => {
    try {
      const cookie = info && info.cookie;
      if (!cookie || !cookie.domain || cookie.domain.indexOf('amazon.com.br') === -1) return;
      if (AMZ_COOKIES_DE_SESSAO.indexOf(cookie.name) === -1) return;
      // Serializado com a gravação: sem a fila, um `invalidarTagAmazon` disparado
      // durante a leitura terminava DEPOIS do `gravarTagNoCache` e apagava a tag
      // recém-lida — o cache nascia vazio e o lote voltava a buscar por produto.
      filaDoCacheDaTag = filaDoCacheDaTag.then(() => invalidarTagAmazon(`cookie ${cookie.name} mudou`)).catch(() => {});
    } catch (e) { /* nunca derrubar o listener por causa disto */ }
  });
}

async function reinjectContentScripts() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.url && isSupportedSite(tab.url)) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: getScriptsForUrl(tab.url),
          });
        } catch (e) {
          console.log('[AchadinhoPRO] Não foi possível reinjetar na tab:', tab.id);
        }
      }
    }
  } catch (error) {
    console.error('[AchadinhoPRO] Erro ao reinjetar scripts:', error);
  }
}

// ===== SCHEDULED AUTOMATION =====

const PERIOD_RANGES = {
  madrugada: { start: 0, end: 6 },
  manha: { start: 6, end: 12 },
  tarde: { start: 12, end: 18 },
  noite: { start: 18, end: 24 },
};

function setupScheduleAlarm() {
  chrome.alarms.create('scheduleCheck', { periodInMinutes: 5 });
  console.log('[Schedule] Alarm criado: check a cada 5 min');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  // Send queue auto-resume timer
  if (globalThis.sendQueue) {
    globalThis.sendQueue.handleAutoResumeAlarm(alarm);
  }

  if (alarm.name === 'scheduleCheck') {
    checkAndRunSchedule();
  }
});

async function getScheduleConfig() {
  const data = await chrome.storage.local.get(['scheduleConfig']);
  return data.scheduleConfig || {
    enabled: false,
    periods: [],
    keywordGroupIds: [],
    lastExecutionDate: null,
    lastExecutionTime: null,
    lastExecutionResult: null,
  };
}

async function saveScheduleConfig(config) {
  await chrome.storage.local.set({ scheduleConfig: config });
  // Also sync to server (best-effort)
  try {
    const authenticated = await api.isAuthenticated();
    if (authenticated) {
      await api.saveSchedule(config);
    }
  } catch (e) {
    console.warn('[Schedule] Falha ao sincronizar com servidor:', e.message);
  }
  return config;
}

function getTodayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getCurrentPeriod() {
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 6) return 'madrugada';
  if (hour >= 6 && hour < 12) return 'manha';
  if (hour >= 12 && hour < 18) return 'tarde';
  return 'noite';
}

function isPeriodPassed(period) {
  const hour = new Date().getHours();
  const range = PERIOD_RANGES[period];
  return hour >= range.end;
}

function getRandomMinuteInPeriod(period) {
  const range = PERIOD_RANGES[period];
  // Random time within the period, leaving 30min buffer at end
  const startMin = range.start * 60;
  const endMin = (range.end * 60) - 30;
  return Math.floor(Math.random() * (endMin - startMin)) + startMin;
}

async function checkAndRunSchedule() {
  // Don't run if automation is already running
  if (automationState === STATE.RUNNING) return;

  const config = await getScheduleConfig();
  if (!config.enabled || !config.periods || config.periods.length === 0) return;
  if (!config.keywordGroupIds || config.keywordGroupIds.length === 0) return;

  const today = getTodayDateStr();

  // Already executed today?
  if (config.lastExecutionDate === today) return;

  const authenticated = await api.isAuthenticated();
  if (!authenticated) return;

  const currentPeriod = getCurrentPeriod();
  const isInSelectedPeriod = config.periods.includes(currentPeriod);

  if (isInSelectedPeriod) {
    // We're in a selected period — check if we should execute now
    // Use a random delay to avoid always executing at the same time
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();

    // Get or generate random target minute for today
    let targetMinute = config._todayTargetMinute;
    if (!targetMinute || config._todayTargetDate !== today) {
      targetMinute = getRandomMinuteInPeriod(currentPeriod);
      config._todayTargetMinute = targetMinute;
      config._todayTargetDate = today;
      await chrome.storage.local.set({ scheduleConfig: config });
      console.log(`[Schedule] Target para hoje: ${Math.floor(targetMinute / 60)}:${String(targetMinute % 60).padStart(2, '0')}`);
    }

    if (currentMinute >= targetMinute) {
      console.log('[Schedule] Horário atingido! Iniciando automação agendada...');
      executeScheduledAutomation(config);
    }
    return;
  }

  // Check if all selected periods already passed today (PC was off)
  const allPassed = config.periods.every(p => isPeriodPassed(p));
  if (allPassed) {
    console.log('[Schedule] Períodos já passaram hoje (PC estava desligado). Executando agora...');
    // Small random delay (1-5 min) before executing
    const delayMs = (Math.random() * 4 + 1) * 60 * 1000;
    setTimeout(() => executeScheduledAutomation(config), delayMs);
  }
}

async function executeScheduledAutomation(config) {
  if (automationState === STATE.RUNNING) return;

  const today = getTodayDateStr();

  // Double-check: reload config in case it was updated
  const freshConfig = await getScheduleConfig();
  if (freshConfig.lastExecutionDate === today) return;

  console.log('[Schedule] Iniciando automação agendada...');
  addLog('Automação agendada iniciada', 'success');

  try {
    // Determine platforms to search (backward compat: default to ['ml'])
    const platforms = freshConfig.platforms || config.platforms || ['ml'];
    addLog(`Agendamento: fontes selecionadas: ${platforms.join(', ')}`, 'info');

    // Load keyword groups
    const response = await api.getKeywordSearches();
    const allKeywords = response.keywords || [];
    const selected = allKeywords.filter(kw => config.keywordGroupIds.includes(String(kw.id)));

    if (selected.length === 0) {
      addLog('Agendamento: nenhum grupo de palavras-chave encontrado', 'warning');
      return;
    }

    // Build keyword list
    const allSearchKeywords = [];
    for (const group of selected) {
      const keywords = group.keywords || [];
      for (const keyword of keywords) {
        if (keyword && keyword.trim()) {
          allSearchKeywords.push({
            keyword: keyword.trim(),
            groupName: group.name,
            groupId: group.id,
          });
        }
      }
    }

    if (allSearchKeywords.length === 0) {
      addLog('Agendamento: nenhuma palavra-chave nos grupos selecionados', 'warning');
      return;
    }

    // Calculate products per keyword
    const totalKw = allSearchKeywords.length;
    let maxProducts;
    if (totalKw <= 5) maxProducts = 30;
    else if (totalKw <= 10) maxProducts = 15;
    else if (totalKw <= 25) maxProducts = 10;
    else maxProducts = 6;

    addLog(`Agendamento: ${totalKw} palavras-chave × ${platforms.length} fonte(s). Máx ${maxProducts} produtos/palavra.`, 'info');

    // Set state and run
    shouldStop = false;
    taskStats = { total: totalKw, completed: 0, failed: 0, totalSaved: 0, totalSkippedNoLink: 0 };
    await setState(STATE.RUNNING);
    broadcastStateUpdate();

    // Run keyword search sequentially for each platform
    for (const platform of platforms) {
      if (shouldStop) break;

      const platformCfg = PLATFORM_CONFIG[platform];
      if (!platformCfg) {
        addLog(`Agendamento: plataforma desconhecida "${platform}", pulando`, 'warning');
        continue;
      }

      // Per-platform login check
      const loginResult = await platformCfg.loginCheck();
      if (!loginResult.loggedIn) {
        addLog(`Agendamento: ${platformCfg.name} — ${loginResult.error || 'não logado'}, pulando`, 'warning');
        continue;
      }
      if (platform === 'ml') {
        addLog(`ML login OK (tag: ${loginResult.tag})`, 'info');
      }

      addLog(`Agendamento: buscando em ${platformCfg.name}...`, 'info');
      taskStats.completed = 0;
      taskStats.failed = 0;

      await runKeywordSearchLoop(allSearchKeywords, maxProducts, platform, true);

      // Delay between platforms
      if (platforms.indexOf(platform) < platforms.length - 1 && !shouldStop) {
        addLog('Aguardando antes da próxima fonte...', 'info');
        await humanDelay(10, 20);
      }
    }

    // Update schedule config with execution result
    const result = {
      totalProducts: taskStats.totalSaved + taskStats.totalSkippedNoLink,
      totalSaved: taskStats.totalSaved,
      totalSkipped: taskStats.totalSkippedNoLink,
      groups: selected.length,
      platforms: platforms,
    };

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const cfg = await getScheduleConfig();
    cfg.lastExecutionDate = today;
    cfg.lastExecutionTime = timeStr;
    cfg.lastExecutionResult = result;
    await saveScheduleConfig(cfg);

    addLog(`Agendamento concluído: ${result.totalSaved} produtos salvos em ${platforms.length} fonte(s)`, 'success');
    await setState(STATE.IDLE);

  } catch (error) {
    console.error('[Schedule] Erro na execução agendada:', error);
    addLog(`Agendamento erro: ${error.message}`, 'error');

    // Still mark as executed today to avoid retrying in a loop
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const cfg = await getScheduleConfig();
    cfg.lastExecutionDate = today;
    cfg.lastExecutionTime = timeStr;
    cfg.lastExecutionResult = { totalProducts: 0, totalSaved: 0, totalSkipped: 0, groups: 0 };
    await saveScheduleConfig(cfg);
    await setState(STATE.ERROR);
  }
}
