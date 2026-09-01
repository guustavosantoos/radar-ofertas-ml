(function () {
  'use strict';

  console.log('[AchadinhoPRO:Shopee] Content script carregado');

  // Guard against "Extension context invalidated" errors
  function isContextValid() {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  // ===== PAGE TYPE DETECTION =====

  function detectPageType() {
    var url = window.location.href;

    // Product page: /product/shopId.itemId or /-i.shopId.itemId
    if (url.match(/shopee\.com\.br\/.+-i\.\d+\.\d+/) || url.indexOf('/product/') !== -1) {
      return 'product';
    }

    // Search page
    if (url.indexOf('/search') !== -1 || url.indexOf('keyword=') !== -1) {
      return 'listing';
    }

    // Deals/offers pages
    if (url.indexOf('/flash_sale') !== -1 || url.indexOf('/daily_discover') !== -1 ||
        url.indexOf('/deals') !== -1 || url.indexOf('/collection') !== -1 ||
        url.indexOf('/campaign') !== -1 || url.indexOf('/mega-sale') !== -1) {
      return 'listing';
    }

    // Category pages
    if (url.match(/shopee\.com\.br\/[^\/]+-cat\.\d+/)) {
      return 'listing';
    }

    // List/category pages (e.g. /list/Cozinha, /list/Eletrônicos)
    if (url.indexOf('/list/') !== -1 || url.indexOf('/list?') !== -1) {
      return 'listing';
    }

    // Homepage with product grids
    if (url.match(/shopee\.com\.br\/?(\?.*)?$/) && document.querySelectorAll('[data-sqe="item"]').length > 0) {
      return 'listing';
    }

    // Official shop / single-segment shop page (e.g. /principiaskincare, /principiaskincare#product_list)
    // Heurística: path com 1 segmento + DOM contendo grid de produtos da loja oficial
    var pathname = window.location.pathname || '';
    var SHOP_PATH_BLACKLIST = [
      'cart', 'user', 'buyer', 'seller', 'login', 'signup', 'register',
      'verify', 'mall', 'official', 'm', 'mobile', 'app', 'help',
      'contact', 'about', 'careers', 'press', 'policies', 'privacy',
      'terms', 'shopping-guarantee', 'recommend', 'wallet', 'orders',
      'account', 'notifications', 'messages', 'voucher-wallet',
      'coins', 'shopee-coins', 'flash_sale', 'daily_discover', 'deals',
      'collection', 'campaign', 'mega-sale', 'list', 'search', 'product',
      'find_similar_products', 'webchat', 'chat', 'shop'
    ];
    var officialShopMatch = pathname.match(/^\/([^\/]+)\/?$/);
    if (officialShopMatch) {
      var firstSegment = officialShopMatch[1].toLowerCase();
      var isBlacklisted = SHOP_PATH_BLACKLIST.indexOf(firstSegment) !== -1;
      // Não pode parecer slug de produto/categoria codificado
      var looksLikeProductOrCat = /-i\.\d+|-cat\.\d+/.test(firstSegment);
      if (!isBlacklisted && !looksLikeProductOrCat) {
        // Confirma via DOM: precisa ter o container de produtos da loja oficial
        var hasShopGrid = document.querySelector(
          'div[class*="shop-search-result-view__item"], ' +
          'div[class*="shop-search-result-view"]'
        );
        if (hasShopGrid) {
          return 'listing';
        }
      }
    }

    return 'unknown';
  }

  function getSimplePageType() {
    return detectPageType();
  }

  // ===== ID EXTRACTION =====

  function extractIdsFromUrl() {
    var url = window.location.href;
    var match = url.match(/i\.(\d+)\.(\d+)/);
    if (match) {
      return { shopId: match[1], itemId: match[2] };
    }
    match = url.match(/\/product\/(\d+)\/(\d+)/);
    if (match) {
      return { shopId: match[1], itemId: match[2] };
    }
    return { shopId: null, itemId: null };
  }

  // ===== STATE EXTRACTION =====

  function getJsonLdData() {
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      try {
        var data = JSON.parse(scripts[i].textContent);
        var items = Array.isArray(data) ? data : [data];
        for (var j = 0; j < items.length; j++) {
          if (items[j]['@type'] === 'Product' || items[j].offers) {
            return { _jsonLd: true, product: items[j] };
          }
        }
      } catch (e) {
        continue;
      }
    }
    return null;
  }

  // ===== OFFER TYPE DETECTION =====

  function detectOfferType() {
    var url = window.location.href.toLowerCase();
    var result = { offerType: null, offerEndTime: null };

    // 1. URL-based detection
    if (url.indexOf('/flash_sale') !== -1 || url.indexOf('flash-sale') !== -1) {
      result.offerType = 'flash_sale';
    } else if (url.indexOf('/daily_discover') !== -1 || url.indexOf('daily-discover') !== -1) {
      result.offerType = 'daily_discover';
    } else if (url.indexOf('/deals') !== -1) {
      result.offerType = 'deals';
    } else if (url.indexOf('/mega-sale') !== -1 || url.indexOf('/mega_sale') !== -1) {
      result.offerType = 'mega_sale';
    } else if (url.indexOf('/campaign') !== -1) {
      result.offerType = 'campaign';
    } else if (url.indexOf('/collection') !== -1) {
      result.offerType = 'collection';
    }

    // 2. DOM-based detection - look for badges/tags
    if (!result.offerType) {
      var badgeSelectors = [
        '[class*="flash-sale"], [class*="flashSale"], [class*="flash_sale"]',
        '[class*="daily-discover"], [class*="dailyDiscover"]',
        '[class*="mega-sale"], [class*="megaSale"]',
        '[class*="deal"], [class*="promo"], [class*="campaign"]',
        '[class*="badge"], [class*="tag"], [class*="label"]'
      ];

      for (var b = 0; b < badgeSelectors.length; b++) {
        var badges = document.querySelectorAll(badgeSelectors[b]);
        for (var bi = 0; bi < badges.length; bi++) {
          var badgeText = (badges[bi].textContent || '').toLowerCase();
          if (badgeText.indexOf('flash') !== -1 || badgeText.indexOf('relâmpago') !== -1) {
            result.offerType = 'flash_sale';
            break;
          }
          if (badgeText.indexOf('descoberta') !== -1 || badgeText.indexOf('discover') !== -1) {
            result.offerType = 'daily_discover';
            break;
          }
          if (badgeText.indexOf('mega') !== -1) {
            result.offerType = 'mega_sale';
            break;
          }
        }
        if (result.offerType) break;
      }
    }

    // 3. Page title/heading detection
    if (!result.offerType) {
      var pageText = (document.title || '').toLowerCase();
      if (pageText.indexOf('flash') !== -1 || pageText.indexOf('relâmpago') !== -1) result.offerType = 'flash_sale';
      else if (pageText.indexOf('descoberta') !== -1 || pageText.indexOf('discover') !== -1) result.offerType = 'daily_discover';
      else if (pageText.indexOf('mega') !== -1) result.offerType = 'mega_sale';
    }

    // 4. Timer/countdown for offerEndTime
    var timerSelectors = ['[class*="countdown"], [class*="timer"], [data-end-time], [data-ends]'];
    for (var t = 0; t < timerSelectors.length; t++) {
      var timerEl = document.querySelector(timerSelectors[t]);
      if (timerEl) {
        var timeData = timerEl.getAttribute('data-end-time') || timerEl.getAttribute('data-ends') || timerEl.getAttribute('data-deadline');
        if (timeData) {
          try {
            result.offerEndTime = new Date(parseInt(timeData) * 1000).toISOString();
          } catch (err) {
            try {
              result.offerEndTime = new Date(timeData).toISOString();
            } catch (err2) {}
          }
        }
        break;
      }
    }

    return result;
  }

  // ===== PRICE PARSING =====

  function parsePriceText(text) {
    if (!text) return null;
    // Extrai a primeira ocorrência de um número com formato de preço BR, evitando
    // remover letras isoladas como "R" de palavras concatenadas ao redor do preço.
    // Aceita: "R$ 1.299,90", "R$1299,90", "1.299,90", "99,00".
    var match = String(text).match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?/);
    if (!match) return null;
    var intPart = match[1].replace(/\./g, '');
    var centsPart = (match[2] || '0').padStart(2, '0').slice(0, 2);
    var value = parseFloat(intPart + '.' + centsPart);
    return isNaN(value) ? null : Math.round(value * 100);
  }

  // Escolhe o par (promocional, cheio) entre candidatos cujo desconto derivado
  // melhor bate com o badge do card (tolerância de 10 p.p.) — evita eleger
  // parcela/nota/cupom como preço. Retorna null quando não há par consistente.
  function pickPairByBadge(vals, badgePercent) {
    if (!badgePercent || !vals || vals.length < 2) return null;
    var best = null;
    for (var i = 0; i < vals.length; i++) {
      for (var j = 0; j < vals.length; j++) {
        var lo = vals[i];
        var hi = vals[j];
        if (!(lo < hi)) continue;
        var d = Math.round((1 - lo / hi) * 100);
        if (d < 1 || d > 99) continue;
        var diff = Math.abs(d - badgePercent);
        if (diff <= 10 && (!best || diff < best.diff)) {
          best = { lo: lo, hi: hi, diff: diff };
        }
      }
    }
    return best;
  }

  // Percentual de badge legítimo: 1..99 (0 não é oferta; 100+ é lixo e quebra
  // a derivação de originalPrice com divisão por zero).
  function validBadgePercent(n) {
    return n >= 1 && n <= 99 ? n : null;
  }

  // Check if an element is likely a rating/review/non-price element
  function isNonPriceElement(el) {
    var className = (el.className || '').toString().toLowerCase();
    var parentClass = el.parentElement ? (el.parentElement.className || '').toString().toLowerCase() : '';
    var grandparentClass = (el.parentElement && el.parentElement.parentElement) ?
      (el.parentElement.parentElement.className || '').toString().toLowerCase() : '';
    var allClasses = className + ' ' + parentClass + ' ' + grandparentClass;

    // Skip rating/review/sold/star elements
    if (/rating|review|star|sold|avalia|estrela|vendido|like|heart|favorite|coin|cashback|voucher|frete|shipping/i.test(allClasses)) {
      return true;
    }

    // Skip elements near SVG stars (ratings)
    var nearestParent = el.closest('[class*="rating"], [class*="star"], [class*="review"], [class*="sold"]');
    if (nearestParent) return true;

    return false;
  }

  // Extract all prices from a container, returning { current, original, discount }
  function extractPricesFromContainer(container) {
    var result = { current: null, original: null, discount: null };

    // Strategy 0: layout Shopee 2026 (flash sale / listagens) com classes hasheadas
    // observadas no DOM real. Preço promocional fica embrulhado em <div class="ydZOJO">
    // (dentro dele um <div class="igmqgG"> com <strong class="C5PR3a">); o preço cheio
    // fica em outro <div class="igmqgG"> FORA do ydZOJO; o badge de desconto fica em
    // <div class="XUBFBk">-16%</div>. Sem essa distinção, os fallbacks genéricos pegam
    // o preço cheio (primeiro no DOM) como atual. Se as classes rotacionarem, este
    // bloco vira no-op e as estratégias genéricas abaixo assumem.
    var promoWrap = container.querySelector('[class*="ydZOJO"]');
    if (promoWrap) {
      // Parse ancorado no <strong> interno ou no "R$" — nunca no primeiro número
      // do texto do wrapper, que pode ser badge/contador ("-16%", "3 un.").
      var promoStrong = promoWrap.querySelector('strong');
      var promoText = promoStrong ? (promoStrong.textContent || '').trim() : '';
      // Mesma validação do fallback de strongs: só dígitos/pontuação com tamanho
      // de preço — <strong> de contador/badge ("3 un.", "-16%") não é preço.
      var promoVal = (/^[\d.,]+$/.test(promoText) && promoText.length >= 3 && promoText.length <= 12)
        ? parsePriceText('R$ ' + promoText)
        : null;
      if (!promoVal) {
        var promoRs = (promoWrap.textContent || '').match(/R\$\s*[\d.,]+/);
        promoVal = promoRs ? parsePriceText(promoRs[0]) : null;
      }
      // Wrapper promocional presente mas ainda sem valor (lazy render): sinaliza
      // ao caller para NÃO fabricar originalPrice por cima do preço cheio.
      if (!promoVal) result.promoPending = true;
      // original e badge só fazem sentido quando o promocional foi lido — sem
      // isso o par meio-populado ressuscitaria o bug (cheio como atual).
      if (promoVal && promoVal > 0) {
        result.current = promoVal;
        var fullEls = container.querySelectorAll('[class*="igmqgG"]');
        for (var f0 = 0; f0 < fullEls.length; f0++) {
          if (fullEls[f0].closest('[class*="ydZOJO"]')) continue;
          var fullRs = ((fullEls[f0].textContent || '')).match(/R\$\s*[\d.,]+/);
          var fullVal = fullRs ? parsePriceText(fullRs[0]) : null;
          if (fullVal && fullVal > result.current) {
            result.original = fullVal;
            break;
          }
        }
        var badge0 = container.querySelector('[class*="XUBFBk"]');
        if (badge0) {
          var badgeMatch0 = (badge0.textContent || '').match(/-?\s*(\d+)\s*%/);
          if (badgeMatch0) {
            var bd0 = parseInt(badgeMatch0[1]);
            if (bd0 >= 1 && bd0 <= 99) result.discount = bd0;
          }
        }
      }
    }
    // Só retorna cedo com o PAR completo; com apenas o promocional, a Strategy 1
    // ainda pode achar o cheio (del/line-through) — os guards abaixo preservam
    // result.current já setado.
    if (result.current && result.original) {
      return result;
    }

    // Strategy 1: Find price elements by Shopee price-specific selectors only
    // IMPORTANT: Do NOT use generic 'span, div' — that captures ratings, sold counts, etc.
    var allPriceEls = container.querySelectorAll(
      '[class*="price"], [class*="Price"], ' +
      '[class*="aBrP0a"], [class*="pqTWkA"], ' +
      'del, [class*="discount"], [class*="percent"]'
    );
    var priceValues = [];

    for (var i = 0; i < allPriceEls.length; i++) {
      var el = allPriceEls[i];
      var text = (el.textContent || '').trim();

      // Skip elements that are clearly not prices (ratings, reviews, sold counts)
      if (isNonPriceElement(el)) continue;

      // Check for discount percentage
      var discountMatch = text.match(/(\d+)\s*%\s*(OFF|off|desc|de desconto)?/i);
      if (discountMatch && !result.discount) {
        // 1..99: badge legítimo nunca é 0% nem 100%+ (100 causaria divisão por
        // zero na derivação de originalPrice a jusante).
        var d1 = parseInt(discountMatch[1]);
        if (d1 >= 1 && d1 <= 99) result.discount = d1;
        continue;
      }

      // Check for price values - require R$ prefix or be inside a price-class element
      var className = (el.className || '').toString().toLowerCase();
      var hasR$ = text.indexOf('R$') !== -1 || text.indexOf('r$') !== -1;
      var isPriceClass = /price|Price|aBrP0a|pqTWkA/i.test(className);

      // Only match bare numbers if the element has a price-related class
      var priceMatch;
      if (hasR$) {
        priceMatch = text.match(/R\$\s*([\d.,]+)/i);
      } else if (isPriceClass) {
        priceMatch = text.match(/([\d.,]+)/);
      } else {
        continue; // Skip elements without R$ and without price class
      }

      if (priceMatch) {
        var val = parsePriceText(priceMatch[0]);
        if (val && val > 0) {
          // Check if this is inside a del/strikethrough (original price)
          // className coerçido para string: em elementos SVG é SVGAnimatedString
          // (sem indexOf) e o TypeError descartaria o card inteiro no caller.
          var elCls = (el.className || '').toString();
          var isOriginal = el.tagName === 'DEL' ||
            el.closest('del') !== null ||
            elCls.indexOf('original') !== -1 ||
            elCls.indexOf('before') !== -1 ||
            elCls.indexOf('old') !== -1 ||
            elCls.indexOf('strike') !== -1 ||
            window.getComputedStyle(el).textDecoration.indexOf('line-through') !== -1;

          priceValues.push({ value: val, isOriginal: isOriginal });
        }
      }
    }

    // Deduplicate: parent and child elements often match the same price
    var uniquePrices = [];
    for (var d = 0; d < priceValues.length; d++) {
      var isDup = false;
      for (var u = 0; u < uniquePrices.length; u++) {
        if (uniquePrices[u].value === priceValues[d].value && uniquePrices[u].isOriginal === priceValues[d].isOriginal) {
          isDup = true;
          break;
        }
      }
      if (!isDup) uniquePrices.push(priceValues[d]);
    }
    priceValues = uniquePrices;

    // Assign prices: original is the higher/strikethrough one, current is the lower one
    // (respeitando result.current/original que a Strategy 0 possa ter deixado)
    if (priceValues.length === 1) {
      if (priceValues[0].isOriginal) {
        if (!result.original && (!result.current || priceValues[0].value > result.current)) {
          result.original = priceValues[0].value;
        }
      } else if (!result.current) {
        result.current = priceValues[0].value;
      } else if (!result.original && priceValues[0].value > result.current) {
        result.original = priceValues[0].value;
      }
    } else if (priceValues.length >= 2) {
      for (var p = 0; p < priceValues.length; p++) {
        if (priceValues[p].isOriginal && !result.original) {
          result.original = priceValues[p].value;
        } else if (!priceValues[p].isOriginal && !result.current) {
          result.current = priceValues[p].value;
        }
      }
      // If no explicit original found, use max as original, min as current
      if (!result.original && !result.current) {
        var sorted = priceValues.map(function(pv) { return pv.value; }).sort(function(a, b) { return a - b; });
        result.current = sorted[0];
        if (sorted.length > 1 && sorted[sorted.length - 1] > sorted[0]) {
          result.original = sorted[sorted.length - 1];
        }
      }
    }

    // Calculate discount if we have both prices but no explicit discount
    // (1..99: diferença < 0,5% arredonda para 0 e não é oferta — fica null)
    if (!result.discount && result.original && result.current && result.original > result.current) {
      var dEnd = Math.round((1 - result.current / result.original) * 100);
      if (dEnd >= 1 && dEnd <= 99) result.discount = dEnd;
    }

    return result;
  }

  // ===== PRODUCT PAGE EXTRACTION =====

  function extractProductFromDOM() {
    var ids = extractIdsFromUrl();

    // Title
    var titleEl = document.querySelector(
      '[class*="product-briefing"] [class*="title"], ' +
      'div[data-sqe="name"], ' +
      '.product-title, ' +
      'h1[class*="title"], ' +
      'span[class*="VCJJhJ"], ' +
      'div[class*="VCJJhJ"], ' +
      'section[class*="page-product"] h1'
    );
    var title = titleEl ? (titleEl.textContent || '').trim() : null;

    // If no title from selectors, try meta
    if (!title) {
      var metaTitle = document.querySelector('meta[property="og:title"]');
      title = metaTitle ? metaTitle.getAttribute('content') : null;
    }

    if (!title) return null;

    // Price
    var priceEl = document.querySelector(
      'div[class*="product-price"] [class*="current"], ' +
      'div[class*="pqTWkA"], ' +
      'div[class*="price"] span[class*="current"], ' +
      'section[class*="product"] [class*="price-value"]'
    );
    var price = priceEl ? parsePriceText(priceEl.textContent) : null;

    // Original price
    var origPriceEl = document.querySelector(
      'div[class*="product-price"] [class*="original"], ' +
      'div[class*="price"] del, ' +
      'div[class*="price"] [class*="before"], ' +
      '[class*="original-price"]'
    );
    var originalPrice = origPriceEl ? parsePriceText(origPriceEl.textContent) : null;

    // Discount
    var discountPercent = null;
    var discountEl = document.querySelector(
      '[class*="product-price"] [class*="discount"], ' +
      'span[class*="percent"], ' +
      '[class*="discount-tag"]'
    );
    if (discountEl) {
      var discountMatch = (discountEl.textContent || '').match(/(\d+)\s*%/);
      if (discountMatch) discountPercent = validBadgePercent(parseInt(discountMatch[1]));
    }
    if (!discountPercent && originalPrice && price && originalPrice > price && originalPrice / price <= 100) {
      discountPercent = validBadgePercent(Math.round((1 - price / originalPrice) * 100));
    }

    // Image - try multiple CDN domains and patterns
    var imageUrl = null;
    var productImgSelectors = [
      'img[src*="down-br.img.susercontent"]',
      'img[src*="cf.shopee"]',
      'img[src*="f.shopee"]',
      'img[src*="shopeesz"]',
      '[class*="product-briefing"] img',
      'div[class*="zoom-image"] img',
      'div[class*="image-viewer"] img',
      'picture img'
    ];
    for (var pi = 0; pi < productImgSelectors.length; pi++) {
      var pImgEl = document.querySelector(productImgSelectors[pi]);
      if (pImgEl) {
        var pSrc = pImgEl.getAttribute('src') || '';
        var pDataSrc = pImgEl.getAttribute('data-src') || '';
        if (pSrc && pSrc.indexOf('data:') === -1 && pSrc.indexOf('placeholder') === -1 && pSrc.length > 20) {
          imageUrl = pSrc;
          break;
        }
        if (pDataSrc && pDataSrc.indexOf('data:') === -1 && pDataSrc.length > 20) {
          imageUrl = pDataSrc;
          break;
        }
      }
    }
    if (!imageUrl) {
      var metaImg = document.querySelector('meta[property="og:image"]');
      imageUrl = metaImg ? metaImg.getAttribute('content') : null;
    }

    // Seller
    var sellerEl = document.querySelector(
      'div[class*="shop-info"] [class*="name"], ' +
      'a[class*="shop-name"], ' +
      'div[class*="seller-info"] [class*="name"], ' +
      '[data-sqe="shop"] [class*="name"]'
    );
    var seller = sellerEl ? (sellerEl.textContent || '').trim() : null;

    // Rating
    var ratingEl = document.querySelector(
      'div[class*="product-rating"] [class*="score"], ' +
      '[class*="rating-star"] + span, ' +
      'div[class*="product-briefing"] [class*="rating"]'
    );
    var rating = ratingEl ? (ratingEl.textContent || '').trim() : null;
    if (!rating) {
      // Fallback: look for small spans near star SVGs with rating format (e.g. "4.7")
      var starSvgs = document.querySelectorAll('div[class*="product-briefing"] svg, div[class*="product-rating"] svg');
      for (var si = 0; si < starSvgs.length && !rating; si++) {
        var parent = starSvgs[si].parentElement;
        if (parent) {
          var spans = parent.querySelectorAll('span');
          for (var sj = 0; sj < spans.length; sj++) {
            var txt = (spans[sj].textContent || '').trim();
            if (/^[1-5]\.\d$/.test(txt)) { rating = txt; break; }
          }
        }
      }
    }

    // Free shipping
    var freeShipping = false;
    var shippingEls = document.querySelectorAll(
      '[class*="shipping"], [class*="delivery"], [class*="frete"]'
    );
    for (var i = 0; i < shippingEls.length; i++) {
      var shText = (shippingEls[i].textContent || '').toLowerCase();
      if (shText.indexOf('grátis') !== -1 || shText.indexOf('gratis') !== -1 || shText.indexOf('free') !== -1) {
        freeShipping = true;
        break;
      }
    }

    // Sales
    var salesQuantity = 0;
    var salesEl = document.querySelector(
      'div[class*="product-briefing"] [class*="sold"], ' +
      'span[class*="sold"], ' +
      '[class*="historical-sold"]'
    );
    if (salesEl) {
      var salesMatch = (salesEl.textContent || '').match(/([\d.,]+)\s*(mil|k)?/i);
      if (salesMatch) {
        var num = parseFloat(salesMatch[1].replace('.', '').replace(',', '.'));
        if (salesMatch[2] && (salesMatch[2].toLowerCase() === 'mil' || salesMatch[2].toLowerCase() === 'k')) {
          num *= 1000;
        }
        salesQuantity = Math.floor(num);
      }
    }

    return {
      platform: 'shopee',
      platformItemId: ids.itemId,
      shopId: ids.shopId,
      productName: title,
      price: price,
      originalPrice: originalPrice,
      discountPercent: discountPercent,
      freeShipping: freeShipping,
      imageUrl: imageUrl,
      productUrl: window.location.href,
      seller: seller,
      rating: rating,
      condition: 'new',
      categoryId: null,
      salesQuantity: salesQuantity,
      offerType: detectOfferType().offerType,
      offerEndTime: detectOfferType().offerEndTime,
      position: null
    };
  }

  function extractProductFromJsonLd(jsonLdData) {
    if (!jsonLdData || !jsonLdData._jsonLd || !jsonLdData.product) return null;
    var product = jsonLdData.product;
    var ids = extractIdsFromUrl();
    var offer = product.offers || {};
    var price = offer.price || offer.lowPrice;

    return {
      platform: 'shopee',
      platformItemId: ids.itemId,
      shopId: ids.shopId,
      productName: product.name || null,
      price: price ? Math.round(parseFloat(price) * 100) : null,
      originalPrice: null,
      discountPercent: null,
      freeShipping: false,
      imageUrl: product.image || null,
      productUrl: window.location.href,
      seller: offer.seller ? offer.seller.name : null,
      rating: product.aggregateRating ? String(product.aggregateRating.ratingValue) : null,
      condition: 'new',
      categoryId: null,
      salesQuantity: 0,
      offerType: detectOfferType().offerType,
      offerEndTime: detectOfferType().offerEndTime,
      position: null
    };
  }

  function extractSingleProduct() {
    // Try JSON-LD first
    var jsonLdData = getJsonLdData();
    if (jsonLdData) {
      var fromJsonLd = extractProductFromJsonLd(jsonLdData);
      if (fromJsonLd && fromJsonLd.productName) return fromJsonLd;
    }

    // Then DOM
    var fromDOM = extractProductFromDOM();
    if (fromDOM && fromDOM.productName) return fromDOM;

    return null;
  }

  // ===== LISTING EXTRACTION =====

  function extractListingFromDOM() {
    console.log('[AchadinhoPRO:Shopee] Extraindo listagem do DOM');

    // Shopee uses various card selectors depending on the page
    var cardSelectors = [
      // Loja oficial (mais específico — bate com /principiaskincare etc.)
      'div[class*="shop-search-result-view__item"]',
      'div[data-sqe="item"]',
      'li[class*="search-item"]',
      'div[class*="shopee-search-item-result__item"]',
      'a[data-sqe="link"]',
      'div[class*="flash-sale-item-card"]',
      'div[class*="flash-sale-item"]',
      'div[class*="deal-item"]',
      'div[class*="col-xs-2-4"]',
      'div[class*="product-card"]',
      // Flash sale moderna: container avô do <a> que inclui preço+imagem
      'div:has(> a[href*="-i."]):has([class*="text-shopee-primary"])',
      'div:has(> a[href*="-i."]):has(del)',
      // Generic: any link to a product page inside known containers
      'a[href*="-i."][class*="contents"]',
      'div[class*="GQZVnL"]',
      'div[class*="ofs-item"]',
      // Último recurso estruturado: ancestral do link de produto que contenha "R$"
      'div[class*="flash-sale"] a[href*="-i."]',
    ];

    var cards = [];
    for (var s = 0; s < cardSelectors.length; s++) {
      try {
        cards = document.querySelectorAll(cardSelectors[s]);
      } catch (selErr) {
        // Seletores com :has() podem falhar em browsers antigos — ignora e segue
        continue;
      }
      if (cards.length > 0) {
        console.log('[AchadinhoPRO:Shopee] Cards encontrados com seletor:', cardSelectors[s], 'count:', cards.length);
        break;
      }
    }

    // Fallback: find ALL links pointing to product pages
    if (cards.length === 0) {
      console.log('[AchadinhoPRO:Shopee] Tentando fallback: links para produtos');
      var allLinks = document.querySelectorAll('a[href*="-i."]');
      // Filter to only links that look like product cards (have images inside)
      var productLinks = [];
      for (var l = 0; l < allLinks.length; l++) {
        var link = allLinks[l];
        if (link.querySelector('img') && link.href.match(/i\.\d+\.\d+/)) {
          productLinks.push(link);
        }
      }
      if (productLinks.length > 0) {
        cards = productLinks;
        console.log('[AchadinhoPRO:Shopee] Fallback: encontrados', cards.length, 'links de produtos com imagens');
      }
    }

    if (cards.length === 0) {
      console.log('[AchadinhoPRO:Shopee] Nenhum card encontrado no DOM');
      return [];
    }

    var products = [];
    for (var idx = 0; idx < cards.length; idx++) {
      try {
        var card = cards[idx];
        var product = extractProductFromCard(card, idx);
        if (product && product.productName) {
          products.push(product);
        }
      } catch (e) {
        console.error('[AchadinhoPRO:Shopee] Erro ao extrair card:', e);
      }
    }

    console.log('[AchadinhoPRO:Shopee] Produtos extraídos do DOM:', products.length);
    return products;
  }

  function extractProductFromCard(card, idx) {
    // Title
    var titleEl = card.querySelector(
      'div[data-sqe="name"], ' +
      '[class*="item-title"], ' +
      '[class*="product-name"], ' +
      '[class*="ie3A\\+n"], ' +
      '[class*="EAIlz5"], ' +
      'div[class*="line-clamp"], ' +
      'span[class*="name"], ' +
      'div[class*="title"]'
    );
    var title = titleEl ? (titleEl.textContent || '').trim() : '';
    var ariaSource = '';
    if (!title) {
      // Try aria-label on the card or link
      var linkEl = card.querySelector('a[href*="shopee"]') || card.closest('a');
      ariaSource = linkEl ? (linkEl.getAttribute('aria-label') || linkEl.getAttribute('title') || '') : '';
      // Em cards de flash sale o aria-label traz "nome null promoção menos 28% preço R$ XX"
      // — corta no primeiro marcador de metadados para ficar só o nome limpo.
      if (ariaSource) {
        var cut = ariaSource.split(/\s*(?:\bnull\b|promoç[ãa]o|pre[çc]o\s+(?:atual|original|promocional)|R\$|menos\s+\d+\s*%|-\d+\s*%)/i)[0];
        title = (cut || ariaSource).trim();
      }
    }
    if (!title) return null;

    // URL & IDs
    var url = null;
    var itemId = null;
    var shopId = null;
    var linkEl2 = card.tagName === 'A' ? card : card.querySelector('a[href*="-i."], a[href*="/product/"]');
    if (linkEl2) {
      url = linkEl2.href;
      var match = url.match(/i\.(\d+)\.(\d+)/);
      if (match) {
        shopId = match[1];
        itemId = match[2];
      }
    }

    // Price extraction - use smart container-based extraction
    // Em páginas de flash sale (/flash_sale?promotionId=...), o "card" capturado
    // pode ser apenas o <a href="-i."> envolvendo a imagem, enquanto preço e
    // badge -XX% vivem em <div>s irmãos/avô fora do link. Apenas nesse caso
    // (card = <a> SEM "R$" dentro) sobe até um ancestral com preço. Cards com
    // preços internos (comportamento normal) continuam usando o próprio card.
    var priceContainer = card;
    if (card.tagName === 'A' && (card.textContent || '').indexOf('R$') === -1) {
      var cardIdMatch = (card.href || '').match(/i\.(\d+)\.(\d+)/) ||
        (card.href || '').match(/\/product\/(\d+)\/(\d+)/);
      var cursor = card.parentElement;
      for (var hop = 0; hop < 5 && cursor && cursor !== document.body; hop++) {
        if ((cursor.textContent || '').indexOf('R$') !== -1) {
          // Rejeita ancestral que contenha link de OUTRO produto: nesse nível
          // já estamos na linha/grade e o preço encontrado seria do vizinho.
          var cursorLinks = cursor.querySelectorAll('a[href*="-i."]');
          var hasForeign = false;
          var distinctIds = {};
          for (var al = 0; al < cursorLinks.length; al++) {
            var linkIdMatch = (cursorLinks[al].href || '').match(/i\.(\d+)\.(\d+)/);
            if (!linkIdMatch) continue;
            distinctIds[linkIdMatch[1] + '.' + linkIdMatch[2]] = true;
            if (cardIdMatch && (linkIdMatch[1] !== cardIdMatch[1] || linkIdMatch[2] !== cardIdMatch[2])) {
              hasForeign = true;
              break;
            }
          }
          // Card sem ids extraíveis no href: só rejeita quando o ancestral
          // contém 2+ produtos distintos (o link do PRÓPRIO produto não conta).
          if (!cardIdMatch) {
            var idKeys = Object.keys(distinctIds);
            hasForeign = idKeys.length > 1;
          }
          if (!hasForeign) priceContainer = cursor;
          break;
        }
        cursor = cursor.parentElement;
      }
    }
    var prices = extractPricesFromContainer(priceContainer);
    var price = prices.current;
    var originalPrice = prices.original;
    var discountPercent = prices.discount;
    var promoPending = prices.promoPending === true;

    // Fallback estrutural para flash sale moderna Shopee (estrutura observada
    // no DOM: <div class="iibRFx"><span class="NCJp2i">R$</span><strong class="iwH3_q">68,00</strong></div>
    // para preço atual, e <div class="iibRFx"> sem <strong> para preço original).
    // Classes hasheadas mudam mensalmente, então combinamos seletor específico + <strong> genérico.
    // Usa priceContainer (card ou ancestral expandido) para alcançar spans fora do <a>.
    var containerText = (priceContainer.textContent || '').replace(/\s+/g, ' ');
    // Badge de desconto textual em forma canônica ("-16%" ou "16% OFF/desc"),
    // procurado FORA do título ("Fritadeira - 50% mais rápida" não é badge —
    // e alimentaria pickPairByBadge, elegendo parcela como preço). Regex frouxa
    // /\d+%/ casaria também cashback/moedas.
    var badgeSearchText = title
      ? containerText.split(title.replace(/\s+/g, ' ')).join(' ')
      : containerText;
    if (!discountPercent) {
      var badgeTextMatch = badgeSearchText.match(/-\s*(\d+)\s*%/) ||
        badgeSearchText.match(/(\d+)\s*%\s*(?:OFF|desc)/i);
      if (badgeTextMatch) {
        var badgeTextVal = parseInt(badgeTextMatch[1]);
        if (badgeTextVal >= 1 && badgeTextVal <= 99) discountPercent = badgeTextVal;
      }
    }
    var hasDiscountHint = !!discountPercent;

    if (!price) {
      var strongPriceEl = priceContainer.querySelector('strong[class*="iwH3_q"]');
      if (strongPriceEl) {
        price = parsePriceText('R$ ' + (strongPriceEl.textContent || '').trim());
      } else {
        // Layout 2026 usa <strong> tanto no preço cheio quanto no promocional.
        // Coleta todos com cara de preço (pai contém R$), em ordem DOM.
        var strongCandidates = priceContainer.querySelectorAll('strong');
        var strongVals = [];
        for (var sci = 0; sci < strongCandidates.length; sci++) {
          var sct = (strongCandidates[sci].textContent || '').trim();
          if (/^[\d.,]+$/.test(sct) && sct.length >= 3 && sct.length <= 12) {
            var spar = strongCandidates[sci].parentElement;
            if (spar && (spar.textContent || '').indexOf('R$') !== -1) {
              var sval = parsePriceText('R$ ' + sct);
              if (sval && sval > 0 && strongVals.indexOf(sval) === -1) strongVals.push(sval);
            }
          }
        }
        if (strongVals.length) {
          var strongPair = pickPairByBadge(strongVals, discountPercent);
          if (strongPair) {
            // Par consistente com o badge: menor=promocional, maior=cheio.
            price = strongPair.lo;
            if (!originalPrice) originalPrice = strongPair.hi;
          } else {
            // Sem badge/par consistente: invariante antiga — o preço real vem
            // ANTES de parcelas/notas/valores menores no DOM → primeiro strong.
            price = strongVals[0];
          }
        }
      }
    }

    // Fallback regex-no-textContent: scanneia "R$ X,XX" no priceContainer
    // (ordem DOM). originalPrice só é inferido quando consistente com o badge —
    // evita capturar parcelamento/cupom como "preço original".
    if (!price || (!originalPrice && hasDiscountHint)) {
      var rsMatches = containerText.match(/R\$\s*[\d.,]+/gi);
      if (rsMatches && rsMatches.length) {
        var rsParsed = [];
        for (var rm = 0; rm < rsMatches.length; rm++) {
          var rv = parsePriceText(rsMatches[rm]);
          if (rv && rv > 0) rsParsed.push(rv);
        }
        rsParsed = rsParsed.filter(function(v, i, arr) { return arr.indexOf(v) === i; });
        if (rsParsed.length) {
          if (!price) {
            var rsPair = pickPairByBadge(rsParsed, discountPercent);
            if (rsPair) {
              price = rsPair.lo;
              if (!originalPrice) originalPrice = rsPair.hi;
            } else {
              price = rsParsed[0]; // ordem DOM: preço real vem antes de parcelas
            }
          } else if (!originalPrice && hasDiscountHint) {
            // Já temos o atual: procura o cheio consistente com o badge.
            var hiCand = null;
            var hiDiff = 11;
            for (var rj = 0; rj < rsParsed.length; rj++) {
              if (rsParsed[rj] <= price) continue;
              var dRs = Math.round((1 - price / rsParsed[rj]) * 100);
              if (dRs < 1 || dRs > 99) continue;
              var dfRs = Math.abs(dRs - discountPercent);
              if (dfRs <= 10 && dfRs < hiDiff) {
                hiDiff = dfRs;
                hiCand = rsParsed[rj];
              }
            }
            if (hiCand) originalPrice = hiCand;
          }
        }
      }
    }

    // Fallback: simple selectors if container extraction failed
    if (!price) {
      var priceEl = card.querySelector(
        'span[class*="price"]:not(del span), ' +
        'div[class*="price"] span:not(del span), ' +
        '[class*="aBrP0a"], ' +
        '[class*="price-value"]'
      );
      price = priceEl ? parsePriceText(priceEl.textContent) : null;
    }

    // Fallback 2: Shopee Tailwind layout — R$ prefix span + value span inside text-shopee-primary
    if (!price) {
      var shopeePromoPrice = card.querySelector('[class*="text-shopee-primary"][class*="font-medium"]');
      if (shopeePromoPrice) {
        var priceText = (shopeePromoPrice.textContent || '').trim();
        if (priceText.indexOf('R$') !== -1) {
          price = parsePriceText(priceText);
        }
      }
    }
    // Fallback 3: Find any element with aria-label="promotion price" or containing R$
    if (!price) {
      var promoLabel = card.querySelector('[aria-label*="promotion price"], [aria-label*="current price"]');
      if (promoLabel) {
        var promoParent = promoLabel.closest('div');
        if (promoParent) {
          var priceTextAll = (promoParent.textContent || '').trim();
          if (priceTextAll.indexOf('R$') !== -1) {
            price = parsePriceText(priceTextAll);
          }
        }
      }
    }

    if (!originalPrice) {
      var origPriceEl = card.querySelector(
        'del, ' +
        '[class*="original-price"], ' +
        '[class*="before-discount"]'
      );
      originalPrice = origPriceEl ? parsePriceText(origPriceEl.textContent) : null;
    }
    if (!discountPercent) {
      var discountEl = card.querySelector(
        '[class*="discount"], ' +
        'span[class*="percent"]'
      );
      if (discountEl) {
        var discountMatch = (discountEl.textContent || '').match(/(\d+)\s*%/);
        if (discountMatch) discountPercent = validBadgePercent(parseInt(discountMatch[1]));
      }
    }
    // Fallback: Shopee Tailwind discount badge (bg-shopee-pink with -XX% text or aria-label)
    if (!discountPercent) {
      var pinkBadge = card.querySelector('[class*="bg-shopee-pink"]');
      if (pinkBadge) {
        var badgeLabel = pinkBadge.getAttribute('aria-label') || pinkBadge.textContent || '';
        var badgeMatch = badgeLabel.match(/-?\s*(\d+)\s*%/);
        if (badgeMatch) discountPercent = validBadgePercent(parseInt(badgeMatch[1]));
      }
      // Also try aria-label on child span (e.g. <span aria-label="-53%">)
      if (!discountPercent) {
        var discountAriaEl = card.querySelector('[aria-label*="%"]');
        if (discountAriaEl) {
          var ariaVal = discountAriaEl.getAttribute('aria-label') || '';
          var ariaMatch = ariaVal.match(/-?\s*(\d+)\s*%/);
          if (ariaMatch) discountPercent = validBadgePercent(parseInt(ariaMatch[1]));
        }
      }
    }
    // Fallback final: extrair dados do aria-label do link (flash sale Shopee
    // serializa tudo: "nome null promoção menos XX% preço original R$ A preço R$ B")
    if (!price || !originalPrice || !discountPercent) {
      var ariaFallback = ariaSource || '';
      if (!ariaFallback) {
        var linkForAria = card.tagName === 'A' ? card : (card.querySelector('a[aria-label]') || null);
        if (linkForAria) ariaFallback = linkForAria.getAttribute('aria-label') || '';
      }
      if (ariaFallback) {
        var ariaPrices = ariaFallback.match(/R\$\s*[\d.,]+/gi);
        if (ariaPrices && ariaPrices.length > 0) {
          var parsedPrices = [];
          for (var ap = 0; ap < ariaPrices.length; ap++) {
            var v = parsePriceText(ariaPrices[ap]);
            if (v && v > 0) parsedPrices.push(v);
          }
          if (parsedPrices.length === 1 && !price) {
            price = parsedPrices[0];
          } else if (parsedPrices.length >= 2) {
            parsedPrices.sort(function(a, b) { return a - b; });
            if (!price) price = parsedPrices[0];
            if (!originalPrice && parsedPrices[parsedPrices.length - 1] > parsedPrices[0]) {
              originalPrice = parsedPrices[parsedPrices.length - 1];
            }
          }
        }
        if (!discountPercent) {
          var ariaDiscMatch = ariaFallback.match(/menos\s+(\d+)\s*%/i) || ariaFallback.match(/-\s*(\d+)\s*%/);
          if (ariaDiscMatch) discountPercent = validBadgePercent(parseInt(ariaDiscMatch[1]));
        }
      }
    }
    // Trava de plausibilidade final (espelha server/price-format.ts): par com
    // atual >= cheio ou razão > 100× vem de fontes heterogêneas/erro de parse —
    // descarta par E desconto (trocar legitimaria lixo; manter só o desconto
    // faria o server gravar o badge do cliente verbatim sem par que o sustente).
    if (price && originalPrice && (price >= originalPrice || originalPrice / price > 100)) {
      originalPrice = null;
      discountPercent = null;
    }
    if (!discountPercent && originalPrice && price && originalPrice > price) {
      var derivedDisc = Math.round((1 - price / originalPrice) * 100);
      if (derivedDisc >= 1 && derivedDisc <= 99) discountPercent = derivedDisc;
    }
    // Deriva o cheio de price+badge quando só o promocional aparece no card
    // (layout comum fora de flash sale); 1..99 evita divisão por zero (100% OFF).
    // promoPending: o wrapper promocional existe mas ainda não renderizou (lazy) —
    // o price capturado é o CHEIO e fabricar um "original" acima dele seria fictício.
    if (!originalPrice && !promoPending && price && discountPercent && discountPercent >= 1 && discountPercent <= 99) {
      originalPrice = Math.round(price / (1 - discountPercent / 100));
    }

    // Image - find the PRODUCT image, not badges/icons
    var imageUrl = null;

    function isProductImage(imgEl) {
      var src = imgEl.getAttribute('src') || '';
      var dataSrc = imgEl.getAttribute('data-src') || '';
      // Prefer data-src for lazy-loaded images where src is a placeholder
      var effectiveSrc = '';
      if (src && src.indexOf('data:') === -1 && src.length >= 20) {
        effectiveSrc = src;
      } else if (dataSrc && dataSrc.indexOf('data:') === -1 && dataSrc.length >= 20) {
        effectiveSrc = dataSrc;
      }
      if (!effectiveSrc) return false;

      // Skip badge/icon/label images by alt text or aria-label
      var altText = (imgEl.getAttribute('alt') || imgEl.getAttribute('aria-label') || '').toLowerCase();
      if (/indicado|oficial|official|preferred|frete|gr[aá]tis|free.?ship|voucher|coin|cashback|ads|patrocinado|sponsored/i.test(altText)) return false;

      // Skip badge/overlay images by parent element class/position
      var parentEl = imgEl.parentElement;
      if (parentEl) {
        var parentClass = (parentEl.className || '').toString().toLowerCase();
        if (/badge|overlay|label|tag|stamp|icon|logo|ribbon/i.test(parentClass)) return false;
        // Badge overlays are typically position:absolute inside the card
        var parentStyle = window.getComputedStyle ? window.getComputedStyle(parentEl) : null;
        if (parentStyle && parentStyle.position === 'absolute') {
          // Check if this is a small overlay (badges), not the main image container
          var parentRect = parentEl.getBoundingClientRect();
          if (parentRect.width < 120 || parentRect.height < 120) return false;
        }
      }

      // Skip badge/icon/label images (small icons like "Oficial", "Indicado", "Frete Grátis")
      var width = imgEl.getAttribute('width') || imgEl.naturalWidth || imgEl.offsetWidth || 0;
      var height = imgEl.getAttribute('height') || imgEl.naturalHeight || imgEl.offsetHeight || 0;
      width = parseInt(width) || 0;
      height = parseInt(height) || 0;
      // Badge images are typically very small (< 80px)
      if ((width > 0 && width < 80) || (height > 0 && height < 80)) return false;
      // Also check rendered size via getBoundingClientRect for lazy-loaded images with no explicit dimensions
      if (width === 0 && height === 0) {
        var rect = imgEl.getBoundingClientRect();
        if (rect.width > 0 && rect.width < 80) return false;
        if (rect.height > 0 && rect.height < 80) return false;
      }

      // Skip known badge/icon patterns in URL
      if (effectiveSrc.match(/badge|icon|label|tag|logo|official|stamp|voucher|coin|free.?shipping/i)) return false;
      // Skip SVG placeholder
      if (effectiveSrc.indexOf('.svg') !== -1) return false;
      return effectiveSrc;
    }

    // Strategy 1: Prefer the LAST susercontent/cf.shopee background-image (flash sale product photos)
    // Flash sale cards stack multiple susercontent divs — the first is an overlay (often black/empty),
    // the actual product image is always the LAST one in DOM order.
    var allBgEls = card.querySelectorAll('div[style*="background-image"]');
    var lastSucontentUrl = null;
    for (var bgIdx1 = 0; bgIdx1 < allBgEls.length; bgIdx1++) {
      var bgStyle1 = allBgEls[bgIdx1].getAttribute('style') || '';
      var bgMatch1 = bgStyle1.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
      if (bgMatch1 && (bgMatch1[1].indexOf('susercontent') !== -1 || bgMatch1[1].indexOf('cf.shopee') !== -1)) {
        lastSucontentUrl = bgMatch1[1]; // keep overwriting — last one wins
      }
    }
    if (lastSucontentUrl) {
      imageUrl = lastSucontentUrl;
    }

    // Strategy 2: Prefer Shopee CDN product <img> tags (susercontent.com)
    if (!imageUrl) {
      var allImgs = card.querySelectorAll('img');
      for (var imgIdx = 0; imgIdx < allImgs.length; imgIdx++) {
        var candidateSrc = allImgs[imgIdx].getAttribute('src') || allImgs[imgIdx].getAttribute('data-src') || '';
        if (candidateSrc.indexOf('susercontent') !== -1 || candidateSrc.indexOf('cf.shopee') !== -1) {
          var validSrc = isProductImage(allImgs[imgIdx]);
          if (validSrc) {
            imageUrl = validSrc;
            break;
          }
        }
      }
    }

    // Strategy 3: Any valid product <img>
    if (!imageUrl) {
      var allImgs2 = card.querySelectorAll('img');
      for (var imgIdx2 = 0; imgIdx2 < allImgs2.length; imgIdx2++) {
        var validSrc2 = isProductImage(allImgs2[imgIdx2]);
        if (validSrc2) {
          imageUrl = validSrc2;
          break;
        }
      }
    }

    // Strategy 4: Any other background-image (skip known promotional/badge domains)
    if (!imageUrl) {
      for (var bgIdx2 = 0; bgIdx2 < allBgEls.length; bgIdx2++) {
        var bgStyle2 = allBgEls[bgIdx2].getAttribute('style') || '';
        var bgMatch2 = bgStyle2.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
        if (bgMatch2 && !bgMatch2[1].match(/badge|icon|label|tag|logo|oficial|indicado|shopeemobile|deo\./i)) {
          imageUrl = bgMatch2[1];
          break;
        }
      }
    }

    // Free shipping badge
    var freeShipping = false;
    var shippingBadge = card.querySelector(
      '[class*="free-shipping"], ' +
      'img[alt*="Free"], ' +
      '[class*="frete"], ' +
      'svg[class*="ship"]'
    );
    if (shippingBadge) {
      freeShipping = true;
    } else {
      var allText = card.textContent || '';
      if (allText.toLowerCase().indexOf('frete grátis') !== -1 || allText.toLowerCase().indexOf('free shipping') !== -1) {
        freeShipping = true;
      }
    }

    // Rating
    var ratingEl = card.querySelector('[class*="rating"]');
    var rating = null;
    if (ratingEl) {
      var ratingMatch = (ratingEl.textContent || '').match(/([\d.]+)/);
      if (ratingMatch) rating = ratingMatch[1];
    }
    if (!rating) {
      // Shopee uses small spans (inline-block truncate) near star SVGs for rating
      var starContainer = card.querySelector('svg');
      if (starContainer && starContainer.parentElement) {
        var ratingSpans = starContainer.parentElement.querySelectorAll('span');
        for (var rs = 0; rs < ratingSpans.length; rs++) {
          var spanText = (ratingSpans[rs].textContent || '').trim();
          if (/^[1-5]\.\d$/.test(spanText)) {
            rating = spanText;
            break;
          }
        }
      }
    }
    // Fallback: Shopee Tailwind — rating in small span near promotion-label-icon img
    if (!rating) {
      var promoIcon = card.querySelector('img[alt="promotion-label-icon"]');
      if (promoIcon && promoIcon.parentElement) {
        var ratingSpans2 = promoIcon.parentElement.querySelectorAll('span');
        for (var rs2 = 0; rs2 < ratingSpans2.length; rs2++) {
          var spanText2 = (ratingSpans2[rs2].textContent || '').trim();
          if (/^[1-5]\.\d$/.test(spanText2)) {
            rating = spanText2;
            break;
          }
        }
      }
    }
    // Fallback: Scan all small truncate spans in badge-like containers for rating pattern
    if (!rating) {
      var truncateSpans = card.querySelectorAll('span.truncate, span[class*="inline-block"]');
      for (var ts = 0; ts < truncateSpans.length; ts++) {
        var tsText = (truncateSpans[ts].textContent || '').trim();
        if (/^[1-5]\.\d$/.test(tsText)) {
          // Verify it's not inside a price area
          var tsParent = truncateSpans[ts].closest('[class*="text-shopee-primary"]');
          if (!tsParent) {
            rating = tsText;
            break;
          }
        }
      }
    }

    // Seller
    var sellerEl = card.querySelector('[class*="shop-name"], [class*="seller"]');
    var seller = sellerEl ? (sellerEl.textContent || '').trim() : null;

    // Sales
    var salesQuantity = 0;
    var salesEl = card.querySelector('[class*="sold"], [class*="sales"]');
    if (salesEl) {
      var salesText = salesEl.textContent || '';
      var salesMatch = salesText.match(/([\d.,]+)\s*(mil|k)?/i);
      if (salesMatch) {
        var num = parseFloat(salesMatch[1].replace('.', '').replace(',', '.'));
        if (salesMatch[2] && (salesMatch[2].toLowerCase() === 'mil' || salesMatch[2].toLowerCase() === 'k')) {
          num *= 1000;
        }
        salesQuantity = Math.floor(num);
      }
    }
    // Fallback: Shopee Tailwind — sales text with "Vendido(s)" pattern anywhere in card
    if (salesQuantity === 0) {
      var allDivs = card.querySelectorAll('div');
      for (var sd = 0; sd < allDivs.length; sd++) {
        var divText = (allDivs[sd].textContent || '').trim();
        // Match patterns: "300mil+ Vendido(s)", "20mil+ Vendido(s)", "10+ Vendido(s)"
        var vendidoMatch = divText.match(/([\d.,]+)\s*(mil|k)?\+?\s*vendido/i);
        if (vendidoMatch) {
          var salesNum = parseFloat(vendidoMatch[1].replace('.', '').replace(',', '.'));
          if (vendidoMatch[2] && (vendidoMatch[2].toLowerCase() === 'mil' || vendidoMatch[2].toLowerCase() === 'k')) {
            salesNum *= 1000;
          }
          salesQuantity = Math.floor(salesNum);
          break;
        }
        // Also match English "sold" pattern
        var soldMatch = divText.match(/([\d.,]+)\s*(mil|k)?\+?\s*sold/i);
        if (soldMatch) {
          var soldNum = parseFloat(soldMatch[1].replace('.', '').replace(',', '.'));
          if (soldMatch[2] && (soldMatch[2].toLowerCase() === 'mil' || soldMatch[2].toLowerCase() === 'k')) {
            soldNum *= 1000;
          }
          salesQuantity = Math.floor(soldNum);
          break;
        }
      }
    }

    // Offer type from page context
    var offerInfo = detectOfferType();

    return {
      platform: 'shopee',
      platformItemId: itemId,
      shopId: shopId,
      productName: title,
      price: price,
      originalPrice: originalPrice,
      discountPercent: discountPercent,
      freeShipping: freeShipping,
      imageUrl: imageUrl,
      productUrl: url,
      seller: seller,
      rating: rating,
      condition: 'new',
      categoryId: null,
      salesQuantity: salesQuantity,
      offerType: offerInfo.offerType,
      offerEndTime: offerInfo.offerEndTime,
      position: idx + 1
    };
  }

  // ===== CATEGORY EXTRACTION =====

  function extractCategoryInfo() {
    var categoryName = null;
    var categoryBreadcrumb = [];

    // Strategy 1: Sidebar navigation with active sub-category
    var mainCatEl = document.querySelector('.shopee-category-list__main-category__link');
    var activeCatEl = document.querySelector('.shopee-category-list__sub-category--active');

    if (mainCatEl) {
      var mainText = (mainCatEl.textContent || '').trim();
      if (mainText) categoryBreadcrumb.push(mainText);
    }
    if (activeCatEl) {
      var activeText = (activeCatEl.textContent || '').trim();
      if (activeText) {
        categoryBreadcrumb.push(activeText);
        categoryName = activeText;
      }
    }

    // Strategy 2: Breadcrumb from page header
    if (categoryBreadcrumb.length === 0) {
      var breadcrumbs = document.querySelectorAll('.shopee-header-section__header__category-breadcrumb a, [class*="breadcrumb"] a');
      breadcrumbs.forEach(function(el) {
        var text = (el.textContent || '').trim();
        if (text) categoryBreadcrumb.push(text);
      });
      if (categoryBreadcrumb.length > 0) {
        categoryName = categoryBreadcrumb[categoryBreadcrumb.length - 1];
      }
    }

    // Strategy 3: Extract from URL (e.g. /Artigos-de-Cozinha-cat.123.456 or /list/Cozinha)
    if (!categoryName) {
      var urlMatch = window.location.pathname.match(/\/([^\/]+)-cat\.\d+/);
      if (urlMatch) {
        categoryName = urlMatch[1].replace(/-/g, ' ');
      } else {
        var listMatch = window.location.pathname.match(/\/list\/([^\/\?]+)/);
        if (listMatch) {
          categoryName = decodeURIComponent(listMatch[1]).replace(/-/g, ' ');
        }
      }
      if (categoryName && categoryBreadcrumb.length === 0) {
        categoryBreadcrumb.push(categoryName);
      }
    }

    return {
      categoryName: categoryName,
      categoryBreadcrumb: categoryBreadcrumb.length > 0 ? categoryBreadcrumb : null,
    };
  }

  // ===== MAIN EXTRACTION FUNCTION =====

  function extractProductData() {
    var pageType = detectPageType();
    console.log('[AchadinhoPRO:Shopee] Tipo de página detectado:', pageType);

    if (pageType === 'product') {
      var product = extractSingleProduct();
      if (product && product.productName) {
        return { success: true, data: product, source: 'shopee_dom', pageType: 'product' };
      }
      return { success: false, error: 'Dados do produto não encontrados', captcha: false };
    }

    if (pageType === 'listing') {
      var products = extractListingFromDOM();
      if (products.length > 0) {
        // Enrich products with category info
        var catInfo = extractCategoryInfo();
        if (catInfo.categoryName || catInfo.categoryBreadcrumb) {
          for (var ci = 0; ci < products.length; ci++) {
            if (!products[ci].categoryName && catInfo.categoryName) products[ci].categoryName = catInfo.categoryName;
            if (!products[ci].categoryBreadcrumb && catInfo.categoryBreadcrumb) products[ci].categoryBreadcrumb = catInfo.categoryBreadcrumb;
          }
        }
        return { success: true, data: products, source: 'shopee_dom', count: products.length, pageType: 'listing' };
      }
      return { success: false, error: 'Nenhum produto encontrado na listagem', captcha: false };
    }

    // Unknown page - try both
    var singleProduct = extractSingleProduct();
    if (singleProduct && singleProduct.productName) {
      return { success: true, data: singleProduct, source: 'shopee_dom', pageType: 'product' };
    }

    var listProducts = extractListingFromDOM();
    if (listProducts.length > 0) {
      return { success: true, data: listProducts, source: 'shopee_dom', count: listProducts.length, pageType: 'listing' };
    }

    return { success: false, error: 'Página não reconhecida', captcha: false };
  }

  // ===== MESSAGE LISTENERS =====

  chrome.runtime.onMessage.addListener(function(message, _sender, sendResponse) {
    if (message.action === 'ping') {
      sendResponse({ status: 'ok', marketplace: 'shopee' });
      return true;
    }

    if (message.action === 'getPageType') {
      sendResponse({ pageType: detectPageType() });
      return true;
    }

    if (message.action === 'extractOffer') {
      var result = extractProductData();
      console.log('[AchadinhoPRO:Shopee] Resultado extractOffer:', result.success, result.source, Array.isArray(result.data) ? result.data.length + ' items' : 'single');
      sendResponse(result);
      return true;
    }

    if (message.action === 'extractAllOffers') {
      var products = extractListingFromDOM();
      console.log('[AchadinhoPRO:Shopee] Resultado extractAllOffers:', products.length, 'produtos');
      sendResponse({
        success: products.length > 0,
        data: products,
        count: products.length,
      });
      return true;
    }

    return false;
  });

  // ===== AUTO-EXTRACT ON PRODUCT PAGE =====

  // ===== AUTO-EXTRACT WITH RETRY (Shopee loads content dynamically) =====

  function autoExtractAndSend() {
    if (!isContextValid()) return false;
    var result = extractProductData();
    if (result.success) {
      chrome.runtime.sendMessage({
        action: 'offerExtracted',
        data: result.data,
        source: result.source,
        platform: 'shopee'
      }).catch(function() {});
      return true;
    }
    return false;
  }

  // Retry extraction with increasing delays for dynamically loaded pages
  function autoExtractWithRetry(maxAttempts, delayMs) {
    var attempts = 0;
    function tryExtract() {
      if (!isContextValid()) return;
      attempts++;
      console.log('[AchadinhoPRO:Shopee] Auto-extract tentativa', attempts, '/', maxAttempts);
      if (autoExtractAndSend()) {
        console.log('[AchadinhoPRO:Shopee] Auto-extract sucesso na tentativa', attempts);
        return;
      }
      if (attempts < maxAttempts) {
        setTimeout(tryExtract, delayMs);
      } else {
        console.log('[AchadinhoPRO:Shopee] Auto-extract: nenhum produto encontrado após', maxAttempts, 'tentativas');
      }
    }
    setTimeout(tryExtract, delayMs);
  }

  // Start auto-extraction: more retries for listing pages (lazy loading)
  var pageType = getSimplePageType();
  if (pageType === 'product') {
    autoExtractWithRetry(3, 1500);
  } else if (pageType === 'listing') {
    autoExtractWithRetry(8, 2000);
  }

  // ===== MUTATION OBSERVER FOR LAZY-LOADED CONTENT =====

  var lastExtractedCount = 0;
  var extractDebounce = null;

  function onDomChanged() {
    if (!isContextValid()) { cleanupObservers(); return; }
    // Only re-extract on listing pages (new cards may appear on scroll)
    if (getSimplePageType() !== 'listing') return;

    if (extractDebounce) clearTimeout(extractDebounce);
    extractDebounce = setTimeout(function() {
      if (!isContextValid()) { cleanupObservers(); return; }
      var result = extractProductData();
      if (result.success && Array.isArray(result.data) && result.data.length > lastExtractedCount) {
        lastExtractedCount = result.data.length;
        console.log('[AchadinhoPRO:Shopee] Novos produtos detectados no DOM:', lastExtractedCount);
        chrome.runtime.sendMessage({
          action: 'offerExtracted',
          data: result.data,
          source: result.source,
          platform: 'shopee'
        }).catch(function() {});
      }
    }, 1500);
  }

  // ===== NAVIGATION DETECTION =====

  var lastUrl = window.location.href;
  var navigationTimeout = null;

  function notifyPageChange() {
    if (!isContextValid()) { cleanupObservers(); return; }
    var currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      console.log('[AchadinhoPRO:Shopee] Navegação detectada:', currentUrl);
      lastUrl = currentUrl;
      lastExtractedCount = 0;
      if (navigationTimeout) clearTimeout(navigationTimeout);
      navigationTimeout = setTimeout(function() {
        if (!isContextValid()) { cleanupObservers(); return; }
        try {
          chrome.runtime.sendMessage({
            action: 'pageChanged',
            url: currentUrl,
            pageType: getSimplePageType(),
            platform: 'shopee'
          }).catch(function() {});

          // Auto-extract after navigation
          var newPageType = getSimplePageType();
          if (newPageType === 'product') {
            autoExtractWithRetry(3, 1500);
          } else if (newPageType === 'listing') {
            autoExtractWithRetry(8, 2000);
          }
        } catch (e) {}
      }, 1200);
    }
  }

  // Cleanup function to stop observers when context is invalidated
  function cleanupObservers() {
    console.log('[AchadinhoPRO:Shopee] Contexto invalidado, desconectando observers');
    if (domObserver) domObserver.disconnect();
    window.removeEventListener('popstate', notifyPageChange);
  }

  // Shopee is a SPA - observe DOM changes for navigation AND lazy loading
  var domObserver = new MutationObserver(function() {
    if (!isContextValid()) { cleanupObservers(); return; }
    notifyPageChange();
    onDomChanged();
  });
  if (document.body) {
    domObserver.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener('popstate', notifyPageChange);

  var originalPushState = history.pushState;
  var originalReplaceState = history.replaceState;
  history.pushState = function() { originalPushState.apply(this, arguments); notifyPageChange(); };
  history.replaceState = function() { originalReplaceState.apply(this, arguments); notifyPageChange(); };

  console.log('[AchadinhoPRO:Shopee] Tipo de página:', getSimplePageType());
})();
