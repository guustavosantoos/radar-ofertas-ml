/**
 * amazon-image-utils.js — normalização de URL de imagem da Amazon.
 *
 * Extraído do amazon-scraper.js para ser TESTÁVEL fora do browser (padrão UMD:
 * window.AmazonImageUtils no browser, module.exports nos testes).
 *
 * Bug (2026-07): imagens de alguns produtos eram salvas/enviadas ao WhatsApp
 * CORTADAS. Causa medida nos bytes reais:
 *  - A imagem MASTER da Amazon (URL SEM modificadores, ".../I/611PJXf6gsL.jpg")
 *    é o canvas quadrado 1:1 (ex.: 2560x2560) com o produto centralizado e padding.
 *  - Os modificadores no nome do arquivo — especialmente "_AC_" (Adaptive Crop) —
 *    REMOVEM o padding e recortam no bounding box do produto. Um frasco alto e
 *    fino vira 437x1500 (ratio 0.29, retrato extremo) → o WhatsApp corta no preview.
 *  - O scraper usava `data-old-hires` (._AC_SL1500_) ou, quando ausente, o
 *    `img.src` (._AC_SX342_SY445_) — ambos já autocropados.
 *
 * Solução: remover TODOS os modificadores → recuperar o master quadrado 1:1,
 * que o WhatsApp exibe inteiro e mantém o mesmo enquadramento do site.
 *
 * Formato das URLs de imagem da Amazon:
 *   https://m.media-amazon.com/images/I/{ID}._{MODIFICADORES}_.{ext}
 *   https://m.media-amazon.com/images/I/{ID}.{ext}                 (master, sem modificadores)
 * onde {ID} é alfanumérico e pode conter + - % @, e {MODIFICADORES} é um bloco
 * como "_AC_SX342_SY445_QL70_ML2_", "_AC_SL1500_", "_AC_US40_", "_AC_".
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
  // window.AmazonImageUtils ficava undefined (scraper caía no fallback).
  var g = (typeof window !== 'undefined') ? window
        : (typeof self !== 'undefined') ? self
        : (typeof globalThis !== 'undefined') ? globalThis : null;
  if (g) g.AmazonImageUtils = api;
})(function () {
  'use strict';

  // Casa o nome do arquivo com modificadores e captura ID + extensão, descartando
  // o bloco de modificadores do meio. Exige DOIS pontos (ID . modificadores . ext),
  // então URLs já-master (um ponto só) NÃO casam e ficam intactas.
  var MODIFIER_RE =
    /(\/images\/I\/[A-Za-z0-9%@+-]+)\.[^/?#]*?(\.(?:jpg|jpeg|png|gif|webp|avif))(\?[^"'\s]*)?$/i;

  // Host de mídia da Amazon (evita mexer em URLs de outros CDNs).
  var AMZ_IMG_HOST = /(?:^|\.)(?:media-amazon|images-amazon|ssl-images-amazon)\.com$/i;

  function isAmazonImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.indexOf('/images/I/') === -1) return false;
    try {
      var u = new URL(url);
      return AMZ_IMG_HOST.test(u.hostname);
    } catch (e) {
      // Sem URL() (ambiente degradado) — confia no path /images/I/ + host textual.
      return /(?:media-amazon|images-amazon|ssl-images-amazon)\.com\//i.test(url);
    }
  }

  // Remove os modificadores de tamanho/crop → imagem master (canvas quadrado 1:1
  // original). No-op para URLs não-Amazon ou já-master.
  function fullSizeAmazonImageUrl(url) {
    if (!isAmazonImageUrl(url)) return url || null;
    return url.replace(MODIFIER_RE, '$1$2$3');
  }

  // Escolhe a melhor fonte de imagem de um <img> da PDP e normaliza para o master.
  // Ordem: data-old-hires → maior URL do data-a-dynamic-image → src.
  // (Todas apontam para o mesmo ID, então após normalizar dão o mesmo master —
  // a ordem só importa para URLs que não sejam da Amazon.)
  function pickBestImageUrl(img) {
    if (!img) return null;
    var candidates = [];

    var hires = img.getAttribute ? img.getAttribute('data-old-hires') : null;
    if (hires) candidates.push(hires);

    var dyn = img.getAttribute ? img.getAttribute('data-a-dynamic-image') : null;
    if (dyn) {
      try {
        var map = JSON.parse(dyn);
        var best = null;
        var bestArea = -1;
        for (var u in map) {
          if (!Object.prototype.hasOwnProperty.call(map, u)) continue;
          var dims = map[u];
          var area = (dims && dims.length === 2) ? (dims[0] * dims[1]) : 0;
          if (area > bestArea) { bestArea = area; best = u; }
        }
        if (best) candidates.push(best);
      } catch (e) { /* JSON malformado — ignora */ }
    }

    if (img.src) candidates.push(img.src);

    for (var i = 0; i < candidates.length; i++) {
      var url = candidates[i];
      if (url && url.indexOf('data:') === -1) return fullSizeAmazonImageUrl(url);
    }
    return null;
  }

  return {
    fullSizeAmazonImageUrl: fullSizeAmazonImageUrl,
    pickBestImageUrl: pickBestImageUrl,
    isAmazonImageUrl: isAmazonImageUrl,
  };
});
