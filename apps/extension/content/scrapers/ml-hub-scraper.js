/**
 * Hub de AFILIADOS do Mercado Livre — leitura dos cards e dos selos.
 * (https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true#menu-user)
 *
 * Por que este módulo existe (bug de 31/ago/2026):
 *
 *  1. A grade do hub carrega por INFINITE SCROLL. O `_n.ctx.r` / `__PRELOADED_STATE__`
 *     que o ml-scraper lê é o payload SSR da PRIMEIRA página e NÃO cresce com a
 *     rolagem — o ML busca as páginas seguintes por XHR e só pinta no DOM. Como
 *     extractListingProducts() dá prioridade absoluta ao estado e usa o DOM apenas
 *     para enriquecer preço (enrichListingFromDOM nunca ACRESCENTA item), tudo que
 *     entrava por scroll ficava invisível para o painel.
 *
 *  2. Os selos do card do hub não existiam em nenhum extrator: "MAIS VENDIDO",
 *     "MAIS BUSCADO", "MAIS COMPARTILHADO" (.poly-component__highlight) e o chip de
 *     comissão "GANHOS EXTRAS 16%" / "GANHOS 12%" (.poly-component__chip). Para um
 *     afiliado o percentual de ganho é o dado mais importante da tela e ele não
 *     chegava ao produto salvo.
 *
 *  3. O id do item vinha ERRADO nos cards de promoção. O href do card traz
 *     `pdp_filters=deal%3AMLB1578289-1` ANTES do `wid=MLB6762741456`, e o regex solto
 *     /MLB-?(\d+)/ de extractListingFromDOM pegava o id da PROMOÇÃO — gravando a
 *     chave (userId, mlItemId) de outro registro, que colide entre todos os itens da
 *     mesma promoção. A ordem correta é a que o próprio ML usa no botão
 *     "Compartilhar": input[name="id"] > wid= > item_id: > /p/MLB.
 *
 * O contrato de DOM está congelado em tests/fixtures/ml-hub-afiliados-cards-2026-08-31.html
 * (HTML real, capturado da página) e exercitado por tests/mlHubScraper.test.ts.
 *
 * UMD no mesmo padrão de ml-price-utils.js: `window.MlHubScraper` como content script,
 * `module.exports` para os testes em node.
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.MlHubScraper = api;
  }
})(function () {
  /** Card da grade do hub — mesmo polycard das outras listagens do ML. */
  var CARD_SELECTOR = '.poly-card, .ui-search-result, .andes-card[class*="poly-card"]';

  /** Colapsa espaços/nbsp e apara. O Andes quebra rótulos em vários <span>. */
  function collapse(text) {
    return String(text == null ? '' : text).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** "MAIS VENDIDO" → "Mais vendido"; "GANHOS EXTRAS 16%" → "Ganhos extras 16%". */
  function prettifyTag(text) {
    var t = collapse(text);
    if (!t) return '';
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  }

  function normalizeId(value) {
    var v = collapse(value).toUpperCase().replace(/-/g, '');
    return /^MLB\d{6,}$/.test(v) ? v : null;
  }

  /** URL do hub de afiliados (com ou sem query/hash, com ou sem sub-rota). */
  function isHubUrl(url) {
    return /\/afiliados\/hub(?:[/?#]|$)/i.test(String(url || ''));
  }

  /**
   * Duas URLs do hub que diferem SÓ no hash são a mesma página. O hub carrega com
   * `#menu-user` e reescreve o fragmento durante a navegação interna; sem isto o
   * notifyPageChange do ml-scraper dispara `pageChanged`, o painel zera
   * currentListingProducts e a lista acumulada na rolagem some da tela.
   * Fora do hub a comparação continua sendo a URL inteira — na PDP o fragmento
   * (`#polycard_client=...&wid=MLB...`) identifica O ITEM e não pode ser ignorado.
   */
  function isSameHubPage(urlA, urlB) {
    if (!isHubUrl(urlA) || !isHubUrl(urlB)) return false;
    return stripHash(urlA) === stripHash(urlB);
  }

  function stripHash(url) {
    var s = String(url || '');
    var i = s.indexOf('#');
    return i === -1 ? s : s.slice(0, i);
  }

  function attr(el, name) {
    if (!el) return '';
    if (el.getAttribute) {
      var v = el.getAttribute(name);
      if (v != null) return String(v);
    }
    return el[name] != null ? String(el[name]) : '';
  }

  /**
   * URL ABSOLUTA de href/src. A PROPRIEDADE (`el.href`) vem resolvida pelo navegador;
   * o ATRIBUTO pode ser relativo ("/produto/..."). É o que `extractListingFromDOM` já
   * fazia, e perder isso mandaria um caminho relativo para a geração do link de
   * afiliado e para `ml_products.product_link`. Cai no atributo fora do navegador
   * (nos testes, o adaptador cheerio só expõe getAttribute).
   */
  function absoluteUrl(el, name) {
    if (!el) return '';
    var prop = el[name];
    if (typeof prop === 'string' && /^https?:\/\//i.test(prop)) return prop;
    return attr(el, name);
  }

  function text(el) {
    return el ? collapse(el.textContent) : '';
  }

  /**
   * Id do ITEM anunciado, na mesma ordem de confiança que o ML usa no card:
   *  1. input[name="id"] do botão "Compartilhar" — o id exato, sem ambiguidade;
   *  2. `wid=MLB…` no fragmento — idem, é o que o ML manda para a PDP;
   *  3. `pdp_filters=item_id:MLB…`;
   *  4. `/p/MLB…` — id de FAMÍLIA do catálogo, último recurso.
   * `deal:MLB…` (id da promoção) é deliberadamente ignorado: era o que o regex
   * solto capturava.
   */
  function readCardItemId(card) {
    if (!card || !card.querySelector) return null;

    var input = card.querySelector('input[data-testid="form-data-id"], input[name="id"]');
    var fromInput = normalizeId(attr(input, 'value'));
    if (fromInput) return fromInput;

    return readItemIdFromHref(absoluteUrl(cardLink(card), 'href'));
  }

  /**
   * O link do produto — o do TÍTULO, com preferência real.
   * `querySelector('a.poly-component__title, a[href]')` NÃO faz isso: com lista de
   * seletores o DOM devolve o primeiro nó em ordem de DOCUMENTO que case com qualquer
   * um deles, então um link de imagem ou de vendedor antes do título sequestraria o id
   * e o productLink. Duas chamadas separadas é o único jeito de ordenar a preferência.
   */
  function cardLink(card) {
    if (!card || !card.querySelector) return null;
    return card.querySelector('a.poly-component__title') || card.querySelector('a[href]');
  }

  function readItemIdFromHref(href) {
    var raw = String(href || '');
    if (!raw) return null;
    var h = raw;
    try {
      h = decodeURIComponent(raw);
    } catch (e) {
      /* href com % solto — segue com o texto cru */
    }

    var patterns = [
      /[?&#]wid=(MLB-?\d{6,})/i,
      /item_id[:=](MLB-?\d{6,})/i,
      /\/p\/(MLB-?\d{6,})/i,
      /\/(MLB-?\d{6,})(?:[/?#]|$)/i,
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = h.match(patterns[i]);
      var id = m ? normalizeId(m[1]) : null;
      if (id) return id;
    }
    return null;
  }

  /**
   * Selos do card. Dois grupos, com marcações diferentes:
   *  - destaque:  <span class="poly-component__highlight">MAIS VENDIDO</span>
   *  - comissão:  <div class="poly-component__chip"> com
   *               .poly-pill__pill ("GANHOS EXTRAS" ou "GANHOS 16%") e, no chip
   *               composto, um irmão .poly-component__label com o "16%".
   * Devolve os rótulos legíveis em `tags`. `commissionPercent`/`hasExtraEarnings`
   * são de uso INTERNO (compor e conferir o rótulo) e não entram no produto: não há
   * coluna nem consumidor para eles, e um campo assim seria descartado em silêncio
   * pela whitelist do ingest.
   */
  function readCardTags(card) {
    var out = { tags: [], highlightTag: null, commissionPercent: null, hasExtraEarnings: false };
    if (!card || !card.querySelectorAll) return out;

    var seen = {};
    function push(label) {
      var t = prettifyTag(label);
      if (!t) return;
      var key = t.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.tags.push(t);
    }

    var highlights = card.querySelectorAll('.poly-component__highlight');
    for (var h = 0; h < highlights.length; h++) {
      var hl = text(highlights[h]);
      if (!hl) continue;
      if (!out.highlightTag) out.highlightTag = prettifyTag(hl);
      push(hl);
    }

    var chips = card.querySelectorAll('.poly-component__chip');
    for (var c = 0; c < chips.length; c++) {
      var chip = chips[c];
      var pill = chip.querySelector ? chip.querySelector('.poly-pill__pill') : null;
      var label = chip.querySelector ? chip.querySelector('.poly-component__label') : null;
      var chipText = collapse(text(pill) + ' ' + text(label)) || text(chip);
      if (!chipText) continue;
      readCommissionInto(out, chipText);
      push(chipText);
    }

    // Layout sem o wrapper .poly-component__chip (visto em variações do hub).
    if (!chips.length) {
      var pills = card.querySelectorAll('.poly-pill__pill');
      for (var p = 0; p < pills.length; p++) {
        var pillText = text(pills[p]);
        if (!pillText) continue;
        readCommissionInto(out, pillText);
        push(pillText);
      }
    }

    return out;
  }

  function readCommissionInto(out, chipText) {
    if (!/ganho/i.test(chipText)) return;
    if (/extra/i.test(chipText)) out.hasExtraEarnings = true;
    var m = chipText.match(/(\d{1,3})\s*%/);
    if (m && out.commissionPercent == null) {
      var pct = parseInt(m[1], 10);
      if (pct > 0 && pct <= 100) out.commissionPercent = pct;
    }
  }

  /**
   * Avaliação e vendas do card do hub. Aqui elas vivem em
   * `.poly-component__review-compacted` ("4.5 | +100mil vendidos") — os seletores
   * `.poly-reviews__*` das outras listagens do ML não alcançam este layout, e sem
   * isto todo produto do hub era salvo sem nota e sem volume de vendas.
   * Fallback no texto acessível ("Classificação 4.5 de 5 estrelas. Mais de 100mil
   * produtos vendidos.").
   */
  function readCardReviews(card) {
    var out = { ratingStar: null, salesQuantity: null };
    if (!card || !card.querySelector) return out;

    var compact = text(card.querySelector('.poly-component__review-compacted'));
    var accessible = '';
    var hidden = card.querySelectorAll ? card.querySelectorAll('.andes-visually-hidden') : [];
    for (var i = 0; i < hidden.length; i++) {
      var t = text(hidden[i]);
      if (/classifica|estrela|vendid/i.test(t)) { accessible = t; break; }
    }

    // A nota precisa vir de uma posição ANCORADA. Um `/(\d+[.,]\d+)/` solto no texto
    // inteiro casaria com o decimal do volume de vendas — num card sem avaliação,
    // "Mais de 1,5 mil produtos vendidos" viraria uma nota fabricada de 1,5 estrela,
    // que entra nos filtros e na ordenação da automação como se fosse medida.
    var ratingMatch = null;
    if (compact.indexOf('|') !== -1) {
      // Layout do hub: "4.5 | +100mil vendidos" — a nota é o trecho antes do separador.
      ratingMatch = compact.split('|')[0].match(/(\d+[.,]\d+)/);
    } else if (/^\d+[.,]\d+$/.test(compact)) {
      ratingMatch = compact.match(/(\d+[.,]\d+)/);
    }
    if (!ratingMatch && accessible) {
      // "Classificação 4.5 de 5 estrelas." — exige o contexto da escala.
      ratingMatch = accessible.match(/(\d+[.,]\d+)\s*(?:de\s*5|estrela)/i)
        || accessible.match(/classifica\S*\s+(\d+[.,]\d+)/i);
    }
    if (ratingMatch) {
      var rating = parseFloat(ratingMatch[1].replace(',', '.'));
      if (isFinite(rating) && rating > 0 && rating <= 5) out.ratingStar = Math.round(rating * 100);
    }

    out.salesQuantity = parseSales(compact) || parseSales(accessible);
    return out;
  }

  /** "+100mil vendidos" → 100000; "+500 vendidos" → 500; "1,5 mil vendidos" → 1500. */
  function parseSales(raw) {
    var s = collapse(raw);
    if (!s) return null;
    var m = s.match(/([\d.,]+)\s*(mil)?\s*(?:produtos?\s+)?vendidos/i);
    if (!m) return null;
    var num = parseFloat(String(m[1]).replace(/\./g, '').replace(',', '.'));
    if (!isFinite(num) || num <= 0) return null;
    if (m[2]) num *= 1000;
    return Math.round(num);
  }

  /**
   * Um card → um produto no MESMO contrato de extractListingFromDOM (ml-scraper.js),
   * mais o campo novo `tags`. `priceUtils` é o MlPriceUtils (injetado nos testes;
   * no navegador vem de window). Sem ele o preço fica nulo em vez de errado.
   */
  function readCard(card, priceUtils, idx) {
    if (!card || !card.querySelector) return null;

    var titleEl = card.querySelector('a.poly-component__title, .poly-component__title, a[title]');
    var productName = text(titleEl) || collapse(attr(titleEl, 'title'));
    if (!productName) return null;

    var productLink = absoluteUrl(cardLink(card), 'href') || null;

    var imgEl = card.querySelector('img.poly-component__picture, img[src*="mlstatic"]');
    var imageUrl = absoluteUrl(imgEl, 'src') || attr(imgEl, 'data-src') || null;

    var prices = { priceCents: null, originalPriceCents: null, discountPercent: null };
    var pu = priceUtils || (typeof window !== 'undefined' ? window.MlPriceUtils : null);
    if (pu && pu.extractCardPriceData) prices = pu.extractCardPriceData(card);

    var tagInfo = readCardTags(card);
    var reviews = readCardReviews(card);
    var shippingEl = card.querySelector('.poly-component__shipping, .ui-search-item__shipping');

    return {
      mlItemId: readCardItemId(card),
      productName: productName,
      price: prices.priceCents || null,
      originalPrice: prices.originalPriceCents || null,
      discountPercent: prices.discountPercent == null ? null : prices.discountPercent,
      freeShipping: /grátis|gratis/i.test(text(shippingEl)),
      imageUrl: imageUrl,
      productLink: productLink,
      sellerName: text(card.querySelector('.poly-component__seller, .ui-search-result__seller')) || null,
      sellerId: null,
      sellerReputation: null,
      condition: 'new',
      ratingStar: reviews.ratingStar,
      reviewsCount: null,
      salesQuantity: reviews.salesQuantity,
      categoryId: null,
      categoryName: null,
      categoryBreadcrumb: null,
      offerType: null,
      offerEndTime: null,
      position: idx + 1,
      // O percentual de comissão viaja DENTRO da tag ("Ganhos extras 16%"). Não há
      // campo próprio de propósito: sem coluna no banco e sem consumidor, um
      // `commissionPercent` no produto seria descartado em silêncio pela whitelist
      // do ingest e daria a impressão de que persiste.
      tags: tagInfo.tags,
      // Marca a leitura como AUTORITATIVA para tags. O card do hub renderiza os selos
      // no mesmo bloco do título e do preço: se ele existe e não tem selo, o produto
      // realmente deixou de ter selo. Sem este sinal o ingest não consegue distinguir
      // "página que não mostra selo" (uma PDP, uma busca) de "hub confirmando que não
      // há mais selo" — e, para não apagar tag boa, nunca apagaria nenhuma: comissão
      // encerrada ficaria exibida como ativa para sempre.
      tagsSource: 'ml_hub',
    };
  }

  /** Todos os cards pintados AGORA — inclusive os que entraram por scroll. */
  function extractProducts(doc, priceUtils) {
    var scope = doc || (typeof document !== 'undefined' ? document : null);
    if (!scope || !scope.querySelectorAll) return [];
    var cards = scope.querySelectorAll(CARD_SELECTOR);
    var products = [];
    for (var i = 0; i < cards.length; i++) {
      try {
        var p = readCard(cards[i], priceUtils, products.length);
        // Sem id o produto não tem chave de dedupe nem de upsert — descartar é
        // melhor que acumular fantasmas a cada rolagem.
        if (p && p.mlItemId) products.push(p);
      } catch (e) {
        /* card fora do padrão não derruba a varredura */
      }
    }
    return products;
  }

  /**
   * União cumulativa por mlItemId, preservando a ordem da primeira aparição.
   * Usada duas vezes: para acumular o que entra na rolagem e para juntar o que o
   * estado SSR trouxe com o que só existe no DOM. Campo já preenchido nunca é
   * sobrescrito — o estado costuma ser mais completo (categoria, vendedor) e o DOM
   * é quem tem os selos.
   */
  function mergeListings(base, incoming) {
    var out = [];
    var index = {};

    function keyOf(p) {
      if (!p) return '';
      return normalizeId(p.mlItemId) || collapse(p.productLink) || collapse(p.productName).toLowerCase();
    }

    function add(p) {
      var key = keyOf(p);
      if (!p || !key) return;
      if (!Object.prototype.hasOwnProperty.call(index, key)) {
        index[key] = out.length;
        out.push(p);
        return;
      }
      // A leitura NOVA do card prevalece. `fillGaps` (que só preenche vazio) estava
      // errado aqui: o acumulador congelava o primeiro valor visto, então um preço
      // que mudasse durante a coleta ficaria no antigo, e as tags se SOMAVAM — o
      // mesmo produto exibia "Ganhos 16%" e "Ganhos 12%" ao mesmo tempo, duas
      // comissões contraditórias na tela e no que seria salvo.
      out[index[key]] = refreshFields(out[index[key]], p);
    }

    for (var i = 0; i < (base || []).length; i++) add(base[i]);
    for (var j = 0; j < (incoming || []).length; j++) add(incoming[j]);
    return out;
  }

  /**
   * Completa os campos de `base` com o que `extra` tiver, SEM NUNCA acrescentar item.
   *
   * É o que o hub usa para aproveitar o estado SSR sem deixá-lo criar linha: os dois
   * lados não concordam sobre o id. O DOM usa readCardItemId (input[name="id"] > wid=),
   * enquanto extractOffersPageProducts cai, no fallback, no regex solto /MLB-?(\d+)/ —
   * que num card `/p/MLB63904966?…&wid=MLB7480686754` devolve o id de FAMÍLIA e, num
   * card com `pdp_filters=deal%3A…`, o id da PROMOÇÃO. Com `mergeListings` o mesmo
   * produto entraria DUAS vezes, e a cópia do estado seria salva sob um id que colide
   * entre todos os itens da mesma promoção. Casar por título cobre justamente os casos
   * em que os ids divergem.
   */
  function fillFromListing(base, extra) {
    if (!Array.isArray(base) || !base.length || !Array.isArray(extra) || !extra.length) return base || [];

    var byId = {};
    var byTitle = {};
    for (var i = 0; i < extra.length; i++) {
      var e = extra[i];
      if (!e) continue;
      var id = normalizeId(e.mlItemId);
      if (id && !byId[id]) byId[id] = e;
      var t = collapse(e.productName).toLowerCase();
      if (t) {
        // Título repetido é ambíguo (dois vendedores, mesmo texto) — anula.
        byTitle[t] = Object.prototype.hasOwnProperty.call(byTitle, t) ? null : e;
      }
    }

    for (var j = 0; j < base.length; j++) {
      var p = base[j];
      if (!p) continue;
      var hit = byId[normalizeId(p.mlItemId)] || byTitle[collapse(p.productName).toLowerCase()] || null;
      if (!hit) continue;
      // O id do DOM é o de maior confiança: fillGaps só preenche o que está vazio,
      // então um id divergente do estado nunca sobrescreve o que já foi lido do card.
      base[j] = fillGaps(p, hit);
    }
    return base;
  }

  /**
   * Reconciliação de uma releitura do MESMO card: o que a passagem nova trouxe vence.
   *
   * Só vence quando trouxe valor de verdade — campo nulo/vazio na leitura nova (card
   * ainda pintando, imagem em lazy-load) preserva o que já havia, senão a acumulação
   * apagaria dado bom a cada rolagem. Tags são SUBSTITUÍDAS em bloco, nunca unidas:
   * "Ganhos 16%" virando "Ganhos 12%" é troca de comissão, não um segundo selo.
   */
  function refreshFields(current, novo) {
    var merged = {};
    var k;
    for (k in current) if (Object.prototype.hasOwnProperty.call(current, k)) merged[k] = current[k];
    for (k in novo) {
      if (!Object.prototype.hasOwnProperty.call(novo, k)) continue;
      var valor = novo[k];
      if (k === 'tags') {
        if (!Array.isArray(valor)) continue;
        // Lista vazia de uma leitura AUTORITATIVA (card do hub lido inteiro) é
        // informação: o produto deixou de ter selo. Preservar aqui anulava na prática
        // a regra da rota — o vazio nunca chegava ao servidor e a comissão encerrada
        // seguia exibida como ativa. De uma leitura não-autoritativa o vazio continua
        // sendo ausência de dado, e preserva.
        if (valor.length || novo.tagsSource === 'ml_hub') merged.tags = mergeTags([], valor);
        continue;
      }
      if (valor == null || valor === '') continue;
      merged[k] = valor;
    }
    return merged;
  }

  function fillGaps(current, extra) {
    var merged = {};
    var k;
    for (k in current) if (Object.prototype.hasOwnProperty.call(current, k)) merged[k] = current[k];
    for (k in extra) {
      if (!Object.prototype.hasOwnProperty.call(extra, k)) continue;
      var novo = extra[k];
      var atual = merged[k];
      if (k === 'tags') {
        merged.tags = mergeTags(atual, novo);
        continue;
      }
      if (novo == null || novo === '' || novo === false) continue;
      if (atual == null || atual === '' || atual === false) merged[k] = novo;
    }
    return merged;
  }

  function mergeTags(a, b) {
    var out = [];
    var seen = {};
    [a, b].forEach(function (list) {
      if (!Array.isArray(list)) return;
      list.forEach(function (tag) {
        var t = collapse(tag);
        if (!t || seen[t.toLowerCase()]) return;
        seen[t.toLowerCase()] = true;
        out.push(t);
      });
    });
    return out;
  }

  /**
   * Enriquece uma lista já extraída (do estado SSR) com o que só o DOM tem: os
   * selos. Casa por id normalizado e, como fallback, por título — o mesmo par de
   * chaves que enrichListingFromDOM usa para preço.
   */
  function enrichWithTags(products, doc) {
    var scope = doc || (typeof document !== 'undefined' ? document : null);
    if (!Array.isArray(products) || !products.length || !scope || !scope.querySelectorAll) return products;

    var cards = scope.querySelectorAll(CARD_SELECTOR);
    if (!cards.length) return products;

    var byId = {};
    var byTitle = {};
    for (var i = 0; i < cards.length; i++) {
      var info = readCardTags(cards[i]);
      if (!info.tags.length) continue;
      var id = readCardItemId(cards[i]);
      if (id && !byId[id]) byId[id] = info;
      var title = collapse(text(cards[i].querySelector('.poly-component__title'))).toLowerCase();
      if (title) {
        // Título repetido na página é ambíguo — anula em vez de casar errado.
        byTitle[title] = Object.prototype.hasOwnProperty.call(byTitle, title) ? null : info;
      }
    }

    for (var j = 0; j < products.length; j++) {
      var p = products[j];
      if (!p) continue;
      var hit = byId[normalizeId(p.mlItemId)] || byTitle[collapse(p.productName).toLowerCase()] || null;
      if (!hit) continue;
      p.tags = mergeTags(p.tags, hit.tags);
    }
    return products;
  }

  return {
    CARD_SELECTOR: CARD_SELECTOR,
    isHubUrl: isHubUrl,
    isSameHubPage: isSameHubPage,
    readCardItemId: readCardItemId,
    readItemIdFromHref: readItemIdFromHref,
    readCardTags: readCardTags,
    readCardReviews: readCardReviews,
    readCard: readCard,
    extractProducts: extractProducts,
    mergeListings: mergeListings,
    fillFromListing: fillFromListing,
    enrichWithTags: enrichWithTags,
    parseSales: parseSales,
  };
});
