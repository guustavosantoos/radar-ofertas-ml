/**
 * ml-price-utils.js — decisão do percentual de desconto nos cards de listagem do ML.
 *
 * Extraído do ml-scraper.js para ser TESTÁVEL fora do browser. Padrão UMD:
 *  - Content script (browser): registra `window.MlPriceUtils`.
 *  - Node/testes: `module.exports` (ver tests/mlScraperPrice.test.ts).
 *
 * Regra de negócio (bug de 2026-07, MLB1010954920 "Kit 6 Cuecas Lupo"):
 *  - O card do ML nem sempre renderiza o badge de desconto, mesmo com o preço
 *    cheio riscado presente. Sem fallback, o produto era salvo com originalPrice
 *    preenchido e discountPercent null — sumia dos filtros de desconto mínimo e
 *    era anunciado sem "De/Por".
 *  - O badge, quando existe e é plausível (1–99%), prevalece — é o arredondamento
 *    oficial do ML. Sem badge, deriva do par de preços.
 *  - Travas de plausibilidade espelham server/price-format.ts: preço cheio deve
 *    ser MAIOR que o atual e no máximo 100× (o erro de escala 1000× já produziu
 *    51 linhas de "-100% OFF" fantasma na Amazon); percentual derivado < 1% não
 *    é oferta. O servidor re-sanitiza na ingestão, mas barrar aqui evita que a
 *    extensão fabrique percentual a partir de um DOM corrompido.
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.MlPriceUtils = api;
  }
})(function () {
  var MAX_PLAUSIBLE_PRICE_RATIO = 100;

  /**
   * Lê um bloco andes-money-amount para CENTAVOS: a fração ("52", ou "1.399" em
   * milhar) e os centavos ("19") vivem em <span>s SEPARADOS — ler só a fração
   * enviava R$ 52,00 para um produto de R$ 52,19.
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
   * Extrai o trio de preço de um card de listagem do ML (layout polycard 2026):
   *  - preço atual:   .poly-price__current (fração + centavos; o parcelamento
   *    "2x R$ 26,10" fica FORA desse container e não pode contaminar a leitura)
   *  - preço cheio:   <s class="andes-money-amount--previous"> em .poly-price__labels
   *  - badge:         .poly-price__discount-polylabel ("67% OFF" no polylabel-pill) —
   *    classe NOVA do ML; os seletores antigos (.andes-money-amount__discount,
   *    .poly-price__disc_label) não a alcançavam e o percentual vinha null em
   *    praticamente todos os cards. Mantidos como fallback de layouts anteriores,
   *    junto com o legado price-tag-fraction/price-tag-cents.
   * O percentual final passa por computeListingDiscountPercent (badge plausível >
   * derivado > null).
   */
  function extractCardPriceData(card) {
    if (!card || !card.querySelector) {
      return { priceCents: null, originalPriceCents: null, discountPercent: null };
    }

    var priceCents = readMoneyAmountCents(card.querySelector('.poly-price__current'));
    if (priceCents == null) {
      var legacyFr = card.querySelector('.price-tag-fraction');
      var legacyFrText = legacyFr ? (legacyFr.textContent || '').replace(/\D/g, '') : '';
      if (legacyFrText) {
        var legacyCe = card.querySelector('.price-tag-cents');
        var legacyCeText = legacyCe ? (legacyCe.textContent || '').replace(/\D/g, '') : '';
        priceCents = parseInt(legacyFrText, 10) * 100 + (legacyCeText ? parseInt(legacyCeText.slice(0, 2), 10) : 0);
      }
    }

    var originalPriceCents = readMoneyAmountCents(card.querySelector('.andes-money-amount--previous'));

    var discountEl = card.querySelector('.poly-price__discount-polylabel, .andes-money-amount__discount, .poly-price__disc_label');
    var discountMatch = discountEl ? (discountEl.textContent || '').match(/(\d+)\s*%/) : null;
    var badgePercent = discountMatch ? parseInt(discountMatch[1], 10) : null;

    return {
      priceCents: priceCents || null,
      originalPriceCents: originalPriceCents || null,
      discountPercent: computeListingDiscountPercent(priceCents, originalPriceCents, badgePercent),
    };
  }

  /**
   * Percentual efetivo do card: badge plausível > derivado dos preços > null.
   * Preços em centavos (a razão é adimensional, mas os chamadores usam centavos).
   */
  function computeListingDiscountPercent(priceCents, originalPriceCents, badgePercent) {
    if (badgePercent && badgePercent >= 1 && badgePercent <= 99) {
      return Math.round(badgePercent);
    }
    if (!priceCents || priceCents <= 0) return null;
    if (!originalPriceCents || originalPriceCents <= priceCents) return null;
    if (originalPriceCents > priceCents * MAX_PLAUSIBLE_PRICE_RATIO) return null;

    var pct = Math.round((1 - priceCents / originalPriceCents) * 100);
    return pct >= 1 ? pct : null;
  }

  /**
   * Valor monetário do estado JSON do ML em REAIS, tolerante a todas as
   * codificações observadas: número puro (52.19), string pt-BR ("R$ 1.399,90"),
   * string com ponto decimal ("52.19") e objeto ({value}/{amount}/{text}).
   * O bug de jul/2026: previous_price veio como NÚMERO e o leitor antigo fazia
   * `previous_price.value || previous_price.amount` → undefined → null — o
   * preço cheio sumia de TODOS os cards mesmo visível na página.
   */
  function parseMoneyValue(v) {
    if (v == null) return null;
    if (typeof v === 'number') return (isFinite(v) && v > 0) ? v : null;
    if (typeof v === 'string') {
      var s = v.replace(/[^\d.,]/g, '');
      if (!s) return null;
      if (s.indexOf(',') !== -1) {
        // pt-BR: ponto = milhar, vírgula = decimal
        s = s.replace(/\./g, '').replace(',', '.');
      } else {
        // Só pontos: grupos de 3 dígitos são milhar ("1.399"); senão o último é decimal ("52.19").
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

  /** Percentual de badge vindo do estado: número, "67% OFF" ou objeto aninhado. */
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
   * Lê o componente `price` de um polycard do __PRELOADED_STATE__ para o trio
   * {priceCents, originalPriceCents, discountPercent}, cobrindo os nomes de
   * campo conhecidos (current_price/previous_price/original_price e
   * discount/discount_label/discount_rate) em qualquer codificação. O
   * percentual final passa por computeListingDiscountPercent.
   */
  function readPolycardPrice(priceComp) {
    var out = { priceCents: null, originalPriceCents: null, discountPercent: null };
    if (!priceComp || typeof priceComp !== 'object') return out;
    var p = priceComp.price || priceComp;

    var current = parseMoneyValue(p.current_price != null ? p.current_price : (p.value != null ? p.value : p.amount));
    var original = parseMoneyValue(p.previous_price != null ? p.previous_price : p.original_price);
    var badge = readBadgePercent(
      p.discount != null ? p.discount
        : (p.discount_label != null ? p.discount_label
          : (p.discount_rate != null ? p.discount_rate : priceComp.discount_label)));

    out.priceCents = current ? Math.round(current * 100) : null;
    out.originalPriceCents = original ? Math.round(original * 100) : null;
    out.discountPercent = computeListingDiscountPercent(out.priceCents, out.originalPriceCents, badge);
    return out;
  }

  /**
   * TODOS os ids de item presentes num href de card do ML (MLB/MLBU, com ou sem
   * hífen), na ordem em que aparecem. Um mesmo card expõe ids DIFERENTES conforme
   * o tipo: o link orgânico de catálogo usa /p/<id de FAMÍLIA> e carrega o id do
   * ITEM só em wid=<id>; anúncios usam link de tracking com o id em
   * pdp_filters=item_id:<id>; user products usam /up/MLBU<id> + wid. Casar pelo
   * PRIMEIRO id apenas fazia o enriquecimento via DOM falhar exatamente nos cards
   * orgânicos de catálogo (id de família ≠ id do item que o estado usa) — o padrão
   * de intermitência observado em 15/jul: anúncios e /up/ com De/Por, /p/ sem.
   */
  function extractIdsFromHref(href) {
    if (!href) return [];
    var out = [];
    var seen = {};
    var re = /MLBU?-?(\d{6,})/gi;
    var m;
    while ((m = re.exec(href)) !== null) {
      var id = m[0].toUpperCase().replace('-', '');
      if (!seen[id]) { seen[id] = true; out.push(id); }
    }
    return out;
  }

  /** Título normalizado para casamento fallback (minúsculas, espaços colapsados). */
  function normalizeTitle(text) {
    return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  return {
    computeListingDiscountPercent: computeListingDiscountPercent,
    readMoneyAmountCents: readMoneyAmountCents,
    extractCardPriceData: extractCardPriceData,
    parseMoneyValue: parseMoneyValue,
    readBadgePercent: readBadgePercent,
    readPolycardPrice: readPolycardPrice,
    extractIdsFromHref: extractIdsFromHref,
    normalizeTitle: normalizeTitle,
  };
});
