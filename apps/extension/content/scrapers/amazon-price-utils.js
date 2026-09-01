/**
 * amazon-price-utils.js — seleção de preços da Amazon (PDP e cards de listing).
 *
 * Extraído do amazon-scraper.js para ser TESTÁVEL fora do browser. Padrão UMD:
 *  - Content script (browser): registra `window.AmazonPriceUtils`.
 *  - Node/testes: `module.exports` (ver tests/amazonScraperPrice.test.ts).
 *
 * Regra de negócio que este módulo garante (bug reportado em 2026-07):
 *  - O PREÇO ATUAL é o priceToPay — NUNCA o preço-por-unidade (ex.: "R$1.465,67 / l").
 *  - O PREÇO "De" (original) é o basisprice ("De: R$ 59,00" / preço riscado) —
 *    NUNCA o preço-por-unidade. Se NÃO há "De", originalPrice é null (sem desconto).
 *
 * Por que o bug existia: o preço-por-unidade da Amazon é renderizado num
 * `span.a-price a-text-price apex-priceperunit-value`. Como ele carrega as
 * classes `a-price` E `a-text-price`, os seletores genéricos antigos
 * (`span.a-price .a-offscreen` e `span.a-text-price .a-offscreen`) o capturavam
 * como preço atual / preço "De". O "De" real fica em
 * `.apex-basisprice-offscreen-label` / `[data-basisprice-label]` ou no preço
 * riscado `span.a-price[data-a-strike="true"]` — nenhum era consultado.
 */
(function (factory) {
  var api = factory();
  // Node / CommonJS (testes via require): exporta o objeto.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Browser / content script (MV3): registra no global SEMPRE — NÃO usar `else`.
  // Em content scripts de extensão o `module`/`exports` do CommonJS pode estar
  // presente no escopo; com `else`, o registro global nunca rodava e
  // window.AmazonPriceUtils ficava undefined (scraper caía no fallback legado).
  var g = (typeof window !== 'undefined') ? window
        : (typeof self !== 'undefined') ? self
        : (typeof globalThis !== 'undefined') ? globalThis : null;
  if (g) g.AmazonPriceUtils = api;
})(function () {
  'use strict';

  // Seletor que identifica o preço-por-unidade em qualquer variação conhecida.
  // Explícitos primeiro (case-sensitive): `.apex-priceperunit-value` (o valor)
  // e `.pricePerUnit` (o container "(R$ x / l)"). Os `[class*=...]` cobrem
  // variações futuras de nomenclatura da Amazon.
  var PER_UNIT_SELECTOR =
    '.apex-priceperunit-value, .pricePerUnit, ' +
    '[class*="priceperunit"], [class*="PricePerUnit"], [class*="pricePerUnit"], [class*="price-per-unit"]';

  // Preço riscado (list price). Serve tanto para identificar o "De" quanto para
  // NUNCA aceitá-lo como preço atual.
  var STRIKE_SELECTOR = 'span.a-price[data-a-strike="true"], [data-a-strike="true"]';

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

  function isPerUnitEl(el) {
    return !!(el && el.closest && el.closest(PER_UNIT_SELECTOR));
  }

  function isStrikeEl(el) {
    return !!(el && el.closest && el.closest(STRIKE_SELECTOR));
  }

  // Preço ATUAL (priceToPay). Ignora preço-por-unidade e preço riscado.
  // `root` pode ser o document (PDP) ou um card de listing.
  function pickCurrentPrice(root) {
    if (!root || !root.querySelectorAll) return null;
    // Seletores prioritários: o priceToPay explícito é inequívoco.
    var prioritized = [
      '.a-price.priceToPay .a-offscreen',
      '.apexPriceToPay .a-offscreen',
      '.reinventPricePriceToPayMargin .a-offscreen',
    ];
    for (var p = 0; p < prioritized.length; p++) {
      var pe = root.querySelector(prioritized[p]);
      if (pe && !isPerUnitEl(pe) && !isStrikeEl(pe)) {
        var pv = parsePrice(pe.textContent);
        if (pv) return pv;
      }
    }
    // Genérico: primeiro `span.a-price .a-offscreen` que não seja preço-por-unidade
    // nem preço riscado.
    var els = root.querySelectorAll('span.a-price .a-offscreen');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (isPerUnitEl(el) || isStrikeEl(el)) continue;
      var v = parsePrice(el.textContent);
      if (v) return v;
    }
    return null;
  }

  // Preço "De" (list price / basisprice). Ignora preço-por-unidade.
  // Retorna null quando NÃO há "De" — nesse caso não há desconto.
  function pickOriginalPrice(root) {
    if (!root || !root.querySelectorAll) return null;
    var candidates = [
      '.apex-basisprice-offscreen-label',                  // "De: R$ 59,00"
      '[data-basisprice-label]',                           // idem (atributo)
      'span.a-price[data-a-strike="true"] .a-offscreen',   // preço riscado
      '.basisPrice .a-offscreen',                          // container basisPrice clássico
      'span.a-text-price .a-offscreen',                    // fallback legado (com guard)
    ];
    for (var i = 0; i < candidates.length; i++) {
      var list = root.querySelectorAll(candidates[i]);
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (isPerUnitEl(el)) continue; // NUNCA o preço-por-unidade
        var val = parsePrice(el.textContent);
        if (val) return val;
      }
    }
    return null;
  }

  // Desconto %. Só existe quando há "De" (originalPrice > price).
  // Prefere o % oficial exibido pela Amazon (`span.savingsPercentage`) — mais
  // fiel ao arredondamento da própria Amazon — e cai para o cálculo.
  function computeDiscountPercent(root, price, originalPrice) {
    if (!price || !originalPrice || originalPrice <= price) return null;
    if (root && root.querySelector) {
      var el = root.querySelector('span.savingsPercentage');
      if (el) {
        var m = (el.textContent || '').match(/-?(\d+)\s*%/);
        if (m) {
          var pct = parseInt(m[1], 10);
          if (pct > 0 && pct < 100) return pct;
        }
      }
    }
    return Math.round(((originalPrice - price) / originalPrice) * 100);
  }

  return {
    parsePrice: parsePrice,
    pickCurrentPrice: pickCurrentPrice,
    pickOriginalPrice: pickOriginalPrice,
    computeDiscountPercent: computeDiscountPercent,
    isPerUnitEl: isPerUnitEl,
    isStrikeEl: isStrikeEl,
  };
});
