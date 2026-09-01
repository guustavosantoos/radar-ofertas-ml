/**
 * ml-pdp-scraper.js — extração da PÁGINA DE PRODUTO INDIVIDUAL (PDP) do Mercado
 * Livre: /p/MLB..., /up/MLBU... e produto.mercadolivre.com.br/MLB-...
 *
 * Bug de 2026-07 (PDP MLB32717965, "Conj de Panelas Ceramic Life"): entrando
 * DIRETO na URL do produto — em vez de clicar no card da listagem — a extensão
 * salvava o PREÇO CHEIO como preço atual, sem preço cheio, sem percentual, sem
 * vendas, sem avaliações e sem frete. Causas encontradas no HTML real da PDP:
 *
 *  1. PREÇO (DOM): o riscado (<s class="ui-pdp-price__original-value
 *     andes-money-amount--previous">) vem ANTES do preço atual no DOM, então
 *     `document.querySelector('.andes-money-amount__fraction')` devolvia o CHEIO.
 *     O mesmo seletor solto ainda alcança a PARCELA ("em 12x R$ 60,83", em
 *     .ui-pdp-price__subtitles) e o preço de OUTRO vendedor (segundo bloco
 *     .ui-pdp-price, dentro de "Outras opções de compra").
 *  2. PREÇO (estado): na PDP o componente usa price.value / price.original_value /
 *     discount_label.value — nomes DIFERENTES do polycard de listagem
 *     (current_price / previous_price / discount) —, então o leitor achava só o
 *     preço atual e devolvia cheio e desconto nulos.
 *  3. AVALIAÇÕES (estado): a nota vem em header.reviews.rating (número) e o total
 *     em header.reviews.amount — não em reviews.rating.average/total.
 *  4. FRETE: o seletor antigo pegava o PRIMEIRO .ui-pdp-color--GREEN da página,
 *     que com desconto é o rótulo "33% OFF" — frete grátis virava false.
 *  5. VENDAS: o subtítulo vem colado ("+10mil vendidos") e às vezes só no
 *     aria-label ("Novo. Mais de 50 mil vendidos").
 *  6. Selo MAIS VENDIDO e ranking ("8º em Jogo de Panelas") nunca eram lidos.
 *
 * ISOLAMENTO PROPOSITAL: este módulo é AUTO-CONTIDO (não importa nada) e serve
 * SÓ à PDP. O caminho de listagem/grid — ml-price-utils.js + extractListingProducts /
 * extractListingFromDOM / enrichListingFromDOM do ml-scraper.js — continua
 * intacto e não passa por aqui. As poucas primitivas monetárias duplicadas de
 * ml-price-utils.js são o preço dessa separação: mexer na PDP não pode arriscar
 * a listagem, que é o caminho de maior volume e já estabilizado.
 *
 * Padrão UMD, igual aos outros utils do projeto:
 *  - Content script (browser): registra `window.MlPdpScraper`.
 *  - Node/testes: `module.exports` (ver tests/mlPdpScraper.test.ts).
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.MlPdpScraper = api;
  }
})(function () {
  // Mesmas travas de plausibilidade de ml-price-utils.js e server/price-format.ts.
  var MAX_PLAUSIBLE_PRICE_RATIO = 100;

  // ==========================================================================
  // Primitivas monetárias (auto-contidas — ver ISOLAMENTO no cabeçalho)
  // ==========================================================================

  /** Valor monetário em REAIS: número, string pt-BR ("R$ 1.399,90") ou objeto. */
  function parseMoneyValue(v) {
    if (v == null) return null;
    if (typeof v === 'number') return (isFinite(v) && v > 0) ? v : null;
    if (typeof v === 'string') {
      var s = v.replace(/[^\d.,]/g, '');
      if (!s) return null;
      if (s.indexOf(',') !== -1) {
        s = s.replace(/\./g, '').replace(',', '.');
      } else {
        var parts = s.split('.');
        if (parts.length > 1) {
          var allThousands = true;
          for (var i = 1; i < parts.length; i++) {
            if (parts[i].length !== 3) { allThousands = false; break; }
          }
          s = allThousands ? parts.join('') : parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
        }
      }
      var n = parseFloat(s);
      return (isFinite(n) && n > 0) ? n : null;
    }
    if (typeof v === 'object') {
      if (v.value != null) return parseMoneyValue(v.value);
      if (v.amount != null) return parseMoneyValue(v.amount);
      if (v.text != null) return parseMoneyValue(v.text);
      return null;
    }
    return null;
  }

  /** Percentual de badge: 33, "33% OFF" ou objeto ({value}/{text}/{label}). */
  function readBadgePercent(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return isFinite(raw) ? raw : null;
    if (typeof raw === 'string') {
      var m = raw.match(/(\d+)\s*%/);
      if (m) return parseInt(m[1], 10);
      return /^\s*\d+\s*$/.test(raw) ? parseInt(raw, 10) : null;
    }
    if (typeof raw === 'object') {
      if (raw.value != null) return readBadgePercent(raw.value);
      if (raw.percentage != null) return readBadgePercent(raw.percentage);
      if (raw.text != null) return readBadgePercent(raw.text);
      if (raw.label != null) return readBadgePercent(raw.label);
      return null;
    }
    return null;
  }

  /**
   * Lê um bloco .andes-money-amount para CENTAVOS. Fração ("729", ou "1.099" em
   * milhar) e centavos ("99") vivem em <span>s separados — ler só a fração
   * mandaria R$ 729,00 para um produto de R$ 729,99.
   */
  function readMoneyAmountCents(rootEl) {
    if (!rootEl || !rootEl.querySelector) return null;
    var fr = rootEl.querySelector('.andes-money-amount__fraction');
    var frText = fr ? (fr.textContent || '').replace(/\D/g, '') : '';
    if (!frText) return null;
    var reais = parseInt(frText, 10);
    if (!isFinite(reais) || reais <= 0) return null;
    var ce = rootEl.querySelector('.andes-money-amount__cents');
    var ceText = ce ? (ce.textContent || '').replace(/\D/g, '') : '';
    var cents = ceText ? parseInt(ceText.slice(0, 2), 10) : 0;
    return reais * 100 + cents;
  }

  /**
   * Percentual efetivo: badge plausível (1–99) > derivado do par > null.
   *
   * O badge só vale enquanto o par de preços não o contradiz. Havendo par, ele
   * manda: cheio ≤ atual, ou razão acima de MAX_PLAUSIBLE_PRICE_RATIO, é dado
   * corrompido — e um badge lido da tela não conserta preços de outra fonte
   * (é o caso do enrichFromPdp, que cruza o preço do JSON-LD com o badge do DOM).
   * Mesma regra do sanitizeIncomingDiscountPercent do servidor: preços mandam.
   * Sem preço cheio, o badge segue sendo a única fonte e continua valendo.
   */
  function computeDiscountPercent(priceCents, originalPriceCents, badgePercent) {
    var hasPair = priceCents > 0 && originalPriceCents > 0;
    var pairIsBroken = hasPair && (
      originalPriceCents <= priceCents
      || originalPriceCents > priceCents * MAX_PLAUSIBLE_PRICE_RATIO
    );
    if (badgePercent && badgePercent >= 1 && badgePercent <= 99 && !pairIsBroken) {
      return Math.round(badgePercent);
    }
    if (!priceCents || priceCents <= 0) return null;
    if (!originalPriceCents || originalPriceCents <= priceCents) return null;
    if (originalPriceCents > priceCents * MAX_PLAUSIBLE_PRICE_RATIO) return null;
    var pct = Math.round((1 - priceCents / originalPriceCents) * 100);
    return pct >= 1 ? pct : null;
  }

  // ==========================================================================
  // Reconhecimento da página
  // ==========================================================================

  /**
   * URL inequívoca de PDP. Deliberadamente NÃO casa o padrão solto /MLB\d+ (que
   * também aparece em /mais-vendidos/MLB436280 e outras LISTAGENS) — quem decide
   * por esse padrão genérico continua sendo o ml-scraper, depois dos testes de
   * listagem.
   */
  function isPdpUrl(url) {
    if (!url) return false;
    return /\/p\/MLB-?\d+/i.test(url)
      || /\/up\/MLBU?-?\d+/i.test(url)
      || /produto\.mercadoli(vre|bre)\./i.test(url);
  }

  /** Marcadores de DOM que só existem na PDP renderizada. */
  function hasPdpDom(doc) {
    if (!doc || !doc.querySelector) return false;
    return !!doc.querySelector('h1.ui-pdp-title, .ui-pdp-container__row--price, #price .ui-pdp-price');
  }

  /** MLB do produto, ancorado no PATH (o id do /p/ é o que o link canônico usa). */
  function extractItemIdFromUrl(url) {
    if (!url) return null;
    var m = String(url).match(/\/p\/(MLB-?\d+)/i)
      || String(url).match(/\/up\/(MLBU?-?\d+)/i)
      || String(url).match(/\/(MLB-?\d+)(?:[-/?#]|$)/i)
      || String(url).match(/(MLB-?\d+)/i);
    return m ? String(m[1]).toUpperCase().replace('-', '') : null;
  }

  // ==========================================================================
  // Preço
  // ==========================================================================

  /**
   * Bloco de preço PRINCIPAL. Ancorar em #price é obrigatório: "Outras opções de
   * compra" tem outro .ui-pdp-price, com o preço de outro vendedor.
   */
  function findPdpPriceRoot(doc) {
    if (!doc || !doc.querySelector) return null;
    return doc.querySelector('#price .ui-pdp-price')
      || doc.querySelector('.ui-pdp-container__row--price .ui-pdp-price')
      || doc.querySelector('#price')
      || doc.querySelector('.ui-pdp-price');
  }

  /** Trio {atual, cheio, %} do DOM renderizado da PDP. */
  function extractPriceFromDom(doc) {
    var out = { priceCents: null, originalPriceCents: null, discountPercent: null };
    var priceRoot = findPdpPriceRoot(doc);
    if (!priceRoot) return out;

    // O atual mora na second-line; os dois :not cobrem layouts em que o riscado
    // aparece no mesmo escopo, com qualquer uma das classes usadas pelo ML.
    var currentScope = priceRoot.querySelector('.ui-pdp-price__second-line') || priceRoot;
    var priceCents = readMoneyAmountCents(
      currentScope.querySelector(
        '.andes-money-amount:not(.andes-money-amount--previous):not(.ui-pdp-price__original-value)'
      )
    );
    if (priceCents == null) {
      // Último recurso: o microdado schema.org que a própria PDP publica
      // (<meta itemprop="price" content="729.99">).
      var metaEl = currentScope.querySelector('meta[itemprop="price"]');
      var metaValue = metaEl && metaEl.getAttribute ? parseMoneyValue(metaEl.getAttribute('content')) : null;
      if (metaValue) priceCents = Math.round(metaValue * 100);
    }

    var originalPriceCents = readMoneyAmountCents(
      priceRoot.querySelector('.ui-pdp-price__original-value, .andes-money-amount--previous')
    );

    var discountEl = priceRoot.querySelector('.andes-money-amount__discount, .ui-pdp-price__second-line__label');
    var badgePercent = discountEl ? readBadgePercent(discountEl.textContent) : null;

    out.priceCents = priceCents || null;
    out.originalPriceCents = originalPriceCents || null;
    out.discountPercent = computeDiscountPercent(out.priceCents, out.originalPriceCents, badgePercent);
    return out;
  }

  /**
   * Mesmo trio, lido de initialState.components.price. Aceita também os nomes do
   * polycard para não depender de qual variante o ML servir.
   */
  function readStatePrice(priceComponent) {
    var out = { priceCents: null, originalPriceCents: null, discountPercent: null };
    if (!priceComponent || typeof priceComponent !== 'object') return out;
    var p = priceComponent.price || priceComponent;

    var current = parseMoneyValue(
      p.value != null ? p.value : (p.current_price != null ? p.current_price : p.amount)
    );
    var original = parseMoneyValue(
      p.original_value != null ? p.original_value
        : (p.original_price != null ? p.original_price
          : (p.previous_price != null ? p.previous_price
            : (priceComponent.original_value != null ? priceComponent.original_value : priceComponent.original_price)))
    );
    var badge = readBadgePercent(
      priceComponent.discount_label != null ? priceComponent.discount_label
        : (p.discount_label != null ? p.discount_label
          : (priceComponent.discount != null ? priceComponent.discount : p.discount))
    );

    out.priceCents = current ? Math.round(current * 100) : null;
    out.originalPriceCents = original ? Math.round(original * 100) : null;
    out.discountPercent = computeDiscountPercent(out.priceCents, out.originalPriceCents, badge);
    return out;
  }

  /**
   * Decide o trio final entre DOM e estado. O DOM RENDERIZADO manda: é o que o
   * usuário está vendo e continua certo depois de trocar a variação (cor/tamanho),
   * quando o estado inline fica velho. O estado só completa o que faltou — e
   * apenas se falar do MESMO preço atual, senão misturar os dois fabricaria um
   * "De/Por" de variações diferentes.
   */
  function resolvePrices(domPrice, statePrice) {
    var chosen;
    if (domPrice.priceCents != null) {
      chosen = {
        priceCents: domPrice.priceCents,
        originalPriceCents: domPrice.originalPriceCents,
        discountPercent: domPrice.discountPercent,
      };
      if (statePrice.priceCents === domPrice.priceCents) {
        if (chosen.originalPriceCents == null) chosen.originalPriceCents = statePrice.originalPriceCents;
        if (chosen.discountPercent == null) chosen.discountPercent = statePrice.discountPercent;
      }
    } else {
      chosen = {
        priceCents: statePrice.priceCents,
        originalPriceCents: statePrice.originalPriceCents,
        discountPercent: statePrice.discountPercent,
      };
    }
    chosen.discountPercent = computeDiscountPercent(
      chosen.priceCents, chosen.originalPriceCents, chosen.discountPercent
    );
    return chosen;
  }

  // ==========================================================================
  // Vendas, avaliações, frete, selos
  // ==========================================================================

  /**
   * Quantidade vendida do subtítulo ("Novo  |  +10mil vendidos"). O ML alterna
   * entre "+10mil" (colado), "+50 mil", "Mais de 50 mil" e "1.000", e o separador
   * troca de papel: COM sufixo (mil/mi/k) o ponto/vírgula é decimal ("1,2 mil" =
   * 1200); SEM sufixo é separador de milhar ("1.000" = 1000).
   */
  function parseSoldQuantity(text) {
    if (text == null) return null;
    var t = String(text).toLowerCase().replace(/ /g, ' ');
    var m = t.match(/(\d[\d.,]*)\s*(mil|mi|k|m)?\s*vendid/);
    if (!m) return null;
    var suffix = m[2] || '';
    var mult = (suffix === 'mil' || suffix === 'k') ? 1000
      : ((suffix === 'mi' || suffix === 'm') ? 1000000 : 1);
    var num = suffix
      ? parseFloat(m[1].replace(/\./g, '').replace(',', '.'))
      : parseInt(m[1].replace(/[.,]/g, ''), 10);
    if (!isFinite(num) || num <= 0) return null;
    return Math.floor(num * mult);
  }

  /** Total de avaliações: "(24401)", "(24.401)", "4.750 opiniões". */
  function parseReviewsCount(text) {
    if (text == null) return null;
    var m = String(text).match(/\d[\d.,]*/);
    if (!m) return null;
    var n = parseInt(m[0].replace(/[.,]/g, ''), 10);
    return (isFinite(n) && n > 0) ? n : null;
  }

  /**
   * Nota: "4.8", "4,8", "Avaliação 4.8 de 5. 4.750 opiniões.". Varre os números
   * do texto e devolve o primeiro plausível como nota (0 < n <= 5), pulando o que
   * for separador de MILHAR ("4.750 opiniões" é total, não nota 4,75) e o que
   * estourar a escala ("48" não é 4,8).
   */
  function parseRatingValue(text) {
    if (text == null) return null;
    var re = /(\d+)(?:[.,](\d+))?/g;
    var s = String(text);
    var m;
    while ((m = re.exec(s)) !== null) {
      if (m[2] && m[2].length === 3) continue;
      var v = parseFloat(m[1] + (m[2] ? '.' + m[2] : ''));
      if (isFinite(v) && v > 0 && v <= 5) return v;
    }
    return null;
  }

  /** Texto do subtítulo da PDP, do innerText OU do aria-label. */
  function readSubtitleTexts(doc) {
    var out = [];
    if (!doc || !doc.querySelectorAll) return out;
    var els = doc.querySelectorAll('.ui-pdp-subtitle, .ui-pdp-header__subtitle');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el) continue;
      if (el.textContent) out.push(el.textContent);
      var aria = el.getAttribute ? el.getAttribute('aria-label') : null;
      if (aria) out.push(aria);
    }
    return out;
  }

  function extractSalesFromDom(doc) {
    var texts = readSubtitleTexts(doc);
    for (var i = 0; i < texts.length; i++) {
      var qty = parseSoldQuantity(texts[i]);
      if (qty) return qty;
    }
    return null;
  }

  function parseConditionText(text) {
    var t = String(text || '').toLowerCase();
    if (t.indexOf('recondicionado') !== -1) return 'refurbished';
    if (t.indexOf('usado') !== -1) return 'used';
    if (t.indexOf('novo') !== -1) return 'new';
    return null;
  }

  function extractConditionFromDom(doc) {
    var texts = readSubtitleTexts(doc);
    for (var i = 0; i < texts.length; i++) {
      var condition = parseConditionText(texts[i]);
      if (condition) return condition;
    }
    return null;
  }

  /**
   * Nota e total de avaliações do DOM: .ui-pdp-review__rating ("4.8") e
   * .ui-pdp-review__amount ("(4750)"). O texto acessível
   * ("Avaliação 4.8 de 5. 4.750 opiniões.") cobre o que faltar.
   */
  function extractReviewsFromDom(doc) {
    var out = { rating: null, count: null };
    if (!doc || !doc.querySelector) return out;

    var ratingEl = doc.querySelector('.ui-pdp-review__rating, .ui-review-capability__rating__average');
    if (ratingEl) out.rating = parseRatingValue(ratingEl.textContent);

    var countEl = doc.querySelector('.ui-pdp-review__amount, .ui-review-capability__rating__label');
    if (countEl) out.count = parseReviewsCount(countEl.textContent);

    if (out.rating == null || out.count == null) {
      var hidden = doc.querySelector('.ui-pdp-review__label .andes-visually-hidden, .ui-pdp-header__info .andes-visually-hidden');
      var txt = hidden ? (hidden.textContent || '') : '';
      if (txt) {
        if (out.rating == null) out.rating = parseRatingValue(txt);
        if (out.count == null) {
          var m = txt.match(/([\d.,]+)\s*(?:opini|avalia|coment)/i);
          if (m) out.count = parseReviewsCount(m[1]);
        }
      }
    }
    return out;
  }

  /**
   * Frete grátis CONDICIONAL — campanha da loja ("Frete grátis em compras acima de
   * R$ 19", "a partir de R$ 79", benefício Meli+). Anuncia a promoção da loja, não
   * o frete DESTA oferta: se o produto está abaixo do limiar, quem compra paga.
   */
  var CONDITIONAL_SHIPPING_RE = /(a partir de|acima de|em compras|para pedidos|primeira compra|produtos selecionados|meli\+|meli mais|assine)/i;

  /**
   * "Frete grátis" de verdade — não "Devolução grátis", não o rótulo verde de
   * desconto e não a campanha condicional da loja. Na dúvida devolve false: um
   * falso NEGATIVO só omite um selo; um falso POSITIVO publica ao consumidor uma
   * vantagem que não existe.
   */
  function isFreeShippingText(text) {
    if (!text) return false;
    var t = String(text).toLowerCase();
    if (t.indexOf('grátis') === -1 && t.indexOf('gratis') === -1 && t.indexOf('gratuito') === -1) return false;
    if (!/(frete|envio|entrega|chega)/.test(t)) return false;
    return !CONDITIONAL_SHIPPING_RE.test(t);
  }

  /**
   * Blocos que falam do frete da OFERTA PRINCIPAL. Tudo que está fora deles —
   * "Outras opções de compra" (outro vendedor), "Compre junto", banner de campanha
   * — fala do frete de outra coisa e não pode decidir o campo deste produto.
   */
  var SHIPPING_SCOPE_SELECTORS = ['#shipping_summary', '.ui-pdp-shipping', '#buybox-form', '.ui-pdp-buybox'];
  // As classes do ML mudam com frequência, então além dos títulos conhecidos
  // varremos os parágrafos/itens do bloco. Cada texto é avaliado SEPARADAMENTE:
  // concatenar o bloco inteiro num só texto funde "Chegará ... por R$ 24,90" com
  // "Devolução grátis" — que é o layout padrão da PDP — e o par "grátis" +
  // "chega" no mesmo blob ressuscita o falso positivo de frete grátis.
  var SHIPPING_TEXT_SELECTORS = '.ui-pdp-media__title, .ui-pdp-summary-list__text, .ui-pdp-color--GREEN, p, li';

  function collectShippingTexts(root) {
    var out = [];
    if (!root || !root.querySelectorAll) return out;
    var els = root.querySelectorAll(SHIPPING_TEXT_SELECTORS);
    for (var i = 0; i < els.length; i++) {
      var t = els[i] && els[i].textContent;
      if (t) out.push(t);
    }
    return out;
  }

  /**
   * Frete grátis na PDP. O seletor antigo (primeiro .ui-pdp-color--GREEN) errava
   * dos dois lados: FALSO NEGATIVO porque, havendo desconto, o primeiro verde da
   * página é o rótulo "33% OFF"; e FALSO POSITIVO porque "Devolução grátis" também
   * é verde.
   *
   * Ancorar só no positivo não bastava: quando o bloco do vendedor principal diz
   * "Chegará ... por R$ 24,90", o "não" era descartado e a varredura do documento
   * inteiro fazia o "Frete grátis" de OUTRO vendedor vencer. Por isso, havendo
   * bloco da oferta principal, ele decide sozinho — inclusive quando a resposta é
   * não. A varredura solta só sobrevive como último recurso, para o layout
   * resumido que não renderiza nenhum desses blocos.
   */
  function readFreeShippingFromDom(doc) {
    if (!doc || !doc.querySelector) return null;

    var scopedTexts = [];
    var foundScopedRoot = false;
    for (var i = 0; i < SHIPPING_SCOPE_SELECTORS.length; i++) {
      var root = doc.querySelector(SHIPPING_SCOPE_SELECTORS[i]);
      if (root) {
        foundScopedRoot = true;
        scopedTexts = scopedTexts.concat(collectShippingTexts(root));
      }
    }

    var texts = foundScopedRoot ? scopedTexts : collectShippingTexts(doc);
    var foundShippingSignal = false;
    for (var j = 0; j < texts.length; j++) {
      if (/(frete|envio|entrega|chega)/i.test(String(texts[j]))) {
        foundShippingSignal = true;
      }
      if (isFreeShippingText(texts[j])) return true;
    }
    return foundShippingSignal ? false : null;
  }

  function hasFreeShippingFromDom(doc) {
    return readFreeShippingFromDom(doc) === true;
  }

  /**
   * Selo "MAIS VENDIDO" e posição no ranking ("8º em Jogo de Panelas"): a PDP
   * renderiza DOIS pills irmãos em .ui-pdp-promotions-pill — o primeiro (fundo
   * laranja) é o selo; o segundo (classe best_seller_position) é o rank. O texto
   * fica no <a class="ui-pdp-promotions-pill-label__target">.
   */
  function extractBestSellerFromDom(doc) {
    var out = { isBestSeller: false, bestSellerRank: null };
    if (!doc || !doc.querySelectorAll) return out;
    var pills = doc.querySelectorAll('.ui-pdp-promotions-pill-label');
    for (var i = 0; i < pills.length; i++) {
      var text = String((pills[i] && pills[i].textContent) || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (/mais\s*vendido/i.test(text)) {
        out.isBestSeller = true;
      } else if (!out.bestSellerRank && /^\d+\s*[ºo°]\s+em\s+/i.test(text)) {
        out.bestSellerRank = text;
      }
    }
    return out;
  }

  // ==========================================================================
  // Demais campos do DOM
  // ==========================================================================

  function textOf(doc, selector) {
    if (!doc || !doc.querySelector) return null;
    var el = doc.querySelector(selector);
    var t = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return t || null;
  }

  function extractTitleFromDom(doc) {
    return textOf(doc, 'h1.ui-pdp-title') || textOf(doc, '.ui-pdp-title') || textOf(doc, 'h1');
  }

  /** Texto que é RÓTULO do box do vendedor, não o nome de ninguém. */
  var SELLER_LABEL_ONLY_RE = /^(vendido por|informaç(ão|ões) sobre o vendedor|informac(ao|oes) sobre o vendedor|outros vendedores|ver mais dados desta loja|loja oficial)$/i;

  /**
   * O heading do box ("Informações sobre o vendedor", "Vendido por") entrava como
   * nome quando o link do vendedor mudava de classe — e, por ter prioridade sobre
   * o estado em extractProduct, apagava o nickname correto. Devolve null no lugar
   * do rótulo para o estado poder assumir.
   */
  function cleanSellerName(raw) {
    if (!raw) return null;
    var t = String(raw).replace(/\s+/g, ' ').trim();
    t = t.replace(/^vendido por\s+/i, '').replace(/^loja oficial de\s+/i, '').trim();
    if (!t || SELLER_LABEL_ONLY_RE.test(t)) return null;
    return t;
  }

  function extractSellerFromDom(doc) {
    // [class*=] porque o ML alterna entre ui-pdp-seller__link-trigger e
    // ui-pdp-seller__link-trigger-button — e seletor de classe só casa token exato.
    return cleanSellerName(textOf(doc, '[class*="ui-pdp-seller__link-trigger"]'))
      || cleanSellerName(textOf(doc, '.ui-pdp-seller__header__title'))
      || cleanSellerName(textOf(doc, '.ui-box-component__seller-link .ui-pdp-color--BLUE'));
  }

  function extractImageFromDom(doc) {
    if (!doc || !doc.querySelector) return null;
    var selectors = [
      '.ui-pdp-gallery__figure img', 'figure.ui-pdp-gallery__figure img',
      'img[data-zoom]', '.ui-pdp-image', '.ui-pdp-gallery img',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var img = doc.querySelector(selectors[i]);
      if (!img || !img.getAttribute) continue;
      var url = img.getAttribute('data-zoom') || img.getAttribute('src') || img.src || null;
      if (url && url.indexOf('data:') === -1 && url.indexOf('.gif') === -1) {
        return url.replace(/-[A-Z]\.jpg/, '-O.jpg').replace(/-[A-Z]\.webp/, '-O.webp');
      }
    }
    return null;
  }

  function getCanonicalUrl(doc, fallbackUrl) {
    if (doc && doc.querySelector) {
      var canonical = doc.querySelector('link[rel="canonical"]');
      var href = canonical ? (canonical.href || (canonical.getAttribute ? canonical.getAttribute('href') : null)) : null;
      if (href) return href;
    }
    return fallbackUrl || null;
  }

  /**
   * Item id REAL que a URL carrega nos parâmetros de rastreio do clique:
   * `#...&wid=MLB<id>` e `?pdp_filters=item_id:MLB<id>`.
   *
   * Só interessa na PDP de produto de vendedor (/up/MLBU<id>), onde o id do path é
   * de OUTRO namespace (MLBU) e não identifica o item — o mesmo card do ML traz
   * `/up/MLBU777596893` e `wid=MLB4628788660` lado a lado, ids distintos do mesmo
   * produto. Por isso NUNCA se deriva o MLB tirando o "U" do MLBU.
   *
   * Recusa de propósito `pdp_filters=deal:MLB<id>`: aquilo é id de PROMOÇÃO, não do
   * item (ver o caso "deal=" em tests/mlPdpScraper.test.ts). O guard de 6+ dígitos
   * é o mesmo do extractIdsFromHref (ml-price-utils.js) e evita casar slug com a
   * marca MLB, como "bone-mlb-9forty".
   */
  function extractItemIdFromTracking(url) {
    if (!url) return null;
    var s = String(url);
    var cut = s.search(/[?#]/);
    if (cut === -1) return null;
    var extras = s.slice(cut);
    try { extras = decodeURIComponent(extras); } catch (e) { /* mantém cru */ }
    var m = extras.match(/[?#&](?:wid|item_id)=(MLB\d{6,})/i)
      || extras.match(/item_id[:=](MLB\d{6,})/i);
    return m ? m[1].toUpperCase() : null;
  }

  /**
   * Link do produto para a PDP. Regra geral: o <link rel="canonical">.
   *
   * EXCEÇÃO da PDP de produto de vendedor (/up/MLBU<id>): o canonical é a própria
   * /up/, e o gerador de link de afiliado não trabalha com o namespace MLBU — era
   * por isso que "abrir o produto sozinho" não gerava link, enquanto escolher o
   * mesmo produto pelo grid funcionava (lá o ml-scraper já reescreve /up/ usando o
   * MLB do estado da listagem). Quando a URL da aba ainda carrega o MLB real do
   * item — o caso de quem chegou clicando no card —, montamos a PDP canônica desse
   * item, na forma `-_JM` que a API de afiliados aceita.
   *
   * Sem esse dado (visita direta por URL colada), devolvemos a própria /up/: quem
   * gera o link decide, e nada é inventado.
   */
  function resolveProductLink(doc, pageUrl) {
    var canonical = getCanonicalUrl(doc, pageUrl);
    if (!canonical || !/\/up\/MLBU?-?\d+/i.test(canonical)) return canonical;

    var itemId = extractItemIdFromTracking(pageUrl) || extractItemIdFromTracking(canonical);
    if (!itemId) return canonical;

    return 'https://produto.mercadolivre.com.br/MLB-' + itemId.replace(/^MLB/i, '') + '-_JM';
  }

  // ==========================================================================
  // Estado (__PRELOADED_STATE__ da PDP)
  // ==========================================================================

  function readStateComponents(state) {
    if (!state || typeof state !== 'object') return {};
    var initialState = state.initialState || state;
    return (initialState && initialState.components) || {};
  }

  /** Nota/total do estado: header.reviews.rating + header.reviews.amount. */
  function readStateReviews(components) {
    var out = { rating: null, count: null };
    var header = components.header || {};
    var r = header.reviews || components.reviews || {};
    if (!r || typeof r !== 'object') return out;

    var nestedRating = r.rating && typeof r.rating === 'object' ? r.rating : null;
    var rawRating = nestedRating
      ? (nestedRating.average != null ? nestedRating.average : nestedRating.value)
      : (r.rating != null ? r.rating
      : (r.rating_average_formatted != null ? r.rating_average_formatted
        : (r.rating_average != null ? r.rating_average
          : (r.average != null ? r.average : null))));
    out.rating = parseRatingValue(rawRating);

    var rawCount = r.amount != null ? r.amount
      : (r.total != null ? r.total
        : (nestedRating && nestedRating.total != null ? nestedRating.total
          : (r.formatted_total && r.formatted_total.text != null ? r.formatted_total.text : r.subtitle)));
    out.count = parseReviewsCount(rawCount);
    return out;
  }

  function readStateFreeShipping(components) {
    var summary = components.shipping_summary || {};
    var title = summary.title;
    var text = title && typeof title === 'object' ? title.text : title;
    if (isFreeShippingText(text)) return true;
    var shipping = components.shipping || {};
    if (shipping.free_shipping === true) return true;
    if (isFreeShippingText(shipping.text || shipping.label)) return true;
    return false;
  }

  function readStateBestSeller(components) {
    var out = { isBestSeller: false, bestSellerRank: null };
    var h = components.highlights || components.promotions || {};
    var tagText = h.tag_action && h.tag_action.label ? h.tag_action.label.text : null;
    if (tagText && /mais\s*vendido/i.test(String(tagText))) out.isBestSeller = true;
    var rankText = h.description_action && h.description_action.label ? h.description_action.label.text : null;
    if (rankText && /^\d+\s*[ºo°]\s+em\s+/i.test(String(rankText).trim())) {
      out.bestSellerRank = String(rankText).replace(/\s+/g, ' ').trim();
    }
    return out;
  }

  function readStateSales(components) {
    var header = components.header || {};
    var fromSubtitle = parseSoldQuantity(header.subtitle);
    if (fromSubtitle) return fromSubtitle;
    var track = components.track || {};
    var item = track.melidata_event && track.melidata_event.item ? track.melidata_event.item : null;
    if (item && item.sold_quantity) {
      var n = parseInt(item.sold_quantity, 10);
      if (isFinite(n) && n > 0) return n;
    }
    return null;
  }

  function readStateSeller(components) {
    var out = { sellerName: null, sellerId: null, sellerReputation: null, isOfficialStore: false };
    var sellerComp = components.seller || components.seller_data || {};
    var seller = sellerComp.seller || sellerComp;
    if (!seller || typeof seller !== 'object') return out;
    out.sellerName = cleanSellerName(seller.nickname || seller.name
      || (sellerComp.seller_name || null)
      || (sellerComp.title && sellerComp.title.text ? sellerComp.title.text : null));
    var id = sellerComp.seller_id != null ? sellerComp.seller_id : seller.id;
    out.sellerId = id != null ? String(id) : null;
    out.sellerReputation = (seller.seller_reputation && seller.seller_reputation.level_id) || null;
    out.isOfficialStore = seller.is_official_store === true || sellerComp.is_official_store === true;
    return out;
  }

  function readStateImage(components) {
    var gallery = components.gallery || {};
    var pics = gallery.pictures || [];
    if (Array.isArray(pics) && pics.length > 0) {
      var url = pics[0].url || pics[0].secure_url || null;
      if (url) return String(url).replace(/-[A-Z]\.jpg/, '-O.jpg').replace(/-[A-Z]\.webp/, '-O.webp');
    }
    return null;
  }

  // ==========================================================================
  // Entrada pública
  // ==========================================================================

  /**
   * Produto completo da PDP. O DOM renderizado é a fonte primária (é o que o
   * usuário está vendo); o estado preenche o que o DOM não expõe. Devolve null
   * quando não há nem nome nem preço — quem chama decide o fallback.
   *
   * @param {Document} doc   document da PDP (injetável nos testes)
   * @param {object=} state  __PRELOADED_STATE__ já parseado, se houver
   * @param {string=} pageUrl URL da página (default: window.location.href)
   */
  function extractProduct(doc, state, pageUrl) {
    if (!doc && typeof document !== 'undefined') doc = document;
    var url = pageUrl
      || (typeof window !== 'undefined' && window.location ? window.location.href : null);

    var components = readStateComponents(state);
    var header = components.header || {};

    var prices = resolvePrices(extractPriceFromDom(doc), readStatePrice(components.price));

    var productName = extractTitleFromDom(doc) || header.title || null;
    if (!productName && prices.priceCents == null) return null;

    var domReviews = extractReviewsFromDom(doc);
    var stateReviews = readStateReviews(components);
    var rating = domReviews.rating != null ? domReviews.rating : stateReviews.rating;
    var reviewsCount = domReviews.count != null ? domReviews.count : stateReviews.count;

    var domBest = extractBestSellerFromDom(doc);
    var stateBest = readStateBestSeller(components);
    var stateSeller = readStateSeller(components);

    var salesQuantity = extractSalesFromDom(doc);
    if (!salesQuantity) salesQuantity = readStateSales(components);
    var condition = extractConditionFromDom(doc) || parseConditionText(header.subtitle);
    var domFreeShipping = readFreeShippingFromDom(doc);

    // Link e id saem da MESMA resolução: numa PDP /up/ alcançada por clique, ambos
    // passam a apontar para o MLB real do item — o mesmo id que o grid grava para
    // esse produto, o que evita a linha duplicada no upsert por (userId, mlItemId).
    var productLink = resolveProductLink(doc, url);

    return {
      mlItemId: extractItemIdFromUrl(productLink) || extractItemIdFromUrl(url),
      productName: productName,
      price: prices.priceCents,
      originalPrice: prices.originalPriceCents,
      discountPercent: prices.discountPercent,
      condition: condition,
      sellerName: extractSellerFromDom(doc) || stateSeller.sellerName,
      sellerId: stateSeller.sellerId,
      sellerReputation: stateSeller.sellerReputation,
      ratingStar: rating != null ? Math.round(rating * 100) : null,
      reviewsCount: reviewsCount || 0,
      freeShipping: domFreeShipping != null ? domFreeShipping : readStateFreeShipping(components),
      imageUrl: extractImageFromDom(doc) || readStateImage(components),
      productLink: productLink,
      categoryId: null,
      categoryName: null,
      categoryBreadcrumb: null,
      salesQuantity: salesQuantity || 0,
      offerType: null,
      offerEndTime: null,
      isOfficialStore: stateSeller.isOfficialStore,
      isBestSeller: domBest.isBestSeller || stateBest.isBestSeller,
      bestSellerRank: domBest.bestSellerRank || stateBest.bestSellerRank,
    };
  }

  /**
   * Completa um produto já extraído por outro caminho (ex.: JSON-LD, que traz só
   * o preço COM desconto) com o que a PDP mostra na tela. Só preenche buraco —
   * nunca sobrescreve valor já presente.
   */
  function enrichFromPdp(product, doc, state, pageUrl) {
    if (!product) return product;
    var pdp = extractProduct(doc, state, pageUrl);
    if (!pdp) return product;

    var fillable = [
      'originalPrice', 'discountPercent', 'condition', 'sellerName', 'sellerId',
      'sellerReputation', 'ratingStar', 'imageUrl', 'isBestSeller', 'bestSellerRank',
    ];
    for (var i = 0; i < fillable.length; i++) {
      var k = fillable[i];
      if ((product[k] == null || product[k] === false) && pdp[k] != null && pdp[k] !== false) {
        product[k] = pdp[k];
      }
    }
    if (!product.price && pdp.price) product.price = pdp.price;
    if (!product.reviewsCount && pdp.reviewsCount) product.reviewsCount = pdp.reviewsCount;
    if (!product.salesQuantity && pdp.salesQuantity) product.salesQuantity = pdp.salesQuantity;
    if (!product.freeShipping && pdp.freeShipping) product.freeShipping = true;

    // Preço cheio veio do DOM depois do preço atual do JSON-LD: o percentual tem
    // de ser recalculado com as travas, não herdado.
    product.discountPercent = computeDiscountPercent(
      product.price, product.originalPrice, product.discountPercent
    );
    return product;
  }

  return {
    // reconhecimento
    isPdpUrl: isPdpUrl,
    hasPdpDom: hasPdpDom,
    extractItemIdFromUrl: extractItemIdFromUrl,
    extractItemIdFromTracking: extractItemIdFromTracking,
    resolveProductLink: resolveProductLink,
    // preço
    findPdpPriceRoot: findPdpPriceRoot,
    extractPriceFromDom: extractPriceFromDom,
    readStatePrice: readStatePrice,
    resolvePrices: resolvePrices,
    computeDiscountPercent: computeDiscountPercent,
    // demais campos
    parseSoldQuantity: parseSoldQuantity,
    parseReviewsCount: parseReviewsCount,
    parseRatingValue: parseRatingValue,
    extractSalesFromDom: extractSalesFromDom,
    extractReviewsFromDom: extractReviewsFromDom,
    extractConditionFromDom: extractConditionFromDom,
    extractBestSellerFromDom: extractBestSellerFromDom,
    hasFreeShippingFromDom: hasFreeShippingFromDom,
    isFreeShippingText: isFreeShippingText,
    extractTitleFromDom: extractTitleFromDom,
    extractImageFromDom: extractImageFromDom,
    extractSellerFromDom: extractSellerFromDom,
    // entrada
    extractProduct: extractProduct,
    enrichFromPdp: enrichFromPdp,
    // primitivas (expostas para teste)
    parseMoneyValue: parseMoneyValue,
    readBadgePercent: readBadgePercent,
    readMoneyAmountCents: readMoneyAmountCents,
  };
});
