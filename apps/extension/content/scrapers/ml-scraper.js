(function () {
  'use strict';

  console.log('[AchadinhoPRO:ML] Content script carregado');

  // Guard against "Extension context invalidated" errors (quando extensão é recarregada)
  function isContextValid() {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  var _urlObserver = null;
  var _notifyInterval = null;
  var _hubGridObserver = null;
  var _hubReextractTimer = null;
  var _observersCleanedUp = false;
  function cleanupObservers() {
    if (_observersCleanedUp) return;
    _observersCleanedUp = true;
    try { if (_urlObserver) _urlObserver.disconnect(); } catch (e) {}
    try { if (_hubGridObserver) _hubGridObserver.disconnect(); } catch (e) {}
    try { if (_notifyInterval) clearInterval(_notifyInterval); } catch (e) {}
    try { if (_hubReextractTimer) clearTimeout(_hubReextractTimer); } catch (e) {}
    _urlObserver = null;
    _hubGridObserver = null;
    _notifyInterval = null;
    _hubReextractTimer = null;
  }

  var preloadedState = null;

  function normalizeUrl(url, baseUrl) {
    baseUrl = baseUrl || 'https://www.mercadolivre.com.br';
    if (!url) return null;
    if (url.startsWith('https://') || url.startsWith('http://')) return url;
    if (url.match(/^(www|produto|click\d*)\.mercadoli(vre|bre)\.com/i)) return `https://${url}`;
    if (url.startsWith('/')) return `${baseUrl}${url}`;
    return `${baseUrl}/${url}`;
  }

  async function getPreloadedState() {
    var scriptTag = document.getElementById('__PRELOADED_STATE__');
    if (scriptTag && scriptTag.textContent) {
      try {
        var data = JSON.parse(scriptTag.textContent);
        console.log('[AchadinhoPRO:ML] Estado extraído de <script> tag');
        return data;
      } catch (e) {
        console.warn('[AchadinhoPRO:ML] Erro ao parsear __PRELOADED_STATE__ tag:', e);
      }
    }

    var inlineState = findStateInScripts();
    if (inlineState) {
      console.log('[AchadinhoPRO:ML] Estado extraído de script inline', inlineState._nordicFormat ? '(formato Nordic)' : '');
      return inlineState;
    }

    var windowState = await injectAndGetWindowState();
    if (windowState) {
      console.log('[AchadinhoPRO:ML] Estado extraído via injeção', windowState._nordicFormat ? '(formato Nordic)' : '');
      return windowState;
    }

    return null;
  }

  function findStateInScripts() {
    var scripts = document.querySelectorAll('script:not([src])');

    for (var s = 0; s < scripts.length; s++) {
      var text = scripts[s].textContent || '';

      var stateIndex = text.indexOf('window.__PRELOADED_STATE__');
      var isNordic = false;

      if (stateIndex === -1) {
        stateIndex = text.indexOf('_n.ctx.r');
        if (stateIndex !== -1) {
          isNordic = true;
          console.log('[AchadinhoPRO:ML] Encontrado formato _n.ctx.r');
        }
      }

      if (stateIndex === -1) continue;

      var equalIndex = text.indexOf('=', stateIndex);
      if (equalIndex === -1) continue;

      var startIndex = text.indexOf('{', equalIndex);
      if (startIndex === -1) continue;

      var braceCount = 0;
      var endIndex = startIndex;

      for (var i = startIndex; i < text.length; i++) {
        if (text[i] === '{') braceCount++;
        else if (text[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            endIndex = i + 1;
            break;
          }
        }
      }

      if (braceCount !== 0) continue;

      try {
        var jsonStr = text.substring(startIndex, endIndex);
        jsonStr = jsonStr.replace(/\\u002F/g, '/');
        jsonStr = jsonStr.replace(/\\u0026/g, '&');
        var data = JSON.parse(jsonStr);

        if (isNordic) {
          data = normalizeNordicData(data);
        }

        return data;
      } catch (e) {
        console.warn('[AchadinhoPRO:ML] Erro ao parsear JSON inline:', e);
      }
    }

    return null;
  }

  function normalizeNordicData(data) {
    if (data && data.appProps && data.appProps.pageProps && data.appProps.pageProps.data && data.appProps.pageProps.data.items) {
      var items = data.appProps.pageProps.data.items;
      console.log('[AchadinhoPRO:ML] Normalizando _n.ctx.r (data.items):', items.length);
      if (items.length > 0) {
        console.log('[AchadinhoPRO:ML] Keys do primeiro item Nordic:', Object.keys(items[0]));
        console.log('[AchadinhoPRO:ML] Primeiro item preview:', JSON.stringify(items[0]).substring(0, 500));
      }
      return {
        data: {
          items: items,
          paging: data.appProps.pageProps.data.paging || {}
        },
        _nordicFormat: true,
        _nordicSubFormat: 'data.items'
      };
    }

    if (data && data.appProps && data.appProps.pageProps && data.appProps.pageProps.initialState && data.appProps.pageProps.initialState.results) {
      var results = data.appProps.pageProps.initialState.results;
      console.log('[AchadinhoPRO:ML] Normalizando _n.ctx.r (initialState.results):', results.length);
      var items = results
        .filter(function(r) { return r.polycard && r.polycard.metadata && r.polycard.metadata.id; })
        .map(function(r) {
          return {
            card: {
              metadata: r.polycard.metadata,
              components: r.polycard.components || [],
              pictures: r.polycard.pictures || { pictures: [] }
            }
          };
        });
      return {
        data: {
          items: items,
          paging: data.appProps.pageProps.initialState.paging || {}
        },
        _nordicFormat: true,
        _nordicSubFormat: 'initialState.results'
      };
    }

    data._nordicFormat = true;
    return data;
  }

  function injectAndGetWindowState() {
    return new Promise(function(resolve) {
      var attempts = 0;
      var maxAttempts = 5;

      function tryInject() {
        attempts++;

        var dataElement = document.getElementById('__achadinhopro_data__');
        if (!dataElement) {
          dataElement = document.createElement('div');
          dataElement.id = '__achadinhopro_data__';
          dataElement.style.display = 'none';
          document.body.appendChild(dataElement);
        }
        dataElement.textContent = '';

        var script = document.createElement('script');
        script.textContent = [
          '(function() {',
          '  try {',
          '    var data = window.__PRELOADED_STATE__;',
          '    var isNordic = false;',
          '    if (!data && window._n && window._n.ctx && window._n.ctx.r) {',
          '      data = window._n.ctx.r;',
          '      isNordic = true;',
          '    }',
          '    var el = document.getElementById("__achadinhopro_data__");',
          '    if (data && el) {',
          '      if (isNordic && data.appProps && data.appProps.pageProps && data.appProps.pageProps.data && data.appProps.pageProps.data.items) {',
          '        data = { data: { items: data.appProps.pageProps.data.items, paging: data.appProps.pageProps.data.paging || {} }, _nordicFormat: true, _nordicSubFormat: "data.items" };',
          '      } else if (isNordic && data.appProps && data.appProps.pageProps && data.appProps.pageProps.initialState && data.appProps.pageProps.initialState.results) {',
          '        var r = data.appProps.pageProps.initialState.results;',
          '        var items = r.filter(function(x){return x.polycard&&x.polycard.metadata&&x.polycard.metadata.id;}).map(function(x){return {card:{metadata:x.polycard.metadata,components:x.polycard.components||[],pictures:x.polycard.pictures||{pictures:[]}}};});',
          '        data = { data: { items: items, paging: data.appProps.pageProps.initialState.paging || {} }, _nordicFormat: true, _nordicSubFormat: "initialState.results" };',
          '      }',
          '      el.textContent = JSON.stringify(data);',
          '    }',
          '  } catch (e) {}',
          '})();'
        ].join('\n');
        document.documentElement.appendChild(script);
        script.remove();

        setTimeout(function() {
          try {
            var content = dataElement.textContent;
            if (content && content.length > 10) {
              dataElement.remove();
              resolve(JSON.parse(content));
            } else if (attempts < maxAttempts) {
              setTimeout(tryInject, 200);
            } else {
              dataElement.remove();
              resolve(null);
            }
          } catch (e) {
            if (attempts < maxAttempts) {
              setTimeout(tryInject, 200);
            } else {
              if (dataElement.parentNode) dataElement.remove();
              resolve(null);
            }
          }
        }, 150);
      }

      tryInject();
    });
  }

  function detectCaptcha() {
    var title = document.title || '';
    if (title.toLowerCase().indexOf('verifique') !== -1 || title.toLowerCase().indexOf('verifica') !== -1) return true;
    var body = document.body ? document.body.textContent : '';
    if (body && (body.indexOf('Verifique se você é humano') !== -1 || body.indexOf('captcha') !== -1)) return true;
    return false;
  }

  function detectPageType() {
    var url = window.location.href;

    // Detect homepage: mercadolivre.com.br/ or mercadolivre.com.br (with optional query params like ?matt_tool=)
    var homepagePattern = /^https?:\/\/[^/]*mercadolivre\.com\.br\/?(\?[^/]*)?$/;
    if (homepagePattern.test(url)) {
      console.log('[AchadinhoPRO:ML] Detectado como homepage');
      return 'homepage';
    }

    // Detect category pages: /c/MLB-XXXXX, /c/anything
    if (url.indexOf('/c/') !== -1) {
      console.log('[AchadinhoPRO:ML] Detectado como categoria');
      return 'category';
    }

    // Hub de afiliados (/afiliados/hub): grade polycard com INFINITE SCROLL. Não
    // batia em nenhum dos padrões de listagem abaixo e caía no ramo 'unknown', que
    // só extrai por acaso. Ver cabeçalho de ml-hub-scraper.js.
    if (typeof MlHubScraper !== 'undefined' && MlHubScraper.isHubUrl(url)) {
      console.log('[AchadinhoPRO:ML] Detectado como listing (hub de afiliados)');
      return 'listing';
    }

    if (url.indexOf('/ofertas') !== -1 || url.indexOf('/busca') !== -1
        || url.indexOf('/mais-vendidos') !== -1 || url.indexOf('_Desde_') !== -1) {
      console.log('[AchadinhoPRO:ML] Detectado como listing pela URL');
      return 'listing';
    }

    if (url.indexOf('lista.mercadolivre') !== -1 || url.indexOf('/s?') !== -1 || url.indexOf('busca?') !== -1 || url.indexOf('_DisplayType_') !== -1) {
      console.log('[AchadinhoPRO:ML] Detectado como listing pela URL (busca/lista)');
      return 'listing';
    }

    // PDP inequívoca (/p/MLB..., /up/MLBU..., produto.mercadolivre) ou DOM de PDP.
    // Vem ANTES do teste de data.items porque a PDP também carrega carrosséis de
    // relacionados no estado — e a página do produto virava 'listing', devolvendo
    // um ARRAY de recomendações no lugar do produto aberto. Os testes de listagem
    // por URL (categoria/ofertas/busca) já rodaram acima, então nenhuma listagem
    // chega aqui.
    if (typeof MlPdpScraper !== 'undefined'
        && (MlPdpScraper.isPdpUrl(url) || MlPdpScraper.hasPdpDom(document))) {
      console.log('[AchadinhoPRO:ML] Detectado como product (PDP)');
      return 'product';
    }

    if (preloadedState && preloadedState.data && preloadedState.data.items) {
      console.log('[AchadinhoPRO:ML] Detectado como listing por data.items');
      return 'listing';
    }

    if (url.indexOf('/p/MLB') !== -1 || url.match(/\/MLB-?\d+/)) {
      console.log('[AchadinhoPRO:ML] Detectado como product pela URL');
      return 'product';
    }

    if (url.indexOf('produto.mercadolivre') !== -1) {
      console.log('[AchadinhoPRO:ML] Detectado como product (produto.mercadolivre)');
      return 'product';
    }

    if (preloadedState) {
      var is = preloadedState.initialState || preloadedState;
      if (is.components && is.components.gallery) {
        console.log('[AchadinhoPRO:ML] Detectado como product pela estrutura do estado');
        return 'product';
      }
    }

    if (preloadedState && (preloadedState.results || (preloadedState.initialState && preloadedState.initialState.results))) {
      console.log('[AchadinhoPRO:ML] Detectado como listing pela estrutura do estado');
      return 'listing';
    }

    console.log('[AchadinhoPRO:ML] Tipo de página não identificado');
    return 'unknown';
  }

  function extractItemIdFromUrl() {
    // O id tem de sair da MESMA resolução do link (getCanonicalUrl acima): numa PDP
    // de produto de vendedor a URL da aba traz o id da PROMOÇÃO em
    // `pdp_filters=deal:MLB…` ANTES do `wid=MLB…` do item, e o regex solto abaixo
    // pegava o da promoção — gravando uma chave (userId, mlItemId) que não é do
    // produto e pode colidir com outro item da mesma promoção.
    var link = getCanonicalUrl();
    if (typeof MlPdpScraper !== 'undefined' && MlPdpScraper.extractItemIdFromUrl) {
      var id = MlPdpScraper.extractItemIdFromUrl(link);
      if (id) return id;
    }
    var url = window.location.href;
    var match = url.match(/MLB-?(\d+)/i);
    return match ? 'MLB' + match[1] : null;
  }

  function getTextFromDOM(selector) {
    var el = document.querySelector(selector);
    return el ? (el.textContent || '').trim() : null;
  }

  function getPriceFromDOM() {
    var fractionEl = document.querySelector('.andes-money-amount__fraction');
    if (!fractionEl) return null;
    var centsEl = document.querySelector('.andes-money-amount__cents');
    var value = (fractionEl.textContent || '').replace(/\D/g, '');
    // Normaliza centavos: remove separadores e garante 2 dígitos para evitar que "9"
    // vire 0.9 em vez de 0.09 ao ser concatenado no parseFloat.
    var rawCents = centsEl ? (centsEl.textContent || '').replace(/\D/g, '') : '';
    var centValue = rawCents ? rawCents.padStart(2, '0').slice(0, 2) : '00';
    return parseFloat(value + '.' + centValue);
  }

  function getSellerFromDOM() {
    var el = document.querySelector('.ui-pdp-seller__link-trigger') ||
             document.querySelector('.ui-pdp-seller__header__title');
    return el ? (el.textContent || '').trim() : null;
  }

  function getCanonicalUrl() {
    var canonical = document.querySelector('link[rel="canonical"]');
    var url = canonical ? canonical.href : window.location.href;
    // PDP de produto de vendedor (/up/MLBU...): o canonical aponta para o namespace
    // MLBU, com o qual o gerador de link de afiliado não trabalha. O ml-pdp-scraper
    // recupera o MLB real do item a partir do rastreio do clique — ver
    // resolveProductLink lá. Mesmo tratamento que o caminho dedicado da PDP recebe,
    // para que os caminhos legado/JSON-LD não fiquem com o defeito antigo.
    if (/\/up\/MLBU?-?\d+/i.test(url)
      && typeof MlPdpScraper !== 'undefined' && MlPdpScraper.resolveProductLink) {
      try {
        return MlPdpScraper.resolveProductLink(document, window.location.href) || url;
      } catch (e) { /* mantém o canonical */ }
    }
    return url;
  }

  function hasFreeShippingFromDOM() {
    var el = document.querySelector('.ui-pdp-color--GREEN');
    return el ? (el.textContent || '').toLowerCase().indexOf('grátis') !== -1 : false;
  }

  function extractConditionFromDOM() {
    var el = document.querySelector('.ui-pdp-subtitle');
    var text = el ? (el.textContent || '').toLowerCase() : '';
    if (text.indexOf('novo') !== -1) return 'new';
    if (text.indexOf('usado') !== -1) return 'used';
    return null;
  }

  function getSalesFromDOM() {
    var selectors = ['.ui-pdp-subtitle', '.ui-pdp-header__subtitle', '[class*="subtitle"]'];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) {
        var text = el.textContent || '';
        var match = text.match(/\+?(\d+[\.,]?\d*)\s*(mil|k)?\s*vendidos?/i);
        if (match) {
          var num = parseFloat(match[1].replace(',', '.'));
          if (match[2] && (match[2].toLowerCase() === 'mil' || match[2].toLowerCase() === 'k')) {
            num *= 1000;
          }
          return Math.floor(num);
        }
      }
    }
    return 0;
  }

  function getRatingFromDOM() {
    var ratingEl = document.querySelector('.ui-pdp-review__rating, .ui-review-capability__rating__average');
    var countEl = document.querySelector('.ui-pdp-review__amount, .ui-review-capability__rating__label');
    var rating = null;
    var count = 0;
    if (ratingEl) rating = parseFloat(ratingEl.textContent);
    if (countEl) {
      var match = (countEl.textContent || '').match(/\(?([\d\.]+)\)?/);
      if (match) count = parseInt(match[1].replace('.', ''));
    }
    return { rating: rating, count: count };
  }

  function getImageFromDOM() {
    var selectors = [
      'img[data-zoom]', '.ui-pdp-gallery__figure img', '.ui-pdp-image',
      '.slick-current img', '.ui-pdp-gallery img', 'figure.ui-pdp-gallery__figure img',
      'picture.ui-pdp-gallery__figure img'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var img = document.querySelector(selectors[i]);
      if (img) {
        var url = img.getAttribute('data-zoom') || img.src;
        if (url && url.indexOf('data:') === -1 && url.indexOf('gif') === -1) {
          return url.replace(/-[A-Z]\.jpg/, '-O.jpg').replace(/-[A-Z]\.webp/, '-O.webp');
        }
      }
    }

    var allImages = document.querySelectorAll('img');
    for (var j = 0; j < allImages.length; j++) {
      if (allImages[j].naturalWidth >= 300 && allImages[j].src && allImages[j].src.indexOf('data:') === -1) {
        return allImages[j].src;
      }
    }

    return null;
  }

  function extractImages(gallery) {
    var images = [];
    if (gallery && gallery.pictures) {
      var pics = gallery.pictures;
      for (var i = 0; i < pics.length; i++) {
        var url = pics[i].url || pics[i].secure_url;
        if (url) images.push(url.replace(/-[A-Z]\.jpg/, '-O.jpg'));
      }
    }
    if (images.length === 0) {
      var domImg = getImageFromDOM();
      if (domImg) images.push(domImg);
    }
    return images;
  }

  function extractPriceData(priceComponent) {
    var currentPrice = null;
    var originalPrice = null;
    var discountPercentage = null;

    if (priceComponent && priceComponent.price) {
      var p = priceComponent.price;
      currentPrice = p.value || p.amount || null;
    }

    if (priceComponent && priceComponent.original_price) {
      originalPrice = priceComponent.original_price.value || priceComponent.original_price.amount || null;
    }

    if (!currentPrice) {
      currentPrice = getPriceFromDOM();
    }

    if (originalPrice && currentPrice && originalPrice > currentPrice) {
      discountPercentage = Math.round((1 - currentPrice / originalPrice) * 100);
    }

    if (priceComponent && priceComponent.discount && priceComponent.discount.percentage) {
      discountPercentage = priceComponent.discount.percentage;
    }

    return { currentPrice: currentPrice, originalPrice: originalPrice, discountPercentage: discountPercentage };
  }

  function extractSalesData(components) {
    var soldQuantity = 0;

    if (components && components.header && components.header.subtitle) {
      var match = components.header.subtitle.match(/(\d+[\.,]?\d*)\s*(mil|k)?\s*vendidos?/i);
      if (match) {
        var num = parseFloat(match[1].replace(',', '.'));
        if (match[2] && (match[2].toLowerCase() === 'mil' || match[2].toLowerCase() === 'k')) {
          num *= 1000;
        }
        soldQuantity = Math.floor(num);
      }
    }

    if (!soldQuantity && components && components.track && components.track.melidata_event && components.track.melidata_event.item) {
      soldQuantity = components.track.melidata_event.item.sold_quantity || 0;
    }

    if (!soldQuantity) {
      soldQuantity = getSalesFromDOM();
    }

    return soldQuantity;
  }

  function extractRatingData(reviews, components) {
    var rating = null;
    var count = 0;

    if (reviews && reviews.rating && reviews.rating.average) {
      rating = reviews.rating.average;
      count = reviews.rating.total || reviews.total || 0;
    }

    if (!rating && components && components.header && components.header.reviews && components.header.reviews.rating && components.header.reviews.rating.average) {
      rating = components.header.reviews.rating.average;
      count = components.header.reviews.rating.total || 0;
    }

    if (!rating) {
      var domData = getRatingFromDOM();
      rating = domData.rating;
      count = domData.count;
    }

    return { rating: rating, count: count };
  }

  function extractProductFromState(state) {
    if (!state) return null;

    var initialState = state.initialState || state;
    var components = initialState.components || {};

    var header = components.header || {};
    var price = components.price || {};
    var gallery = components.gallery || {};
    var seller = components.seller || {};
    var shipping = components.shipping || {};
    var reviews = components.reviews || (components.header ? components.header.reviews : null) || {};

    var priceData = extractPriceData(price);
    var images = extractImages(gallery);
    var soldQuantity = extractSalesData(components);
    var ratingData = extractRatingData(reviews, components);

    var sellerName = (seller.seller && seller.seller.nickname) || getSellerFromDOM();
    var sellerId = seller.seller_id || (seller.seller && seller.seller.id) || null;
    var sellerReputation = (seller.seller && seller.seller.seller_reputation && seller.seller.seller_reputation.level_id) || null;
    var isOfficialStore = (seller.seller && seller.seller.is_official_store) || false;

    var freeShipping = (shipping && shipping.free_shipping === true) || hasFreeShippingFromDOM();

    var currentPriceCents = priceData.currentPrice ? Math.round(priceData.currentPrice * 100) : null;
    var originalPriceCents = priceData.originalPrice ? Math.round(priceData.originalPrice * 100) : null;
    var ratingStar = ratingData.rating ? Math.round(ratingData.rating * 100) : null;

    return {
      mlItemId: extractItemIdFromUrl(),
      productName: header.title || getTextFromDOM('h1'),
      price: currentPriceCents,
      originalPrice: originalPriceCents,
      discountPercent: priceData.discountPercentage,
      condition: extractConditionFromDOM(),
      sellerName: sellerName,
      sellerId: sellerId ? String(sellerId) : null,
      sellerReputation: sellerReputation,
      ratingStar: ratingStar,
      reviewsCount: ratingData.count || 0,
      freeShipping: freeShipping,
      imageUrl: images[0] || null,
      productLink: getCanonicalUrl(),
      categoryId: null,
      categoryName: null,
      categoryBreadcrumb: null,
      salesQuantity: soldQuantity || 0,
      offerType: null,
      offerEndTime: null,
      isOfficialStore: isOfficialStore
    };
  }

  function extractFlatItem(item, idx) {
    var baseUrl = 'https://www.mercadolivre.com.br';

    var title = item.title || '';
    if (!title) return null;

    var currentPrice = item.price || null;
    if (typeof currentPrice === 'object' && currentPrice !== null) {
      currentPrice = currentPrice.amount || currentPrice.value || null;
    }

    var originalPrice = item.original_price || null;
    if (typeof originalPrice === 'object' && originalPrice !== null) {
      originalPrice = originalPrice.amount || originalPrice.value || null;
    }

    var discountPercent = null;
    if (originalPrice && currentPrice && originalPrice > currentPrice) {
      discountPercent = Math.round((1 - currentPrice / originalPrice) * 100);
    }

    var mainImage = item.thumbnail || item.picture || null;
    if (mainImage) {
      mainImage = mainImage.replace(/-[A-Z]\.jpg/, '-O.jpg').replace(/-[A-Z]\.webp/, '-O.webp');
      if (mainImage.indexOf('http') === -1) {
        mainImage = 'https://http2.mlstatic.com/' + mainImage;
      }
    }
    if (!mainImage && item.pictures && item.pictures.length > 0) {
      mainImage = item.pictures[0].url || item.pictures[0].secure_url || null;
    }

    var url = item.permalink || item.url || null;
    if (url) url = normalizeUrl(url, baseUrl);

    var freeShipping = false;
    if (item.shipping) {
      freeShipping = item.shipping.free_shipping === true;
      if (!freeShipping && item.shipping.tags) {
        freeShipping = item.shipping.tags.indexOf('free_shipping') !== -1 || item.shipping.tags.indexOf('self_service_in') !== -1;
      }
    }

    var rating = null;
    var totalReviews = 0;
    if (item.reviews) {
      rating = item.reviews.rating_average || null;
      totalReviews = item.reviews.total || 0;
    }

    var mlItemId = item.id || null;
    if (!mlItemId && url) {
      var idMatch = url.match(/MLB-?(\d+)/i);
      if (idMatch) mlItemId = 'MLB' + idMatch[1];
    }

    var sellerName = null;
    if (item.seller) {
      sellerName = item.seller.nickname || item.seller.name || null;
    }
    if (!sellerName && item.official_store_name) {
      sellerName = item.official_store_name;
    }

    var priceCents = currentPrice ? Math.round(currentPrice * 100) : null;
    var originalPriceCents = originalPrice ? Math.round(originalPrice * 100) : null;

    return {
      mlItemId: mlItemId,
      productName: title,
      price: priceCents,
      originalPrice: originalPriceCents,
      discountPercent: discountPercent,
      freeShipping: freeShipping,
      imageUrl: mainImage,
      productLink: url,
      sellerName: sellerName,
      sellerId: item.seller && item.seller.id ? String(item.seller.id) : null,
      sellerReputation: null,
      condition: item.condition || 'new',
      ratingStar: rating ? Math.round(rating * 100) : null,
      reviewsCount: totalReviews || null,
      salesQuantity: item.sold_quantity || null,
      categoryId: item.category_id || null,
      categoryName: null,
      categoryBreadcrumb: null,
      offerType: null,
      offerEndTime: null,
      position: item.position || idx + 1
    };
  }

  function extractPolycardItem(item, idx) {
    var baseUrl = 'https://www.mercadolivre.com.br';

    var card = item.card || item.polycard || item || {};
    var metadata = card.metadata || item.metadata || {};
    var components = card.components || item.components || [];

    if (!Array.isArray(components)) {
      var compArray = [];
      Object.keys(components).forEach(function(key) {
        if (components[key] && typeof components[key] === 'object') {
          components[key].type = components[key].type || key;
          compArray.push(components[key]);
        }
      });
      components = compArray;
    }

    var titleComp = null, priceComp = null, reviewsComp = null, shippingComp = null;
    for (var c = 0; c < components.length; c++) {
      var comp = components[c];
      if (!comp) continue;
      if (comp.type === 'title' || comp.type === 'header') titleComp = comp;
      if (comp.type === 'price') priceComp = comp;
      if (comp.type === 'reviews') reviewsComp = comp;
      if (comp.type === 'shipping') shippingComp = comp;
    }

    var title = '';
    if (titleComp) {
      if (titleComp.title) {
        title = typeof titleComp.title === 'string' ? titleComp.title : (titleComp.title.text || titleComp.title.label || '');
      }
      if (!title && titleComp.text) title = titleComp.text;
    }
    if (!title && metadata.title) title = metadata.title;
    if (!title) return null;

    // Leitura tolerante do componente de preço (ml-price-utils, testado em
    // tests/mlScraperPrice.test.ts): o estado do ML alterna entre número puro,
    // objeto {value}/{amount} e string — o leitor antigo assumia objeto e
    // devolvia null para previous_price numérico, sumindo com o preço cheio de
    // todos os cards. O badge também pode vir como discount_label ("67% OFF").
    var statePrices = null;
    if (typeof MlPriceUtils !== 'undefined' && MlPriceUtils.readPolycardPrice) {
      statePrices = MlPriceUtils.readPolycardPrice(priceComp);
    } else if (priceComp) {
      // Fallback (carga fora de ordem): comportamento antigo, objeto-ou-nada.
      var currentPrice = 0, originalPrice = null, discount = null;
      var priceObj = priceComp.price || priceComp;
      if (typeof priceObj.current_price === 'number') currentPrice = priceObj.current_price;
      else if (priceObj.current_price) currentPrice = priceObj.current_price.value || priceObj.current_price.amount || 0;
      else currentPrice = priceObj.value || priceObj.amount || 0;
      if (typeof priceObj.previous_price === 'number') originalPrice = priceObj.previous_price;
      else if (priceObj.previous_price) originalPrice = priceObj.previous_price.value || priceObj.previous_price.amount || null;
      else if (priceObj.original_price) originalPrice = typeof priceObj.original_price === 'number' ? priceObj.original_price : (priceObj.original_price.value || priceObj.original_price.amount || null);
      if (priceObj.discount) discount = typeof priceObj.discount === 'number' ? priceObj.discount : (priceObj.discount.value || priceObj.discount.percentage || null);
      if (!discount && originalPrice && currentPrice && originalPrice > currentPrice) {
        discount = Math.round((1 - currentPrice / originalPrice) * 100);
      }
      statePrices = {
        priceCents: currentPrice ? Math.round(currentPrice * 100) : null,
        originalPriceCents: originalPrice ? Math.round(originalPrice * 100) : null,
        discountPercent: discount,
      };
    } else {
      statePrices = { priceCents: null, originalPriceCents: null, discountPercent: null };
    }

    var mainImage = null;
    if (card.pictures && card.pictures.pictures && card.pictures.pictures[0]) {
      var pictureId = card.pictures.pictures[0].id || '';
      if (pictureId) mainImage = 'https://http2.mlstatic.com/D_NQ_NP_2X_' + pictureId + '-O.webp';
    }
    if (!mainImage && item.pictures && item.pictures.pictures && item.pictures.pictures[0]) {
      var pid = item.pictures.pictures[0].id || '';
      if (pid) mainImage = 'https://http2.mlstatic.com/D_NQ_NP_2X_' + pid + '-O.webp';
    }
    if (!mainImage && metadata.image) mainImage = metadata.image;
    if (!mainImage && item.thumbnail) mainImage = item.thumbnail;

    var url = normalizeUrl(metadata.url || item.permalink || null, baseUrl);

    // Se a URL é do tipo /up/ (user product), construir URL direta com MLB id
    if (url && url.indexOf('/up/') !== -1 && metadata.id) {
      url = baseUrl + '/' + metadata.id;
    }

    var rating = null;
    var totalReviews = 0;
    if (reviewsComp) {
      var rev = reviewsComp.reviews || reviewsComp;
      rating = rev.rating_average || rev.average || null;
      totalReviews = rev.total || rev.amount || 0;
      // Fallback: extract from label text like "4.8" or "4.8 (123)"
      if (!rating && rev.label) {
        var labelMatch = String(rev.label).match(/([\d]+[.,]\d)/);
        if (labelMatch) rating = parseFloat(labelMatch[1].replace(',', '.'));
      }
      if (!rating && reviewsComp.label) {
        var labelMatch2 = String(reviewsComp.label).match(/([\d]+[.,]\d)/);
        if (labelMatch2) rating = parseFloat(labelMatch2[1].replace(',', '.'));
      }
    }

    var freeShipping = false;
    if (shippingComp) {
      var sh = shippingComp.shipping || shippingComp;
      if (sh.text && typeof sh.text === 'string' && sh.text.toLowerCase().indexOf('grátis') !== -1) freeShipping = true;
      if (sh.free_shipping) freeShipping = true;
      if (sh.label && typeof sh.label === 'string' && sh.label.toLowerCase().indexOf('grátis') !== -1) freeShipping = true;
    }

    var mlItemId = metadata.id || item.id || null;
    if (!mlItemId && url) {
      var idMatch = url.match(/MLB-?(\d+)/i);
      if (idMatch) mlItemId = 'MLB' + idMatch[1];
    }

    return {
      mlItemId: mlItemId,
      productName: title,
      price: statePrices.priceCents,
      originalPrice: statePrices.originalPriceCents,
      discountPercent: statePrices.discountPercent,
      freeShipping: freeShipping,
      imageUrl: mainImage,
      productLink: url,
      sellerName: metadata.seller_name || null,
      sellerId: null,
      sellerReputation: null,
      condition: 'new',
      ratingStar: rating ? Math.round(rating * 100) : null,
      reviewsCount: totalReviews || null,
      salesQuantity: null,
      categoryId: null,
      categoryName: null,
      categoryBreadcrumb: null,
      offerType: null,
      offerEndTime: null,
      position: item.position || idx + 1
    };
  }

  function detectItemFormat(item) {
    if (item.title && (item.price !== undefined || item.permalink || item.thumbnail || item.id)) {
      return 'flat';
    }
    if (item.card || item.polycard || (item.metadata && item.components)) {
      return 'polycard';
    }
    if (item.components && (Array.isArray(item.components) || typeof item.components === 'object')) {
      return 'polycard';
    }
    return 'unknown';
  }

  function extractOffersPageProducts(items) {
    if (!items || items.length === 0) return [];

    var firstItem = items[0];
    var format = detectItemFormat(firstItem);
    console.log('[AchadinhoPRO:ML] Formato dos itens detectado:', format);
    console.log('[AchadinhoPRO:ML] Keys do primeiro item:', Object.keys(firstItem));

    if (firstItem.card || firstItem.polycard) {
      var innerObj = firstItem.card || firstItem.polycard;
      console.log('[AchadinhoPRO:ML] Keys do card/polycard:', Object.keys(innerObj));
    }

    var products = [];
    for (var idx = 0; idx < items.length; idx++) {
      try {
        var item = items[idx];
        var itemFormat = detectItemFormat(item);
        var product = null;

        if (itemFormat === 'flat') {
          product = extractFlatItem(item, idx);
        } else if (itemFormat === 'polycard') {
          product = extractPolycardItem(item, idx);
        } else {
          product = extractFlatItem(item, idx);
          if (!product || !product.productName) {
            product = extractPolycardItem(item, idx);
          }
        }

        if (product && product.productName) {
          products.push(product);
        }
      } catch (e) {
        console.error('[AchadinhoPRO:ML] Erro ao extrair item de oferta:', e);
      }
    }

    console.log('[AchadinhoPRO:ML] Produtos extraídos com sucesso:', products.length, 'de', items.length);
    if (products.length > 0) {
      console.log('[AchadinhoPRO:ML] Exemplo do primeiro produto:', JSON.stringify({
        title: products[0].productName,
        price: products[0].price,
        image: products[0].imageUrl ? 'sim' : 'nao',
        link: products[0].productLink ? 'sim' : 'nao',
        id: products[0].mlItemId
      }));
    }

    return products;
  }

  function extractSearchResults(results) {
    if (!Array.isArray(results)) return [];

    var products = [];
    for (var i = 0; i < results.length; i++) {
      var item = results[i];
      try {
        var format = detectItemFormat(item);
        var product = null;

        if (item.polycard && item.polycard.metadata) {
          product = extractPolycardItem({ card: { metadata: item.polycard.metadata, components: item.polycard.components || [], pictures: item.polycard.pictures || { pictures: [] } } }, i);
        } else if (format === 'flat') {
          product = extractFlatItem(item, i);
        } else if (format === 'polycard') {
          product = extractPolycardItem(item, i);
        } else {
          product = extractFlatItem(item, i);
          if (!product || !product.productName) {
            product = extractPolycardItem(item, i);
          }
        }

        if (product && product.productName) {
          product.position = i + 1;
          products.push(product);
        }
      } catch (e) {
        console.error('[AchadinhoPRO:ML] Erro ao extrair item de busca:', e);
      }
    }
    return products.filter(function(p) { return p.productName; });
  }

  function extractListingFromDOM() {
    console.log('[AchadinhoPRO:ML] Usando extração DOM como fallback');

    var cards = document.querySelectorAll('.poly-card, .ui-search-result, .andes-card[class*="poly-card"]');
    console.log('[AchadinhoPRO:ML] Cards encontrados no DOM:', cards.length);

    var products = [];

    for (var idx = 0; idx < cards.length; idx++) {
      var card = cards[idx];
      try {
        var titleEl = card.querySelector('.poly-component__title, .ui-search-item__title, a[title]');
        var title = titleEl ? (titleEl.textContent || titleEl.getAttribute('title') || '').trim() : '';
        if (!title) continue;

        var linkEl = card.querySelector('a[href*="mercadolivre"], a[href*="/p/"], a[href*="/MLB"]');
        var url = linkEl ? linkEl.href : null;

        // Filtrar URLs de tracking (/mclics/) e tentar achar link direto
        if (url && url.indexOf('/mclics/') !== -1) {
          var directLink = card.querySelector('a[href*="/p/"], a[href*="/MLB-"], a[href*="/MLB"]');
          url = directLink ? directLink.href : null;
        }
        if (url && url.indexOf('/mclics/') !== -1) url = null;

        var imgEl = card.querySelector('img.poly-component__picture, img[src*="mlstatic"]');
        var mainImage = imgEl ? (imgEl.src || imgEl.getAttribute('data-src') || null) : null;

        // Trio de preço do card (atual COM centavos, cheio, badge polylabel novo +
        // seletores antigos) — regra, motivação e testes em ml-price-utils.js /
        // tests/mlScraperPrice.test.ts. Fallback inline cobre carga fora de ordem,
        // no comportamento pré-2026 (fração sem centavos, badge só nas classes velhas).
        var priceCents, originalPriceCents, discountPercent;
        if (typeof MlPriceUtils !== 'undefined' && MlPriceUtils.extractCardPriceData) {
          var cardPrices = MlPriceUtils.extractCardPriceData(card);
          priceCents = cardPrices.priceCents;
          originalPriceCents = cardPrices.originalPriceCents;
          discountPercent = cardPrices.discountPercent;
        } else {
          var priceEl = card.querySelector('.poly-price__current .andes-money-amount__fraction, .price-tag-fraction');
          var priceText = priceEl ? (priceEl.textContent || '').replace(/\D/g, '') : '0';
          priceCents = priceText && parseInt(priceText, 10) > 0 ? parseInt(priceText, 10) * 100 : null;

          var origPriceEl = card.querySelector('.andes-money-amount--previous .andes-money-amount__fraction');
          var origPriceText = origPriceEl ? (origPriceEl.textContent || '').replace(/\D/g, '') : '';
          originalPriceCents = origPriceText ? parseInt(origPriceText, 10) * 100 : null;

          var discountEl = card.querySelector('.andes-money-amount__discount, .poly-price__disc_label');
          var discountMatch = discountEl ? (discountEl.textContent || '').match(/(\d+)%/) : null;
          var badgePercent = discountMatch ? parseInt(discountMatch[1], 10) : null;
          discountPercent = badgePercent
            || ((originalPriceCents && priceCents && originalPriceCents > priceCents && originalPriceCents <= priceCents * 100)
                ? (Math.round((1 - priceCents / originalPriceCents) * 100) || null)
                : null);
        }

        var shippingEl = card.querySelector('.poly-component__shipping, .ui-search-item__shipping');
        var freeShipping = shippingEl ? (shippingEl.textContent || '').toLowerCase().indexOf('grátis') !== -1 : false;

        var ratingEl = card.querySelector('.poly-reviews__rating, .poly-component__reviews .poly-phrase-label');
        var rating = null;
        if (ratingEl) {
          var ratingMatch = (ratingEl.textContent || '').match(/([\d]+[.,]?\d*)/);
          if (ratingMatch) rating = parseFloat(ratingMatch[1].replace(',', '.'));
        }

        // Captura quantidade de reviews
        var reviewsEl = card.querySelector('.poly-reviews__total, .reviews');
        var reviewsCount = null;
        if (reviewsEl) {
          var reviewsText = reviewsEl.textContent || reviewsEl.getAttribute('aria-hidden') || '';
          var reviewsMatch = reviewsText.match(/\d+/);
          if (reviewsMatch) {
            reviewsCount = parseInt(reviewsMatch[0]);
          }
        }

        // Captura nome completo da loja/seller
        var sellerEl = card.querySelector('.poly-component__seller, .ui-search-result__seller');
        var sellerName = sellerEl ? (sellerEl.textContent || '').replace(/svg.*$/i, '').trim() : null;

        var itemIdMatch = url ? url.match(/MLB-?(\d+)/i) : null;
        var mlItemId = itemIdMatch ? 'MLB' + itemIdMatch[1] : null;

        products.push({
          mlItemId: mlItemId,
          productName: title,
          price: priceCents,
          originalPrice: originalPriceCents,
          discountPercent: discountPercent,
          freeShipping: freeShipping,
          imageUrl: mainImage,
          productLink: url,
          sellerName: sellerName || null,
          sellerId: null,
          sellerReputation: null,
          condition: 'new',
          ratingStar: rating ? Math.round(rating * 100) : null,
          reviewsCount: reviewsCount,
          salesQuantity: null,
          categoryId: null,
          categoryName: null,
          categoryBreadcrumb: null,
          offerType: null,
          offerEndTime: null,
          position: idx + 1
        });
      } catch (e) {
        console.error('[AchadinhoPRO:ML] Erro ao extrair card do DOM:', e);
      }
    }

    return products;
  }

  /**
   * Preenche preço cheio/desconto (e preço, se faltar) a partir dos cards
   * VISÍVEIS da página, casando por MLB id. O estado JSON do ML muda de formato
   * com frequência (jul/2026: previous_price virou número puro e o badge migrou
   * para discount_label) — o DOM renderizado é a fonte de verdade do que o
   * usuário está vendo, então tudo que a listagem exibe deve chegar ao save.
   * Só preenche campos ausentes; nunca sobrescreve o que o estado já deu.
   */
  function enrichListingFromDOM(products) {
    try {
      if (typeof MlPriceUtils === 'undefined' || !MlPriceUtils.extractCardPriceData) return products;
      var cards = document.querySelectorAll('.poly-card, .ui-search-result, .andes-card[class*="poly-card"]');
      if (!cards.length) return products;

      // Indexa por TODOS os ids do link (id de família do /p/ + id do item em wid=)
      // — casar só pelo primeiro id falhava nos cards orgânicos de catálogo (ver
      // extractIdsFromHref). Título único fica como fallback de casamento.
      var byId = {};
      var byTitle = {};
      for (var i = 0; i < cards.length; i++) {
        var link = cards[i].querySelector('a.poly-component__title, a[href*="MLB"], a[href*="/p/"]');
        var ids = MlPriceUtils.extractIdsFromHref(link ? link.href : '');
        if (!ids.length) continue;
        var data = MlPriceUtils.extractCardPriceData(cards[i]);
        for (var k = 0; k < ids.length; k++) {
          if (!byId[ids[k]]) byId[ids[k]] = data;
        }
        var titleEl = cards[i].querySelector('.poly-component__title');
        var t = MlPriceUtils.normalizeTitle(titleEl ? titleEl.textContent : '');
        if (t) {
          // Título duplicado na página (acontece: mesmo produto em posições
          // diferentes) é ambíguo — marca null e não usa como fallback.
          byTitle[t] = Object.prototype.hasOwnProperty.call(byTitle, t) ? null : data;
        }
      }

      var enriched = 0;
      for (var j = 0; j < products.length; j++) {
        var p = products[j];
        if (!p) continue;
        var d = p.mlItemId ? byId[String(p.mlItemId).toUpperCase().replace('-', '')] : null;
        if (!d && p.productName) d = byTitle[MlPriceUtils.normalizeTitle(p.productName)] || null;
        if (!d) continue;
        if (p.originalPrice == null && d.originalPriceCents != null) { p.originalPrice = d.originalPriceCents; enriched++; }
        if (p.discountPercent == null && d.discountPercent != null) p.discountPercent = d.discountPercent;
        if (p.price == null && d.priceCents != null) p.price = d.priceCents;
      }
      if (enriched > 0) {
        console.log('[AchadinhoPRO:ML] Preço cheio/desconto preenchidos do DOM em', enriched, 'produto(s) que o estado não trouxe');
      }
    } catch (e) {
      console.warn('[AchadinhoPRO:ML] enrichListingFromDOM falhou (seguindo só com o estado):', e);
    }
    return products;
  }

  /** Estamos no hub de afiliados? (grade com infinite scroll — ver ml-hub-scraper.js) */
  function isAffiliateHub() {
    return typeof MlHubScraper !== 'undefined' && MlHubScraper.isHubUrl(window.location.href);
  }

  /**
   * Passo final de toda listagem: completa preço cheio/desconto pelo DOM e cola os
   * SELOS do card (MAIS VENDIDO, GANHOS EXTRAS 16%…) nos produtos que vieram do
   * estado. As tags só existem no DOM renderizado — o estado não as publica.
   */
  function finishListing(products) {
    var out = enrichListingFromDOM(products);
    if (typeof MlHubScraper !== 'undefined' && MlHubScraper.enrichWithTags) {
      try {
        out = MlHubScraper.enrichWithTags(out, document);
      } catch (e) {
        console.warn('[AchadinhoPRO:ML] enrichWithTags falhou (seguindo sem selos):', e);
      }
    }
    return out;
  }

  function extractListingProducts(state) {
    // Hub de afiliados: o DOM é a FONTE DE VERDADE. O estado SSR (_n.ctx.r) é o
    // primeiro lote e não cresce com a rolagem — o ML busca as páginas seguintes
    // por XHR e só pinta os cards. Preferir o estado aqui, como nas demais
    // listagens, era exatamente o que sumia com tudo que entrava por scroll.
    if (isAffiliateHub()) {
      var domHub = MlHubScraper.extractProducts(document, typeof MlPriceUtils !== 'undefined' ? MlPriceUtils : null);
      var stateItems = state && state.data ? (state.data.items || []) : [];
      var stateHub = stateItems.length > 0 ? extractOffersPageProducts(stateItems) : [];
      // O estado COMPLETA (categoria, vendedor) e nunca ACRESCENTA: os dois lados não
      // concordam sobre o id — o DOM usa readCardItemId (input[name="id"] > wid=) e o
      // estado ainda cai, no fallback, no regex solto que pega o id de família ou o da
      // promoção. Deixá-lo criar linha duplicaria o produto e salvaria a cópia sob uma
      // chave que colide entre todos os itens da mesma promoção.
      var mergedHub = MlHubScraper.fillFromListing(domHub, stateHub);
      console.log('[AchadinhoPRO:ML] Hub de afiliados — DOM:', domHub.length, '(estado:', stateHub.length, 'usado só para completar campos)');
      return finishListing(mergedHub);
    }

    if (!state) {
      var domProducts = extractListingFromDOM();
      if (domProducts.length > 0) {
        console.log('[AchadinhoPRO:ML] Usando extração DOM (sem estado):', domProducts.length);
        return finishListing(domProducts);
      }
      return [];
    }

    var offersItems = state.data ? (state.data.items || []) : [];
    if (offersItems.length > 0) {
      console.log('[AchadinhoPRO:ML] Usando estrutura de ofertas (data.items):', offersItems.length);
      var products = extractOffersPageProducts(offersItems);
      if (products.length === 0) {
        console.log('[AchadinhoPRO:ML] extractOffersPageProducts retornou 0 produtos, tentando DOM fallback');
        products = extractListingFromDOM();
      }
      return finishListing(products);
    }

    var searchResults = state.results || (state.initialState ? state.initialState.results : null) || (state.initialState ? state.initialState.items : null) || [];
    if (searchResults.length > 0) {
      console.log('[AchadinhoPRO:ML] Usando estrutura de busca (results):', searchResults.length);
      var searchProducts = extractSearchResults(searchResults);
      if (searchProducts.length === 0) {
        console.log('[AchadinhoPRO:ML] extractSearchResults retornou 0 produtos, tentando DOM fallback');
        searchProducts = extractListingFromDOM();
      }
      return finishListing(searchProducts);
    }

    var domFallback = extractListingFromDOM();
    if (domFallback.length > 0) {
      console.log('[AchadinhoPRO:ML] Usando extração DOM (fallback):', domFallback.length);
      return finishListing(domFallback);
    }

    return [];
  }

  function getJsonLdProduct() {
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      try {
        var data = JSON.parse(scripts[i].textContent);
        var items = Array.isArray(data) ? data : [data];
        for (var j = 0; j < items.length; j++) {
          var item = items[j];
          if (item['@type'] === 'Product' || item.offers) {
            var offer = item.offers || {};
            var price = offer.price || offer.lowPrice;
            return {
              mlItemId: extractItemIdFromUrl(),
              productName: item.name || null,
              price: price ? Math.round(parseFloat(price) * 100) : null,
              originalPrice: null,
              discountPercent: null,
              condition: item.itemCondition && item.itemCondition.indexOf('New') !== -1 ? 'new' : 'used',
              sellerName: offer.seller ? offer.seller.name : null,
              sellerId: null,
              sellerReputation: null,
              ratingStar: item.aggregateRating && item.aggregateRating.ratingValue
                ? Math.round(parseFloat(item.aggregateRating.ratingValue) * 100)
                : null,
              reviewsCount: item.aggregateRating && item.aggregateRating.reviewCount
                ? parseInt(item.aggregateRating.reviewCount) : 0,
              freeShipping: false,
              imageUrl: item.image || null,
              productLink: getCanonicalUrl(),
              categoryId: null,
              categoryName: null,
              categoryBreadcrumb: null,
              salesQuantity: null,
              offerType: null,
              offerEndTime: null
            };
          }
        }
      } catch (e) {
        continue;
      }
    }
    return null;
  }

  function extractCategoryInfo() {
    var result = { categoryId: null, categoryName: null, categoryBreadcrumb: null };

    // 1. From URL pattern: /categoria/MLB1055
    var url = window.location.href;
    var catMatch = url.match(/\/categoria\/([A-Z]{3}\d+)/i);
    if (catMatch) result.categoryId = catMatch[1];

    // 2. From breadcrumbs in DOM — extract FULL path, not just last item
    var breadcrumbs = document.querySelectorAll('.andes-breadcrumb__item, .ui-search-breadcrumb__item, nav[class*="breadcrumb"] li');
    if (breadcrumbs.length > 0) {
      var path = [];
      for (var b = 0; b < breadcrumbs.length; b++) {
        var crumbText = (breadcrumbs[b].textContent || '').trim();
        if (crumbText && crumbText.length > 1 && crumbText.length < 80) {
          path.push(crumbText);
        }
      }

      if (path.length > 0) {
        result.categoryBreadcrumb = path;
        result.categoryName = path[path.length - 1];
        console.log('[AchadinhoPRO:ML] Breadcrumb:', path.join(' > '));
      }

      // Extract categoryId from last breadcrumb link
      var last = breadcrumbs[breadcrumbs.length - 1];
      var link = last.querySelector('a');
      if (link && link.href) {
        var idMatch = link.href.match(/([A-Z]{3}\d+)/);
        if (idMatch && !result.categoryId) result.categoryId = idMatch[1];
      }
    }

    // 3. From page title on category/search pages
    if (!result.categoryName) {
      var titleEl = document.querySelector('.ui-search-breadcrumb__title, h1.ui-search-breadcrumb__title');
      if (titleEl) result.categoryName = (titleEl.textContent || '').trim();
    }

    // 4. From preloaded state — categoryId and category path if available
    if (preloadedState) {
      var is = preloadedState.initialState || preloadedState;
      if (is.categoryId && !result.categoryId) result.categoryId = is.categoryId;
      if (is.category_id && !result.categoryId) result.categoryId = is.category_id;

      // Try to find category name/path from state breadcrumbs or filters
      if (!result.categoryName && is.breadcrumb) {
        var bc = is.breadcrumb;
        if (Array.isArray(bc) && bc.length > 0) {
          var bcPath = bc.map(function(item) { return item.name || item.text || ''; }).filter(function(t) { return t.length > 0; });
          if (bcPath.length > 0) {
            result.categoryBreadcrumb = result.categoryBreadcrumb || bcPath;
            result.categoryName = result.categoryName || bcPath[bcPath.length - 1];
          }
        }
      }

      if (!result.categoryName && is.appliedFilters) {
        var filters = is.appliedFilters;
        if (Array.isArray(filters)) {
          for (var f = 0; f < filters.length; f++) {
            if (filters[f].id === 'category' && filters[f].name) {
              result.categoryName = filters[f].name;
              break;
            }
          }
        }
      }
    }

    // 5. From search scope display
    if (!result.categoryName) {
      var searchScope = document.querySelector('.ui-search-breadcrumb .ui-search-breadcrumb__title, .andes-breadcrumb__container');
      if (searchScope) {
        var scopeText = (searchScope.textContent || '').trim();
        if (scopeText.length > 1 && scopeText.length < 100) {
          result.categoryName = scopeText;
        }
      }
    }

    return result;
  }

  /**
   * detectOfferType() é POR PÁGINA: varre título, cabeçalhos, abas e qualquer elemento
   * com classe contendo "offer"/"promo"/"deal" do documento INTEIRO, e carimba o mesmo
   * valor em todos os produtos extraídos.
   *
   * No hub de afiliados isso é veneno. A grade mistura produtos de campanhas diferentes
   * e uma única faixa "Oferta do dia" no cabeçalho — ou o título de um carrossel —
   * marcaria os até 1000 produtos acumulados como `oferta_do_dia`. Esse valor não é
   * decorativo: deleteExpiredFlashOfferMlProducts (server/product-maintenance.ts) APAGA
   * essas linhas 48 h depois. O usuário coletaria a página inteira e a perderia sozinho
   * dois dias depois, sem nenhum erro na tela.
   *
   * No hub o que classifica o produto é a TAG do card (lida do próprio card, em
   * ml-hub-scraper.js), não o cartaz da página.
   */
  function pageOfferInfo() {
    if (isAffiliateHub()) return { offerType: null, offerEndTime: null };
    return detectOfferType();
  }

  function detectOfferType() {
    var result = { offerType: null, offerEndTime: null };
    var url = window.location.href.toLowerCase();

    // Helper: check text for offer type keywords
    // IMPORTANT: Check "oferta do dia" BEFORE "relâmpago" because on ML's offers page
    // both tab labels exist in the DOM, and "relâmpago" would always win otherwise
    function classifyText(text) {
      var t = (text || '').toLowerCase();
      if (t.indexOf('oferta do dia') !== -1 || t.indexOf('ofertas do dia') !== -1 || t.indexOf('deal of the day') !== -1 || t.indexOf('deal_of_the_day') !== -1) {
        return 'oferta_do_dia';
      }
      if (t.indexOf('relâmpago') !== -1 || t.indexOf('relampago') !== -1 || t.indexOf('lightning') !== -1) {
        return 'oferta_relampago';
      }
      return null;
    }

    // 1. URL-based detection (specific patterns FIRST, generic last)
    if (url.indexOf('oferta-do-dia') !== -1 || url.indexOf('oferta_do_dia') !== -1 || url.indexOf('ofertas-do-dia') !== -1 || url.indexOf('deal-of-the-day') !== -1 || url.indexOf('deal_of_the_day') !== -1) {
      result.offerType = 'oferta_do_dia';
    } else if (url.indexOf('relampago') !== -1 || url.indexOf('lightning') !== -1 || url.indexOf('flash') !== -1) {
      result.offerType = 'oferta_relampago';
    } else if (url.indexOf('/ofertas') !== -1) {
      // Generic offers page - will be overridden if we find specific type below
      result.offerType = 'promocao';
    }

    // 2. Page title/heading detection (most reliable for ML)
    // Check active tab FIRST (most reliable indicator of current page type)
    if (!result.offerType || result.offerType === 'promocao') {
      var activeTabs = document.querySelectorAll('.andes-tabs__link--active, .nav-menu-item--active a, [class*="tab"][class*="active"], [class*="tabs"] [aria-selected="true"]');
      for (var at = 0; at < activeTabs.length; at++) {
        var tabClassified = classifyText(activeTabs[at].textContent);
        if (tabClassified) {
          result.offerType = tabClassified;
          break;
        }
      }
    }
    // Then check generic headings if active tab didn't match
    if (!result.offerType || result.offerType === 'promocao') {
      var headings = document.querySelectorAll('h1, h2, .nav-header-title, .deals-header__title, .promotions-title, [class*="header"] [class*="title"]');
      for (var h = 0; h < headings.length; h++) {
        var classified = classifyText(headings[h].textContent);
        if (classified) {
          result.offerType = classified;
          break;
        }
      }
    }

    // 3. DOM badges and labels (broader search)
    if (!result.offerType || result.offerType === 'promocao') {
      var badgeSelectors = [
        '.deal-badge', '.ui-pdp-promotions-pill-label',
        '[class*="deal"]', '[class*="lightning"]',
        '.poly-component__highlight', '.ui-pdp-promotions__pill',
        '.andes-tag__label', '.promotion-item__pill',
        '.andes-tabs__link--active', '.nav-menu-item--active',
        '[class*="offer"]', '[class*="promo"]',
        '.pill-label', '.highlight-label'
      ];
      for (var s = 0; s < badgeSelectors.length; s++) {
        var elements = document.querySelectorAll(badgeSelectors[s]);
        for (var e = 0; e < elements.length; e++) {
          var classified2 = classifyText(elements[e].textContent);
          if (classified2) {
            result.offerType = classified2;
            break;
          }
        }
        if (result.offerType && result.offerType !== 'promocao') break;
      }
    }

    // 4. Full page text scan as last resort (only check first 5000 chars for performance)
    if (!result.offerType || result.offerType === 'promocao') {
      var pageText = (document.title || '') + ' ' + ((document.body && document.body.innerText) || '').substring(0, 5000);
      var pageClassified = classifyText(pageText);
      if (pageClassified) {
        result.offerType = pageClassified;
      }
    }

    // 5. Preloaded state detection
    if (preloadedState && (!result.offerType || result.offerType === 'promocao')) {
      var is = preloadedState.initialState || preloadedState;

      // Check deal_type field
      var dealType = is.deal_type || is.dealType || null;
      if (!dealType && is.components) dealType = is.components.deal_type || null;
      if (!dealType && preloadedState.data) dealType = preloadedState.data.deal_type || preloadedState.data.dealType || null;

      if (dealType) {
        var dtClassified = classifyText(String(dealType));
        if (dtClassified) result.offerType = dtClassified;
      }

      // Check page title in state
      if (!result.offerType || result.offerType === 'promocao') {
        var stateTitle = is.title || is.pageTitle || (is.seo && is.seo.title) || null;
        if (!stateTitle && preloadedState.data) stateTitle = preloadedState.data.title || null;
        if (stateTitle) {
          var titleClassified = classifyText(stateTitle);
          if (titleClassified) result.offerType = titleClassified;
        }
      }

      // Check tab/navigation labels in state
      if (!result.offerType || result.offerType === 'promocao') {
        var tabs = is.tabs || (is.components && is.components.tabs) || null;
        if (!tabs && preloadedState.data) tabs = preloadedState.data.tabs || null;
        if (Array.isArray(tabs)) {
          for (var ti = 0; ti < tabs.length; ti++) {
            var tab = tabs[ti];
            if (tab && (tab.selected || tab.active)) {
              var tabClassified = classifyText(tab.label || tab.title || tab.name || '');
              if (tabClassified) {
                result.offerType = tabClassified;
                break;
              }
            }
          }
        }
      }
    }

    // 6. Timer/countdown for offerEndTime
    var timerSelectors = ['[class*="countdown"]', '[class*="timer"]', '.deal-timer', '[data-ends]', '[data-end-time]'];
    for (var t = 0; t < timerSelectors.length; t++) {
      var timerEl = document.querySelector(timerSelectors[t]);
      if (timerEl) {
        var timeData = timerEl.getAttribute('data-ends') || timerEl.getAttribute('data-end-time') || timerEl.getAttribute('data-deadline');
        if (timeData) {
          try {
            result.offerEndTime = new Date(timeData).toISOString();
          } catch (err) {}
        }
        break;
      }
    }

    return result;
  }

  async function extractProductData() {
    if (detectCaptcha()) {
      return { success: false, captcha: true, error: 'CAPTCHA detectado' };
    }

    preloadedState = await getPreloadedState();

    if (preloadedState) {
      console.log('[AchadinhoPRO:ML] Estado encontrado! Keys:', Object.keys(preloadedState));
      console.log('[AchadinhoPRO:ML] Tem data.items?', !!(preloadedState.data && preloadedState.data.items), 'count:', preloadedState.data && preloadedState.data.items ? preloadedState.data.items.length : 0);
      console.log('[AchadinhoPRO:ML] Tem results?', !!preloadedState.results);
      console.log('[AchadinhoPRO:ML] Tem initialState?', !!preloadedState.initialState);
    }

    var pageType = detectPageType();
    console.log('[AchadinhoPRO:ML] Tipo de página detectado:', pageType);

    if (pageType === 'homepage' || pageType === 'category') {
      return { success: false, error: 'Página inicial ou categoria - navegue até um produto', captcha: false };
    }

    var categoryInfo = extractCategoryInfo();
    var offerInfo = pageOfferInfo();

    if (pageType === 'product') {
      // Caminho dedicado da PDP (ml-pdp-scraper.js): lê preço atual/cheio/%,
      // vendas, avaliações, frete e selo MAIS VENDIDO do DOM renderizado, com o
      // __PRELOADED_STATE__ completando o que a tela não mostra. Fica FORA do
      // caminho de listagem/grid de propósito — ver cabeçalho do módulo.
      if (typeof MlPdpScraper !== 'undefined' && MlPdpScraper.extractProduct) {
        try {
          var pdpData = MlPdpScraper.extractProduct(document, preloadedState, window.location.href);
          if (pdpData && pdpData.productName && pdpData.price) {
            if (!pdpData.categoryId && categoryInfo.categoryId) pdpData.categoryId = categoryInfo.categoryId;
            if (!pdpData.categoryName && categoryInfo.categoryName) pdpData.categoryName = categoryInfo.categoryName;
            if (!pdpData.categoryBreadcrumb && categoryInfo.categoryBreadcrumb) pdpData.categoryBreadcrumb = categoryInfo.categoryBreadcrumb;
            if (!pdpData.offerType && offerInfo.offerType) pdpData.offerType = offerInfo.offerType;
            if (!pdpData.offerEndTime && offerInfo.offerEndTime) pdpData.offerEndTime = offerInfo.offerEndTime;
            console.log('[AchadinhoPRO:ML] PDP extraída:', JSON.stringify({
              price: pdpData.price, originalPrice: pdpData.originalPrice,
              discountPercent: pdpData.discountPercent, salesQuantity: pdpData.salesQuantity,
              ratingStar: pdpData.ratingStar, reviewsCount: pdpData.reviewsCount,
              freeShipping: pdpData.freeShipping, isBestSeller: pdpData.isBestSeller
            }));
            return { success: true, data: pdpData, source: 'pdp' };
          }
          console.warn('[AchadinhoPRO:ML] PDP sem nome/preço, caindo no caminho legado');
        } catch (pdpErr) {
          console.warn('[AchadinhoPRO:ML] ml-pdp-scraper falhou, caindo no caminho legado:', pdpErr);
        }
      }

      if (preloadedState) {
        var data = extractProductFromState(preloadedState);
        if (data && data.productName) {
          if (!data.categoryId && categoryInfo.categoryId) data.categoryId = categoryInfo.categoryId;
          if (!data.categoryName && categoryInfo.categoryName) data.categoryName = categoryInfo.categoryName;
          if (!data.categoryBreadcrumb && categoryInfo.categoryBreadcrumb) data.categoryBreadcrumb = categoryInfo.categoryBreadcrumb;
          if (!data.offerType && offerInfo.offerType) data.offerType = offerInfo.offerType;
          if (!data.offerEndTime && offerInfo.offerEndTime) data.offerEndTime = offerInfo.offerEndTime;
          return { success: true, data: data, source: 'preloaded_state' };
        }
      }

      var jsonLd = getJsonLdProduct();
      if (jsonLd) {
        // O JSON-LD da PDP só publica o preço COM desconto — sem preço cheio, sem
        // percentual, sem vendas e com freeShipping fixo em false. Completa com o
        // que está renderizado na tela antes de entregar.
        if (typeof MlPdpScraper !== 'undefined' && MlPdpScraper.enrichFromPdp) {
          try {
            jsonLd = MlPdpScraper.enrichFromPdp(jsonLd, document, preloadedState, window.location.href);
          } catch (enrichErr) {
            console.warn('[AchadinhoPRO:ML] enrichFromPdp falhou (seguindo só com o JSON-LD):', enrichErr);
          }
        }
        if (!jsonLd.categoryId && categoryInfo.categoryId) jsonLd.categoryId = categoryInfo.categoryId;
        if (!jsonLd.categoryName && categoryInfo.categoryName) jsonLd.categoryName = categoryInfo.categoryName;
        if (!jsonLd.categoryBreadcrumb && categoryInfo.categoryBreadcrumb) jsonLd.categoryBreadcrumb = categoryInfo.categoryBreadcrumb;
        if (!jsonLd.offerType) jsonLd.offerType = offerInfo.offerType;
        if (!jsonLd.offerEndTime) jsonLd.offerEndTime = offerInfo.offerEndTime;
        return { success: true, data: jsonLd, source: 'json-ld' };
      }

      return { success: false, error: 'Dados do produto não encontrados', captcha: false };
    }

    function enrichProducts(products) {
      for (var i = 0; i < products.length; i++) {
        if (!products[i].categoryId && categoryInfo.categoryId) products[i].categoryId = categoryInfo.categoryId;
        if (!products[i].categoryName && categoryInfo.categoryName) products[i].categoryName = categoryInfo.categoryName;
        if (!products[i].categoryBreadcrumb && categoryInfo.categoryBreadcrumb) products[i].categoryBreadcrumb = categoryInfo.categoryBreadcrumb;
        if (!products[i].offerType && offerInfo.offerType) products[i].offerType = offerInfo.offerType;
        if (!products[i].offerEndTime && offerInfo.offerEndTime) products[i].offerEndTime = offerInfo.offerEndTime;
      }
      return products;
    }

    if (pageType === 'listing') {
      var products = extractListingProducts(preloadedState);
      if (products.length > 0) {
        enrichProducts(products);
        return { success: true, data: products, source: 'listing', count: products.length };
      }

      return { success: false, error: 'Nenhum produto encontrado na listagem', captcha: false };
    }

    // Fallback for unknown pages: only try listing extraction, never single product
    // This prevents promo banners/GIFs from being shown as products on category/landing pages
    if (preloadedState) {
      var listingProducts = extractListingProducts(preloadedState);
      if (listingProducts.length > 0) {
        enrichProducts(listingProducts);
        return { success: true, data: listingProducts, source: 'listing', count: listingProducts.length };
      }
    }

    var domProducts = extractListingFromDOM();
    if (domProducts.length > 0) {
      enrichProducts(domProducts);
      return { success: true, data: domProducts, source: 'dom', count: domProducts.length };
    }

    return { success: false, error: 'Página não reconhecida', captcha: false };
  }

  chrome.runtime.onMessage.addListener(function(message, _sender, sendResponse) {
    if (message.action === 'getPageType') {
      preloadedState = null;
      getPreloadedState().then(function(state) {
        preloadedState = state;
        sendResponse({ pageType: detectPageType() });
      }).catch(function() {
        sendResponse({ pageType: detectPageType() });
      });
      return true;
    }

    if (message.action === 'ping') {
      sendResponse({ status: 'ok', marketplace: 'mercadolivre' });
      return true;
    }

    if (message.action === 'extractOffer') {
      extractProductData().then(function(result) {
        // A resposta também precisa ser CUMULATIVA no hub: o painel a exibe direto
        // (displayListing), sem o guard de tamanho do offerExtracted — devolver o lote
        // cru aqui apagaria da tela tudo que a rolagem já tinha coletado.
        if (result.success) result.data = applyHubAccumulation(result.data, 'extractOffer');
        console.log('[AchadinhoPRO:ML] Resultado extractOffer:', result.success, result.source, Array.isArray(result.data) ? result.data.length + ' items' : 'single');
        sendResponse(result);
      }).catch(function(err) {
        console.error('[AchadinhoPRO:ML] Erro em extractOffer:', err);
        sendResponse({ success: false, error: err.message });
      });
      return true;
    }

    if (message.action === 'extractAllOffers') {
      if (detectCaptcha()) {
        sendResponse({ success: false, captcha: true, error: 'CAPTCHA detectado' });
        return true;
      }

      getPreloadedState().then(function(state) {
        preloadedState = state;
        var products = extractListingProducts(state);

        // Enrich products with offerType and categoryInfo (same as extractProductData)
        var categoryInfo = extractCategoryInfo();
        var offerInfo = pageOfferInfo();
        for (var i = 0; i < products.length; i++) {
          if (!products[i].categoryId && categoryInfo.categoryId) products[i].categoryId = categoryInfo.categoryId;
          if (!products[i].categoryName && categoryInfo.categoryName) products[i].categoryName = categoryInfo.categoryName;
          if (!products[i].categoryBreadcrumb && categoryInfo.categoryBreadcrumb) products[i].categoryBreadcrumb = categoryInfo.categoryBreadcrumb;
          if (!products[i].offerType && offerInfo.offerType) products[i].offerType = offerInfo.offerType;
          if (!products[i].offerEndTime && offerInfo.offerEndTime) products[i].offerEndTime = offerInfo.offerEndTime;
        }

        // Mesma regra do extractOffer: no hub a coleta em lote entrega o cumulativo.
        products = applyHubAccumulation(products, 'extractAllOffers');

        console.log('[AchadinhoPRO:ML] Resultado extractAllOffers:', products.length, 'produtos, offerType:', offerInfo.offerType);
        sendResponse({
          success: products.length > 0,
          data: products,
          count: products.length,
        });
      }).catch(function(err) {
        console.error('[AchadinhoPRO:ML] Erro em extractAllOffers:', err);
        sendResponse({ success: false, data: [], error: err.message });
      });
      return true;
    }

    return false;
  });

  function getSimplePageType() {
    var url = window.location.href;
    var homepagePattern = /^https?:\/\/[^/]*mercadolivre\.com\.br\/?(\?[^/]*)?$/;
    if (homepagePattern.test(url)) return 'homepage';
    if (url.indexOf('/c/') !== -1) return 'category';
    if (typeof MlHubScraper !== 'undefined' && MlHubScraper.isHubUrl(url)) return 'listing';
    if (url.indexOf('lista.mercadolivre') !== -1 || url.indexOf('/s?') !== -1
        || url.indexOf('/ofertas') !== -1 || url.indexOf('/mais-vendidos') !== -1
        || url.indexOf('busca?') !== -1 || url.indexOf('_Desde_') !== -1) return 'listing';
    if (url.indexOf('/p/MLB') !== -1 || url.match(/\/MLB-?\d+/) || url.indexOf('produto.mercadolivre') !== -1) return 'product';
    return 'unknown';
  }

  // ===== ACUMULAÇÃO DA LISTAGEM (infinite scroll do hub de afiliados) =====
  // O painel NÃO acumula: displayListing substitui currentListingProducts pelo que
  // chega (sidepanel.js:815) e só se defende rejeitando lotes MENORES que o atual
  // (1686). O contrato implícito é "o content script manda a lista cumulativa
  // completa" — que a Amazon já cumpre (amazon-scraper.js:1399) e o ML não cumpria.
  // Acumular fica restrito ao hub: nas demais listagens do ML a paginação troca a
  // URL (e o acumulador é zerado ali), então não há o que somar.
  var accumulatedListing = [];

  // Teto da acumulação. Cada extração reenvia a lista INTEIRA ao painel (structured
  // clone) e o painel repinta todos os itens, sem virtualização — rolar o hub por muito
  // tempo viraria uma mensagem de centenas de KB a cada 4 s. Corte explícito e logado:
  // truncar em silêncio faria a tela parecer "coletou tudo" quando não coletou.
  var MAX_ACCUMULATED_LISTING = 1000;
  var _accumulationCapWarned = false;

  function resetAccumulation(motivo) {
    if (accumulatedListing.length) {
      console.log('[AchadinhoPRO:ML] Acumulação zerada (' + motivo + '):', accumulatedListing.length, 'produtos descartados');
    }
    accumulatedListing = [];
    _accumulationCapWarned = false;

    // O React troca a grade inteira na navegação SPA. Soltar o observer e zerar a
    // contagem é o que permite rearmá-lo na grade NOVA — mantê-lo preso ao nó antigo
    // deixava o gatilho "grade cresceu" morto da segunda visita ao hub em diante.
    try { if (_hubGridObserver) _hubGridObserver.disconnect(); } catch (e) {}
    _hubGridObserver = null;
    lastHubExtract = 0;
    if (typeof startHubGridWatch === 'function') startHubGridWatch();
  }

  /**
   * Aplica a acumulação do hub a um resultado de extração e devolve a lista CUMULATIVA.
   *
   * Passa por aqui TODA saída de listagem do hub — o envio automático (`sendExtraction`)
   * e também as respostas de `extractOffer`/`extractAllOffers`. Se o handler de mensagem
   * respondesse com o lote cru, reabrir o side panel depois de uma rolagem longa
   * substituiria a lista acumulada pelos poucos cards pintados naquele instante (o
   * painel chama displayListing direto na resposta, sem passar pelo guard de tamanho).
   */
  function applyHubAccumulation(data, source) {
    if (!Array.isArray(data) || !isAffiliateHub() || typeof MlHubScraper === 'undefined') return data;

    var antes = accumulatedListing.length;
    accumulatedListing = MlHubScraper.mergeListings(accumulatedListing, data);
    if (accumulatedListing.length > MAX_ACCUMULATED_LISTING) {
      if (!_accumulationCapWarned) {
        _accumulationCapWarned = true;
        console.warn('[AchadinhoPRO:ML] Teto de ' + MAX_ACCUMULATED_LISTING + ' produtos atingido no hub — os que entrarem daqui em diante NÃO serão coletados. Salve o que já está na lista antes de continuar rolando.');
      }
      accumulatedListing = accumulatedListing.slice(0, MAX_ACCUMULATED_LISTING);
    }
    console.log('[AchadinhoPRO:ML] ' + source + ': acumulação ' + antes + ' → ' + accumulatedListing.length + ' (lote: ' + data.length + ')');
    return accumulatedListing;
  }

  // extractProductData() é async e a rolagem dispara várias vezes seguidas. Sem esta
  // trava duas extrações se sobrepõem e a mais LENTA (com o DOM mais velho) responde
  // por último, mandando ao painel uma lista menor que a já acumulada — que o guard de
  // length do painel então descarta, congelando a contagem na tela.
  var _extractionInFlight = false;
  var _extractionPending = null;

  function sendExtraction(source) {
    if (!isContextValid()) { cleanupObservers(); return Promise.resolve(false); }

    if (_extractionInFlight) {
      // Guarda só a última: o DOM da próxima passada já contém tudo o que esta veria.
      _extractionPending = source;
      return Promise.resolve(false);
    }
    _extractionInFlight = true;

    var url = window.location.href;
    return extractProductData().then(function(result) {
      if (!result.success) return false;

      var data = applyHubAccumulation(result.data, source);

      if (!isContextValid()) { cleanupObservers(); return false; }
      chrome.runtime.sendMessage({
        action: 'offerExtracted',
        data: data,
        source: result.source,
        url: url,
      }).catch(function() {});
      return true;
    }).catch(function() {
      return false;
    }).then(function(ok) {
      _extractionInFlight = false;
      if (_extractionPending) {
        var motivo = _extractionPending;
        _extractionPending = null;
        // Pedido que chegou enquanto esta rodava: o lote que o disparou pode ser
        // justamente o último da rolagem, e perdê-lo devolveria o bug original.
        setTimeout(function() { sendExtraction(motivo + ' (pendente)'); }, 300);
      }
      return ok;
    });
  }

  // Auto-extract on page load for all page types (product, listing, offers)
  setTimeout(function() {
    sendExtraction('Load');
  }, 1000);

  var lastUrl = window.location.href;
  var navigationTimeout = null;

  function notifyPageChange() {
    var currentUrl = window.location.href;
    if (currentUrl === lastUrl) return;

    // Dentro do hub, mexer SÓ no fragmento não é navegação: a página carrega com
    // `#menu-user` e reescreve a âncora durante o uso. Tratar isso como troca de
    // página fazia o painel zerar currentListingProducts (sidepanel.js:1703) no
    // meio da rolagem, apagando tudo que já tinha sido acumulado. Fora do hub a
    // comparação continua sendo a URL inteira — na PDP o fragmento (`wid=MLB…`)
    // identifica o item.
    if (typeof MlHubScraper !== 'undefined' && MlHubScraper.isSameHubPage(lastUrl, currentUrl)) {
      lastUrl = currentUrl;
      return;
    }

    console.log('[AchadinhoPRO:ML] Navegação detectada:', currentUrl);
    lastUrl = currentUrl;
    preloadedState = null;
    resetAccumulation('navegação');
    if (navigationTimeout) clearTimeout(navigationTimeout);
    navigationTimeout = setTimeout(function() {
      try {
        chrome.runtime.sendMessage({
          action: 'pageChanged',
          url: currentUrl,
          pageType: getSimplePageType()
        }).catch(function() {});

        // Re-extract for ALL page types (product, listing, offers)
        sendExtraction('Navegação');
      } catch (e) {}
    }, 800);
  }

  // ===== INFINITE SCROLL DO HUB =====
  // Re-extrai enquanto a grade cresce: cada passada lê o DOM inteiro e o merge por
  // mlItemId garante que nada duplique. Dois gatilhos, porque um só não cobre a
  // página: `scroll` pega a rolagem do usuário; a contagem de cards no
  // MutationObserver pega o lote que chega DEPOIS que a rolagem parou (a resposta
  // do XHR do ML) e um eventual botão "ver mais". Debounce de 1,5 s e no mínimo
  // 4 s entre extrações — sem isso o painel seria repintado a cada card inserido.
  var lastHubExtract = 0;

  var HUB_DEBOUNCE_MS = 1500;
  var HUB_MIN_GAP_MS = 4000;

  function scheduleHubReextract(motivo) {
    if (!isContextValid()) { cleanupObservers(); return; }
    if (!isAffiliateHub()) return;

    if (_hubReextractTimer) clearTimeout(_hubReextractTimer);
    _hubReextractTimer = setTimeout(function() { runHubReextract(motivo); }, HUB_DEBOUNCE_MS);
  }

  function runHubReextract(motivo) {
    _hubReextractTimer = null;
    if (!isContextValid()) { cleanupObservers(); return; }
    if (!isAffiliateHub()) return;

    // Dentro do intervalo mínimo o pedido é ADIADO, nunca descartado. Descartar
    // reintroduzia o bug original no caso mais comum: o usuário rola, para, e o lote
    // do XHR chega logo depois da extração anterior — os dois disparos (scroll e
    // mutação da grade) cairiam dentro do gap e aqueles cards nunca chegariam ao
    // painel, porque não há mais nada que dispare depois.
    var faltam = HUB_MIN_GAP_MS - (Date.now() - lastHubExtract);
    if (faltam > 0) {
      _hubReextractTimer = setTimeout(function() { runHubReextract(motivo); }, faltam);
      return;
    }

    lastHubExtract = Date.now();
    console.log('[AchadinhoPRO:ML] Hub de afiliados — re-extraindo (' + motivo + ')');
    sendExtraction(motivo);
  }

  function hubCardSelector() {
    return (typeof MlHubScraper !== 'undefined' && MlHubScraper.CARD_SELECTOR) || '.poly-card';
  }

  window.addEventListener('scroll', function() {
    scheduleHubReextract('Scroll');
  }, { passive: true });

  /**
   * Segundo gatilho: a grade cresceu. O lote do infinite scroll costuma chegar DEPOIS
   * que a rolagem parou (é a resposta do XHR), e aí o listener de `scroll` já rodou —
   * sem isto o último lote de cada rolagem ficaria de fora.
   *
   * O observer é pendurado no CONTAINER dos cards, com childList e SEM subtree. O
   * _urlObserver acima já observa `document.body` inteiro com subtree e só sobrevive
   * porque seu callback sai em O(1); pendurar uma varredura de DOM ali dentro, numa
   * página de scroll infinito, viraria re-extração em cascata e CPU alta na aba.
   */
  function watchHubGrid() {
    if (!isContextValid()) { cleanupObservers(); return; }
    if (!isAffiliateHub() || _hubGridObserver) return;

    var firstCard = null;
    try { firstCard = document.querySelector(hubCardSelector()); } catch (e) {}
    // O container não é procurado por classe de propósito: o nome da grade é do
    // design system do ML e muda sem aviso. O pai do primeiro card é sempre o certo.
    var grid = firstCard && firstCard.parentElement ? firstCard.parentElement : null;
    if (!grid) return;

    // Dispara por NÓ ADICIONADO, não por contagem total. Comparar o total contra um
    // máximo histórico silenciava exatamente o caso que este observer existe para
    // cobrir: se a grade recicla (remove 20 do topo, acrescenta 20 embaixo), o total
    // fica estável ou cai, e o gatilho só voltaria a disparar quando a contagem
    // superasse o pico anterior — que pode nunca acontecer.
    _hubGridObserver = new MutationObserver(function(mutations) {
      if (!isContextValid()) { cleanupObservers(); return; }
      var novos = 0;
      for (var m = 0; m < mutations.length; m++) {
        var add = mutations[m] && mutations[m].addedNodes;
        if (add && add.length) novos += add.length;
      }
      if (!novos) return;
      scheduleHubReextract('Grade recebeu ' + novos + ' card(s)');
    });
    _hubGridObserver.observe(grid, { childList: true });
    console.log('[AchadinhoPRO:ML] Observando a grade do hub —', grid.children ? grid.children.length : 0, 'cards no início');
  }

  /**
   * A grade é pintada pelo React depois do content script; tenta algumas vezes até
   * existir e desiste em silêncio (o listener de scroll continua cobrindo a rolagem).
   *
   * Precisa ser REARMÁVEL: numa navegação SPA hub → busca → hub, o React descarta a
   * grade antiga. Sem rearmar, o observer ficaria preso ao nó descartado e o gatilho
   * "grade cresceu" morreria na segunda visita — sobrando só o listener de scroll.
   */
  function startHubGridWatch() {
    if (!isAffiliateHub()) return;
    var tentativas = 0;
    var intervalo = setInterval(function() {
      tentativas++;
      if (!isContextValid() || _hubGridObserver || tentativas > 10 || !isAffiliateHub()) {
        clearInterval(intervalo);
        return;
      }
      watchHubGrid();
    }, 1000);
  }

  startHubGridWatch();

  _urlObserver = new MutationObserver(function() {
    if (!isContextValid()) { cleanupObservers(); return; }
    notifyPageChange();
  });
  if (document.body) {
    _urlObserver.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener('popstate', function() {
    if (!isContextValid()) { cleanupObservers(); return; }
    notifyPageChange();
  });
  window.addEventListener('hashchange', function() {
    if (!isContextValid()) { cleanupObservers(); return; }
    notifyPageChange();
  });

  var originalPushState = history.pushState;
  var originalReplaceState = history.replaceState;
  history.pushState = function() {
    originalPushState.apply(this, arguments);
    if (!isContextValid()) { cleanupObservers(); return; }
    notifyPageChange();
  };
  history.replaceState = function() {
    originalReplaceState.apply(this, arguments);
    if (!isContextValid()) { cleanupObservers(); return; }
    notifyPageChange();
  };

  // Polling backup — catches navigation that other methods miss (e.g. location.assign, hash-only changes)
  _notifyInterval = setInterval(function() {
    if (!isContextValid()) { cleanupObservers(); return; }
    notifyPageChange();
  }, 1500);

  console.log('[AchadinhoPRO:ML] Tipo de página:', getSimplePageType());
})();
