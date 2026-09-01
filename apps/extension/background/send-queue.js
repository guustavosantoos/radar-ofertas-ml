/**
 * send-queue.js — Persistent Product Send Queue State Machine
 * Loaded as ES module side-effect import in service-worker.js
 *
 * States: idle | sending | paused
 * Persisted in chrome.storage.local under key 'sendQueue'
 */

'use strict';

// ---------------------------------------------------------------------------
// Internal State
// ---------------------------------------------------------------------------
let status = 'idle';       // 'idle' | 'sending' | 'paused'
let items = [];            // Array of queue items
let currentIndex = 0;      // Pointer into items[]
let pauseReason = null;    // Human-readable reason for pause
let isProcessing = false;  // Guard against concurrent processQueue() calls
let loopGeneration = 0;    // Incremented on each addAndSend to signal old loops to stop
let restoreStarted = false; // Restore exatamente uma vez por vida do service worker
// Promessa que resolve quando o snapshot do storage terminou de ser aplicado.
// Quem acorda o worker por ALARME precisa esperar por ela: `chrome.storage.local.get`
// é assíncrono e o evento chega ANTES do callback, então `status` ainda vale
// 'idle' (o valor inicial do módulo) quando o alarme de auto-resume dispara.
let restoreConcluido = null;
// A fila já foi mexida desde que o módulo carregou?
//
// `chrome.storage.local.get` é ASSÍNCRONO, mas `restore()` é chamado durante a
// avaliação do módulo — e o Chrome só despacha o evento que ACORDOU o service
// worker depois que todo o grafo de módulos avalia. No caminho mais comum
// (worker dormiu após 30s de ociosidade, usuário clica em enviar) a ordem real é:
//
//   1. módulo avalia   → restore() dispara o get, que fica em voo
//   2. Chrome despacha → 'sendQueue:add' → addAndSend() enche items e começa a enviar
//   3. callback do get → chegava e sobrescrevia items/currentIndex/stats/status
//
// O passo 3 apagava o lote que o usuário acabara de mandar: medido com lote de
// 5 produtos, 1 era enviado e 4 sumiam em silêncio, com a UI ainda exibindo o
// lote ANTERIOR como concluído. É a assinatura do bug histórico "a fila pula
// ~50% dos produtos". O snapshot só vale enquanto ninguém tocou na fila.
let filaTocadaDesdeOLoad = false;
// Quantas vezes seguidas a fila parou porque a sessão do marketplace caiu.
// Zera a cada enriquecimento bem-sucedido e a cada lote novo. Existe para a
// pausa por sessão não virar um ciclo eterno de "pausa 1 min → falha → pausa"
// quando o usuário não relogar: passado o teto, os itens erram com o motivo à
// vista, que é informação, e a fila encerra.
let pausasPorSessao = 0;
const MAX_PAUSAS_POR_SESSAO = 3;
// A tag da Amazon já foi revalidada neste lote? Uma revalidação por LOTE (não por
// produto): quem trocou de conta do Associados no meio da sessão geraria o lote inteiro
// com a tag antiga — comissão para a conta errada. Zera em `addAndSend`.
let tagAmazonRevalidadaNoLote = false;
// Quantas esperas por throttling um MESMO item aguenta antes de virar erro.
const MAX_COOLDOWNS_POR_ITEM = 3;
let stats = {
  sent: 0,
  errors: 0,
  total: 0,
  duplicates: 0,   // Items that were upserts (already existed in list)
  filtered: 0,     // Items rejected by server validation
};

const STORAGE_KEY = 'sendQueue';
const AUTO_RESUME_ALARM = 'sendQueueAutoResume';
const KEEPALIVE_ALARM = 'sendQueueKeepalive';
const MAX_ITEMS_KEPT = 50;

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/** Save current state snapshot to chrome.storage.local */
function persist() {
  const snapshot = {
    status,
    items,
    currentIndex,
    pauseReason,
    stats,
    // Vai para o storage porque a pausa DESLIGA o keepalive: o worker é
    // reciclado durante o minuto de espera e um contador só em memória
    // voltaria a zero a cada ciclo — o teto nunca dispararia e a fila ficaria
    // pausando para sempre contra uma sessão que não volta.
    pausasPorSessao,
  };
  try {
    chrome.storage.local.set({ [STORAGE_KEY]: snapshot }).catch((err) => {
      console.error('[SendQueue] persist failed:', err?.message || err);
      // Em caso de QuotaExceededError, tenta aparar itens já finalizados para liberar espaço
      if (String(err?.message || err).toLowerCase().includes('quota')) {
        const trimmed = items.filter((i) => i.status !== 'sent' && i.status !== 'error').slice(-500);
        chrome.storage.local
          .set({ [STORAGE_KEY]: { status, items: trimmed, currentIndex, pauseReason, stats } })
          .catch((e) => console.error('[SendQueue] persist retry failed:', e?.message || e));
      }
    });
  } catch (e) {
    console.error('[SendQueue] persist sync error:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Broadcasting
// ---------------------------------------------------------------------------

/**
 * Retrato da fila no formato que a barra do painel lê.
 *
 * Fonte ÚNICA para o broadcast e para o `getState`: o painel que abre no meio de
 * um lote chama `getState` e renderiza com a mesma função que trata o broadcast.
 * Enquanto os dois formatos divergiram (`sentCount`/`errorCount` de um lado,
 * `sent`/`errors` do outro), reabrir o painel mostrava "Enviando... 0/0" com a
 * fila cheia — e nenhum motivo de erro, porque `items` não vinha.
 */
function snapshotParaUI() {
  const pending = items.filter((i) => i.status === 'pending' || i.status === 'sending').length;
  const sent = items.filter((i) => i.status === 'sent').length;
  const errors = items.filter((i) => i.status === 'error').length;
  return {
    status,
    pauseReason,
    pending,
    currentIndex,
    total: sent + errors + pending,
    sent: sent,
    errors: errors,
    duplicates: stats.duplicates || 0,
    filtered: stats.filtered || 0,
    // Lightweight item summaries for the UI
    items: items.map((item, idx) => ({
      status: item.status,
      platform: item.platform,
      errorMessage: item.errorMessage || null,
      saveStatus: item.saveStatus || null,
      productName: item.product?.productName || item.product?.name || '',
      isCurrent: idx === currentIndex,
    })),
  };
}

/** Broadcast current queue status to the sidebar (may not be open — ignore errors) */
function broadcast() {
  chrome.runtime.sendMessage({ action: 'sendQueue:status', ...snapshotParaUI() }).catch(() => {
    // Sidebar not open — silently ignore
  });
}

// ---------------------------------------------------------------------------
// Affiliate link enrichment
// ---------------------------------------------------------------------------

/**
 * Enriches a product with an affiliate short link, if applicable.
 * Shopee products are returned as-is.
 * Returns { product, cooldown?, cooldownMs? }
 * If cooldown is true, the caller should pause and wait before retrying.
 *
 * @param {object} product
 * @param {string} platform  'ml' | 'amazon' | 'shopee'
 * @returns {Promise<{product: object, cooldown?: boolean, cooldownMs?: number}>}
 */
function enrichProductWithAffiliateLink(product, platform) {
  return new Promise((resolve) => {
    if (platform === 'shopee') {
      resolve({ product });
      return;
    }

    const url = product.productLink || product.productUrl || '';

    // Timeout to prevent hanging if callback never fires (e.g., tab closed).
    // 60s e nao 30s: a geracao de link Amazon pode reabrir a aba e tentar de novo
    // (ver generateAmazonAffiliateLinkViaCookies). O pior caso real e
    // 15s (carga da aba) + 2s + 1,5s + 15s + 2s ≈ 36s — o teto antigo cortava
    // essa segunda chance no meio e devolvia "tempo esgotado" no lugar do motivo.
    const timeout = setTimeout(() => {
      console.warn('[SendQueue] Enrichment timeout for', platform, url.slice(0, 40));
      resolve({ product, error: 'Tempo esgotado (60s) ao gerar o link de afiliado' });
    }, 60000);

    if (platform === 'amazon') {
      if (!globalThis._handlers?.handleGenerateAmazonShortLink) {
        clearTimeout(timeout);
        resolve({ product });
        return;
      }
      // ASIN e `forceRefresh` viajam junto: o ASIN é conferido contra o da URL (link
      // para o produto errado é pior que save recusado) e a tag é revalidada uma vez por
      // lote — quem trocou de conta do Associados não gera o lote todo com a tag antiga.
      const opcoesAmazon = {
        asin: product.asin || product.platformItemId || null,
        forceRefresh: !tagAmazonRevalidadaNoLote,
      };
      globalThis._handlers.handleGenerateAmazonShortLink(url, (result) => {
        clearTimeout(timeout);
        // A revalidação só conta como gasta se a tag foi REALMENTE resolvida
        // (`tagRevalidada`, carimbado pelo service worker só quando resolveAmazonTag
        // devolve sucesso). Marcar em qualquer resultado — como antes — queimava a
        // revalidação do lote em falhas que nem chegaram a ler a tag: ASIN divergente
        // (sai antes da consulta), aba em página de erro, tag malformada. Os produtos
        // seguintes saíam com a tag do CACHE, que pode ser da conta do Associados
        // anterior: comissão para a conta errada. Marcar só no link gerado, por outro
        // lado, abria uma aba por item até o primeiro acerto — `tagRevalidada` separa
        // "não consegui ler a tag" de "li a tag e o resto falhou".
        if (result && result.tagRevalidada) tagAmazonRevalidadaNoLote = true;
        if (result && result.success && result.short_link) {
          // affiliateTag acompanha o link: sem ela o backend recusa o save (o link pode
          // ser um amzn.to legado, opaco, e o servidor confere asin × link × tag).
          resolve({ product: { ...product, affiliateShortLink: result.short_link, affiliateTag: result.tag } });
        } else if (result && result.cooldown) {
          resolve({ product, cooldown: true, cooldownMs: result.cooldownMs || 60000, error: result.error });
        } else {
          // O MOTIVO viaja junto. Sem isto o item virava "Affiliate short link
          // required but not generated" — mensagem que descreve o sintoma e
          // esconde a causa (sessão do Associados caída, throttling da Amazon,
          // aba em página de erro), deixando a UI com um contador de erros mudo.
          resolve({
            product,
            error: (result && result.error) || 'Link de afiliado Amazon não gerado',
            sessionExpired: !!(result && result.reason === 'session'),
          });
        }
      }, opcoesAmazon);
      return;
    }

    // Default: Mercado Livre (ml)
    if (!globalThis._handlers?.handleGenerateShortLink) {
      clearTimeout(timeout);
      resolve({ product });
      return;
    }
    globalThis._handlers.handleGenerateShortLink(url, (result) => {
      clearTimeout(timeout);
      if (result && result.success && result.short_link) {
        resolve({ product: { ...product, affiliateShortLink: result.short_link } });
      } else if (result && result.cooldown) {
        // Linkbuilder is in cooldown — signal the queue to pause and wait
        resolve({ product, cooldown: true, cooldownMs: result.cooldownMs || 60000 });
      } else if (result && result.notRetryable) {
        // Falha terminal: repetir não muda o resultado. Pode ser o produto barrado
        // pelo programa (error 111) OU a URL não ser de produto — o motivo REAL
        // precisa viajar junto, senão a fila mascara um problema pelo outro.
        resolve({ product, notRetryable: true, error: result.error });
      } else {
        resolve({ product });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// API send helpers
// ---------------------------------------------------------------------------

/**
 * Sends a single product to the backend API via globalThis._handlers.
 * Returns a Promise that resolves with the handler callback result.
 *
 * @param {object} product
 * @param {string} platform  'ml' | 'amazon' | 'shopee'
 * @param {string|null} listId
 * @returns {Promise<any>}
 */
function sendProductToAPI(product, platform, listId) {
  return new Promise((resolve) => {
    const handlers = globalThis._handlers;
    if (!handlers) {
      resolve({ success: false, error: '_handlers not available' });
      return;
    }

    const cb = (result) => {
      resolve(result || { success: false, error: 'No response from handler' });
    };

    if (listId) {
      // Format product as list item for the addListItems API
      var platformKey = platform === 'amazon' ? 'amz' : platform;
      var listItem = {
        platformItemId: product.platformItemId || product.mlItemId || product.asin || product.itemId || '',
        platform: platformKey,
        productName: product.productName || '',
        price: product.price || 0,
        originalPrice: product.originalPrice || 0,
        discountPercent: product.discountPercent || 0,
        imageUrl: product.imageUrl || '',
        productUrl: product.productUrl || product.productLink || '',
        affiliateLink: product.affiliateShortLink || product.affiliateLink || '',
        // Tag Amazon exigida pela trava de ingest da rota de listas (isValidAmzAffiliateLink).
        affiliateTag: product.affiliateTag || null,
        seller: product.seller || product.sellerName || product.shopName || '',
        freeShipping: product.freeShipping || product.isPrime || false,
        // A ESCALA de `ratingStar` difere por marketplace e dividir sempre por 100
        // gravava a nota errada na lista: o ML manda `nota × 100` (4,7 → 470), mas a
        // Amazon manda `nota × 10` (4,7 → 47, ver comentário em shared/schema/amz.ts),
        // e 47/100 virava "0.5" — um produto 4,7 estrelas entrava na lista com meia
        // estrela.
        rating: product.ratingStar
          ? String((product.ratingStar / (platform === 'amazon' ? 10 : 100)).toFixed(1))
          : (product.rating ? String(product.rating) : ''),
        // Só Amazon: contagem de avaliações e selo Prime (colunas da Migration 0078 no
        // servidor; o executor da automação passa a mandá-los na mensagem). ML/Shopee
        // não ganham chave nenhuma — o payload deles continua idêntico.
        ...(platform === 'amazon' ? {
          reviewsCount: product.reviewsCount || null,
          isPrime: !!product.isPrime,
        } : {}),
        condition: product.condition || 'new',
        categoryId: product.categoryId || '',
        categoryName: product.categoryName || '',
      };
      // Extract MLB ID from URL as fallback
      if (!listItem.platformItemId && product.productLink) {
        var mlMatch = product.productLink.match(/MLB-?(\d+)/i);
        if (mlMatch) listItem.platformItemId = 'MLB' + mlMatch[1];
      }
      handlers.handleSaveToList(listId, [listItem], platformKey, cb);
      return;
    }

    if (platform === 'amazon') {
      handlers.handleSaveAmazonProducts([product], null, cb);
      return;
    }

    if (platform === 'shopee') {
      handlers.handleSaveShopeeProducts([product], null, cb);
      return;
    }

    // Default: Mercado Livre manual save
    handlers.handleManualSave(product, cb);
  });
}

// ---------------------------------------------------------------------------
// Delay helper
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find the next item that is pending and whose platform is NOT in cooldown.
 * Returns index or -1 if none found.
 */
function findNextProcessableItem(startIdx, itemsArr, cooldowns) {
  const now = Date.now();
  for (let i = startIdx; i < itemsArr.length; i++) {
    const it = itemsArr[i];
    if (it.status !== 'pending') continue;
    const cd = cooldowns[it.platform] || 0;
    if (now >= cd) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Core processing loop
// ---------------------------------------------------------------------------

/**
 * Processes the queue sequentially while status === 'sending'.
 * Skips items already sent or errored.
 * Enriches each item with an affiliate link before sending.
 * Uses isProcessing guard to prevent concurrent loop instances.
 */
async function processQueue() {
  // Prevent multiple concurrent loops — this is the root cause of products being skipped
  if (isProcessing) {
    console.log('[SendQueue] processQueue already running, new items will be picked up by existing loop');
    return;
  }
  isProcessing = true;
  const myGeneration = loopGeneration;

  // Track per-platform cooldowns: { platform: cooldownExpiresAt }
  const platformCooldowns = {};
  // Track ML items sent since last session refresh
  let mlItemsSinceRefresh = 0;
  const ML_SESSION_REFRESH_EVERY = 25;

  try {
    while (status === 'sending' && currentIndex < items.length && myGeneration === loopGeneration) {
      const item = items[currentIndex];

      // Skip already-finished items
      if (item.status === 'sent' || item.status === 'error') {
        currentIndex++;
        continue;
      }

      // Check if this item's platform is in cooldown
      const cooldownUntil = platformCooldowns[item.platform] || 0;
      if (Date.now() < cooldownUntil) {
        // Platform in cooldown — try to find a non-cooldown item ahead
        const nextIdx = findNextProcessableItem(currentIndex + 1, items, platformCooldowns);
        if (nextIdx !== -1) {
          // Swap: move processable item to current position so we process it next
          console.log(`[SendQueue] ${item.platform} in cooldown, skipping to item ${nextIdx} (${items[nextIdx].platform})`);
          const temp = items[currentIndex];
          items[currentIndex] = items[nextIdx];
          items[nextIdx] = temp;
          continue; // Re-process currentIndex which now has the swapped item
        }
        // All remaining items are in cooldown — wait for the shortest cooldown
        const minWait = Math.min(...Object.values(platformCooldowns).map(t => Math.max(0, t - Date.now())));
        console.log(`[SendQueue] All platforms in cooldown, waiting ${Math.ceil(minWait / 1000)}s...`);
        await delay(minWait + 2000);
        // Clear expired cooldowns
        for (const p of Object.keys(platformCooldowns)) {
          if (Date.now() >= platformCooldowns[p]) delete platformCooldowns[p];
        }
        continue;
      }

      // ML session refresh: every 25 ML items, force linkbuilder tab refresh
      if (item.platform === 'ml' && mlItemsSinceRefresh >= ML_SESSION_REFRESH_EVERY) {
        console.log(`[SendQueue] Refreshing ML linkbuilder session after ${mlItemsSinceRefresh} items`);
        try {
          if (globalThis._handlers?.refreshLinkBuilderSession) {
            await globalThis._handlers.refreshLinkBuilderSession();
          }
        } catch (e) {
          console.warn('[SendQueue] Session refresh failed:', e.message);
        }
        mlItemsSinceRefresh = 0;
        await delay(2000); // Wait for new session to initialize
      }

      // Mark as sending (mlItemsSinceRefresh é incrementado apenas após sucesso na linha 400,
      // para não dobrar a contagem e disparar refresh do linkbuilder mais cedo do que o previsto)
      item.status = 'sending';
      broadcast();

      try {
        // 1. Enrich with affiliate link if not yet enriched
        if (!item.enriched) {
          const enrichResult = await enrichProductWithAffiliateLink(item.product, item.platform);
          item.product = enrichResult.product;

          // If linkbuilder is in cooldown, set platform cooldown and retry via loop
          if (enrichResult.cooldown) {
            // TETO. O cooldown devolve o item para `pending` sem gastar
            // `enrichRetries` — de propósito, porque esperar costuma resolver.
            // Mas com a Amazon respondendo 503 de forma persistente (e agora ela
            // TAMBÉM produz cooldown, não só o linkbuilder do ML) o ciclo
            // "espera 60s → 503 → espera 60s" não tem fim, com o keepalive
            // mantendo o worker vivo indefinidamente.
            item.cooldownRetries = (item.cooldownRetries || 0) + 1;
            if (item.cooldownRetries > MAX_COOLDOWNS_POR_ITEM) {
              item.status = 'error';
              item.errorMessage = enrichResult.error
                || `${item.platform}: limite de tentativas após ${MAX_COOLDOWNS_POR_ITEM} esperas`;
              item.saveStatus = 'error';
              stats.errors++;
              console.warn(`[SendQueue] ${item.platform} segue limitando após ${MAX_COOLDOWNS_POR_ITEM} cooldowns — item marcado como erro`);
              persist();
              broadcast();
              continue;
            }
            const waitMs = Math.min(enrichResult.cooldownMs || 60000, 120000);
            platformCooldowns[item.platform] = Date.now() + waitMs;
            console.log(`[SendQueue] ${item.platform} linkbuilder cooldown ${item.cooldownRetries}/${MAX_COOLDOWNS_POR_ITEM}: ${Math.ceil(waitMs / 1000)}s`);
            item.status = 'pending'; // Reset to pending for retry
            persist();
            broadcast();
            continue; // Loop will find non-cooldown items or wait
          }

          // Sessão do marketplace caída (Associados Amazon / linkbuilder do ML):
          // insistir agora só queima o lote inteiro — foi exatamente o
          // "0 enviados, 10 erros, 5 restantes" relatado em 2026-08. A fila
          // PAUSA com o motivo na tela e o item volta a PENDENTE; o auto-resume
          // de 1 min retoma sozinho assim que o login voltar.
          if (enrichResult.sessionExpired) {
            pausasPorSessao++;
            if (pausasPorSessao <= MAX_PAUSAS_POR_SESSAO) {
              item.status = 'pending';
              item.errorMessage = enrichResult.error || null;
              console.warn(`[SendQueue] Sessão ${item.platform} expirada — pausando (${pausasPorSessao}/${MAX_PAUSAS_POR_SESSAO}): ${enrichResult.error}`);
              pause(enrichResult.error || 'Sessão do marketplace expirada — faça login e o envio continua');
              continue; // o `while` sai sozinho: status deixou de ser 'sending'
            }
            console.warn('[SendQueue] Sessão segue expirada após ' + MAX_PAUSAS_POR_SESSAO + ' pausas — marcando os itens como erro');
          }

          // Falha terminal do enriquecimento — pular direto sem retry. A causa vem do
          // service worker: pode ser o produto barrado pelo programa (error 111) ou a
          // URL não ser de produto. Mensagem fixa aqui esconderia uma atrás da outra.
          if (enrichResult.notRetryable) {
            const motivoTerminal = enrichResult.error || 'Produto não permitido no programa de afiliados';
            console.warn(`[SendQueue] Enriquecimento terminal (${motivoTerminal}), pulando: ${item.product.productName?.slice(0, 40)}`);
            item.status = 'error';
            // errorMessage, não `error`: é o campo que `snapshotParaUI` manda
            // para o painel. Gravado no campo errado, o motivo terminal chegava
            // à tela como `null` — justamente nos casos que ele explica.
            item.errorMessage = motivoTerminal;
            item.saveStatus = 'error';
            stats.errors++;
            persist();
            broadcast();
            continue;
          }

          // Check if enrichment actually produced a link
          item.enrichError = enrichResult.error || null;
          const requiresLink = item.platform === 'ml' || item.platform === 'amazon';
          if (requiresLink && !item.product.affiliateShortLink) {
            // Enrichment failed but no cooldown — retry up to 2 times with a delay
            item.enrichRetries = (item.enrichRetries || 0) + 1;
            if (item.enrichRetries <= 2) {
              console.log(`[SendQueue] Enrichment failed for ${item.platform} (${item.enrichError || 'sem motivo'}), retry ${item.enrichRetries}/2 after 5s...`);
              item.status = 'pending';
              await delay(5000); // Wait 5s before retry (let linkbuilder recover)
              continue; // Retry enrichment
            }
            // Max retries exhausted — fall through to error
          }

          item.enriched = true;
          if (item.product.affiliateShortLink || item.platform === 'shopee') pausasPorSessao = 0;
        }

        // 2. Validate: ML and Amazon require an affiliate short link
        const requiresLink = item.platform === 'ml' || item.platform === 'amazon';
        if (requiresLink && !item.product.affiliateShortLink) {
          // A mensagem tem de dizer POR QUE não veio link. "Affiliate short link
          // required but not generated" descreve o sintoma e some com a causa —
          // era o texto que chegava na UI atrás de um contador de erros mudo.
          throw new Error(item.enrichError || 'Link de afiliado não gerado');
        }

        // 3. Send to API
        const apiResult = await sendProductToAPI(item.product, item.platform, item.listId);

        // 4. Check result
        if (apiResult && apiResult.success) {
          // Detect if item was a duplicate (upsert) vs truly new — only for list saves
          const data = apiResult.data || apiResult;
          if (item.listId && data.filteredCount > 0 && data.saved === 0) {
            item.status = 'error';
            item.errorMessage = 'Filtrado pelo servidor (link ou ID ausente)';
            item.saveStatus = 'filtered';
            stats.filtered++;
            stats.errors++;
          } else if (item.listId && data.updatedCount > 0 && data.newCount === 0) {
            item.status = 'sent';
            item.saveStatus = 'duplicate';
            stats.duplicates++;
            stats.sent++;
          } else {
            item.status = 'sent';
            item.saveStatus = data._saveStatus || 'new';
            stats.sent++;
          }
          if (item.platform === 'ml') mlItemsSinceRefresh++;
        } else {
          item.status = 'error';
          const errMsg = apiResult?.error || 'Erro ao salvar';
          item.errorMessage = errMsg;
          if (item.listId && errMsg.includes('Nenhum item válido')) {
            item.saveStatus = 'filtered';
            stats.filtered++;
          }
          stats.errors++;
        }
      } catch (err) {
        item.status = 'error';
        item.errorMessage = err?.message || String(err);
        item.saveStatus = 'error';
        stats.errors++;
      }

      // Persist after each item
      persist();
      broadcast();

      currentIndex++;

      // Delay between sends: ML/Amazon 600ms, Shopee 300ms
      if (status === 'sending') {
        const waitMs = (item.platform === 'ml' || item.platform === 'amazon') ? 600 : 300;
        await delay(waitMs);
      }
    }

    // All items processed (or loop exited due to pause/stop/generation change)
    if (status === 'sending' && myGeneration === loopGeneration) {
      status = 'idle';
      pauseReason = null;

      // Cleanup: keep only the last MAX_ITEMS_KEPT items that are done
      if (items.length > MAX_ITEMS_KEPT) {
        items = items.slice(-MAX_ITEMS_KEPT);
        currentIndex = items.length;
      }

      stopKeepaliveAlarm();
      persist();
      broadcast();
    }
  } finally {
    isProcessing = false;
    // If generation changed while we were running, a new addAndSend was called.
    // Restart the loop with the new state.
    if (myGeneration !== loopGeneration && status === 'sending') {
      console.log('[SendQueue] Generation changed, restarting processQueue for new batch');
      processQueue();
    }
  }
}

// ---------------------------------------------------------------------------
// Alarm helpers
// ---------------------------------------------------------------------------

function clearAutoResumeAlarm() {
  chrome.alarms.clear(AUTO_RESUME_ALARM);
}

function createAutoResumeAlarm() {
  chrome.alarms.create(AUTO_RESUME_ALARM, { delayInMinutes: 1 });
}

/** Start a recurring keepalive alarm (every 25s) to prevent MV3 service worker termination */
function startKeepaliveAlarm() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 25 / 60 });
}

/** Stop the keepalive alarm when queue is idle */
function stopKeepaliveAlarm() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add items to the queue and start/resume sending.
 * If the queue is already processing, items are appended and the existing loop picks them up.
 * If idle/paused, completed items are cleaned up and a new loop starts.
 *
 * @param {Array<{product, platform, listId}>} newItems
 */
function addAndSend(newItems) {
  filaTocadaDesdeOLoad = true;  // vence o snapshot do restore (ver declaração)
  clearAutoResumeAlarm();
  pausasPorSessao = 0;
  tagAmazonRevalidadaNoLote = false;

  const wasActive = status === 'sending';

  const mapped = (newItems || []).map((raw) => ({
    product: raw.product,
    platform: raw.platform,
    listId: raw.listId || null,
    enriched: false,
    status: 'pending',
    errorMessage: null,
    saveStatus: null,
  }));

  if (wasActive) {
    // Queue is actively processing — just append new items.
    // The running processQueue() loop will pick them up automatically
    // because it checks `currentIndex < items.length` on each iteration.
    // DO NOT reset currentIndex or filter items — that causes the race condition.
    items.push(...mapped);
    stats.total = items.length;
    console.log(`[SendQueue] Appended ${mapped.length} items to active queue (total: ${items.length}, currentIndex: ${currentIndex})`);
  } else {
    // Queue is idle or paused — safe to clean up completed items and restart.
    // Increment loopGeneration to signal any lingering old loop (still awaiting) to stop
    // before it can corrupt our new state.
    loopGeneration++;
    const stillActive = items.filter((i) => i.status === 'pending' || i.status === 'sending');
    items = [...stillActive, ...mapped];
    currentIndex = 0;
    // Reset stats for new batch
    stats = { sent: 0, errors: 0, total: items.length, duplicates: 0, filtered: 0 };
    console.log(`[SendQueue] Starting new queue with ${items.length} items (${stillActive.length} carried over + ${mapped.length} new)`);
  }

  status = 'sending';
  pauseReason = null;

  persist();
  broadcast();

  // Keep service worker alive while queue is processing (MV3 kills after 30s idle)
  startKeepaliveAlarm();

  // Kick off the loop (non-blocking) — if already running, processQueue() exits immediately
  processQueue();
}

/**
 * Pause the queue and schedule an auto-resume alarm in 1 minute.
 *
 * @param {string} [reason]
 */
function pause(reason) {
  filaTocadaDesdeOLoad = true;  // vence o snapshot do restore (ver declaração)
  if (status === 'idle') return;
  status = 'paused';
  pauseReason = reason || 'paused';
  stopKeepaliveAlarm();
  createAutoResumeAlarm();
  persist();
  broadcast();
}

/**
 * Clear the auto-resume alarm and resume processing from where we left off.
 */
function resume() {
  // O guard vem PRIMEIRO, e isso não é estilo. Num worker recém-acordado pelo
  // alarme, o restore ainda está em voo e `status` vale 'idle': marcar
  // `filaTocadaDesdeOLoad` aqui fazia o restore descartar o snapshot logo
  // depois — o lote pausado sumia em silêncio, sem alarme para retomar, que é o
  // OPOSTO do que a pausa promete. Ver `handleAutoResumeAlarm`.
  if (status !== 'paused') return;
  filaTocadaDesdeOLoad = true;  // vence o snapshot do restore (ver declaração)
  clearAutoResumeAlarm();
  status = 'sending';
  pauseReason = null;
  startKeepaliveAlarm();
  persist();
  broadcast();
  processQueue();
}

/**
 * Clear the queue entirely and reset all state.
 */
function clear() {
  filaTocadaDesdeOLoad = true;  // vence o snapshot do restore (ver declaração)
  clearAutoResumeAlarm();
  stopKeepaliveAlarm();
  loopGeneration++;  // Signal any running loop to stop immediately
  status = 'idle';
  items = [];
  currentIndex = 0;
  pauseReason = null;
  isProcessing = false;
  stats = { sent: 0, errors: 0, total: 0, duplicates: 0, filtered: 0 };
  persist();
  broadcast();
}

/**
 * Restore queue state from chrome.storage.local on service worker startup.
 * - If was 'sending' → set to 'paused' (safe recovery)
 * - If paused with pending items → auto-resume after 5 seconds
 */
function restore() {
  if (restoreStarted) return restoreConcluido;
  restoreStarted = true;

  let concluir;
  restoreConcluido = new Promise((r) => { concluir = r; });

  try {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      try {
      const storageError = chrome.runtime?.lastError;
      if (storageError) {
        restoreStarted = false;
        console.error('[SendQueue] restore failed:', storageError.message || storageError);
        return;
      }

      // O evento que acordou o worker (onMessage/onAlarm) é despachado ANTES
      // deste callback chegar. Se ele já mexeu na fila, o snapshot que estava
      // em voo está obsoleto — aplicá-lo aqui apagaria o lote vivo e deixaria o
      // loop em execução escrevendo num array que não é mais o `items`, com
      // `currentIndex` descolado do que foi realmente enviado.
      if (filaTocadaDesdeOLoad) {
        console.log('[SendQueue] restore descartado — a fila já foi usada desde o load.');
        return;
      }

      const saved = result?.[STORAGE_KEY];
      if (!saved) return;

      items = saved.items || [];
      currentIndex = saved.currentIndex || 0;
      stats = saved.stats || { sent: 0, errors: 0, total: 0, duplicates: 0, filtered: 0 };
      pauseReason = saved.pauseReason || null;
      pausasPorSessao = saved.pausasPorSessao || 0;

      // Always reset processing guard on restore (no loop is running yet)
      isProcessing = false;

      // Safe recovery: treat 'sending' as 'paused' after restart
      if (saved.status === 'sending') {
        status = 'paused';
        pauseReason = 'Retomando após reinício da extensão';
      } else {
        status = saved.status || 'idle';
      }

      // Fix items that were mid-send when the worker was killed
      items.forEach((item) => {
        if (item.status === 'sending') {
          item.status = 'pending';
        }
      });

      persist();
      broadcast();

      // Auto-resume if paused and there are still pending items
      const hasPending = items.some((item) => item.status === 'pending');
      if (status === 'paused' && hasPending) {
        // Use chrome.alarms instead of setTimeout — survives service worker termination
        chrome.alarms.create(AUTO_RESUME_ALARM, { delayInMinutes: 5 / 60 }); // ~5 seconds
      }
      } finally {
        // SEMPRE resolve, inclusive nos returns antecipados acima: quem espera
        // por esta promessa (o alarme de auto-resume) não pode ficar pendurado
        // porque o storage veio vazio ou a fila já tinha sido tocada.
        concluir();
      }
    });
  } catch (e) {
    // Permite retry por onStartup/onInstalled se a API ainda não estava pronta.
    restoreStarted = false;
    console.error('[SendQueue] restore failed:', e?.message || e);
    concluir();
  }
  return restoreConcluido;
}

/**
 * Return a lightweight status summary for the UI.
 *
 * @returns {object}
 */
function getState() {
  const snapshot = snapshotParaUI();
  return {
    ...snapshot,
    stats: { ...stats },
    // Campos legados — mantidos porque a UI antiga lê `pendingCount`.
    pendingCount: items.filter((i) => i.status === 'pending').length,
    sentCount: snapshot.sent,
    errorCount: snapshot.errors,
  };
}

/**
 * Handle the chrome.alarms.onAlarm event for sendQueueAutoResume.
 * Should be called from the service worker's alarm listener.
 *
 * @param {chrome.alarms.Alarm} alarm
 */
async function handleAutoResumeAlarm(alarm) {
  if (alarm?.name === AUTO_RESUME_ALARM) {
    // Espera o snapshot ser aplicado. O alarme pode ter RESSUSCITADO o worker —
    // e aí `status` ainda é 'idle' porque o `chrome.storage.local.get` do
    // restore não voltou. Sem esta espera o resume não fazia nada e a fila
    // pausada ficava órfã (nenhum alarme restante para acordá-la de novo).
    try { await restore(); } catch (e) { /* restore já loga */ }
    resume();
    return;
  }
  if (alarm?.name === KEEPALIVE_ALARM) {
    // Service worker was woken by keepalive — ensure queue is still processing
    if (status === 'sending' && !isProcessing) {
      console.log('[SendQueue] Keepalive: restarting stalled processQueue');
      processQueue();
    }
    // If queue finished while we were asleep, clean up the alarm
    if (status === 'idle') {
      stopKeepaliveAlarm();
    }
  }
}

// ---------------------------------------------------------------------------
// Export public API via globalThis
// ---------------------------------------------------------------------------

globalThis.sendQueue = {
  addAndSend,
  pause,
  resume,
  clear,
  restore,
  getState,
  handleAutoResumeAlarm,
};

// Um service worker MV3 pode renascer por mensagem/alarme sem disparar
// runtime.onStartup (que é só o início do perfil do Chrome) nem onInstalled.
// Sem restaurar no carregamento do módulo, a fila persistida ficava invisível e
// o keepalive recém-disparado via apenas status='idle', cancelando a si próprio.
restore();

// ---------------------------------------------------------------------------
// Marcador de módulo ES
// ---------------------------------------------------------------------------
// Sem nenhum import/export de nível superior, o TypeScript trata este arquivo
// como script global — e a `let status` do topo passa a resolver para a global
// depreciada `Window.status` (lib.dom), gerando avisos "'status' is deprecated"
// em toda referência (além de colidir como redeclaração). Como módulo, `status`
// é um binding local do módulo e o problema some. Seguro em runtime: já é
// carregado via `import './send-queue.js'` no service worker `"type": "module"`.
export {};
