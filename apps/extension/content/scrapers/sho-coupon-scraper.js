/**
 * Scraper da página de cupons da Shopee (https://shopee.com.br/m/cupom-de-desconto).
 *
 * Padrão UMD, igual aos outros scrapers do projeto:
 *  - Content script (browser): registra `window.ShopeeCouponScraper` e instala o
 *    listener de mensagens;
 *  - Node/testes: `module.exports` com as funções puras, SEM tocar window/chrome
 *    (ver tests/shopeeCouponScraper.test.ts).
 *
 * ⚠️ CALIBRAÇÃO: o DOM da Shopee é ofuscado e muda. Este parser trabalha por
 * ÂNCORAS DE TEXTO ("% OFF", "R$", "mín", "máx", "Esgotado") e NÃO por classes CSS —
 * é resiliente, mas os seletores de card/seção/código devem ser conferidos contra o HTML
 * real com o usuário logado. Use a action 'dumpCouponPage' para capturar o HTML e ajustar.
 * Cada cupom carrega `rawText` (innerText do card) para re-parse server-side sem nova release.
 *
 * VALIDADE: não vem no card — vive atrás do "Condições" (`<a aria-label="Link dos
 * termos e condições">`). Este scraper só CAPTURA esse texto (`conditionsText`);
 * quem deriva a data é o servidor (`shared/shopee-coupon-conditions.ts`), pelo mesmo
 * motivo do fluxo do ML: conserto de redação sem republicar a extensão.
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime) {
    return; // Node/teste: só as funções puras.
  }
  window.ShopeeCouponScraper = api;
  api._install();
})(function () {
  'use strict';

  function isContextValid() {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  var COUPON_URL = 'https://shopee.com.br/m/cupom-de-desconto';

  // Orçamento da leitura de condições. O service worker espera no máximo 150 s pela
  // extração inteira (service-worker.js), e a página ainda consome até 45 s de
  // waitForContent + ~5 s de scroll. O que sobra é isto — e é um TETO, não uma meta:
  // estourado, os cupons restantes entram sem validade em vez de derrubar o import.
  var CONDITIONS_TOTAL_BUDGET_MS = 60000;
  var CONDITIONS_PER_CARD_MS = 4000;
  // 3 cards seguidos sem conseguir abrir as condições = o gatilho mudou de forma.
  // Insistir nos 30 restantes só queimaria o orçamento inteiro para nada.
  var CONDITIONS_MAX_CONSECUTIVE_FAILURES = 3;
  // Duas leituras iguais em 1,6 s aceitaram uma página ainda montando com só 1 card.
  // O microsite precisa ficar cinco segundos SEM alterar a contagem antes da extração.
  var CANDIDATE_STABLE_MS = 5000;
  // Folga para a aba assumir a página de condições pedida. O service worker já
  // esperou o 'complete' antes de chamar, então passado esse tempo a URL errada é
  // redirecionamento de verdade (login, erro) — insistir só rouba o orçamento do
  // próximo cupom, e quem retenta é o service worker.
  var URL_GRACE_MS = 5000;
  var CANDIDATE_POLL_MS = 800;

  // ── Parsing de texto ────────────────────────────────────────────────────────

  function normalizeText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  // "1.234,56" → 123456 · "20" → 2000 · "20,00" → 2000 · "R$ 15" → 1500 · "1,6mil" → 160000
  function parseReaisToCents(raw) {
    if (!raw) return null;
    var s = String(raw);
    // Formato compacto da Shopee: "R$1,6mil" = R$ 1.600,00
    var mil = s.match(/(\d+(?:[.,]\d+)?)\s*mil\b/i);
    if (mil) {
      var reais = parseFloat(mil[1].replace(',', '.'));
      if (isFinite(reais)) return Math.round(reais * 1000 * 100);
    }
    var m = s.match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?/);
    if (!m) return null;
    var intPart = m[1].replace(/\./g, '');
    var cents = m[2] ? (m[2].length === 1 ? m[2] + '0' : m[2]) : '00';
    var value = parseInt(intPart, 10) * 100 + parseInt(cents, 10);
    return Number.isFinite(value) ? value : null;
  }

  // Retorna { discountType, discountValue } ou null.
  function parseDiscount(text) {
    var t = normalizeText(text);
    // Percentual: "10% OFF", "até 30% de desconto"
    var pct = t.match(/(\d{1,2})\s*%/);
    if (pct) {
      var p = parseInt(pct[1], 10);
      if (p >= 1 && p <= 100) return { discountType: 'percent', discountValue: p };
    }
    // Valor fixo: o valor precisa estar LIGADO ao desconto, senão o "mín. R$ 99" do
    // próprio card seria lido como se fosse o desconto (mesmo texto, outro significado).
    var patterns = [
      /R\$\s*([\d.,]+(?:\s*mil)?)\s*(?:OFF|de desconto)/i,
      /desconto\s+de\s+R\$\s*([\d.,]+(?:\s*mil)?)/i,
      /(?:^|\s)-\s*R\$\s*([\d.,]+(?:\s*mil)?)/,
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = t.match(patterns[i]);
      if (!m) continue;
      // Descarta se o valor casado for o mínimo de compra (ex.: "acima de R$ 99 de desconto"
      // não existe, mas layouts variam — a checagem evita o falso positivo).
      var before = t.slice(0, m.index || 0);
      if (/(?:m[íi]n[.:]?|acima de|a partir de|compras de)\s*$/i.test(before)) continue;
      var cents = parseReaisToCents(m[1]);
      if (cents && cents > 0) return { discountType: 'fixed', discountValue: cents };
    }
    return null;
  }

  // "mín. R$ 99", "Nas compras acima de R$ 99", "acima de R$1,6mil" → centavos
  function parseMinPurchase(text) {
    var t = normalizeText(text);
    var m = t.match(/(?:m[íi]n[.:]?|acima de|a partir de|compras de)\s*R\$\s*([\d.,]+(?:\s*mil)?)/i);
    return m ? parseReaisToCents(m[1]) : null;
  }

  // "Limitado a R$ 10" (formato real da Shopee), "máx. R$ 15", "até R$ 15", "desconto máximo de R$ 15"
  function parseMaxDiscount(text) {
    var t = normalizeText(text);
    var m = t.match(/(?:limitado\s+a|m[áa]x[.:]?|at[ée]|desconto m[áa]ximo de?)\s*R\$\s*([\d.,]+(?:\s*mil)?)/i);
    return m ? parseReaisToCents(m[1]) : null;
  }

  // Rótulo de escopo DENTRO do card ("TODAS AS LOJAS", "TECNOLOGIA", "GIFT CARD UBER"):
  // primeira linha curta do card que não é desconto/condição/botão/tag. É a categoria
  // real do cupom — o título de SEÇÃO da página (fallback) é genérico demais.
  function extractCardLabel(el) {
    var lines = (el.innerText || '').split('\n');
    for (var i = 0; i < lines.length && i < 6; i++) {
      var line = normalizeText(lines[i]);
      if (!line || line.length > 40) continue;
      if (/R\$|%|OFF\b|acima|a partir|Condi[çc][õo]es|Esgotado|Resgatado|Resgatar|Eu quero|Limitado|cashback|Ver mais/i.test(line)) continue;
      if (/^(vendedores nacionais|produtos selecionados|oficial)$/i.test(line)) continue; // tag, não rótulo
      return line;
    }
    return null;
  }

  /**
   * Rótulo de GIFT CARD ("GIFT CARD UBER", "GIFT CARDS RAZER GOLD").
   *
   * Esses cupons não são importados (decisão de produto, 28/jul/2026): o usuário não
   * trabalha com eles. Barrá-los AQUI, e não só no servidor, evita gastar com eles a
   * leitura das condições — que é o recurso escasso do import (uma navegação e um
   * poll por cupom, dentro de um orçamento fechado).
   *
   * A mesma regra vive em `shared/coupon-filters.ts`, do lado do servidor: este
   * arquivo é standalone (sem bundler) e não consegue importar de lá. Mudou aqui,
   * muda lá. Só PREFIXO — "CUPOM PARA GIFT CARD" continuaria entrando.
   */
  function isGiftCardLabel(label) {
    var s = normalizeText(label).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/^[^A-Za-z0-9]+/, '').toUpperCase();
    return /^GIFT[\s_-]*CARDS?\b/.test(s);
  }

  // Tag de escopo do card ("Vendedores nacionais", "Oficial", "Produtos selecionados"),
  // quando presente como linha isolada. Vai no campo `title` (subtítulo na UI).
  function extractCardTag(el) {
    var lines = (el.innerText || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = normalizeText(lines[i]);
      if (/^(vendedores nacionais|produtos selecionados|oficial)$/i.test(line)) return line;
    }
    return null;
  }

  function isExhausted(el, text) {
    var t = normalizeText(text).toLowerCase();
    if (/esgotad|acabou|indispon[íi]vel|sold\s*out/.test(t)) return true;
    // Botão/estado desabilitado dentro do card
    if (el && el.querySelector && el.querySelector('[disabled], .is-disabled, [aria-disabled="true"]')) return true;
    return false;
  }

  function slugify(s) {
    return normalizeText(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // Código do cupom, se visível. Muitos cupons Shopee só revelam o código após "Resgatar";
  // quando não há código explícito, um código SINTÉTICO estável (categoria+regras) mantém o
  // upsert deduplicando entre releituras. Calibrar na Etapa 0 se o código exigir clique.
  function extractCode(el, text, category, disc, min, max) {
    if (el) {
      var dataCode = el.getAttribute && (el.getAttribute('data-code') || el.getAttribute('data-coupon-code') || el.getAttribute('data-promotionid'));
      if (dataCode) return normalizeText(dataCode);
    }
    var m = normalizeText(text).match(/\b(?:c[óo]digo|cupom)[:\s]*([A-Z0-9]{4,20})\b/i);
    if (m) return m[1].toUpperCase();
    var token = normalizeText(text).match(/\b[A-Z0-9]{5,20}\b/);
    if (token && /[A-Z]/.test(token[0]) && /\d/.test(token[0])) return token[0];
    // Fallback sintético e determinístico (estável entre releituras → o upsert dedup).
    // TODAS as regras entram na chave; só o slug da categoria é truncado, para que o
    // discriminador (tipo/valor/mínimo/teto) nunca seja cortado e cupons que diferem
    // apenas no teto deixem de colidir.
    var cat = slugify(category || 'geral').slice(0, 28);
    var d = disc ? disc.discountType[0] + disc.discountValue : 'x';
    var tail = (min ? '-m' + min : '') + (max ? '-x' + max : '');
    return ('SHP-' + cat + '-' + d + tail).slice(0, 100).toUpperCase();
  }

  // ── Condições do cupom (validade) ───────────────────────────────────────────

  // O "Condições" do card. Âncoras, em ordem de confiança: aria-label declarado pela
  // Shopee → texto "Condições" → classe conhecida. A classe (`oWj_Wi` no levantamento
  // de 28/jul/2026) é ofuscada e muda a cada build, por isso NUNCA é a âncora primária —
  // fica só como último recurso, quando o rótulo vier em imagem/ícone.
  function findConditionsTrigger(cardEl) {
    if (!cardEl || !cardEl.querySelectorAll) return null;
    var byLabel = cardEl.querySelectorAll('[aria-label*="termos" i], [aria-label*="condi" i]');
    if (byLabel.length > 0) return byLabel[0];

    var clickable = cardEl.querySelectorAll('a, button, span[role="button"], [class*="oWj_Wi"]');
    for (var i = 0; i < clickable.length; i++) {
      var t = normalizeText(clickable[i].textContent);
      if (/^condi[çc][õo]es/i.test(t) || /termos e condi/i.test(t)) return clickable[i];
    }
    return null;
  }

  /**
   * O card DE VERDADE da Shopee é maior que o bloco de desconto: o link "Condições"
   * e o botão Resgatar moram em IRMÃOS do bloco. Evidência real (dump de
   * 28/jul/2026): `div.LPM2Zd > [div.R4pt0Q rótulo+desconto+mínimo] +
   * [div.TPFl9F > a.oWj_Wi "Condições"] + [botão "Resgatado"]`. O filtro de
   * "mais interno" escolhia o R4pt0Q e a leitura de condições saía `sem-gatilho`.
   *
   * Sobe até englobar o gatilho, com duas travas para nunca clicar as condições do
   * cupom ERRADO: o pai não pode conter outro candidato a card, nem dois gatilhos.
   */
  function expandToConditionsTrigger(el, allCards) {
    var node = el;
    for (var up = 0; up < 4; up++) {
      if (findConditionsTrigger(node)) return node;
      var parent = node.parentElement;
      if (!parent) break;
      var containsOther = false;
      for (var i = 0; i < allCards.length; i++) {
        if (allCards[i] !== el && parent.contains && parent.contains(allCards[i])) {
          containsOther = true;
          break;
        }
      }
      if (containsOther) break;
      var triggers = parent.querySelectorAll
        ? parent.querySelectorAll('[aria-label*="termos" i], [aria-label*="condi" i]')
        : [];
      if (triggers.length >= 2) break;
      node = parent;
    }
    return findConditionsTrigger(node) ? node : el;
  }

  // Palavras que identificam um texto de regulamento — usadas para reconhecer o modal
  // certo (a página tem vários overlays) e para recortar o trecho útil.
  var VALIDITY_HINT = /v[áa]lid|vig[êe]nc|per[íi]odo|vence|expira|prazo|utiliza[çc][ãa]o/i;

  /**
   * Corta em `limit` chars SEM partir um número ao meio.
   *
   * Cortar "…válido até 31/07/2026" em "…válido até 31/07/20" produzia uma data
   * perfeitamente parseável e ERRADA (ano 2020) — e o servidor apagava o cupom por
   * "vencido". Sobra do corte: qualquer sequência final de dígitos e separadores de
   * data sai junto.
   */
  function safeSlice(text, limit) {
    if (text.length <= limit) return text;
    return text.slice(0, limit).replace(/[\d]+(?:[/\-.:]\d*)*\s*$/, '').trim();
  }

  // Janela com cara de DATA — usada para priorizar o recorte E para decidir quando a
  // página de detalhes terminou de renderizar. Numa página inteira de termos, o
  // marketing ("cupom válido para o primeiro pedido") também casa as palavras de
  // vigência, mas só a cláusula com data interessa ao parser.
  //
  // O ramo do mês ABREVIADO entrou em 28/jul/2026: a página de detalhes escreve
  // "Período de validade 27 jul 2026 00:00 - 30 ago 2026 23:59", que os dois ramos
  // originais (dd/mm e mês por extenso) não reconheciam — o recorte de 1200 chars
  // podia jogar fora justamente a vigência. Ele exige dígito ANTES e fronteira de
  // palavra logo depois do mês, senão "7 setores" viraria uma data.
  var DATE_HINT = /\d{1,2}[/.\-]\d{1,2}|\b\d{1,2}\s*(?:º|°)?\s*(?:de\s+)?(?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)(?:\.|\b)|janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro/i;

  /**
   * Reduz o texto de condições ao que interessa. Regulamento inteiro da Shopee passa
   * de 10 mil chars e traz datas de outras promoções — mandar tudo aumenta a chance
   * de o parser server-side achar duas datas conflitantes e descartar as duas.
   * Recorta janelas em torno das frases de vigência, priorizando as que contêm uma
   * DATA; sem nenhuma, devolve o começo (onde a validade costuma estar).
   */
  function condenseConditions(text, maxChars) {
    var limit = maxChars || 1200;
    var t = normalizeText(text);
    if (!t) return '';
    if (t.length <= limit) return t;

    var windows = [];
    var re = /v[áa]lid|vig[êe]nc|per[íi]odo|vence|expira|prazo|utiliz/gi;
    var m = re.exec(t);
    while (m && windows.length < 12) {
      var start = Math.max(0, m.index - 80);
      var slice = t.slice(start, Math.min(t.length, m.index + 320));
      if (windows.indexOf(slice) === -1) windows.push(slice);
      re.lastIndex = m.index + 320;
      m = re.exec(t);
    }
    if (windows.length === 0) return safeSlice(t, limit);

    // Datadas primeiro (ordem original preservada dentro de cada grupo).
    var dated = windows.filter(function (w) { return DATE_HINT.test(w); });
    var plain = windows.filter(function (w) { return !DATE_HINT.test(w); });
    var out = [];
    var used = 0;
    var ordered = dated.concat(plain);
    for (var i = 0; i < ordered.length && out.length < 3 && used < limit; i++) {
      out.push(ordered[i]);
      used += ordered[i].length;
    }
    return safeSlice(out.join(' … '), limit);
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // Overlays/modais candidatos, do mais específico ao mais genérico. A Shopee não
  // expõe um seletor estável de modal, então a decisão final é pelo CONTEÚDO.
  var MODAL_SELECTORS = [
    '[role="dialog"]',
    '[class*="modal" i]',
    '[class*="popup" i]',
    '[class*="dialog" i]',
    '[class*="overlay" i]',
  ];

  /** Todos os textos com cara de regulamento visíveis agora (modais abertos). */
  function collectModalTexts(doc) {
    var d = doc || document;
    var out = [];
    for (var s = 0; s < MODAL_SELECTORS.length; s++) {
      var nodes = d.querySelectorAll(MODAL_SELECTORS[s]);
      for (var i = 0; i < nodes.length; i++) {
        var text = normalizeText(nodes[i].innerText || nodes[i].textContent);
        // < 40 chars é rótulo de botão, não regulamento; sem palavra de vigência
        // provavelmente é o overlay de login/cookies, que também é role="dialog".
        if (text.length < 40 || !VALIDITY_HINT.test(text)) continue;
        if (out.indexOf(text) === -1) out.push(text);
      }
      if (out.length > 0) return out;
    }
    return out;
  }

  /**
   * Texto do modal de condições aberto no momento, ou null.
   *
   * `ignoreTexts` é a trava anti-troca: modal de cupom ANTERIOR que não fechou
   * continua no DOM e seria lido como se fosse deste cupom. Precisa ser uma LISTA —
   * com dois modais presos, guardar só um deixava o outro passar como se fosse novo,
   * e a validade de um cupom entrava em outro com confiança máxima. Validade trocada
   * é pior que validade ausente.
   */
  function openModalText(doc, ignoreTexts) {
    var ignore = !ignoreTexts ? [] : (Array.isArray(ignoreTexts) ? ignoreTexts : [ignoreTexts]);
    var textos = collectModalTexts(doc);
    var best = null;
    for (var i = 0; i < textos.length; i++) {
      if (ignore.indexOf(textos[i]) !== -1) continue;
      if (!best || textos[i].length > best.length) best = textos[i];
    }
    return best;
  }

  function closeOpenModal(doc) {
    var d = doc || document;
    var btn = d.querySelector(
      '[aria-label*="fechar" i], [aria-label*="close" i], [class*="close" i][role="button"], button[class*="close" i]',
    );
    if (btn && btn.click) {
      try { btn.click(); } catch (e) { /* segue para o ESC */ }
    }
    try {
      d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    } catch (e) { /* ambiente sem KeyboardEvent (teste) */ }
  }

  /**
   * Clica no gatilho SEM deixar a página navegar.
   *
   * O gatilho é um `<a>`: se ele tiver href de verdade, o clique levaria a aba para a
   * página de termos e o import perderia a lista inteira de cupons. `preventDefault`
   * na fase de captura cancela só a navegação — o handler React da Shopee, que é quem
   * abre o modal, continua recebendo o evento normalmente. `window.open` é neutralizado
   * pelo mesmo motivo; a URL capturada fica só como diagnóstico (não é usada para
   * buscar os termos — ver o comentário sobre a ausência do plano B por fetch).
   */
  function clickWithoutNavigating(trigger) {
    var captured = { openedUrl: null };
    var doc = trigger.ownerDocument || document;
    var win = doc.defaultView || (typeof window !== 'undefined' ? window : null);

    function block(ev) {
      if (ev.preventDefault) ev.preventDefault();
    }
    doc.addEventListener('click', block, true);

    var originalOpen = win && win.open;
    if (win) {
      win.open = function (url) {
        captured.openedUrl = url || null;
        return null;
      };
    }

    try {
      trigger.click();
    } finally {
      doc.removeEventListener('click', block, true);
      if (win && originalOpen) win.open = originalOpen;
    }
    return captured;
  }

  /** Espera o modal renderizar o texto (poll de 200 ms, como no scraper do ML). */
  function waitForModalText(timeoutMs, doc, ignoreText) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function poll() {
        var text = openModalText(doc, ignoreText);
        if (text) return resolve(text);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(poll, 200);
      })();
    });
  }

  // ── Validade via API do microsite ─────────────────────────────────────────
  // A página de detalhes (/voucher/details) é casca CSR: o curl de 28/jul/2026
  // devolveu 155 KB de HTML com 1 caractere de texto visível, e o "Condições" da
  // lista NAVEGA (não abre modal) — nem fetch da casca nem clique produzem termos.
  // Os dados dos cupons — inclusive início e fim de vigência — chegam ao microsite
  // por API própria (mesma origem). Replicamos a chamada que a página JÁ FEZ (a URL
  // fica no resource timing) e casamos cada voucher com seu card pelo promotionId
  // do href do "Condições". Uma requisição cobre a página inteira.

  var API_URL_HINT = /\/api\/.*(voucher|coupon|cupom|microsite|batch|collection)/i;

  function promotionIdFromHref(href) {
    var m = /[?&]promotionid=(\d{6,20})/i.exec(String(href || ''));
    return m ? m[1] : null;
  }

  /** Epoch (s ou ms) plausível para vigência de cupom → ms; fora da janela → null. */
  function plausibleEpoch(n) {
    var num = Number(n);
    if (!num || !isFinite(num)) return null;
    var ms = num > 1e12 ? num : num * 1000;
    var now = Date.now();
    if (ms < now - 366 * 864e5) return null; // >1 ano no passado: não é vigência
    if (ms > now + 2 * 366 * 864e5) return null; // >2 anos no futuro: idem
    return ms;
  }

  function formatBrDate(ms) {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(ms));
  }

  /**
   * Varre um JSON qualquer atrás de objetos com { promotionid…, end_time… }.
   * Genérico de propósito: o shape exato da resposta do microsite muda, mas o par
   * (id da promoção, fim de vigência) é o invariante dos vouchers da Shopee.
   */
  function extractVoucherTimes(root) {
    var out = {};
    var stack = [root];
    var guard = 0;
    while (stack.length > 0 && guard < 20000) {
      guard++;
      var node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) stack.push(node[i]);
        continue;
      }
      var id = node.promotionid != null ? node.promotionid
        : node.promotion_id != null ? node.promotion_id
        : node.promotionId != null ? node.promotionId
        : null;
      var end = node.end_time != null ? node.end_time
        : node.claim_end_time != null ? node.claim_end_time
        : node.endTime != null ? node.endTime
        : null;
      var start = node.start_time != null ? node.start_time
        : node.claim_start_time != null ? node.claim_start_time
        : node.startTime != null ? node.startTime
        : null;
      if (id != null && end != null) {
        var endMs = plausibleEpoch(end);
        if (endMs) out[String(id)] = { endMs: endMs, startMs: plausibleEpoch(start) };
      }
      for (var k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) {
          var v = node[k];
          if (v && typeof v === 'object') stack.push(v);
        }
      }
    }
    return out;
  }

  /**
   * Tenta preencher `conditionsText` de todos os cupons numa tacada, replicando as
   * chamadas de API do microsite. O texto gerado ("Cupom válido de X a Y, incluindo
   * ambas as datas.") é o formato que o parser server-side já reconhece com
   * prioridade máxima — a extensão continua não decidindo validade nenhuma.
   */
  function readValidityFromMicrositeApi(coupons, cardsByIndex, view, timeoutMs) {
    try {
      var perf = view && view.performance;
      var loc = view && view.location;
      if (!perf || !loc || typeof fetch !== 'function' || typeof perf.getEntriesByType !== 'function') {
        return Promise.resolve({ matched: 0, apisTried: [] });
      }

      var byPromo = {};
      var wanted = 0;
      for (var i = 0; i < coupons.length; i++) {
        var trig = findConditionsTrigger(cardsByIndex[i]);
        var pid = trig && promotionIdFromHref(trig.getAttribute && trig.getAttribute('href'));
        if (pid && !byPromo[pid]) {
          byPromo[pid] = coupons[i];
          wanted++;
        }
      }
      if (wanted === 0) return Promise.resolve({ matched: 0, apisTried: [] });

      var urls = perf.getEntriesByType('resource')
        .map(function (e) { return e.name; })
        .filter(function (u) { return typeof u === 'string' && u.indexOf(loc.origin) === 0 && API_URL_HINT.test(u); })
        .slice(0, 3);

      var matched = 0;
      var chain = Promise.resolve();
      urls.forEach(function (u) {
        chain = chain.then(function () {
          if (matched >= wanted) return null;
          var controller = typeof AbortController === 'function' ? new AbortController() : null;
          var timer = controller
            ? setTimeout(function () { controller.abort(); }, timeoutMs || 5000)
            : null;
          var clear = function () { if (timer) clearTimeout(timer); };
          return fetch(u, { credentials: 'include', signal: controller ? controller.signal : undefined })
            .then(function (r) { clear(); return r.ok ? r.json() : null; })
            .then(function (json) {
              if (!json) return;
              var times = extractVoucherTimes(json);
              for (var pid in times) {
                if (!Object.prototype.hasOwnProperty.call(times, pid)) continue;
                var coupon = byPromo[pid];
                if (!coupon || coupon.conditionsText) continue;
                var t = times[pid];
                coupon.conditionsText = t.startMs
                  ? 'Cupom válido de ' + formatBrDate(t.startMs) + ' a ' + formatBrDate(t.endMs) + ', incluindo ambas as datas.'
                  : 'Cupom válido até ' + formatBrDate(t.endMs) + '.';
                matched++;
              }
            })
            .catch(function () { clear(); });
        });
      });
      return chain.then(function () { return { matched: matched, apisTried: urls }; });
    } catch (e) {
      return Promise.resolve({ matched: 0, apisTried: [] });
    }
  }

  /**
   * O href do "Condições" só vale como fonte de termos quando aponta para a página
   * DEDICADA do cupom (`/voucher/details?evcode=…&promotionId=…` — evidência real no
   * dump de 28/jul/2026). Buscar href genérico foi vetado em revisão: qualquer página
   * same-origin com a palavra "válido" viraria "as condições deste cupom" e uma data
   * de política de privacidade apagaria a leitura inteira. A URL de detalhes é única
   * POR CUPOM, o que elimina o cenário de uma mesma página envenenar todos.
   */
  function isVoucherDetailsHref(href) {
    if (!href) return false;
    return /(?:^|shopee\.com\.br)\/voucher\/details\?/i.test(String(href));
  }

  /**
   * Qualquer página de CONDIÇÕES de cupom que o service worker sabe navegar e ler:
   * `/voucher/details` (cupons de categoria) ou `/digital-product/…/VOUCHER_T_C`
   * (gift cards — evidência no dump de 28/jul/2026: os 5 GIFT CARD ficaram sem
   * validade porque o href deles não era /voucher/details e nunca entravam na fila).
   */
  function isConditionsPageHref(href) {
    if (isVoucherDetailsHref(href)) return true;
    if (!href) return false;
    return /(?:^|shopee\.com\.br)\/digital-product\/.*VOUCHER_T_C/i.test(String(href));
  }

  /** URL corrente do documento (o FakeDoc dos testes só expõe `defaultView.location`). */
  function currentHref(d) {
    try {
      if (d && d.defaultView && d.defaultView.location && d.defaultView.location.href) {
        return String(d.defaultView.location.href);
      }
    } catch (e) { /* inacessível: trata como desconhecida */ }
    try {
      if (d && d.location && d.location.href) return String(d.location.href);
    } catch (e) { /* idem */ }
    try {
      if (typeof location !== 'undefined' && location.href) return String(location.href);
    } catch (e) { /* idem */ }
    return '';
  }

  function pathOfHref(href) {
    var m = /^https?:\/\/[^/]+(\/[^?#]*)/i.exec(String(href || ''));
    return m ? m[1].replace(/\/+$/, '') : '';
  }

  /**
   * O que identifica UM cupom na URL de condições. Nos cupons de categoria é o
   * `promotionId`; nos gift cards o caminho é o MESMO para todos
   * (`/digital-product/…/VOUCHER_T_C`) e quem distingue é a query — comparar só o
   * caminho aceitaria a página do gift card anterior como se fosse a deste.
   */
  function conditionsIdentity(href) {
    var s = String(href || '');
    var pid = promotionIdFromHref(s);
    if (pid) return pid;
    var m = /[?&](?:vouchercode|voucher_code|activityid|activity_id)=([A-Za-z0-9._-]{4,64})/i.exec(s);
    return m ? m[1] : null;
  }

  /**
   * A aba está NA página de condições que o service worker pediu?
   *
   * Sem esta checagem, um redirecionamento (login, "algo deu errado", verificação)
   * ou uma navegação ainda não concluída faz a leitura devolver o texto da página
   * ANTERIOR — validade do cupom errado, que é pior que validade ausente. URL
   * desconhecida (documento sem `location` acessível) NÃO bloqueia: nesse caso a
   * checagem simplesmente não opina, em vez de zerar toda a leitura.
   */
  function sameConditionsPage(atual, esperado) {
    if (!esperado) return true;
    if (!atual) return true;
    var id = conditionsIdentity(esperado);
    // Identidade presente na URL corrente basta: a Shopee reescreve a URL (locale,
    // parâmetros de rastreio) sem trocar o cupom, e exigir igualdade literal faria
    // a leitura desistir de páginas certas.
    if (id) return String(atual).indexOf(id) !== -1;
    var pathE = pathOfHref(esperado);
    return !pathE || pathOfHref(atual) === pathE;
  }

  /**
   * Texto renderizado da página de detalhes do cupom (/voucher/details) — usada
   * pelo service worker, que navega a popup do import até ela e injeta este
   * arquivo. É o equivalente programático de "clicar nas Condições e ler": a
   * página é CSR, então só o RENDER tem o texto (o fetch do HTML devolve casca,
   * provado por curl em 28/jul/2026).
   *
   * REGRA DE ACEITE (bug de 28/jul/2026, corrigido aqui): a versão anterior
   * encerrava o poll assim que o texto passava de 150 chars e casava
   * VALIDITY_HINT — e o CABEÇALHO/RODAPÉ da Shopee ("Termos de utilização",
   * "Política de…") já casa esse teste sozinho, sem uma linha do cupom. Nas
   * primeiras navegações o shell levava ~1 s e chegava junto com o conteúdo, e a
   * leitura saía certa; da 8ª em diante, com CSS/JS em cache, o shell pintava em
   * milissegundos e a leitura resolvia ANTES de o voucher renderizar — 7 cupons
   * com data e o resto "lido" instantaneamente e vazio. Agora só encerra cedo o
   * texto que traz DATA (e na página CERTA); sem data, o poll vai até o fim do
   * orçamento e entrega o melhor que viu, para o servidor decidir com o texto na
   * mão em vez de receber o rodapé como se fosse o regulamento.
   *
   * Devolve `{ text, reason, elapsedMs, textLen, url }` — `reason` é diagnóstico
   * do import, nunca regra de negócio.
   */
  function pollVoucherDetails(timeoutMs, doc, opts) {
    var options = opts || {};
    var d = doc || (typeof document !== 'undefined' ? document : null);
    var limit = typeof timeoutMs === 'number' && timeoutMs >= 0 ? timeoutMs : 10000;
    var esperado = options.expectUrl || null;
    return new Promise(function (resolve) {
      var start = Date.now();
      var url = '';
      var textLen = 0;
      var comData = null; // texto COM data, aguardando confirmação de estabilidade
      var semData = null; // melhor texto com cara de regulamento, mas sem data
      var foraDaPagina = false;

      function finish(text, reason) {
        resolve({
          text: text ? condenseConditions(text) : null,
          reason: reason,
          elapsedMs: Date.now() - start,
          textLen: textLen,
          url: url,
        });
      }

      (function poll() {
        url = currentHref(d);
        var naPaginaCerta = sameConditionsPage(url, esperado);
        if (!naPaginaCerta) foraDaPagina = true;
        // Aba parada em OUTRA página (redirecionamento, navegação que não pegou):
        // esperar o orçamento inteiro aqui só rouba o tempo do próximo cupom. A folga
        // cobre o instante em que a URL antiga ainda vale porque o documento novo não
        // assumiu — o service worker já aguardou o 'complete' antes de chamar.
        if (!naPaginaCerta && Date.now() - start > URL_GRACE_MS) return finish(null, 'url-diferente');
        var text = d && d.body ? normalizeText(d.body.innerText || '') : '';
        textLen = text.length;
        if (naPaginaCerta && text.length > 150 && VALIDITY_HINT.test(text)) {
          if (DATE_HINT.test(text)) {
            // Render em duas etapas troca o texto entre um poll e outro; só aceita
            // quando duas amostras seguidas coincidem — meia data não vira validade.
            if (comData === text) return finish(text, 'ok');
            comData = text;
          } else {
            semData = text;
          }
        }
        if (Date.now() - start >= limit) {
          if (comData) return finish(comData, 'ok-instavel');
          if (semData) return finish(semData, 'sem-data');
          return finish(null, foraDaPagina ? 'url-diferente' : 'sem-texto');
        }
        setTimeout(poll, 400);
      })();
    });
  }

  /** Açúcar histórico: só o texto (o diagnóstico fica para quem pedir o objeto). */
  function readVoucherDetailsText(timeoutMs, doc, opts) {
    return pollVoucherDetails(timeoutMs, doc, opts).then(function (r) { return r.text; });
  }

  /**
   * Lê as condições de UM card. Devolve `{ text, source }` — `source` entra no
   * diagnóstico do import, nunca em regra de negócio.
   *
   * Gatilho com href de `/voucher/details` NÃO é clicado: o link NAVEGA (evidência
   * de 28/jul/2026 — não existe modal), e o clique só arriscaria o roteamento da
   * SPA trocar a página com os cards ainda por ler. Quem resolve esses é o service
   * worker (sonda de fibers + página de detalhes); aqui fica só o caminho de modal
   * para layouts em que o gatilho não é link.
   */
  function readCardConditions(cardEl, opts) {
    var options = opts || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var timeout = options.timeoutMs || CONDITIONS_PER_CARD_MS;
    var trigger = findConditionsTrigger(cardEl);
    if (!trigger) return Promise.resolve({ text: null, source: 'sem-gatilho' });

    var href = trigger.getAttribute ? trigger.getAttribute('href') : null;
    if (isConditionsPageHref(href)) {
      return Promise.resolve({ text: null, source: 'detalhes-por-aba' });
    }

    // Modal remanescente de um card anterior falsearia a leitura deste — o texto
    // pertenceria ao cupom errado, e validade trocada é pior que validade ausente.
    // TUDO o que sobreviver ao fechamento vira `stale` e é ignorado na leitura.
    var stale = collectModalTexts(doc);
    if (stale.length > 0) {
      closeOpenModal(doc);
      stale = collectModalTexts(doc);
    }

    try {
      clickWithoutNavigating(trigger);
    } catch (e) {
      return Promise.resolve({ text: null, source: 'clique-falhou' });
    }

    return waitForModalText(timeout, doc, stale).then(function (text) {
      if (!text) return { text: null, source: 'modal-nao-abriu' };
      closeOpenModal(doc);
      return { text: condenseConditions(text), source: 'modal' };
    });
  }

  // ── Descoberta de cards e categorias ────────────────────────────────────────

  function looksLikeHeading(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    if (/^h[1-4]$/.test(tag)) return true;
    var t = normalizeText(el.textContent);
    // Título curto de seção (categoria), sem "R$"/"%"
    return t.length > 0 && t.length <= 40 && !/R\$|%|OFF/i.test(t) && /[A-Za-zÀ-ÿ]/.test(t);
  }

  // Sobe até achar um heading de seção anterior (categoria) do card.
  function findCategoryForCard(cardEl) {
    var node = cardEl;
    for (var up = 0; up < 6 && node; up++) {
      var sib = node.previousElementSibling;
      var scanned = 0;
      while (sib && scanned < 8) {
        if (looksLikeHeading(sib)) return normalizeText(sib.textContent);
        var innerHeading = sib.querySelector && sib.querySelector('h1,h2,h3,h4');
        if (innerHeading) return normalizeText(innerHeading.textContent);
        sib = sib.previousElementSibling;
        scanned++;
      }
      node = node.parentElement;
    }
    return 'Geral';
  }

  // Um card REAL de cupom da Shopee tem desconto E bloco de condições ("Nas compras
  // acima de R$X" / "Condições" / "Limitado a"). Invólucros internos com só rótulo +
  // desconto NÃO são cards — importá-los gerava o cupom duplicado "sem valor mínimo".
  function looksLikeFullCard(text) {
    var hasDiscount = /%\s*OFF|%|R\$/i.test(text) && /(cupom|OFF|desconto|resgat|usar)/i.test(text);
    var hasConditions = /condi[çc][õo]es|acima de|m[íi]n[.:\s]|limitado a/i.test(text);
    return hasDiscount && hasConditions;
  }

  // Candidatos a card: elementos compactos com desconto + condições; entre elementos
  // ANINHADOS que passam no critério, fica só o MAIS INTERNO (o card de verdade —
  // o de fora é wrapper/seção e duplicaria a extração).
  function collectCandidateCards(doc) {
    var d = doc || document;
    var all = d.querySelectorAll('div, li, a, section, article');
    var cards = [];
    var seen = new Set();
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var text = normalizeText(el.textContent);
      if (!text || text.length > 400) continue;
      if (!looksLikeFullCard(text)) continue;
      // Container com 2+ cards completos dentro → não é um card.
      var childMatches = 0;
      for (var c = 0; c < el.children.length; c++) {
        var ct = normalizeText(el.children[c].textContent);
        if (ct.length <= 400 && looksLikeFullCard(ct)) childMatches++;
      }
      if (childMatches >= 2) continue;
      var key = text.slice(0, 160);
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push(el);
    }
    // Mantém só os mais internos: quem CONTÉM outro candidato é invólucro, não card.
    var innermost = cards.filter(function (el) {
      for (var j = 0; j < cards.length; j++) {
        if (cards[j] !== el && el.contains(cards[j])) return false;
      }
      return true;
    });
    // …e depois EXPANDE cada um até englobar o "Condições": o mais interno é o bloco
    // de desconto, e o gatilho/botão moram em irmãos dele (ver expandToConditionsTrigger).
    return innermost.map(function (el) {
      return expandToConditionsTrigger(el, innermost);
    });
  }

  // Espera ativa pelo render da SPA: só libera quando existe ao menos um CARD real.
  // Procurar apenas "cupom" no body liberava cedo porque o artigo estático abaixo do
  // microsite contém essa palavra mesmo quando a grade ainda não montou.
  function waitForContent(timeoutMs, doc, pollMs) {
    return new Promise(function (resolve) {
      var d = doc || document;
      var interval = pollMs != null ? pollMs : 500;
      var start = Date.now();
      (function poll() {
        if (collectCandidateCards(d).length > 0) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(poll, interval);
      })();
    });
  }

  /**
   * Extrai os cupons da página.
   *
   * `options.readConditions === false` pula a leitura das condições (usado pelo teste,
   * e é o caminho de degradação quando o orçamento de tempo acaba). A leitura é
   * SEQUENCIAL de propósito: o modal da Shopee é singleton, dois cliques concorrentes
   * embaralhariam qual texto pertence a qual cupom.
   */
  function extractCoupons(options) {
    var opts = options || {};
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var readConditions = opts.readConditions !== false;
    // `!= null` e não `||`: orçamento 0 é um valor legítimo ("não leia condições
    // agora") e com `||` viraria os 60 s do default — o oposto do pedido.
    var budget = opts.budgetMs != null ? opts.budgetMs : CONDITIONS_TOTAL_BUDGET_MS;
    var perCard = opts.perCardTimeoutMs != null ? opts.perCardTimeoutMs : CONDITIONS_PER_CARD_MS;
    var deadline = Date.now() + budget;

    var cards = collectCandidateCards(doc);
    var coupons = [];
    var cardsByIndex = [];
    var exhaustedCodes = [];
    var seenCodes = new Set();
    var giftCardsIgnored = 0;

    for (var i = 0; i < cards.length; i++) {
      var el = cards[i];
      var rawText = normalizeText(el.innerText || el.textContent);

      // Cashback não é cupom de desconto direto ("50% DE CASHBACK limitado a R$50"):
      // seria importado como 50% OFF e anunciaria um preço falso. Fora do escopo.
      if (/cashback/i.test(rawText)) continue;

      var disc = parseDiscount(rawText);
      if (!disc) continue; // sem tipo/valor de desconto → não é cupom

      // Categoria = rótulo DENTRO do card (como a Shopee exibe); seção só como fallback.
      var category = extractCardLabel(el) || findCategoryForCard(el) || 'Geral';
      // Gift card não é importado (ver isGiftCardLabel). Antes de extrair código e de
      // entrar na fila de condições: eles ficavam no fim da página e consumiam
      // justamente o orçamento de leitura dos cupons que interessam.
      if (isGiftCardLabel(category)) {
        giftCardsIgnored++;
        continue;
      }
      var tag = extractCardTag(el);
      var min = parseMinPurchase(rawText);
      var max = parseMaxDiscount(rawText);
      var code = extractCode(el, rawText, category, disc, min, max);

      if (isExhausted(el, rawText)) {
        if (!exhaustedCodes.includes(code)) exhaustedCodes.push(code);
        continue; // Regra: cupom esgotado NÃO é importado.
      }
      if (seenCodes.has(code)) continue;
      seenCodes.add(code);

      // O href do "Condições" carrega o promotionId — a chave que casa este card
      // com o voucher da sonda de fibers — e a URL de condições que o service
      // worker navega quando a sonda não cobre. O servidor ignora os dois campos
      // (o Zod descarta desconhecidos); eles existem para o TRÂNSITO na extensão.
      var condTrigger = findConditionsTrigger(el);
      // `&amp;` é desfeito UMA vez, aqui: o navegador já entrega o atributo decodificado,
      // mas o href também chega por dump/serialização, e nesse formato o separador do
      // `promotionId` deixava de ser `&` — a chave que casa o card com a sonda de
      // fibers vinha null e o cupom caía na leitura por página sem precisar.
      var condHrefRaw = condTrigger && condTrigger.getAttribute ? condTrigger.getAttribute('href') : null;
      var condHref = condHrefRaw ? String(condHrefRaw).replace(/&amp;/g, '&') : null;
      var promotionId = isVoucherDetailsHref(condHref) ? promotionIdFromHref(condHref) : null;
      var conditionsUrl = null;
      if (isConditionsPageHref(condHref)) {
        try {
          var base = (doc && doc.defaultView && doc.defaultView.location && doc.defaultView.location.href)
            || (typeof location !== 'undefined' ? location.href : COUPON_URL);
          conditionsUrl = new URL(condHref, base).href;
        } catch (e) { /* href relativo sem base válida — segue sem URL */ }
      }

      coupons.push({
        code: code,
        title: tag, // tag de escopo ("Vendedores nacionais", "Oficial"...) ou null
        couponCategory: category,
        discountType: disc.discountType,
        discountValue: disc.discountValue,
        minPurchaseCents: min || 0,
        maxDiscountCents: max || null,
        // A validade não está no card: sai do texto de `conditionsText`, no servidor.
        validUntil: null,
        conditionsText: null,
        promotionId: promotionId,
        conditionsUrl: conditionsUrl,
        rawText: rawText.slice(0, 500),
      });
      cardsByIndex.push(el);
    }

    var stats = {
      attempted: 0, read: 0, budgetExhausted: false, gaveUp: false, outcomes: [], apisTried: [],
      giftCardsIgnored: giftCardsIgnored,
    };
    if (!readConditions || coupons.length === 0) {
      return Promise.resolve(buildResult(coupons, exhaustedCodes, stats, doc));
    }

    var view = opts.view || (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);

    // Primeira tacada: a API do microsite cobre a página inteira numa requisição.
    var apiPass = readValidityFromMicrositeApi(coupons, cardsByIndex, view, 5000).then(function (r) {
      stats.apisTried = r.apisTried;
      for (var i = 0; i < coupons.length; i++) {
        if (coupons[i].conditionsText) {
          stats.read++;
          stats.outcomes.push({ code: coupons[i].code, source: 'api' });
        }
      }
    });

    // Sequencial via redução de Promises: o modal é singleton (ver comentário acima).
    var consecutiveFailures = 0;
    var chain = apiPass;
    coupons.forEach(function (coupon, index) {
      chain = chain.then(function () {
        if (coupon.conditionsText) return null; // a API já resolveu este
        if (stats.gaveUp || stats.budgetExhausted) return null;
        if (Date.now() >= deadline) {
          stats.budgetExhausted = true;
          return null;
        }
        stats.attempted++;
        return readCardConditions(cardsByIndex[index], {
          document: doc,
          timeoutMs: Math.min(perCard, Math.max(500, deadline - Date.now())),
        }).then(function (r) {
          stats.outcomes.push({ code: coupon.code, source: r.source });
          if (r.text) {
            coupon.conditionsText = r.text;
            stats.read++;
            consecutiveFailures = 0;
            return;
          }
          // Custo zero não entra na conta da desistência: card SEM gatilho (nem
          // clique houve) e gatilho de /voucher/details (deferido ao service
          // worker, que resolve por sonda/página de detalhes). O que a desistência
          // protege é do modal que parou de abrir — esse gasta o timeout por card.
          if (r.source === 'sem-gatilho' || r.source === 'detalhes-por-aba') return;
          consecutiveFailures++;
          if (consecutiveFailures >= CONDITIONS_MAX_CONSECUTIVE_FAILURES) stats.gaveUp = true;
        });
      });
    });

    return chain.then(function () {
      return buildResult(coupons, exhaustedCodes, stats, doc);
    });
  }

  function buildResult(coupons, exhaustedCodes, stats, doc) {
    var result = {
      success: true,
      data: coupons,
      count: coupons.length,
      exhaustedCodes: exhaustedCodes,
      sourceUrl: COUPON_URL,
      conditionsRead: stats.read,
      conditionsAttempted: stats.attempted,
      conditionsGaveUp: stats.gaveUp || stats.budgetExhausted,
      conditionsOutcomes: stats.outcomes,
      apisTried: stats.apisTried,
      // Cards descartados por serem gift card: sem este número, "18 cupons na página,
      // 13 lidos" pareceria falha de extração em vez de filtro de produto.
      giftCardsIgnored: stats.giftCardsIgnored || 0,
    };
    // Anexa o diagnóstico (HTML/texto/candidatos + desfecho por cupom) quando algo
    // pede calibração: 0 cupons (seletores de CARD descalibrados ou página vazia) OU
    // nenhuma condição lida (o gatilho/modal do "Condições" mudou de forma). Sem o
    // segundo caso, o sync de 28/jul/2026 veio "0/1 com validade lida" e não deixou
    // NENHUMA evidência para ajustar os seletores — o dump só saía com 0 cupons.
    if (coupons.length === 0 || (coupons.length > 0 && stats.read === 0)) {
      result.debug = buildDebugDump(doc);
      result.debug.conditionsOutcomes = stats.outcomes;
      result.debug.apisTried = stats.apisTried;
    }
    return result;
  }

  /**
   * Espera a contagem de cards ESTABILIZAR antes de extrair.
   *
   * O microsite monta as seções aos poucos, DEPOIS do scroll: no sync de 28/jul/2026
   * a extração viu 6 cupons e o dump, segundos depois, 23 — as seções do meio
   * renderizaram entre um e outro. Estável = aproximadamente cinco segundos sem
   * nenhuma mudança na contagem (e > 0); o teto garante que página vazia não trava.
   */
  function waitForStableCandidates(timeoutMs, doc, quietMs, pollMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var quietWindow = quietMs != null ? quietMs : CANDIDATE_STABLE_MS;
      var interval = pollMs != null ? pollMs : CANDIDATE_POLL_MS;
      var last = -1;
      var lastChangeAt = start;
      (function poll() {
        var n = collectCandidateCards(doc).length;
        var now = Date.now();
        if (n !== last) {
          last = n;
          lastChangeAt = now;
        }
        if (n > 0 && now - lastChangeAt >= quietWindow) return resolve(n);
        if (now - start > timeoutMs) return resolve(n);
        setTimeout(poll, interval);
      })();
    });
  }

  /**
   * Scroll progressivo para disparar IntersectionObserver/lazy-loading em TODAS as
   * regiões da página. Pular direto para `scrollHeight` repetidamente não intersecta
   * as seções intermediárias e pode deixá-las sem montar.
   *
   * As opções existem só para o DOM falso dos testes; no navegador são usados os
   * tempos conservadores abaixo. A altura é recalculada a cada passo porque novas
   * seções podem aumentar o documento durante o percurso.
   */
  function scrollToLoad(options) {
    return new Promise(function (resolve) {
      var opts = options || {};
      var view = opts.view || window;
      var doc = opts.document || document;
      var stepDelay = opts.stepDelayMs != null ? opts.stepDelayMs : 350;
      var settleDelay = opts.settleDelayMs != null ? opts.settleDelayMs : 800;
      var maxSteps = opts.maxSteps != null ? opts.maxSteps : 30;
      var y = 0;
      var steps = 0;
      var lastBottomHeight = -1;
      var stableBottomPasses = 0;

      function finish() {
        view.scrollTo(0, 0);
        setTimeout(resolve, settleDelay);
      }

      function step() {
        var bodyHeight = doc.body ? Number(doc.body.scrollHeight) || 0 : 0;
        var rootHeight = doc.documentElement ? Number(doc.documentElement.scrollHeight) || 0 : 0;
        var height = Math.max(bodyHeight, rootHeight);
        var viewport = Math.max(Number(view.innerHeight) || 600, 1);
        var bottom = Math.max(0, height - viewport);
        var advance = Math.max(300, Math.floor(viewport * 0.8));

        y = Math.min(bottom, y + advance);
        view.scrollTo(0, y);
        steps++;

        if (y >= bottom) {
          if (height === lastBottomHeight) {
            stableBottomPasses++;
          } else {
            lastBottomHeight = height;
            stableBottomPasses = 0;
          }
          // Uma segunda passagem cobre seções inseridas durante o primeiro percurso.
          if (stableBottomPasses < 1 && steps < maxSteps) y = 0;
        }

        if (stableBottomPasses >= 1 || steps >= maxSteps) return finish();
        setTimeout(step, stepDelay);
      }
      step();
    });
  }

  // Dump para calibração (Etapa 0): HTML + texto + candidatos, para ajustar seletores
  // contra o DOM real. Usado pela action dumpCouponPage e anexado quando extrai 0 cupons.
  function buildDebugDump(doc) {
    var d = doc || document;
    var candidates = collectCandidateCards(d).slice(0, 30).map(function (el) {
      return {
        text: normalizeText(el.innerText || el.textContent).slice(0, 300),
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 120),
        // Sem gatilho de condições não há validade: é o primeiro dado a conferir
        // quando os cupons voltarem a entrar sem data.
        hasConditionsTrigger: !!findConditionsTrigger(el),
      };
    });
    // Versão do manifest que gerou o dump: um dump de extensão desatualizada mandaria
    // a calibração atrás de bug que já não existe. Guardado em try — em Node (teste)
    // não há chrome.runtime.
    var version = '';
    try {
      version = chrome.runtime.getManifest().version;
    } catch (e) { /* ambiente sem chrome */ }
    // URLs de API que a página chamou (resource timing): é daqui que sai o endpoint
    // real dos vouchers quando a heurística API_URL_HINT não o encontrar sozinha.
    var apis = [];
    try {
      var v = (d && d.defaultView) || (typeof window !== 'undefined' ? window : null);
      if (v && v.performance && typeof v.performance.getEntriesByType === 'function') {
        apis = v.performance.getEntriesByType('resource')
          .map(function (e) { return e.name; })
          .filter(function (u) { return typeof u === 'string' && /\/api\//.test(u); })
          .slice(0, 40);
      }
    } catch (e) { /* sem performance */ }
    return {
      resourceApis: apis,
      url: typeof location !== 'undefined' ? location.href : '',
      title: d.title,
      bodyLength: d.body ? d.body.innerHTML.length : 0,
      textSample: d.body ? (d.body.innerText || '').slice(0, 8000) : '',
      htmlSample: d.body ? d.body.innerHTML.slice(0, 150000) : '',
      candidateCount: candidates.length,
      candidates: candidates,
      scraperVersion: version,
    };
  }

  function dumpCouponPage() {
    var dump = buildDebugDump();
    dump.success = true;
    return dump;
  }

  function install() {
    console.log('[AchadinhoPRO:Cupons] Content script carregado');

    chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
      if (!isContextValid()) return false;

      if (message.action === 'ping') {
        sendResponse({ status: 'ok', marketplace: 'shopee', scraper: 'coupons' });
        return true;
      }

      if (message.action === 'extractCoupons') {
        // Aba em segundo plano é throttled pelo Chrome: o microsite da Shopee pode demorar
        // bem mais que numa aba ativa. Espera longa + segunda tentativa quando vier 0.
        var pageReady = false;
        // Teto de resposta: o service worker desiste em 150 s e fecha a janela, e o
        // que estiver só na memória do content script morre junto. A margem de 20 s
        // garante que o sendResponse saia ANTES disso. O orçamento das condições é o
        // menor entre o teto próprio (60 s) e o que ainda cabe aqui — misturar os dois
        // relógios (descontar o tempo de render do orçamento de condições) fazia a
        // segunda passada colapsar no piso de 5 s com 85 s de folga sobrando.
        var hardDeadline = Date.now() + 130000;
        var condicoesBudget = function () {
          return Math.max(5000, Math.min(CONDITIONS_TOTAL_BUDGET_MS, hardDeadline - Date.now()));
        };
        waitForContent(45000).then(function (ready) {
          pageReady = ready;
          return scrollToLoad();
        }).then(function () {
          // As seções montam DEPOIS do scroll — extrair antes de a contagem
          // estabilizar foi o que trouxe 6 cupons de uma página com 23 cards.
          return waitForStableCandidates(15000);
        }).then(function () {
          return extractCoupons({ budgetMs: condicoesBudget() });
        }).then(function (result) {
          if (result.count > 0) return result;
          // Segunda chance: o conteúdo pode ter chegado depois do primeiro passe.
          return new Promise(function (r) { setTimeout(r, 8000); })
            .then(scrollToLoad)
            .then(function () {
              return waitForStableCandidates(10000);
            })
            .then(function () {
              return extractCoupons({ budgetMs: condicoesBudget() });
            });
        }).then(function (result) {
          result.pageReady = pageReady;
          console.log(
            '[AchadinhoPRO:Cupons] extractCoupons:', result.count, 'cupons,',
            result.exhaustedCodes.length, 'esgotados,', result.conditionsRead, 'com condições, pageReady=', pageReady,
          );
          sendResponse(result);
        }).catch(function (err) {
          sendResponse({ success: false, error: (err && err.message) || String(err), data: [], count: 0 });
        });
        return true; // resposta assíncrona
      }

      if (message.action === 'dumpCouponPage') {
        waitForContent(45000).then(scrollToLoad).then(function () {
          sendResponse(dumpCouponPage());
        }).catch(function (err) {
          sendResponse({ success: false, error: (err && err.message) || String(err) });
        });
        return true;
      }

      // Página de DETALHES do cupom (/voucher/details), com o service worker no
      // volante: ele navega a popup até aqui e pede o texto renderizado.
      if (message.action === 'readVoucherDetailsPage') {
        // `expectUrl` = a URL que o service worker mandou a aba abrir. Sem ela a
        // leitura aceitaria o texto da página anterior quando a navegação ainda não
        // tivesse trocado o documento.
        pollVoucherDetails(message.timeoutMs || 10000, null, { expectUrl: message.expectUrl }).then(function (r) {
          sendResponse({
            success: true,
            text: r.text,
            reason: r.reason,
            elapsedMs: r.elapsedMs,
            textLen: r.textLen,
            url: r.url,
          });
        }).catch(function (err) {
          sendResponse({ success: false, error: (err && err.message) || String(err) });
        });
        return true;
      }

      return false;
    });
  }

  return {
    // Entradas de runtime
    _install: install,
    extractCoupons: extractCoupons,
    dumpCouponPage: dumpCouponPage,
    // Primitivas puras (expostas para teste)
    normalizeText: normalizeText,
    parseReaisToCents: parseReaisToCents,
    parseDiscount: parseDiscount,
    parseMinPurchase: parseMinPurchase,
    parseMaxDiscount: parseMaxDiscount,
    extractCardLabel: extractCardLabel,
    isGiftCardLabel: isGiftCardLabel,
    extractCardTag: extractCardTag,
    extractCode: extractCode,
    isExhausted: isExhausted,
    looksLikeFullCard: looksLikeFullCard,
    collectCandidateCards: collectCandidateCards,
    findConditionsTrigger: findConditionsTrigger,
    expandToConditionsTrigger: expandToConditionsTrigger,
    isVoucherDetailsHref: isVoucherDetailsHref,
    isConditionsPageHref: isConditionsPageHref,
    promotionIdFromHref: promotionIdFromHref,
    extractVoucherTimes: extractVoucherTimes,
    readValidityFromMicrositeApi: readValidityFromMicrositeApi,
    waitForContent: waitForContent,
    waitForStableCandidates: waitForStableCandidates,
    scrollToLoad: scrollToLoad,
    condenseConditions: condenseConditions,
    readCardConditions: readCardConditions,
    readVoucherDetailsText: readVoucherDetailsText,
    pollVoucherDetails: pollVoucherDetails,
    sameConditionsPage: sameConditionsPage,
    openModalText: openModalText,
    collectModalTexts: collectModalTexts,
    clickWithoutNavigating: clickWithoutNavigating,
    COUPON_URL: COUPON_URL,
    CONDITIONS_TOTAL_BUDGET_MS: CONDITIONS_TOTAL_BUDGET_MS,
    CONDITIONS_PER_CARD_MS: CONDITIONS_PER_CARD_MS,
    CANDIDATE_STABLE_MS: CANDIDATE_STABLE_MS,
  };
});
