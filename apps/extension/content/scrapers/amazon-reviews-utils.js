/**
 * amazon-reviews-utils.js — leitura da QUANTIDADE de avaliações da Amazon.
 *
 * Extraído do amazon-scraper.js para ser TESTÁVEL fora do browser. Padrão UMD:
 *  - Content script (browser): registra `window.AmazonReviewsUtils`.
 *  - Node/testes: `module.exports` (ver tests/amazonReviewsCount.test.ts).
 *
 * BUG QUE ISTO CONSERTA (2026-08): a extensão mostrava "(1)" para um produto com
 * "(1,4 mil)" avaliações na Amazon. O parser antigo era, nos quatro pontos do
 * scraper, alguma variação de:
 *
 *     texto.replace(/\./g, '').match(/(\d+)/)   →  parseInt
 *
 * Ou seja: removia o separador de milhar e pegava o PRIMEIRO grupo de dígitos.
 *  - "156"      → 156     ✔ (unidade/dezena/centena funcionavam — daí o relato
 *                            de que "só milhar está errado")
 *  - "1.234"    → 1234    ✔
 *  - "1,4 mil"  → 1       ✘ parava na vírgula e jogava fora o "mil"
 *  - "3,5 mil"  → 3       ✘
 *
 * A Amazon abrevia a partir de mil ("1,4 mil", "3,5 mil", "2 mil"), então o
 * número exato NÃO existe no DOM da listagem — 1400 é a melhor leitura possível
 * ali. Na PDP (`acrCustomerReviewText`) o número costuma vir cheio ("1.412
 * avaliações") e é lido exato pela mesma função.
 *
 * REGRA QUE PROTEGE CONTRA LER O RATING COMO CONTAGEM: um número decimal SEM
 * sufixo ("4,5") NUNCA é contagem de avaliações — é a nota. Os cards colocam os
 * dois no mesmo bloco `.a-row.a-size-small`, e o seletor de fallback
 * (`.a-size-small span:last-child`) já pegou o elemento errado no passado.
 * Devolver null aqui faz `pickReviewsCount` seguir para o próximo candidato,
 * em vez de gravar 45 avaliações num produto que tem nota 4,5.
 */
(function (factory) {
  var api = factory();
  // Node / CommonJS (testes via require): exporta o objeto.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Browser / content script (MV3): registra no global SEMPRE — NÃO usar `else`.
  // Mesmo motivo documentado em amazon-price-utils.js: em content script o
  // `module` pode existir no escopo e o registro global nunca rodaria.
  var g = (typeof window !== 'undefined') ? window
        : (typeof self !== 'undefined') ? self
        : (typeof globalThis !== 'undefined') ? globalThis : null;
  if (g) g.AmazonReviewsUtils = api;
})(function () {
  'use strict';

  // Sufixos de escala. As alternativas LONGAS vêm primeiro na regex: com "mi"
  // antes de "mil", "2 mil" casaria "mi" e viraria 2.000.000.
  var SUFFIX_MULTIPLIER = {
    'milhoes': 1000000,
    'milhao': 1000000,
    'milhões': 1000000,
    'milhão': 1000000,
    'mil': 1000,
    'mi': 1000000,
    'm': 1000000, // en-US: "1.4M"
    'k': 1000,    // en-US: "1.4K"
  };

  var NUMBER_WITH_SUFFIX_RE =
    /(\d{1,3}(?:\.\d{3})+|\d{1,3}(?:,\d{3})+|\d+(?:[.,]\d+)?)\s*(milhões|milhoes|milhão|milhao|mil|mi|m|k)?\b/gi;

  // "4,5 de 5 estrelas", "4.5 out of 5 stars" — o rating colado no contador.
  var RATING_NOISE_RE = /[\d.,]+\s*(?:de\s*5(?:\s*estrelas)?|out\s*of\s*5(?:\s*stars)?)/gi;

  // Números que dividem o mesmo bloco `.a-row.a-size-small` com a contagem e
  // que JAMAIS podem virar avaliações: "Mais de 700 compras no mês passado",
  // "R$ 10,00 off", "Entrega GRÁTIS sáb., 29 de ago.".
  var NOT_REVIEWS_RE = /(compra|vendid|r\$|\boff\b|entrega|frete|estoque|cupom|desconto|pedido|parcel)/i;

  // Texto que é SÓ uma contagem: "156", "(3,5 mil)", "1.234". Exigido dos
  // seletores genéricos de fallback, que pegam qualquer span do bloco.
  var COUNT_ONLY_RE =
    /^\(?\s*\d[\d.,]*\s*(?:milhões|milhoes|milhão|milhao|mil|mi|m|k)?\s*\)?$/i;

  /**
   * Converte o texto de contagem de avaliações da Amazon em número inteiro.
   * Devolve null quando o texto não contém uma contagem plausível.
   */
  function parseReviewsCount(text) {
    if (text === null || text === undefined) return null;
    var s = normalize(text);
    if (!s) return null;
    if (NOT_REVIEWS_RE.test(s)) return null;

    // Tira a nota antes de procurar a contagem: sem isso, "4,5 de 5 estrelas
    // (3,5 mil)" devolveria 4 (o primeiro número do texto).
    s = s.replace(RATING_NOISE_RE, ' ');

    NUMBER_WITH_SUFFIX_RE.lastIndex = 0;
    var fallback = null;
    var m;
    while ((m = NUMBER_WITH_SUFFIX_RE.exec(s)) !== null) {
      var suffix = m[2] ? m[2].toLowerCase() : null;
      var value = toNumber(m[1], suffix);
      if (value === null) continue;
      // Com sufixo é inequivocamente uma contagem abreviada ("1,4 mil") —
      // vence qualquer inteiro solto que tenha aparecido antes no texto.
      if (suffix) return value;
      if (fallback === null) fallback = value;
    }
    return fallback;
  }

  function normalize(text) {
    return String(text)
      .replace(/[\u00a0\u202f\u2007]/g, ' ') // NBSP/thin space entre número e "mil"
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /** Converte o par (número textual, sufixo) em inteiro, ou null se implausível. */
  function toNumber(raw, suffix) {
    var multiplier = suffix ? SUFFIX_MULTIPLIER[suffix] : 1;
    if (!multiplier) return null;

    var hasComma = raw.indexOf(',') !== -1;
    var hasDot = raw.indexOf('.') !== -1;
    var normalized;

    if (hasComma && hasDot) {
      // "1.234,5" (pt-BR) ou "1,234.5" (en-US): o ÚLTIMO separador é o decimal.
      if (raw.lastIndexOf(',') > raw.lastIndexOf('.')) {
        normalized = raw.replace(/\./g, '').replace(',', '.');
      } else {
        normalized = raw.replace(/,/g, '');
      }
    } else if (hasComma || hasDot) {
      var sep = hasComma ? ',' : '.';
      var parts = raw.split(sep);
      var decimals = parts[parts.length - 1].length;
      if (decimals === 3 && parts.length >= 2) {
        // Grupos de 3 dígitos = separador de milhar ("1.234", "3,547").
        normalized = parts.join('');
      } else if (!suffix) {
        // Decimal SEM sufixo não é contagem — é a nota. Ver cabeçalho.
        return null;
      } else {
        normalized = parts.join('.');
      }
    } else {
      normalized = raw;
    }

    var n = parseFloat(normalized);
    if (isNaN(n) || n < 0) return null;
    return Math.round(n * multiplier);
  }

  /**
   * Acha e lê a contagem de avaliações dentro de um card de listagem (ou do
   * document, na PDP). Tenta os candidatos do mais específico para o mais
   * genérico e para no primeiro que produzir uma contagem plausível — um
   * candidato que só contém a nota devolve null e a busca continua.
   *
   * `aria-label` vem primeiro quando existe: em vários layouts ele traz o texto
   * completo ("3,5 mil classificações") mesmo quando o span visível foi
   * truncado por CSS.
   */
  function pickReviewsCount(root) {
    if (!root || !root.querySelectorAll) return null;

    // { sel, strict } — `strict` exige que o texto seja SÓ uma contagem, porque
    // o seletor é genérico o bastante para cair em qualquer span do bloco.
    var CANDIDATES = [
      { sel: '#acrCustomerReviewText', strict: false },
      { sel: '[data-cy="reviews-block"] a[aria-label]', strict: false },
      { sel: '[data-cy="reviews-block"] span[aria-label]', strict: false },
      { sel: 'a[href*="#customerReviews"][aria-label]', strict: false },
      { sel: 'span[aria-label*="avalia"]', strict: false },
      { sel: 'span[aria-label*="classifica"]', strict: false },
      { sel: 'span[aria-label*="rating"]', strict: false },
      { sel: 'span[aria-label*="review"]', strict: false },
      { sel: 'a[href*="#customerReviews"] span.a-size-base', strict: false },
      { sel: 'span.a-size-base.s-underline-text', strict: false },
      { sel: 'a[href*="#customerReviews"]', strict: false },
      { sel: '.a-size-small span.a-size-base', strict: true },
      { sel: '.a-size-small span:last-child', strict: true },
    ];

    for (var i = 0; i < CANDIDATES.length; i++) {
      var els = root.querySelectorAll(CANDIDATES[i].sel) || [];
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (!el) continue;
        var count = readCount(el, CANDIDATES[i].strict);
        if (count !== null) return count;
      }
    }
    return null;
  }

  function readCount(el, strict) {
    var aria = el.getAttribute ? el.getAttribute('aria-label') : null;
    if (aria && (!strict || COUNT_ONLY_RE.test(normalize(aria)))) {
      var fromAria = parseReviewsCount(aria);
      if (fromAria !== null) return fromAria;
    }
    var text = el.textContent;
    if (text && (!strict || COUNT_ONLY_RE.test(normalize(text)))) {
      return parseReviewsCount(text);
    }
    return null;
  }

  /**
   * Formatação pt-BR para exibição ("1400" → "1.400"). Mantém o número exato:
   * abreviar de novo ("1,4 mil") perderia o que a PDP traz cheio.
   */
  function formatReviewsCount(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '';
    try {
      return v.toLocaleString('pt-BR');
    } catch (e) {
      return String(Math.round(v));
    }
  }

  return {
    parseReviewsCount: parseReviewsCount,
    pickReviewsCount: pickReviewsCount,
    formatReviewsCount: formatReviewsCount,
  };
});
