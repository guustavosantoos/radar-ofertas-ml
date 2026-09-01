(function () {
  'use strict';

  console.log('[AchadinhoPRO:Amazon] Content script carregado');

  // ===== UTILITIES =====

  function getTextFromDOM(selector) {
    var el = document.querySelector(selector);
    return el ? (el.textContent || '').trim() : null;
  }

  function parsePrice(text) {
    if (!text) return null;
    // Em /events/ os cards trazem o preço com prefixo tipo "Preço da Oferta: R$ 42,10".
    // Extrai apenas o trecho numérico depois do R$, ou o último número formatado.
    var match = text.match(/R\$\s*([\d.]+,\d{2}|\d+)/);
    var raw;
    if (match) {
      raw = match[1];
    } else {
      var fallback = text.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
      if (!fallback) return null;
      raw = fallback[1];
    }
    var cleaned = raw.replace(/\./g, '').replace(',', '.');
    var value = parseFloat(cleaned);
    if (isNaN(value)) return null;
    // Convert to centavos (integer) for DB consistency
    return Math.round(value * 100);
  }

  // Módulo de seleção de preço (amazon-price-utils.js, carregado antes deste no
  // manifest). Garante que o preço-por-unidade ("R$ x / l") nunca seja confundido
  // com o preço atual ou com o "De". Fallback degradado (comportamento legado)
  // caso o módulo não carregue — assim a extensão nunca quebra por isso.
  var PU = (typeof window !== 'undefined' && window.AmazonPriceUtils) || {
    parsePrice: parsePrice,
    // Fallback com o MESMO guard essencial do módulo: nunca aceitar o
    // preço-por-unidade (apex-priceperunit-value / pricePerUnit) como preço.
    _notPerUnit: function (el) {
      return el && !(el.closest && el.closest('.apex-priceperunit-value, .pricePerUnit'));
    },
    pickCurrentPrice: function (r) {
      if (!r || !r.querySelectorAll) return null;
      var els = r.querySelectorAll('span.a-price .a-offscreen');
      for (var i = 0; i < els.length; i++) {
        if (!this._notPerUnit(els[i])) continue;
        if (els[i].closest && els[i].closest('span.a-price[data-a-strike="true"]')) continue;
        var v = parsePrice(els[i].textContent);
        if (v) return v;
      }
      return null;
    },
    pickOriginalPrice: function (r) {
      if (!r || !r.querySelectorAll) return null;
      var els = r.querySelectorAll('span.a-price[data-a-strike="true"] .a-offscreen, span.a-text-price .a-offscreen');
      for (var i = 0; i < els.length; i++) {
        if (!this._notPerUnit(els[i])) continue;
        var v = parsePrice(els[i].textContent);
        if (v) return v;
      }
      return null;
    },
    computeDiscountPercent: function (_r, p, o) {
      return (p && o && o > p) ? Math.round(((o - p) / o) * 100) : null;
    },
  };
  if (!(typeof window !== 'undefined' && window.AmazonPriceUtils)) {
    console.warn('[AchadinhoPRO:Amazon] AmazonPriceUtils não carregou — usando fallback legado de preço');
  }

  // Módulo de normalização de imagem (amazon-image-utils.js, carregado antes deste
  // no manifest). Remove os modificadores da URL (._AC_SX..., ._AC_SL...) e recupera
  // a imagem master quadrada 1:1 — evita imagens cortadas no WhatsApp. Fallback
  // degradado (remoção só do bloco de modificadores) caso o módulo não carregue.
  var IMG = (typeof window !== 'undefined' && window.AmazonImageUtils) || {
    fullSizeAmazonImageUrl: function (url) {
      if (!url || typeof url !== 'string' || url.indexOf('/images/I/') === -1) return url || null;
      return url.replace(/(\/images\/I\/[A-Za-z0-9%@+-]+)\.[^/?#]*?(\.(?:jpg|jpeg|png|gif|webp))(\?[^"'\s]*)?$/i, '$1$2$3');
    },
    pickBestImageUrl: function (img) {
      if (!img) return null;
      var url = (img.getAttribute && img.getAttribute('data-old-hires')) || img.src;
      if (!url || url.indexOf('data:') !== -1) return null;
      return this.fullSizeAmazonImageUrl(url);
    },
  };
  if (!(typeof window !== 'undefined' && window.AmazonImageUtils)) {
    console.warn('[AchadinhoPRO:Amazon] AmazonImageUtils não carregou — usando fallback de imagem');
  }

  // Módulo de contagem de avaliações (amazon-reviews-utils.js, carregado antes
  // deste no manifest). Entende a abreviação da Amazon ("1,4 mil" → 1400), que o
  // parser antigo lia como 1. O fallback abaixo repete a MESMA regra essencial —
  // se ele degradasse para o parser antigo, um módulo que não carregasse traria
  // o bug de volta em silêncio.
  var RU = (typeof window !== 'undefined' && window.AmazonReviewsUtils) || {
    // Fallback com os MESMOS guards do módulo — não uma versão relaxada. Um
    // fallback que aceitasse "4,5" traria de volta, em silêncio, avaliação
    // inventada a partir da nota (o módulo devolve null e a busca continua).
    parseReviewsCount: function (text) {
      if (text === null || text === undefined) return null;
      var s = String(text).replace(/[\u00a0\u202f\u2007]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!s) return null;
      if (/(compra|vendid|r\$|\boff\b|entrega|frete|estoque|cupom|desconto|pedido|parcel)/i.test(s)) return null;
      s = s.replace(/[\d.,]+\s*(?:de\s*5(?:\s*estrelas)?|out\s*of\s*5(?:\s*stars)?)/gi, ' ');
      var m = s.match(/(\d{1,3}(?:\.\d{3})+|\d+(?:[.,]\d+)?)\s*(mil|mi|k|m)?\b/);
      if (!m) return null;
      var raw = m[1];
      var mult = m[2] ? ((m[2] === 'mil' || m[2] === 'k') ? 1000 : 1000000) : 1;
      if (/^\d{1,3}(\.\d{3})+$/.test(raw)) raw = raw.replace(/\./g, '');
      else if (/[.,]\d{1,2}$/.test(raw)) {
        if (!m[2]) return null; // decimal sem sufixo é a NOTA, não a contagem
        raw = raw.replace(',', '.');
      }
      var n = parseFloat(raw);
      return isNaN(n) ? null : Math.round(n * mult);
    },
    pickReviewsCount: function (root) {
      if (!root || !root.querySelectorAll) return null;
      var sels = [
        '#acrCustomerReviewText',
        'a[href*="#customerReviews"][aria-label]',
        'span[aria-label*="avalia"]',
        'span[aria-label*="classifica"]',
        'a[href*="#customerReviews"] span.a-size-base',
        'span.a-size-base.s-underline-text',
        '.a-size-small span.a-size-base',
      ];
      for (var i = 0; i < sels.length; i++) {
        var els = root.querySelectorAll(sels[i]) || [];
        for (var j = 0; j < els.length; j++) {
          var aria = els[j].getAttribute ? els[j].getAttribute('aria-label') : null;
          var v = this.parseReviewsCount(aria);
          if (v === null) v = this.parseReviewsCount(els[j].textContent);
          if (v !== null) return v;
        }
      }
      return null;
    },
  };
  if (!(typeof window !== 'undefined' && window.AmazonReviewsUtils)) {
    console.warn('[AchadinhoPRO:Amazon] AmazonReviewsUtils não carregou — usando fallback de avaliações');
  }

  // ===== PAGE TYPE DETECTION =====

  function getPageType() {
    var path = window.location.pathname;
    var search = window.location.search;
    var href = window.location.href;
    // Homepage: amazon.com.br/ or amazon.com.br (with optional query params)
    if (path === '/' && !search.includes('k=') && !search.includes('node=')) return 'homepage';
    // Product page
    if (/\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(path)) return 'product';
    // Deals — check before category to avoid false match on /deals?node=...
    if (path.includes('/deals') || path.includes('/gp/goldbox') || path.includes('/gp/deals') || href.includes('/deals') || path.includes('/events/')) return 'listing_deals';
    // Bestsellers
    if (path.includes('/bestsellers') || path.includes('/gp/bestsellers') || path.includes('/Best-Sellers') || href.includes('/bestsellers')) return 'listing_bestsellers';
    // Movers and shakers
    if (path.includes('/movers-and-shakers') || path.includes('/gp/movers-and-shakers') || href.includes('/movers-and-shakers')) return 'listing_movers';
    // New releases — check before category
    if (path.includes('/new-releases') || path.includes('/gp/new-releases')) return 'listing_new_releases';
    // Category browse pages (/b?node=, /b/, /gp/browse.html)
    if (/^\/b\/?$/.test(path) || path.includes('/gp/browse') || (search.includes('node=') && !path.includes('/dp/'))) return 'listing_category';
    // Search results
    if (path.includes('/s') || search.includes('k=') || path.includes('/s?')) return 'listing_search';
    return 'unknown';
  }

  function detectOfferType() {
    var pt = getPageType();
    if (pt === 'listing_deals') return 'deal';
    if (pt === 'listing_bestsellers') return 'bestseller';
    if (pt === 'listing_movers') return 'movers_and_shakers';
    if (pt === 'listing_category') return 'category';
    if (pt === 'listing_new_releases') return 'new_releases';
    return null;
  }

  // ===== SINGLE PRODUCT EXTRACTION =====

  function extractAsinFromUrl() {
    var match = window.location.href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    return match ? match[1] : null;
  }

  function extractAsinFromDOM() {
    var el = document.getElementById('ASIN');
    if (el) return el.value || el.textContent.trim();
    var input = document.querySelector('input[name="ASIN"]');
    if (input) return input.value;
    return null;
  }

  function extractAsin() {
    return extractAsinFromUrl() || extractAsinFromDOM();
  }

  // Escopos do bloco de preço da PDP, do mais específico ao mais amplo.
  var PDP_PRICE_SCOPES = [
    '#corePriceDisplay_desktop_feature_div',
    '#corePrice_feature_div',
    '#apex_desktop',
  ];

  function extractPrice() {
    // Preço atual (priceToPay) — nunca o preço-por-unidade nem o riscado.
    for (var i = 0; i < PDP_PRICE_SCOPES.length; i++) {
      var scope = document.querySelector(PDP_PRICE_SCOPES[i]);
      if (scope) {
        var v = PU.pickCurrentPrice(scope);
        if (v) return v;
      }
    }
    // Fallbacks legados de buybox (layouts antigos).
    var legacy = ['#priceblock_ourprice', '#priceblock_dealprice', '#price_inside_buybox'];
    for (var k = 0; k < legacy.length; k++) {
      var le = document.querySelector(legacy[k]);
      if (le) {
        var lv = parsePrice(le.textContent);
        if (lv) return lv;
      }
    }
    // Último recurso: qualquer preço da página, ainda com os guards.
    return PU.pickCurrentPrice(document);
  }

  function extractOriginalPrice() {
    // Preço "De" (basisprice/riscado) — null quando não existe (sem desconto).
    for (var i = 0; i < PDP_PRICE_SCOPES.length; i++) {
      var scope = document.querySelector(PDP_PRICE_SCOPES[i]);
      if (scope) {
        var v = PU.pickOriginalPrice(scope);
        if (v) return v;
      }
    }
    return PU.pickOriginalPrice(document);
  }

  function extractDiscountPercent(price, originalPrice) {
    // Só há desconto quando há "De". Prefere o % oficial da Amazon, escopado ao
    // bloco de preço para não capturar o savings de outro produto na página.
    for (var i = 0; i < PDP_PRICE_SCOPES.length; i++) {
      var scope = document.querySelector(PDP_PRICE_SCOPES[i]);
      if (scope && scope.querySelector('span.savingsPercentage')) {
        return PU.computeDiscountPercent(scope, price, originalPrice);
      }
    }
    return PU.computeDiscountPercent(document, price, originalPrice);
  }

  function extractRating() {
    var el = document.querySelector('#acrPopover span.a-icon-alt, span.a-icon-alt');
    if (el) {
      var text = el.textContent || '';
      // "4,7 de 5 estrelas" → 47 (escala 0-50, onde 4.7 = 47)
      var match = text.match(/([\d,]+)\s+de\s+5/);
      if (match) return Math.round(parseFloat(match[1].replace(',', '.')) * 10);
    }
    return null;
  }

  // Onde a contagem vive na PDP. O fallback é ESCOPADO: varrer o `document`
  // inteiro faria os seletores genéricos do pickReviewsCount alcançarem
  // qualquer span numérico da página (parcelas, quantidade) e inventarem uma
  // contagem para um produto que não tem nenhuma.
  var PDP_REVIEW_SCOPES = [
    '#averageCustomerReviews',
    '#acrCustomerReviewLink',
    '[data-hook="total-review-count"]',
    '#reviewsMedley',
  ];

  function extractReviewsCount() {
    var el = document.getElementById('acrCustomerReviewText');
    // "1.412 avaliações" → 1412; "3,5 mil avaliações" → 3500. O parser antigo
    // (`/([\d.]+)/` + remoção de pontos) parava na vírgula e devolvia 3.
    if (el) {
      var count = RU.parseReviewsCount(el.textContent);
      if (count !== null) return count;
    }
    for (var i = 0; i < PDP_REVIEW_SCOPES.length; i++) {
      var scope = document.querySelector(PDP_REVIEW_SCOPES[i]);
      if (!scope) continue;
      var doEscopo = RU.pickReviewsCount(scope);
      if (doEscopo === null && scope.textContent) doEscopo = RU.parseReviewsCount(scope.textContent);
      if (doEscopo !== null) return doEscopo;
    }
    return null;
  }

  function extractImageUrl() {
    var selectors = ['#imgTagWrapperId img', '#landingImage', '#imgBlkFront', '#main-image'];
    for (var i = 0; i < selectors.length; i++) {
      var img = document.querySelector(selectors[i]);
      if (img) {
        // pickBestImageUrl escolhe a melhor fonte (data-old-hires / dynamic / src)
        // e normaliza para a imagem master quadrada — nunca a versão autocropada.
        var url = IMG.pickBestImageUrl(img);
        if (url) return url;
      }
    }
    return null;
  }

  function extractIsPrime() {
    return !!document.querySelector('i.a-icon-prime, .a-icon-prime');
  }

  // Detecta frete grátis via Prime OU via texto/badge de "Frete GRÁTIS" no DOM.
  // Antes o código assumia freeShipping === isPrime, perdendo vendedores non-Prime
  // com frete próprio gratuito.
  function hasFreeShipping(root) {
    var scope = root || document;
    if (scope.querySelector('i.a-icon-prime, .a-icon-prime')) return true;
    // Bloco de frete na PDP / listing — procura por "GRÁTIS" ou "Grátis" em textos
    // rotulados como mensagens de frete/entrega.
    var shippingSelectors = [
      '#mir-layout-DELIVERY_BLOCK',
      '#deliveryBlockMessage',
      '#amazonGlobal_feature_div',
      '[data-csa-c-delivery-price]',
      '.a-color-base.a-text-bold',
      '.a-color-success',
    ];
    for (var i = 0; i < shippingSelectors.length; i++) {
      var nodes = scope.querySelectorAll(shippingSelectors[i]);
      for (var j = 0; j < nodes.length; j++) {
        var txt = (nodes[j].textContent || '').toLowerCase();
        if (/\bgr[aá]tis\b/.test(txt) && /(frete|entrega|envio)/.test(txt)) return true;
      }
    }
    return false;
  }

  function extractSellerName() {
    var el = document.getElementById('sellerProfileTriggerId');
    if (el) return (el.textContent || '').trim();
    var merchantInfo = document.getElementById('merchant-info');
    if (merchantInfo) {
      var text = (merchantInfo.textContent || '').trim();
      var match = text.match(/(?:vendido por|sold by)\s+(.+?)(?:\.|$)/i);
      if (match) return match[1].trim();
      return text;
    }
    var buyboxSeller = document.querySelector('#tabular-buybox .tabular-buybox-text a, #merchantInfoFeature .a-link-normal');
    if (buyboxSeller) return (buyboxSeller.textContent || '').trim();
    return null;
  }

  function extractCategoryName() {
    // Product page: breadcrumbs
    var breadcrumb = document.getElementById('wayfinding-breadcrumbs_feature_div');
    if (breadcrumb) {
      var links = breadcrumb.querySelectorAll('a');
      if (links.length > 0) return (links[links.length - 1].textContent || '').trim();
    }
    return null;
  }

  function extractCategoryBreadcrumb() {
    // Helper: reject strings that look like prices/deals/garbage instead of real category names
    function isValidBreadcrumbItem(text) {
      if (!text || text.length < 2 || text.length > 80) return false;
      // Reject if contains price patterns (R$, digits with comma/dot currency)
      if (/R\$|^\d+[.,]\d{2}$|^\d+%\s*off/i.test(text)) return false;
      // Reject if looks like deal badge text
      if (/^Ofertas?\s*\d|^Deal|^\d+\s*%|Próxima página|Página anterior/i.test(text)) return false;
      return true;
    }

    // Strategy A: Left sidebar category tree (bestsellers/movers pages)
    // Amazon renders a nested UL tree where each level is a li > a or li > span
    var browseRoot = document.getElementById('zg_browseRoot');
    if (browseRoot) {
      var allLinks = browseRoot.querySelectorAll('a, span.zg_selected');
      var path = [];
      for (var i = 0; i < allLinks.length; i++) {
        var text = (allLinks[i].textContent || '').trim();
        if (isValidBreadcrumbItem(text)) {
          path.push(text);
        }
      }
      if (path.length > 1) {
        console.log('[AchadinhoPRO:Amazon] Breadcrumb (browseRoot):', path.join(' > '));
        return path;
      }
    }

    // Strategy B: Newer Amazon layout — role="tree" or role="group" navigation
    var treeNav = document.querySelector('[role="tree"], [role="group"], #zg-left-col');
    if (treeNav) {
      // Use more restrictive selectors — only direct link/text elements, not all spans
      var treeLinks = treeNav.querySelectorAll('a[href], [role="treeitem"], li > span:not(:empty)');
      var path2 = [];
      var seen2 = {};  // Use object as Set for full dedup (not just consecutive)
      for (var j = 0; j < treeLinks.length; j++) {
        var t2 = (treeLinks[j].textContent || '').trim();
        // Skip generic labels, empty, too long, or already seen
        if (isValidBreadcrumbItem(t2) &&
            !seen2[t2] &&
            !/^(qualquer|any)\s/i.test(t2) &&
            !/^(voltar|back)/i.test(t2)) {
          seen2[t2] = true;
          path2.push(t2);
        }
      }
      if (path2.length > 1) {
        console.log('[AchadinhoPRO:Amazon] Breadcrumb (treeNav):', path2.join(' > '));
        return path2;
      }
    }

    // Strategy C: Generic UL>LI tree inside main content (matches user's XPath pattern)
    // /html/body/div[1]/div[2]/div[2]/div[2]/div/div/div[1]/ul/li[*]/span/h2
    var listItems = document.querySelectorAll('ul > li > span > h2, ul > li > a > h2');
    if (listItems.length > 1) {
      var path3 = [];
      for (var k = 0; k < listItems.length; k++) {
        var t3 = (listItems[k].textContent || '').trim();
        if (isValidBreadcrumbItem(t3)) {
          path3.push(t3);
        }
      }
      if (path3.length > 1) {
        console.log('[AchadinhoPRO:Amazon] Breadcrumb (ul>li>span>h2):', path3.join(' > '));
        return path3;
      }
    }

    // Strategy D: Search page refinements sidebar — category navigation with indent levels
    // li elements have classes like s-navigation-indent-1, s-navigation-indent-2 showing depth
    var refinements = document.getElementById('s-refinements');
    if (refinements) {
      var navItems = refinements.querySelectorAll('li[class*="s-navigation-indent"]');
      var path5 = [];
      for (var n = 0; n < navItems.length; n++) {
        // Only collect items that are bold (current path) or ancestors of bold
        var boldEl = navItems[n].querySelector('.a-text-bold');
        var linkEl = navItems[n].querySelector('a');
        if (boldEl) {
          var boldText = (boldEl.textContent || '').trim();
          if (boldText.length > 1 && boldText.length < 80) {
            path5.push(boldText);
          }
          break; // Bold = current level, we're done
        } else if (linkEl) {
          // Check if this is a parent category (lower indent than bold item)
          var itemText = (linkEl.textContent || '').trim();
          if (itemText.length > 1 && itemText.length < 80 &&
              !/^(qualquer|any|todos|all)\s/i.test(itemText) &&
              !/^(voltar|back)/i.test(itemText)) {
            path5.push(itemText);
          }
        }
      }
      if (path5.length > 0) {
        console.log('[AchadinhoPRO:Amazon] Breadcrumb (refinements):', path5.join(' > '));
        return path5;
      }
    }

    // Strategy E: Product page breadcrumbs
    var breadcrumb = document.getElementById('wayfinding-breadcrumbs_feature_div');
    if (breadcrumb) {
      var links = breadcrumb.querySelectorAll('a');
      var path4 = [];
      for (var m = 0; m < links.length; m++) {
        var t4 = (links[m].textContent || '').trim();
        if (t4 && t4.length > 1) path4.push(t4);
      }
      if (path4.length > 0) {
        console.log('[AchadinhoPRO:Amazon] Breadcrumb (wayfinding):', path4.join(' > '));
        return path4;
      }
    }

    return null;
  }

  function extractListingCategoryName() {
    // Strategy 1: Amazon category card title div - exact selector from DOM
    // <div class="_cDEzb_card-title_2sYgw"><h1>Mais Vendidos em Aquecedores de Mamadeira</h1></div>
    var cardTitle = document.querySelector('div[class*="card-title"] h1, ._cDEzb_card-title_2sYgw h1');
    if (cardTitle) {
      var ctText = (cardTitle.textContent || '').trim();
      var ctMatch = ctText.match(/^(?:Mais [Vv]endidos|Produtos em [Aa]lta|[Oo]fertas|Best\s*[Ss]ellers|Movers.*Shakers)\s+(?:em|in)\s+(.+)$/i);
      if (ctMatch) {
        console.log('[AchadinhoPRO:Amazon] Categoria detectada (card-title):', ctMatch[1].trim());
        return ctMatch[1].trim();
      }
      // If no prefix match, use full text if reasonable
      if (ctText.length > 1 && ctText.length < 100) return ctText;
    }

    // Strategy 2: Any h1 with "Mais Vendidos em X" pattern
    var allH1 = document.querySelectorAll('h1');
    for (var h = 0; h < allH1.length; h++) {
      var h1Text = (allH1[h].textContent || '').trim();
      var h1Match = h1Text.match(/^(?:Mais [Vv]endidos|Produtos em [Aa]lta|[Oo]fertas|Best\s*[Ss]ellers|Movers.*Shakers)\s+(?:em|in)\s+(.+)$/i);
      if (h1Match) {
        console.log('[AchadinhoPRO:Amazon] Categoria detectada (h1):', h1Match[1].trim());
        return h1Match[1].trim();
      }
    }

    // Strategy 3: Banner text elements
    var selectors = ['#zg_banner_text', '#zg-banner-text', '#departmentTitle', '#zg_browseRoot .zg_selected'];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) {
        var text = (el.textContent || '').trim();
        var cleaned = text.replace(/^(?:Mais [Vv]endidos|Produtos em [Aa]lta|[Oo]fertas)\s+(?:em|in)\s+/i, '').trim();
        if (cleaned && cleaned.length > 1 && cleaned.length < 100) return cleaned;
      }
    }

    // Strategy 4: s-metadata JSON — search pages scoped to a category
    // Amazon embeds {"scopedCategoryName":"Babás Eletrônicas"} in a script tag
    var scripts = document.querySelectorAll('script');
    for (var s = 0; s < scripts.length; s++) {
      var scriptText = scripts[s].textContent || '';
      var metaMatch = scriptText.match(/["']scopedCategoryName["']\s*:\s*["']([^"']+)["']/);
      if (metaMatch && metaMatch[1].length > 1 && metaMatch[1].length < 100) {
        console.log('[AchadinhoPRO:Amazon] Categoria detectada (s-metadata):', metaMatch[1]);
        return metaMatch[1];
      }
    }

    // Strategy 5: Search dropdown selected option — category-scoped search pages
    var selectedOption = document.querySelector('#searchDropdownBox option[selected]');
    if (selectedOption) {
      var optText = (selectedOption.textContent || '').trim();
      // Skip generic "Todos os departamentos"
      if (optText && optText.length > 1 && optText.length < 100 &&
          !/^(todos|all)\s/i.test(optText)) {
        console.log('[AchadinhoPRO:Amazon] Categoria detectada (dropdown):', optText);
        return optText;
      }
    }

    // Strategy 6: Refinements accessibility summary — "Filtros selecionados: X"
    var refinementsSummary = document.getElementById('s-refinements-a11y-summary');
    if (refinementsSummary) {
      var summaryText = (refinementsSummary.textContent || '').trim();
      var filterMatch = summaryText.match(/(?:filtros?\s+selecionados?|selected\s+filters?)\s*:\s*(.+)/i);
      if (filterMatch) {
        var filterCat = filterMatch[1].trim();
        if (filterCat.length > 1 && filterCat.length < 100) {
          console.log('[AchadinhoPRO:Amazon] Categoria detectada (refinements):', filterCat);
          return filterCat;
        }
      }
    }

    // Strategy 7: Bold text in refinements nav — current selected category
    var boldCat = document.querySelector('#s-refinements .a-text-bold');
    if (boldCat) {
      var boldText = (boldCat.textContent || '').trim();
      if (boldText.length > 1 && boldText.length < 100) {
        console.log('[AchadinhoPRO:Amazon] Categoria detectada (refinements-bold):', boldText);
        return boldText;
      }
    }

    // Strategy 8: Search term
    var searchTerm = document.querySelector('#search h1 .a-color-state, span.a-color-state');
    if (searchTerm) {
      var term = (searchTerm.textContent || '').trim().replace(/^"/, '').replace(/"$/, '').trim();
      if (term && term.length > 1) return term;
    }

    // Strategy 10: URL path slug
    var path = window.location.pathname;
    var catMatch = path.match(/\/(?:bestsellers|movers-and-shakers|deals)\/([^\/]+)/);
    if (catMatch) {
      var slug = decodeURIComponent(catMatch[1]).replace(/-/g, ' ');
      return slug.charAt(0).toUpperCase() + slug.slice(1);
    }

    // Strategy 11: page title
    var title = document.title || '';
    var titleMatch = title.match(/(?:Mais [Vv]endidos|Produtos em [Aa]lta|[Oo]fertas)\s+(?:em|in)\s+(.+?)(?:\s*[-|]|\s*$)/i);
    if (titleMatch) return titleMatch[1].trim();

    return null;
  }

  function extractSingleProduct() {
    var asin = extractAsin();
    if (!asin) return null;

    var price = extractPrice();
    var originalPrice = extractOriginalPrice();

    var breadcrumb = extractCategoryBreadcrumb();

    return {
      asin: asin,
      platformItemId: asin,
      productName: getTextFromDOM('#productTitle'),
      price: price,
      originalPrice: originalPrice,
      discountPercent: extractDiscountPercent(price, originalPrice),
      ratingStar: extractRating(),
      reviewsCount: extractReviewsCount(),
      imageUrl: extractImageUrl(),
      isPrime: extractIsPrime(),
      freeShipping: hasFreeShipping(document),
      sellerName: extractSellerName(),
      categoryName: extractCategoryName(),
      categoryBreadcrumb: breadcrumb,
      productLink: 'https://www.amazon.com.br/dp/' + asin,
      productUrl: 'https://www.amazon.com.br/dp/' + asin,
      platform: 'amazon',
      marketplace: 'amazon',
    };
  }

  // ===== LISTING EXTRACTION =====

  function extractAsinFromLink(link) {
    if (!link) return null;
    var match = link.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    return match ? match[1] : null;
  }

  function extractListingProducts() {
    var products = [];
    var seen = {};
    var offerType = detectOfferType();

    // Robust offerType detection: also check the actual URL at extraction time
    // (SPA navigation may have changed the URL since content script loaded)
    var currentUrl = window.location.href;
    var currentPath = window.location.pathname;
    if (!offerType || offerType === 'category' || offerType === null) {
      if (currentPath.includes('/deals') || currentPath.includes('/gp/goldbox') || currentPath.includes('/gp/deals') || currentUrl.includes('/deals')) {
        console.log('[AchadinhoPRO:Amazon] URL contains /deals but detectOfferType returned "' + offerType + '" — overriding to "deal"');
        offerType = 'deal';
      } else if (currentPath.includes('/bestsellers') || currentPath.includes('/gp/bestsellers') || currentPath.includes('/Best-Sellers') || currentUrl.includes('/bestsellers')) {
        console.log('[AchadinhoPRO:Amazon] URL contains /bestsellers but detectOfferType returned "' + offerType + '" — overriding to "bestseller"');
        offerType = 'bestseller';
      } else if (currentPath.includes('/movers-and-shakers') || currentPath.includes('/gp/movers-and-shakers') || currentUrl.includes('/movers-and-shakers')) {
        console.log('[AchadinhoPRO:Amazon] URL contains /movers-and-shakers but detectOfferType returned "' + offerType + '" — overriding to "movers_and_shakers"');
        offerType = 'movers_and_shakers';
      }
    }
    console.log('[AchadinhoPRO:Amazon] extractListingProducts: pageType=' + getPageType() + ', offerType=' + offerType + ', url=' + currentPath);

    // Category from page - use robust detection
    var categoryName = extractListingCategoryName();
    var categoryBreadcrumb = extractCategoryBreadcrumb();

    // === Strategy 1: Search results / standard grid ===
    // Skip on deals pages — Strategy 1 picks up footer/recommendation products instead of actual deals
    var isDealsUrl = currentPath.includes('/deals') || currentPath.includes('/goldbox') || currentPath.includes('/gp/deals') || currentPath.includes('/events/');
    // Also detect deals pages by DOM structure (e.g. /b?node= pages that show deal cards)
    if (!isDealsUrl) {
      var hasDealCards = document.querySelectorAll('[data-testid="deal-card"], .DealCard-module__card, [data-deal-id], .dealTile, div[id^="100_dealView_"]').length > 0;
      if (hasDealCards) {
        console.log('[AchadinhoPRO:Amazon] DOM contains deal cards — treating as deals page');
        isDealsUrl = true;
      }
    }
    if (!isDealsUrl) {
      var cards = document.querySelectorAll(
        '[data-component-type="s-search-result"], ' +
        '.s-result-item[data-asin], ' +
        '.sg-col-inner .s-result-item'
      );

      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var asin = card.getAttribute('data-asin');
        if (!asin || asin.length !== 10 || seen[asin]) continue;

        var nameEl = card.querySelector('h2 a span, h2 span, .a-text-normal');
        var productName = nameEl ? (nameEl.textContent || '').trim() : null;
        if (!productName) continue;

        // Price
        var priceEl = card.querySelector('span.a-price .a-offscreen');
        var price = priceEl ? parsePrice(priceEl.textContent) : null;

        // Original price ("De") — pickOriginalPrice ignora o preço-por-unidade.
        var originalPrice = PU.pickOriginalPrice(card);

        // Discount
        var discount = null;
        if (price && originalPrice && originalPrice > price) {
          discount = Math.round(((originalPrice - price) / originalPrice) * 100);
        }

        // Image
        var imgEl = card.querySelector('img.s-image, img[data-image-latency]');
        var imageUrl = imgEl ? IMG.fullSizeAmazonImageUrl(imgEl.src) : null;

        // Rating
        var ratingEl = card.querySelector('span.a-icon-alt, i.a-icon-star-small span.a-icon-alt');
        var ratingStar = null;
        if (ratingEl) {
          var rMatch = (ratingEl.textContent || '').match(/([\d,]+)\s+de\s+5/);
          if (rMatch) ratingStar = Math.round(parseFloat(rMatch[1].replace(',', '.')) * 10);
        }

        // Reviews count — "(1,4 mil)" vale 1400, não 1. Ver amazon-reviews-utils.js.
        var reviewsCount = RU.pickReviewsCount(card);

        // Prime
        var isPrime = !!card.querySelector('i.a-icon-prime, .a-icon-prime');

        seen[asin] = true;
        products.push({
          asin: asin,
          platformItemId: asin,
          productName: productName,
          price: price,
          originalPrice: originalPrice,
          discountPercent: discount,
          ratingStar: ratingStar,
          reviewsCount: reviewsCount,
          imageUrl: imageUrl,
          isPrime: isPrime,
          freeShipping: isPrime || hasFreeShipping(card),
          sellerName: null,
          categoryName: categoryName,
          categoryBreadcrumb: categoryBreadcrumb,
          productLink: 'https://www.amazon.com.br/dp/' + asin,
          productUrl: 'https://www.amazon.com.br/dp/' + asin,
          offerType: offerType,
          platform: 'amazon',
          marketplace: 'amazon',
        });
      }
    }

    // === Strategy 1b: DCL grid / PUIS cards (e.g. /b?node= offers pages) ===
    if (products.length === 0) {
      var puisCards = document.querySelectorAll(
        'div[data-cy="asin-faceout-container"], ' +
        '.dcl-html-grid div.desktop-dossier-view'
      );
      console.log('[AchadinhoPRO:Amazon] Strategy 1b (PUIS/dcl-grid cards): found ' + puisCards.length + ' elements');

      for (var pi = 0; pi < puisCards.length; pi++) {
        var pc = puisCards[pi];
        // Skip cards inside footer/recommendations
        if (pc.closest('#rhf-container, #rhf-shoveler, .rhf-border, [class*="rhf-"]')) continue;

        var pcLink = pc.querySelector('a[href*="/dp/"]');
        var pcAsin = pcLink ? extractAsinFromLink(pcLink.href) : null;
        if (!pcAsin || seen[pcAsin]) continue;

        var pcNameEl = pc.querySelector('h2 a span, h2 span, .a-text-normal, [class*="Title"], [class*="title"], [data-cy*="title"]');
        var pcName = pcNameEl ? (pcNameEl.textContent || '').trim() : null;
        // Fallback: img alt / link aria-label — Amazon /events/ frequentemente
        // renderiza cards sem h2 visível mas com alt/aria-label preenchidos.
        // Sanitiza o alt: strip de prefixos como "Imagem do produto:" e
        // descarta valores genéricos tipo "Amazon Prime" (alt do badge Prime).
        if (!pcName) {
          var pcImgAlt = pc.querySelector('img[alt]');
          if (pcImgAlt) {
            var altCandidate = (pcImgAlt.getAttribute('alt') || '').trim();
            altCandidate = altCandidate.replace(/^imagem\s+do\s+produto[:\s]*/i, '').trim();
            if (altCandidate.length > 3 && !/^amazon\s+prime$|^prime$/i.test(altCandidate)) {
              pcName = altCandidate;
            }
          }
        }
        if (!pcName) {
          var pcAria = pc.querySelector('a[aria-label]');
          if (pcAria) pcName = (pcAria.getAttribute('aria-label') || '').trim();
        }
        if (!pcName || pcName.length < 3) continue;

        var pcPriceEl = pc.querySelector('span.a-price .a-offscreen');
        var pcPrice = pcPriceEl ? parsePrice(pcPriceEl.textContent) : null;

        var pcOriginalPrice = PU.pickOriginalPrice(pc);

        var pcDiscount = null;
        if (pcPrice && pcOriginalPrice && pcOriginalPrice > pcPrice) {
          pcDiscount = Math.round(((pcOriginalPrice - pcPrice) / pcOriginalPrice) * 100);
        }

        var pcImgEl = pc.querySelector('img.s-image, img[data-image-latency]');
        var pcImageUrl = pcImgEl ? IMG.fullSizeAmazonImageUrl(pcImgEl.src) : null;

        var pcRatingEl = pc.querySelector('span.a-icon-alt');
        var pcRatingStar = null;
        if (pcRatingEl) {
          var pcRMatch = (pcRatingEl.textContent || '').match(/([\d,]+)\s+de\s+5/);
          if (pcRMatch) pcRatingStar = Math.round(parseFloat(pcRMatch[1].replace(',', '.')) * 10);
        }

        var pcReviewsCount = RU.pickReviewsCount(pc);

        var pcIsPrime = !!pc.querySelector('i.a-icon-prime, .a-icon-prime');

        seen[pcAsin] = true;
        products.push({
          asin: pcAsin,
          platformItemId: pcAsin,
          productName: pcName,
          price: pcPrice,
          originalPrice: pcOriginalPrice,
          discountPercent: pcDiscount,
          ratingStar: pcRatingStar,
          reviewsCount: pcReviewsCount,
          imageUrl: pcImageUrl,
          isPrime: pcIsPrime,
          freeShipping: pcIsPrime || hasFreeShipping(pc),
          sellerName: null,
          categoryName: categoryName,
          categoryBreadcrumb: categoryBreadcrumb,
          productLink: 'https://www.amazon.com.br/dp/' + pcAsin,
          productUrl: 'https://www.amazon.com.br/dp/' + pcAsin,
          offerType: offerType || 'deal',
          platform: 'amazon',
          marketplace: 'amazon',
        });
      }
    }

    // === Strategy 2: Bestsellers / Movers & Shakers grid ===
    // NÃO roda em deals/events/goldbox: o seletor `.a-carousel-card` é genérico
    // e captura carrosseis "Você também pode gostar" / "Recomendados" que NÃO
    // pertencem ao filtro de categoria/preço/desconto aplicado pelo usuário.
    // Em /events/ofertasmensais isso vazava 49 produtos não-filtrados.
    if (products.length === 0 && !isDealsUrl) {
      var gridCards = document.querySelectorAll(
        '#gridItemRoot, ' +
        '.zg-grid-general-faceout, ' +
        '.p13n-desktop-grid [id^="p13n-asin-index-"], ' +
        '.a-carousel-card, ' +
        '[data-a-carousel-options] .a-list-item'
      );

      for (var j = 0; j < gridCards.length; j++) {
        var gc = gridCards[j];

        // Skip cards inside footer/recommendations/rhf sections
        if (gc.closest('#rhf-container, #rhf-shoveler, .rhf-border, [class*="rhf-"], [data-csa-c-slot-id*="rhf"]')) continue;

        // Find ASIN from link
        var gcLink = gc.querySelector('a[href*="/dp/"]');
        var gcAsin = gcLink ? extractAsinFromLink(gcLink.href) : null;
        if (!gcAsin || seen[gcAsin]) continue;

        var gcNameEl = gc.querySelector('.p13n-sc-truncate, .p13n-sc-truncated, ._cDEzb_p13n-sc-css-line-clamp-3_g3dy1, .a-link-normal span div, a.a-link-normal span');
        var gcName = gcNameEl ? (gcNameEl.textContent || '').trim() : null;
        if (!gcName) continue;

        var gcPriceEl = gc.querySelector('span.a-price .a-offscreen, .p13n-sc-price, ._cDEzb_p13n-sc-price_3mJ9Z');
        var gcPrice = gcPriceEl ? parsePrice(gcPriceEl.textContent) : null;

        var gcOrigPrice = PU.pickOriginalPrice(gc);

        var gcDiscount = null;
        if (gcPrice && gcOrigPrice && gcOrigPrice > gcPrice) {
          gcDiscount = Math.round(((gcOrigPrice - gcPrice) / gcOrigPrice) * 100);
        }

        // Find the product image, skipping ranking icons (green/red arrows) and tiny badges
        var gcImageUrl = null;
        var gcAllImgs = gc.querySelectorAll('img');
        for (var gi = 0; gi < gcAllImgs.length; gi++) {
          var candidateImg = gcAllImgs[gi];
          var candidateSrc = candidateImg.src || candidateImg.getAttribute('data-src') || '';
          // Skip empty, data URIs, and SVGs
          if (!candidateSrc || candidateSrc.indexOf('data:') === 0 || candidateSrc.indexOf('.svg') !== -1) continue;
          // Skip tiny images (ranking arrows, badges, icons are typically < 60px)
          var imgW = candidateImg.naturalWidth || candidateImg.width || parseInt(candidateImg.getAttribute('width')) || 0;
          var imgH = candidateImg.naturalHeight || candidateImg.height || parseInt(candidateImg.getAttribute('height')) || 0;
          if ((imgW > 0 && imgW < 60) || (imgH > 0 && imgH < 60)) continue;
          // Skip known icon/arrow patterns in URL
          if (/arrow|icon|badge|sprite|rank|stock|logo/i.test(candidateSrc)) continue;
          gcImageUrl = IMG.fullSizeAmazonImageUrl(candidateSrc);
          break;
        }

        var gcRatingEl = gc.querySelector('span.a-icon-alt');
        var gcRating = null;
        if (gcRatingEl) {
          var grMatch = (gcRatingEl.textContent || '').match(/([\d,]+)\s+de\s+5/);
          if (grMatch) gcRating = Math.round(parseFloat(grMatch[1].replace(',', '.')) * 10);
        }

        // O seletor legado (`.a-size-small span:last-child`) tanto lia "3,5 mil"
        // como 3 quanto podia pegar o span vizinho ("Mais de 700 compras"). O
        // pickReviewsCount exige que o texto do fallback genérico seja SÓ uma
        // contagem, então esses vizinhos deixam de virar avaliação.
        var gcReviews = RU.pickReviewsCount(gc);

        seen[gcAsin] = true;
        products.push({
          asin: gcAsin,
          platformItemId: gcAsin,
          productName: gcName,
          price: gcPrice,
          originalPrice: gcOrigPrice,
          discountPercent: gcDiscount,
          ratingStar: gcRating,
          reviewsCount: gcReviews,
          imageUrl: gcImageUrl,
          isPrime: false,
          freeShipping: false,
          sellerName: null,
          categoryName: categoryName,
          categoryBreadcrumb: categoryBreadcrumb,
          productLink: 'https://www.amazon.com.br/dp/' + gcAsin,
          productUrl: 'https://www.amazon.com.br/dp/' + gcAsin,
          offerType: offerType,
          platform: 'amazon',
          marketplace: 'amazon',
        });
      }
    }

    // === Strategy 3: Deals page (multiple sub-strategies) ===
    if (products.length === 0 || isDealsUrl) {
      console.log('[AchadinhoPRO:Amazon] Trying deals-specific strategies (current products: ' + products.length + ')...');

      // === Strategy 3-Virtuoso: cards [data-testid="product-card"] ===
      // /events/ofertasmensais usa react-virtuoso (virtual scrolling). Os cards
      // FILTRADOS de verdade ficam em [data-testid="virtuoso-item-list"] com
      // [data-testid="product-card"][data-asin][data-deal-id]. Esses cards
      // têm o atributo `data-csa-c-filtered="true-deals-collection-baby"` (ou
      // similar) confirmando que são do filtro aplicado pelo usuário.
      // Carrosséis "Ofertas em destaque" (.dcl-html-carousel) NÃO devem entrar.
      var productCards = document.querySelectorAll('[data-testid="product-card"][data-asin]');
      console.log('[AchadinhoPRO:Amazon] Strategy 3-Virtuoso (product-card): found ' + productCards.length + ' elements');

      for (var vp = 0; vp < productCards.length; vp++) {
        var pcard = productCards[vp];
        // Excluir cards que estejam dentro de carrosséis "Ofertas em destaque"
        if (pcard.closest('.dcl-html-carousel, .dcl-product-wrapper, .a-carousel, .a-carousel-card')) continue;
        if (pcard.closest('#rhf-container, #rhf-shoveler, [class*="rhf-"]')) continue;

        var vAsin = pcard.getAttribute('data-asin');
        if (!vAsin || vAsin.length !== 10 || seen[vAsin]) continue;

        // Nome: <span class="a-truncate-full a-offscreen"> dentro do title-{ASIN}
        var vNameEl = pcard.querySelector('p[id^="title-"] .a-truncate-full.a-offscreen, [data-testid="product-card-link"] .a-truncate-full.a-offscreen, .a-truncate-full.a-offscreen');
        var vName = vNameEl ? (vNameEl.textContent || '').trim() : null;
        if (!vName) {
          var vImgAlt = pcard.querySelector('img[alt]');
          if (vImgAlt) vName = (vImgAlt.getAttribute('alt') || '').trim();
        }
        if (!vName || vName.length < 3) continue;

        // Preço: dentro de [data-testid="price-section"] o <span class="a-offscreen">
        // vem com prefixo "Preço da Oferta: R$ 42,10" — parsePrice já trata.
        var vPriceEl = pcard.querySelector('[data-testid="price-section"] .a-price .a-offscreen, .ProductCard-module__priceToPay_olAgJzVNGyj2javg2pAe .a-offscreen, .a-price .a-offscreen');
        var vPrice = vPriceEl ? parsePrice(vPriceEl.textContent) : null;

        // Preço original ("De: R$ 94,84") — pickOriginalPrice ignora preço-por-unidade;
        // fallback para o wrapPrice específico dos cards React de deals.
        var vOrigPrice = PU.pickOriginalPrice(pcard);
        if (!vOrigPrice) {
          var vOrigPriceEl = pcard.querySelector('.ProductCard-module__wrapPrice__sMO92NjAjHmGPn3jnIH .a-offscreen');
          vOrigPrice = vOrigPriceEl ? parsePrice(vOrigPriceEl.textContent) : null;
        }

        // Desconto: badge "_filledRoundedBadgeLabel_*" ou "_badgeLabel_*"
        var vDiscount = null;
        var vDiscountEl = pcard.querySelector('[class*="_filledRoundedBadgeLabel"] span, [class*="_badgeLabel"] span, [class*="filledRoundedBadgeLabel"] span');
        if (vDiscountEl) {
          var vdMatch = (vDiscountEl.textContent || '').match(/(\d+)\s*%/);
          if (vdMatch) vDiscount = parseInt(vdMatch[1]);
        }
        if (!vDiscount && vPrice && vOrigPrice && vOrigPrice > vPrice) {
          vDiscount = Math.round(((vOrigPrice - vPrice) / vOrigPrice) * 100);
        }

        // Imagem
        var vImgEl = pcard.querySelector('img.ProductCardImage-module__image_SU6C7KYJpko3vQ2fK7Kf, img[class*="ProductCardImage"], img');
        var vImageUrl = vImgEl ? IMG.fullSizeAmazonImageUrl(vImgEl.src || vImgEl.getAttribute('data-src')) : null;

        seen[vAsin] = true;
        products.push({
          asin: vAsin,
          platformItemId: vAsin,
          productName: vName,
          price: vPrice,
          originalPrice: vOrigPrice,
          discountPercent: vDiscount,
          ratingStar: null,
          reviewsCount: null,
          imageUrl: vImageUrl,
          isPrime: false,
          freeShipping: false,
          sellerName: null,
          categoryName: categoryName,
          categoryBreadcrumb: categoryBreadcrumb,
          productLink: 'https://www.amazon.com.br/dp/' + vAsin,
          productUrl: 'https://www.amazon.com.br/dp/' + vAsin,
          offerType: 'deal',
          platform: 'amazon',
          marketplace: 'amazon',
        });
      }
      console.log('[AchadinhoPRO:Amazon] Strategy 3-Virtuoso extracted ' + products.length + ' products total (after dedup)');

      // Strategy 3a: Deal cards with data-testid or known class patterns
      var dealCards = document.querySelectorAll(
        '[data-testid="deal-card"], ' +
        '.DealCard-module__card, ' +
        '.octopus-dlp-asin-section, ' +
        '.dealTile, ' +
        'div[id^="100_dealView_"], ' +
        '[data-deal-id], ' +
        '.deals-shoveler-item'
      );
      console.log('[AchadinhoPRO:Amazon] Strategy 3a (deal cards): found ' + dealCards.length + ' elements');
      // Diagnóstico extra quando 3a falha: lista seletores candidatos no DOM
      // para identificar quais são os cards filtrados pela Amazon naquele
      // momento (Amazon muda atributos com frequência).
      if (dealCards.length === 0 && isDealsUrl) {
        console.log('[AchadinhoPRO:Amazon] Strategy 3a found 0 — seletores candidatos no DOM:', {
          'a[href*="/dp/"]': document.querySelectorAll('a[href*="/dp/"]').length,
          '[data-asin]:not([data-asin=""])': document.querySelectorAll('[data-asin]:not([data-asin=""])').length,
          '[data-cy]': document.querySelectorAll('[data-cy]').length,
          '[data-cy*="card"]': document.querySelectorAll('[data-cy*="card"]').length,
          '[data-cy*="dossier"]': document.querySelectorAll('[data-cy*="dossier"]').length,
          '[data-cy*="faceout"]': document.querySelectorAll('[data-cy*="faceout"]').length,
          '[role="listitem"]': document.querySelectorAll('[role="listitem"]').length,
          '[data-testid]': document.querySelectorAll('[data-testid]').length,
          '[data-testid*="grid"]': document.querySelectorAll('[data-testid*="grid"]').length,
          '[data-testid*="cell"]': document.querySelectorAll('[data-testid*="cell"]').length,
          '.a-carousel-card': document.querySelectorAll('.a-carousel-card').length,
        });
      }

      for (var k = 0; k < dealCards.length; k++) {
        var dc = dealCards[k];
        // Skip cards inside footer/recommendations
        if (dc.closest('#rhf-container, #rhf-shoveler, .rhf-border, [class*="rhf-"]')) continue;

        var dcLink = dc.querySelector('a[href*="/dp/"], a[href*="/deal/"], a[href*="/gp/"]');
        var dcAsin = dcLink ? extractAsinFromLink(dcLink.href) : null;
        if (!dcAsin || seen[dcAsin]) continue;

        var dcNameEl = dc.querySelector('[class*="Title"], [class*="title"], a span, .a-text-normal, [class*="name"], [class*="Name"]');
        var dcName = dcNameEl ? (dcNameEl.textContent || '').trim() : null;
        if (!dcName) continue;

        var dcPriceEl = dc.querySelector('span.a-price .a-offscreen, [class*="Price"], [class*="price"]');
        var dcPrice = dcPriceEl ? parsePrice(dcPriceEl.textContent) : null;

        var dcImg = dc.querySelector('img');
        var dcImageUrl = dcImg ? IMG.fullSizeAmazonImageUrl(dcImg.src || dcImg.getAttribute('data-src')) : null;

        var dcDiscountEl = dc.querySelector('[class*="discount"], [class*="Discount"], .savingsPercentage, [class*="savings"], [class*="Savings"]');
        var dcDiscount = null;
        if (dcDiscountEl) {
          var ddMatch = (dcDiscountEl.textContent || '').match(/(\d+)\s*%/);
          if (ddMatch) dcDiscount = parseInt(ddMatch[1]);
        }

        seen[dcAsin] = true;
        products.push({
          asin: dcAsin,
          platformItemId: dcAsin,
          productName: dcName,
          price: dcPrice,
          originalPrice: null,
          discountPercent: dcDiscount,
          ratingStar: null,
          reviewsCount: null,
          imageUrl: dcImageUrl,
          isPrime: false,
          freeShipping: false,
          sellerName: null,
          categoryName: categoryName,
          categoryBreadcrumb: categoryBreadcrumb,
          productLink: 'https://www.amazon.com.br/dp/' + dcAsin,
          productUrl: 'https://www.amazon.com.br/dp/' + dcAsin,
          offerType: 'deal',
          platform: 'amazon',
          marketplace: 'amazon',
        });
      }

      // Strategy 3b: Generic — scan ALL links with /dp/ or /deal/ on deals pages
      // Amazon deals pages often use dynamic React components with no stable selectors
      // Also runs on /events/ pages (ofertasmensais e similares), que usam React puro
      // sem selectors estáveis — sem este fallback, filtros de categoria/preço/desconto
      // ficam sem produtos extraídos.
      // Strategy 3b skip rule: SÓ pula 3b quando há filtro ativo E Strategy 3a
      // já encontrou produtos suficientes (>= 3). Se 3a falha em /events/
      // filtrado (seletores não casam, React ainda renderizando), 3b precisa
      // rodar — mas com filtro de exclusão AGRESSIVO que explicitamente
      // descarte carrosseis "Você também pode gostar"/"Recomendados".
      var hasActiveFilter = currentUrl.indexOf('bubble-id=') !== -1 ||
                            currentUrl.indexOf('discounts-widget=') !== -1 ||
                            currentUrl.indexOf('rh=') !== -1;
      var skip3b = hasActiveFilter && products.length >= 3;
      if (skip3b) {
        console.log('[AchadinhoPRO:Amazon] Strategy 3b: SKIP (filtro ativo + ' + products.length + ' produtos via 3a — não contamina com carrosseis)');
      }

      if (isDealsUrl && !skip3b) {
        console.log('[AchadinhoPRO:Amazon] Trying strategy 3b (generic link scan)...');

        var allDpLinks = document.querySelectorAll('a[href*="/dp/"], a[href*="/deal/"], a[href*="/gp/product/"]');
        console.log('[AchadinhoPRO:Amazon] Strategy 3b: found ' + allDpLinks.length + ' product links');

        // Diagnóstico — contadores para descobrir POR QUE produtos são pulados.
        var skip3bFilter = 0, skip3bNoAsin = 0, skip3bSeen = 0;
        var skip3bNoName = 0, accept3b = 0;
        // Em /events/ com filtro ativo (bubble-id, discounts-widget, rh): a
        // página tem cards filtrados na grid + carrosseis genéricos no rodapé.
        // O filtro de exclusão precisa ser agressivo para descartar carrosseis
        // SEM barrar os cards reais. Em /events/ sem filtro: filtro suave para
        // pegar tudo que for deal genuíno.
        var isEventsPage = currentPath.includes('/events/');
        var excludeSel;
        // Em /events/ SEMPRE excluir o carrossel "Ofertas em destaque"
        // (.dcl-html-carousel / .dcl-product-wrapper / .dcl-carousel-element)
        // — ele aparece em TODAS as páginas /events/ com produtos fixos
        // (iPhone, TV etc.) que NÃO pertencem ao filtro do usuário.
        if (isEventsPage && hasActiveFilter) {
          excludeSel = 'footer, #navFooter, #rhf-container, #rhf-shoveler, .rhf-border, [class*="rhf-"], .dcl-html-carousel, .dcl-product-wrapper, .dcl-carousel-element, .a-carousel-card, .a-carousel, [data-a-carousel-options], [class*="acsWidget"], [class*="recommendation"], [class*="sponsored"], [class*="similarities"], [class*="shoveler"]';
        } else if (isEventsPage) {
          excludeSel = 'footer, #navFooter, #rhf-container, #rhf-shoveler, .rhf-border, [class*="rhf-"], .dcl-html-carousel, .dcl-product-wrapper, .dcl-carousel-element';
        } else {
          excludeSel = 'footer, #navFooter, #rhf-container, #rhf-shoveler, .rhf-border, [class*="rhf-"], [class*="recommendation"], [class*="sponsored"], [class*="acsWidget"], [class*="similarities"], .s-result-item, [data-component-type="s-search-result"]';
        }

        for (var m = 0; m < allDpLinks.length; m++) {
          var link = allDpLinks[m];

          if (link.closest(excludeSel)) {
            skip3bFilter++;
            continue;
          }

          var linkAsin = extractAsinFromLink(link.href);

          // For /deal/ links without ASIN, try to find ASIN in parent container
          if (!linkAsin) {
            var parentCard = link.closest('[data-deal-id], [data-asin]');
            if (parentCard) {
              linkAsin = parentCard.getAttribute('data-asin') || null;
            }
            // Also try to find a sibling/child link with /dp/
            if (!linkAsin) {
              var nearbyDpLink = link.parentElement ? link.parentElement.querySelector('a[href*="/dp/"]') : null;
              if (nearbyDpLink) linkAsin = extractAsinFromLink(nearbyDpLink.href);
            }
          }
          if (!linkAsin) { skip3bNoAsin++; continue; }
          if (seen[linkAsin]) { skip3bSeen++; continue; }

          // Walk up to find the containing card (up to 4 levels — mais que isso
          // captura `<section>` ou wrapper que engloba dezenas de cards, e o
          // querySelector('img') passa trivialmente, levando a Strategy 3b a
          // pegar nome de banner/promoção em vez do nome do produto).
          var container = link;
          for (var up = 0; up < 4; up++) {
            if (!container.parentElement) break;
            container = container.parentElement;
            // Stop at elements that look like cards (have image + text)
            if (container.querySelector('img') && container.offsetHeight > 100) break;
          }

          // Extract product info from the container — só seletores com classes
          // de título/nome. `span`/`div` genéricos pegavam badges de desconto
          // ("Economize R$ 50,00 em..."), banners de categoria e textos de
          // promoção. Fallbacks adicionais: img[alt] e a[aria-label].
          var lName = null;
          var nameSelectors = ['[class*="Title"]', '[class*="title"]', '[class*="name"]', '[class*="Name"]', '[data-cy*="title"]'];
          for (var ns = 0; ns < nameSelectors.length; ns++) {
            var nameEls = container.querySelectorAll(nameSelectors[ns]);
            for (var ne = 0; ne < nameEls.length; ne++) {
              var txt = (nameEls[ne].textContent || '').trim();
              if (txt.length > 15 && txt.length < 300 && !txt.match(/^R\$/) && !txt.match(/^\d+%/)) {
                lName = txt;
                break;
              }
            }
            if (lName) break;
          }
          if (!lName) {
            var lImgAlt = container.querySelector('img[alt]');
            if (lImgAlt) {
              var altRaw = (lImgAlt.getAttribute('alt') || '').trim();
              altRaw = altRaw.replace(/^imagem\s+do\s+produto[:\s]*/i, '').trim();
              if (altRaw.length > 15 && altRaw.length < 300 && !/^amazon\s+prime$|^prime$/i.test(altRaw)) {
                lName = altRaw;
              }
            }
          }
          if (!lName) {
            var lAria = container.querySelector('a[aria-label]');
            if (lAria) {
              var ariaRaw = (lAria.getAttribute('aria-label') || '').trim();
              if (ariaRaw.length > 15 && ariaRaw.length < 300) lName = ariaRaw;
            }
          }
          if (!lName) {
            skip3bNoName++;
            // Diagnóstico — primeiros 3 fails: dump amostra do container para
            // descobrir qual seletor de nome está faltando.
            if (skip3bNoName <= 3) {
              console.log('[AchadinhoPRO:Amazon] Strategy 3b skip (no name) #' + skip3bNoName + ':', {
                asin: linkAsin,
                containerTag: container.tagName,
                containerClass: (container.className || '').slice(0, 120),
                containerHeight: container.offsetHeight,
                imgCount: container.querySelectorAll('img').length,
                firstImgAlt: (container.querySelector('img') && container.querySelector('img').getAttribute('alt') || '').slice(0, 80),
                linkAriaLabel: (link.getAttribute('aria-label') || '').slice(0, 80),
                textPreview: (container.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150),
              });
            }
            continue;
          }
          accept3b++;

          var lImg = container.querySelector('img');
          var lImageUrl = lImg ? IMG.fullSizeAmazonImageUrl(lImg.src || lImg.getAttribute('data-src')) : null;
          // Skip tiny icons
          if (lImageUrl && lImg.width < 50) lImageUrl = null;

          var lPriceEl = container.querySelector('span.a-price .a-offscreen, [class*="Price"] .a-offscreen, [class*="price"]');
          var lPrice = lPriceEl ? parsePrice(lPriceEl.textContent) : null;

          var lOrigPrice = PU.pickOriginalPrice(container);

          var lDiscount = null;
          if (lPrice && lOrigPrice && lOrigPrice > lPrice) {
            lDiscount = Math.round(((lOrigPrice - lPrice) / lOrigPrice) * 100);
          }
          if (!lDiscount) {
            var lDiscountEl = container.querySelector('[class*="discount"], [class*="Discount"], [class*="savings"], .savingsPercentage');
            if (lDiscountEl) {
              var ldMatch = (lDiscountEl.textContent || '').match(/(\d+)\s*%/);
              if (ldMatch) lDiscount = parseInt(ldMatch[1]);
            }
          }

          seen[linkAsin] = true;
          products.push({
            asin: linkAsin,
            platformItemId: linkAsin,
            productName: lName,
            price: lPrice,
            originalPrice: lOrigPrice,
            discountPercent: lDiscount,
            ratingStar: null,
            reviewsCount: null,
            imageUrl: lImageUrl,
            isPrime: false,
            freeShipping: false,
            sellerName: null,
            categoryName: categoryName,
            categoryBreadcrumb: categoryBreadcrumb,
            productLink: 'https://www.amazon.com.br/dp/' + linkAsin,
            productUrl: 'https://www.amazon.com.br/dp/' + linkAsin,
            offerType: 'deal',
            platform: 'amazon',
            marketplace: 'amazon',
          });
        }
        console.log('[AchadinhoPRO:Amazon] Strategy 3b breakdown:', {
          totalLinks: allDpLinks.length,
          skipFilter: skip3bFilter,
          skipNoAsin: skip3bNoAsin,
          skipSeen: skip3bSeen,
          skipNoName: skip3bNoName,
          accepted: accept3b,
          isEventsPage: isEventsPage,
        });
        console.log('[AchadinhoPRO:Amazon] Strategy 3b extracted ' + products.length + ' products from link scan');
      }
    }

    // Diagnóstico final — se ainda 0 produtos numa deals page, dump do DOM
    // para ajudar a identificar qual seletor está faltando. Usa console.log
    // (não warn) para não aparecer como "erro" com stack trace no DevTools,
    // já que isso pode acontecer normalmente enquanto o React ainda hidrata.
    if (products.length === 0 && (currentPath.includes('/deals') || currentPath.includes('/events/') || currentPath.includes('/goldbox'))) {
      console.log('[AchadinhoPRO:Amazon] [diag] 0 produtos extraídos (esperado durante hidratação React). DOM:', {
        url: currentUrl,
        pageType: getPageType(),
        totalDpLinks: document.querySelectorAll('a[href*="/dp/"]').length,
        totalDealLinks: document.querySelectorAll('a[href*="/deal/"]').length,
        dataAsinElements: document.querySelectorAll('[data-asin]').length,
        dataDealId: document.querySelectorAll('[data-deal-id]').length,
        dataCyFaceout: document.querySelectorAll('[data-cy="asin-faceout-container"]').length,
        dealCardTestId: document.querySelectorAll('[data-testid="deal-card"]').length,
        cardTitleClass: document.querySelectorAll('[class*="card-title"]').length,
        bodyChildClasses: Array.from(document.body.children).map(function (c) { return c.tagName + '.' + (c.className || '').toString().slice(0, 60); }).slice(0, 5),
      });
    }

    console.log('[AchadinhoPRO:Amazon] Listing: ' + products.length + ' produtos extraídos (' + getPageType() + ', offerType=' + offerType + ')');
    // Sample dos primeiros 3 — confirma se os productNames batem com o filtro
    // ativo (ex: na URL bubble-id=deals-collection-baby, esperam-se produtos
    // de bebê). Se aparecer mistura, indica que algum carrossel está vazando.
    if (products.length > 0) {
      console.log('[AchadinhoPRO:Amazon] Sample dos 3 primeiros:', products.slice(0, 3).map(function (p) {
        return { asin: p.asin, name: (p.productName || '').slice(0, 70) };
      }));
    }
    return products;
  }

  // ===== UNIFIED EXTRACT =====

  function extractAll() {
    var pageType = getPageType();

    if (pageType === 'homepage') {
      return { success: false, data: null, error: 'Página inicial - navegue até um produto' };
    }

    if (pageType === 'product') {
      var product = extractSingleProduct();
      if (product) {
        console.log('[AchadinhoPRO:Amazon] Produto extraído:', (product.productName || '').slice(0, 50));
        return { success: true, data: product, source: 'product_page' };
      }
      return { success: false, data: null, error: 'Não foi possível extrair dados do produto' };
    }

    if (pageType.startsWith('listing_')) {
      var products = extractListingProducts();
      if (products.length > 0) {
        return { success: true, data: products, source: pageType };
      }
      return { success: false, data: null, error: 'Nenhum produto encontrado na listagem' };
    }

    return { success: false, data: null, error: 'Página Amazon não reconhecida' };
  }

  // ===== EXTENSION CONTEXT GUARD =====
  function isExtensionValid() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function safeSendMessage(msg) {
    if (!isExtensionValid()) return;
    try { chrome.runtime.sendMessage(msg).catch(function () {}); } catch (e) {}
  }

  // ===== MESSAGE LISTENER =====
  if (!isExtensionValid()) return; // bail out early if context already dead

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message.action === 'ping') {
      sendResponse({ status: 'ok', marketplace: 'amazon' });
      return true;
    }

    if (message.action === 'extractOffer') {
      try {
        var result = extractAll();

        // On listing pages, merge with accumulated products so we don't lose
        // previously scrolled items (Amazon removes DOM elements on scroll)
        var isListingPage = getPageType().startsWith('listing_');
        if (isListingPage && result.success && Array.isArray(result.data)) {
          result.data = mergeAccumulatedProducts(result.data);
          console.log('[AchadinhoPRO:Amazon] extractOffer (accumulated):', result.data.length + ' items');
        } else {
          console.log('[AchadinhoPRO:Amazon] extractOffer:', result.success, result.source, Array.isArray(result.data) ? result.data.length + ' items' : 'single');
        }

        sendResponse(result);
      } catch (e) {
        console.error('[AchadinhoPRO:Amazon] Erro ao extrair:', e);
        sendResponse({ success: false, data: null, error: e.message });
      }
      return true;
    }

    if (message.action === 'extractAllOffers') {
      try {
        var products = extractListingProducts();
        sendResponse({ success: true, data: products });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }

    return false;
  });

  // ===== AUTO-EXTRACT ON PAGE LOAD =====

  // Track accumulated products for listing pages (Amazon lazy-loads on scroll)
  var accumulatedProducts = {};

  function mergeAccumulatedProducts(newProducts) {
    var merged = [];
    // Add existing accumulated products first
    for (var asin in accumulatedProducts) {
      merged.push(accumulatedProducts[asin]);
    }
    // Add new products
    for (var i = 0; i < newProducts.length; i++) {
      var p = newProducts[i];
      if (p.asin && !accumulatedProducts[p.asin]) {
        accumulatedProducts[p.asin] = p;
        merged.push(p);
      }
    }
    return merged;
  }

  function performExtraction(source, replaceMode) {
    if (!isExtensionValid()) return false;
    var result = extractAll();
    if (!result.success) {
      console.log('[AchadinhoPRO:Amazon] ' + source + ': ' + (result.error || 'sem dados'));
      return false;
    }

    var data = result.data;
    var isListingPage = getPageType().startsWith('listing_');

    // On listing pages, accumulate products across scroll events
    if (isListingPage && Array.isArray(data)) {
      var prevCount = Object.keys(accumulatedProducts).length;
      data = mergeAccumulatedProducts(data);
      var newCount = Object.keys(accumulatedProducts).length;
      console.log('[AchadinhoPRO:Amazon] ' + source + ': accumulation ' + prevCount + ' → ' + newCount + ' (new batch: ' + result.data.length + ')');
    }

    console.log('[AchadinhoPRO:Amazon] ' + source + ': enviando', Array.isArray(data) ? data.length + ' produtos' : 'produto único', replaceMode ? '(replaceMode)' : '');
    safeSendMessage({
      action: 'offerExtracted',
      platform: 'amazon',
      data: data,
      source: result.source,
      url: window.location.href,
      replaceMode: !!replaceMode,
    });
    return true;
  }

  // Token de geração — abandona retries de navegações obsoletas (usuário
  // aplica filtro A e depois B antes do retry de A terminar).
  var navGeneration = 0;

  // Retry com short-circuit (para na 1ª que retorna produtos) — usado para
  // auto-extract inicial onde o DOM só precisa terminar de carregar.
  function performExtractionWithRetry(source, delays) {
    navGeneration++;
    var myGen = navGeneration;
    var attempt = 0;
    function tryNext() {
      if (attempt >= delays.length) return;
      if (navGeneration !== myGen) return;
      var delay = delays[attempt++];
      setTimeout(function () {
        if (navGeneration !== myGen) return;
        var ok = performExtraction(source + '#' + attempt);
        var hasProducts = ok && Object.keys(accumulatedProducts).length > 0;
        if (!hasProducts) tryNext();
      }, delay);
    }
    tryNext();
  }

  // SPA-nav extraction — diferente do retry com short-circuit: a Amazon
  // mantém os cards antigos no DOM enquanto o React faz XHR e re-renderiza.
  // A 1ª extração após pageChanged geralmente pega os PRODUTOS ANTIGOS
  // (parecem novos para o scraper) e o short-circuit aborta as tentativas
  // posteriores que pegariam os filtrados de verdade.
  //
  // Solução: SEMPRE executa todas as tentativas em delays maiores, RESETA o
  // accumulator antes de cada tentativa (não mistura antigos com filtrados),
  // e marca cada offerExtracted com replaceMode=true para o sidepanel
  // ignorar o filtro de "menor que current" que rejeitaria o update real.
  function performExtractionForNav(delays) {
    navGeneration++;
    var myGen = navGeneration;
    for (var i = 0; i < delays.length; i++) {
      (function (idx, delay) {
        setTimeout(function () {
          if (navGeneration !== myGen) return;
          // Reseta accumulator a CADA tentativa de SPA-nav — o React pode
          // estar trocando o DOM e produtos da extração anterior podem ser
          // os antigos do filtro A enquanto o filtro B já está aplicado.
          accumulatedProducts = {};
          performExtraction('SPA-nav#' + (idx + 1), true);
        }, delay);
      })(i, delays[i]);
    }
  }

  // Initial extract — usa retry para deals/events (cards React podem demorar)
  if (getPageType() === 'listing_deals') {
    performExtractionWithRetry('Auto-extract', [2000, 4500, 8000]);
  } else {
    setTimeout(function () { performExtraction('Auto-extract'); }, 2000);
  }

  // ===== SPA NAVIGATION DETECTION =====

  // Extract only the meaningful parts of a URL for navigation comparison
  // Returns path + important filter params, ignoring pagination/tracking params
  function getBaseUrl(url) {
    try {
      var u = new URL(url);
      // Keep ONLY params that indicate category/filter changes
      var meaningfulParams = [
        'k', 'node', 'rh', 'dc', 'discounts-widget', 'ref', 'ref_',
        'field-keywords', 'field-browse', 'bbn',
        'bubble-id', 'category', 'collection', 'deal-filter',
        // /gp/browse.html (página de Novidades, etc) usa enabledRefinements
        // para filtros de categoria via SPA. Sem isto, mudar de filtro era
        // detectado como "scroll pagination" e não resetava accumulator.
        'enabledRefinements', 'pickerToList', 'srs',
      ];
      var base = u.origin + u.pathname;
      var kept = [];
      for (var mi = 0; mi < meaningfulParams.length; mi++) {
        var val = u.searchParams.get(meaningfulParams[mi]);
        if (val) kept.push(meaningfulParams[mi] + '=' + val);
      }
      return kept.length > 0 ? base + '?' + kept.sort().join('&') : base;
    } catch (e) {
      return url;
    }
  }

  var lastUrl = window.location.href;
  var lastBaseUrl = getBaseUrl(lastUrl);

  function handleUrlChange() {
    var currentUrl = window.location.href;
    if (currentUrl === lastUrl) return;

    var oldBaseUrl = lastBaseUrl;
    lastUrl = currentUrl;
    lastBaseUrl = getBaseUrl(currentUrl);

    // If only pagination params changed, just re-extract without clearing
    if (oldBaseUrl === lastBaseUrl) {
      console.log('[AchadinhoPRO:Amazon] Scroll pagination change (accumulating)');
      setTimeout(function () { performExtraction('Pagination-extract'); }, 1500);
      return;
    }

    console.log('[AchadinhoPRO:Amazon] Navegação real detectada:', currentUrl);

    // Clear accumulation on real navigation (different page or different filter)
    accumulatedProducts = {};
    console.log('[AchadinhoPRO:Amazon] Cleared accumulation (real navigation)');

    safeSendMessage({
      action: 'pageChanged',
      url: currentUrl,
      pageType: getPageType(),
    });

    // Filtros React em /events/, /deals/ e /gp/browse.html (Novidades, etc.):
    // SEMPRE executa todas as tentativas (não pode parar cedo, pois React
    // mantém cards antigos visíveis enquanto re-renderiza). Cada tentativa
    // reseta accumulator e usa replaceMode.
    var isSpaPage = currentUrl.includes('/deals') ||
                    currentUrl.includes('/goldbox') ||
                    currentUrl.includes('/events/') ||
                    currentUrl.includes('/gp/browse');
    if (isSpaPage) {
      performExtractionForNav([3000, 7000, 12000]);
    } else {
      setTimeout(function () { performExtraction('SPA-nav'); }, 2000);
    }
  }

  // Detecção instantânea via monkey-patch de history.pushState/replaceState —
  // SPA da Amazon (filtros de categoria, preço, desconto em /events/) muda a
  // URL via pushState sem disparar popstate. Sem isso, a detecção fica refém
  // do polling de 1500ms e perde a primeira janela de re-render.
  (function patchHistory() {
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function () {
      var ret = origPush.apply(this, arguments);
      setTimeout(handleUrlChange, 50);
      return ret;
    };
    history.replaceState = function () {
      var ret = origReplace.apply(this, arguments);
      setTimeout(handleUrlChange, 50);
      return ret;
    };
  })();

  // Poll for URL changes (fallback caso pushState seja chamado em iframe ou
  // contexto onde o monkey-patch não pegue)
  setInterval(handleUrlChange, 1500);

  // Also listen to browser back/forward navigation
  window.addEventListener('popstate', function () {
    setTimeout(handleUrlChange, 500);
  });

  // ===== LISTING PAGE SCROLL DETECTION =====
  // Re-extract when user scrolls on any listing page (Amazon lazy-loads products)
  var scrollExtractTimer = null;
  var lastScrollExtract = 0;
  window.addEventListener('scroll', function () {
    // Only trigger on listing pages (deals, bestsellers, movers-and-shakers, search, categories)
    var pageType = getPageType();
    if (!pageType.startsWith('listing_')) return;

    // Debounce: wait 2s after scroll stops, minimum 5s between extractions
    clearTimeout(scrollExtractTimer);
    scrollExtractTimer = setTimeout(function () {
      var now = Date.now();
      if (now - lastScrollExtract < 5000) return;
      lastScrollExtract = now;
      console.log('[AchadinhoPRO:Amazon] Scroll detected on ' + pageType + ' — re-extracting...');
      performExtraction('Scroll-extract');
    }, 2000);
  });
})();
