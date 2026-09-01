/**
 * Padrão UMD, igual aos outros scrapers do projeto:
 *  - Content script (browser): registra `window.MlCouponScraper` e instala o
 *    listener de mensagens;
 *  - Node/testes: `module.exports` com as funções de parse, SEM tocar em
 *    window/chrome (ver tests/mlCouponScraper.test.ts).
 *
 * A separação importa: os seletores desta página são o ponto mais frágil da
 * feature, e sem poder exercitá-los contra HTML real num teste, cada mudança de
 * layout do ML só apareceria em produção.
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime) {
    return; // Node/teste: só as funções puras.
  }
  window.MlCouponScraper = api;
  if (window.__achadinhoMlCouponScraperLoaded) {
    console.log('[AchadinhoPRO:MLCupons] Já carregado — ignorando re-injeção');
    return;
  }
  window.__achadinhoMlCouponScraperLoaded = true;
  api._install();
})(function () {
  'use strict';

  // Scraper dos CUPONS GERADOS pelo usuário no Mercado Livre
  // (https://www.mercadolivre.com.br/afiliados/coupons#hub).
  //
  // Componente novo e independente do módulo de cupons da Shopee: nenhuma linha de
  // sho-coupon-scraper.js é reaproveitada. O que os dois compartilham é só o
  // contrato de mensagem e o motor de preço, que vive no servidor.
  //
  // ⚠️ TRÊS DECISÕES QUE PARECEM DETALHE E NÃO SÃO:
  //
  // 1. NÃO ESTÁ NO MANIFEST. É injetado por chrome.scripting.executeScript. Se
  //    entrasse em content_scripts com match do ML, rodaria em TODA página do
  //    Mercado Livre junto com ml-scraper.js e disputaria a action 'ping' —
  //    ensureContentScriptInjected aceita a PRIMEIRA resposta, então a extração de
  //    produto passaria a cair aqui de vez em quando.
  //
  // 2. ACTIONS EXCLUSIVAS ('pingMlCoupons', 'extractMlCouponsPage', 'mlCouponNextPage').
  //    Em qualquer aba do
  //    ML o ml-scraper.js já está ativo e responde 'ping'/'extractAllOffers'; este
  //    arquivo nunca reage a essas.
  //
  // 3. GUARDA DE IDEMPOTÊNCIA. O fluxo Shopee usa uma janela popup criada e
  //    destruída a cada import, então re-injeção nunca acontece. Aqui a aba é REAL e
  //    o usuário a mantém aberta: sem a guarda, cada sincronização registraria outro
  //    onMessage e dois listeners responderiam à mesma mensagem ("message channel
  //    closed before a response was received").
  //
  // O PARSE DAS CONDIÇÕES É DO SERVIDOR. Este arquivo captura o texto do modal em
  // `rawText` e não tenta derivar mínimo/teto/período — ver shared/ml-coupon-conditions.ts.
  // O que se extrai do card aqui serve para EXIBIR o cupom no sidepanel.

  var COUPONS_URL = 'https://www.mercadolivre.com.br/afiliados/coupons#hub';

  // Aba "Códigos gerados". Os IDs das abas são estáveis (ao contrário dos
  // `_r_XXX_` dos cards, que mudam a cada render).
  var TAB_GENERATED = '#coupons-tabs-tab-1';
  var CARD_SELECTOR = '.generated-coupon-item';
  // O "Ver produtos". NÃO exige [href]: ver waitForCouponHrefs e extractCard.
  var LINK_SELECTOR = '[class*="__category-link"] a, a[class*="__link"]';
  var LINK_WITH_HREF_SELECTOR = '[class*="__category-link"] a[href], a[class*="__link"][href]';

  function isContextValid() {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function text(el) {
    return el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /** Espera um seletor aparecer; resolve com o elemento ou null no timeout. */
  function waitFor(selector, timeoutMs, root) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function poll() {
        var el = (root || document).querySelector(selector);
        if (el) return resolve(el);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(poll, 200);
      })();
    });
  }

  /**
   * Quantos CARDS de cupom já têm o href do "Ver produtos" resolvido.
   *
   * ⚠️ ESCOPADO AO CARD — e esse escopo é o conserto de um defeito que envenenou dois
   * diagnósticos seguidos. Contando `document.querySelectorAll(LINK_WITH_HREF_SELECTOR)`,
   * o ramo `a[class*="__link"][href]` casava a mobília da página (menu, rodapé, nav do
   * ML). Na sincronização de 26/jul/2026 19:09 isso devolveu 13 "âncoras com href" numa
   * página cujos 8 cupons estavam TODOS sem href: como 13 ≥ 10 cards, a espera abaixo
   * resolvia no primeiro poll (nunca esperou um milissegundo) e o dump ainda registrava
   * `linksWithHrefNow: 13`, sugerindo que as URLs estavam lá.
   *
   * `root` existe só para o teste: em runtime é sempre o documento.
   */
  function countCouponHrefs(root) {
    var cards = (root || document).querySelectorAll(CARD_SELECTOR);
    var n = 0;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].querySelector(LINK_WITH_HREF_SELECTOR)) n += 1;
    }
    return n;
  }

  /**
   * Cards que PODEM ganhar href. O inativo não tem `<a>` nenhum (vira `<span>` com
   * `__disabled`), então incluí-lo no alvo condenaria a espera a estourar o timeout
   * sempre que houvesse um cupom expirado na lista.
   */
  function countActiveCards(root) {
    var cards = (root || document).querySelectorAll(CARD_SELECTOR);
    var n = 0;
    for (var i = 0; i < cards.length; i++) {
      if (!isDisabled(cards[i])) n += 1;
    }
    return n;
  }

  /**
   * O href do "Ver produtos" nunca aparece nesta página — quanto tempo esperar antes de
   * admitir isso. Duas capturas independentes do DOM (fixture das 12:28 e dump das
   * 19:09 de 26/jul/2026) mostram 100% das âncoras de cupom sem atributo href: o ML
   * resolve o destino no clique, por JS. O padrão observado é "todos ou nenhum", então
   * seguir até os 8 s inteiros só atrasaria TODA sincronização sem recuperar nada.
   * A espera continua existindo para o dia em que o ML voltar a emitir o atributo.
   */
  var NO_HREF_GIVE_UP_MS = 2500;

  /**
   * Espera os `href` do "Ver produtos" aparecerem.
   *
   * POR QUE ISTO EXISTE: em 26/jul/2026 uma sincronização real leu 10 cards e devolveu
   * ZERO cupons. O DOM capturado mostrou os 10 `<a class="...__link" target="_blank">`
   * SEM atributo href — e o mesmo link, clicado à mão segundos depois, navegava normal
   * para `lista.mercadolivre.com.br/_Container_...`.
   *
   * A espera é por CONTAGEM ESTÁVEL de cards com href, não por "todos preenchidos".
   */
  function waitForCouponHrefs(expectedCards, timeoutMs) {
    return new Promise(function (resolve) {
      // Sem card não há href a esperar — e esperar aqui só atrasaria em 8 s o
      // diagnóstico de "a aba não tem cupom nenhum".
      if (!expectedCards) return resolve(0);
      var start = Date.now();
      var last = -1;
      var stableFor = 0;
      (function poll() {
        var n = countCouponHrefs();
        // O alvo é recalculado a cada poll: `isDisabled` decide pelo TEXTO do card, que
        // pode não estar renderizado no primeiro tick.
        var alvo = countActiveCards();
        // Todos os cards ativos já com URL: não há o que esperar.
        if (alvo > 0 && n >= alvo) return resolve(n);
        if (n > 0 && n === last) {
          stableFor += 250;
          if (stableFor >= 500) return resolve(n);
        } else {
          stableFor = 0;
        }
        // Nenhum href depois da janela curta: esta página não emite o atributo.
        if (n === 0 && Date.now() - start > NO_HREF_GIVE_UP_MS) return resolve(0);
        last = n;
        if (Date.now() - start > timeoutMs) return resolve(n);
        setTimeout(poll, 250);
      })();
    });
  }

  /** Espera a CONTAGEM de elementos estabilizar (o grid re-renderiza em duas etapas). */
  function waitForStableCount(selector, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var last = -1;
      var stableFor = 0;
      (function poll() {
        var n = document.querySelectorAll(selector).length;
        if (n > 0 && n === last) {
          stableFor += 300;
          if (stableFor >= 600) return resolve(n);
        } else {
          stableFor = 0;
        }
        last = n;
        if (Date.now() - start > timeoutMs) return resolve(n);
        setTimeout(poll, 300);
      })();
    });
  }

  /**
   * Seleciona a aba "Códigos gerados".
   *
   * Sem este clique a página abre em "Cupons disponíveis" e o scraper leria ZERO
   * `generated-coupon-item` — os cards de "Gerar código" são outro componente
   * (`available-coupon-item`), noutra aba, e não interessam: só lemos cupom que o
   * usuário já gerou. O `<span>` do seletor mora DENTRO de um `<button>`; clicar no
   * span não dispara o handler do Andes, daí o `closest('button')`.
   */
  async function selectGeneratedTab() {
    var tab = await waitFor(TAB_GENERATED, 15000);
    if (!tab) return { ok: false, reason: 'aba "Códigos gerados" não encontrada' };

    var button = tab.closest('button') || tab;
    var alreadyActive =
      button.getAttribute('aria-selected') === 'true' ||
      /--active|--selected/.test(button.className || '');

    if (!alreadyActive) {
      button.click();
      await sleep(400);
    }
    var count = await waitForStableCount(CARD_SELECTOR, 15000);
    // O clique acima REMONTA o grid; os href do "Ver produtos" chegam depois dos cards.
    var withHref = await waitForCouponHrefs(count, 8000);
    return { ok: true, count: count, clicked: !alreadyActive, withHref: withHref };
  }

  /**
   * Card inativo/expirado — não vira lista. A PAGINAÇÃO só para quando a página
   * INTEIRA é de cards assim (ver `allInactive` em extractMlCouponsPage).
   *
   * O sinal forte é o badge do Andes, que o ML coloca no card vencido:
   *
   *   <div class="andes-badge … generated-coupon-item__badge …">
   *     <p class="andes-badge__content">Inativo</p>
   *   </div>
   *
   * O texto do card inteiro continua valendo como rede: o badge é o formato de hoje, e
   * um cupom lido como ativo por engano vira lista que promete desconto já vencido.
   */
  function isDisabled(card) {
    if (/--disabled|__disabled/.test(card.className || '')) return true;
    var badge = card.querySelector('[class*="__badge"] .andes-badge__content')
      || card.querySelector('.andes-badge__content');
    if (badge && /inativo|expirado/i.test(text(badge))) return true;
    var t = text(card).toLowerCase();
    return t.indexOf('inativo') !== -1 || t.indexOf('expirado') !== -1;
  }

  // ===== Paginação dos "Códigos gerados" =====
  //
  //   <nav aria-label="Paginação">
  //     <ul class="andes-pagination generated-coupons__pagination">
  //       <li class="andes-pagination__button andes-pagination__button--back">…</li>
  //       <li class="andes-pagination__button andes-pagination__button--current">
  //         <a … aria-current="page" data-andes-state="selected">2</a></li>
  //       <li class="andes-pagination__button andes-pagination__button--next">
  //         <a href="#" data-andes-pagination-control="next">…</a></li>
  //     </ul>
  //   </nav>

  // `root` existe só para o teste; em runtime é sempre o documento (como countCouponHrefs).
  function paginationRoot(root) {
    var doc = root || document;
    return (
      doc.querySelector('.generated-coupons__pagination') ||
      doc.querySelector('nav[aria-label="Paginação"] .andes-pagination')
    );
  }

  /** Número da página atual, ou null quando a página nem tem paginação (lista curta). */
  function currentPageNumber(raiz) {
    var root = paginationRoot(raiz);
    if (!root) return null;
    var atual =
      root.querySelector('.andes-pagination__button--current a') ||
      root.querySelector('a[aria-current="page"]') ||
      root.querySelector('a[data-andes-state="selected"]');
    var n = parseInt(text(atual), 10);
    return isFinite(n) ? n : null;
  }

  /**
   * O `<a>` do "Seguinte", ou null quando não há próxima página.
   *
   * O Andes marca o fim da paginação no `<li>` (`--disabled`) e/ou no `<a>`
   * (`aria-disabled`). Ignorar isso faria a varredura clicar num botão morto e concluir,
   * pela contagem estável de cards, que a página "não mudou" — 15 s perdidos por lote.
   */
  function nextPageButton(raiz) {
    var root = paginationRoot(raiz);
    if (!root) return null;
    var li = root.querySelector('.andes-pagination__button--next');
    if (!li || /--disabled/.test(li.className || '')) return null;
    var a = li.querySelector('a[data-andes-pagination-control="next"]') || li.querySelector('a');
    if (!a) return null;
    // `getAttribute`, e não `hasAttribute`: o scraper inteiro se limita a
    // querySelector/className/textContent/href/getAttribute — é essa superfície mínima
    // que permite exercitá-lo sobre HTML real sem browser.
    if (a.getAttribute('aria-disabled') === 'true' || a.getAttribute('disabled') !== null) return null;
    return a;
  }

  /** Código do primeiro card do grid — testemunha de que a página realmente trocou. */
  function firstCardCode(raiz) {
    var card = (raiz || document).querySelector(CARD_SELECTOR);
    if (!card) return null;
    var b = card.querySelector('[class*="__inner-content"] b') || card.querySelector('b');
    return text(b).replace(/^#/, '').trim() || null;
  }

  /**
   * Avança uma página e espera o grid trocar DE VERDADE.
   *
   * Duas testemunhas, porque nenhuma sozinha basta: o número da paginação muda antes de o
   * grid repintar (ler os cards nesse instante devolveria os da página anterior de novo,
   * e o `seen` os descartaria como duplicata — a página inteira sumiria em silêncio), e o
   * primeiro código muda mesmo quando a paginação não expõe número.
   *
   * O `preventDefault` existe porque o link é `href="#"`: sem ele o clique troca o hash
   * da URL (`#hub` → `#`) e o ML remonta a página na aba errada, jogando fora a seleção
   * de "Códigos gerados". O handler do React continua rodando — o que se cancela é só a
   * navegação do navegador.
   */
  async function goToNextCouponPage() {
    var btn = nextPageButton();
    if (!btn) return { ok: false, reason: 'sem próxima página' };

    var antesNumero = currentPageNumber();
    var antesCodigo = firstCardCode();

    var bloqueiaHash = function (ev) { ev.preventDefault(); };
    document.addEventListener('click', bloqueiaHash, true);
    try {
      btn.click();
    } finally {
      document.removeEventListener('click', bloqueiaHash, true);
    }

    var start = Date.now();
    while (Date.now() - start < 15000) {
      await sleep(250);
      var agoraNumero = currentPageNumber();
      var agoraCodigo = firstCardCode();
      var mudou =
        (antesNumero != null && agoraNumero != null && agoraNumero !== antesNumero) ||
        (antesCodigo && agoraCodigo && agoraCodigo !== antesCodigo);
      if (!mudou) continue;
      // O grid monta em duas etapas; ler no primeiro tick pega metade dos cards.
      var count = await waitForStableCount(CARD_SELECTOR, 10000);
      if (!count) return { ok: false, reason: 'a página seguinte não montou cards' };
      // Os href chegam depois dos cards, como na primeira página.
      await waitForCouponHrefs(count, 5000);
      return { ok: true, pageNumber: currentPageNumber(), cardsFound: count };
    }
    return { ok: false, reason: 'a paginação não respondeu ao clique' };
  }

  /**
   * "68743 reais com 70 centavos" → 6874370.
   *
   * A leitura é do `aria-label` do Andes, e não do texto visível, porque o valor
   * exibido vem quebrado em vários `<span>` (símbolo, inteiro, fração) e concatená-los
   * produz "R$68.74370". O aria-label é a única representação íntegra do número.
   */
  function parseAndesMoneyToCents(ariaLabel) {
    if (!ariaLabel) return null;
    // "real" (singular) e "reais" — o Andes usa os dois conforme o valor.
    var m = /(\d[\d.]*)\s*re(?:al|ais)(?:\s*com\s*(\d+)\s*centavos?)?/i.exec(ariaLabel);
    if (!m) return null;
    var reais = parseInt(String(m[1]).replace(/\./g, ''), 10);
    var centavos = m[2] ? parseInt(m[2], 10) : 0;
    if (!isFinite(reais)) return null;
    return reais * 100 + centavos;
  }

  /** Desconto do card ("7% OFF" / "R$ 200 OFF") — exibição, não cálculo. */
  function parseCardDiscount(raw) {
    if (!raw) return null;
    var pct = /(\d+(?:[.,]\d+)?)\s*%/.exec(raw);
    if (pct) {
      var v = Math.floor(parseFloat(pct[1].replace(',', '.')));
      if (v >= 1 && v <= 100) return { discountType: 'percent', discountValue: v };
    }
    var fixed = /R\$\s*([\d.,]+)/.exec(raw);
    if (fixed) {
      var cents = parseAndesMoneyToCents(fixed[1] + ' reais');
      if (cents == null) {
        var n = parseFloat(fixed[1].replace(/\./g, '').replace(',', '.'));
        cents = isFinite(n) ? Math.round(n * 100) : null;
      }
      if (cents) return { discountType: 'fixed', discountValue: cents };
    }
    return null;
  }

  /**
   * Extrai um card. Seletores partem do CARD e usam CLASSE — nunca `id`
   * (`_r_XXX_` muda a cada render) nem `nth-child` (a ordem dos blocos difere
   * entre card ativo e inativo).
   */
  function extractCard(card) {
    var codeEl = card.querySelector('[class*="__inner-content"] b') || card.querySelector('b');
    var code = text(codeEl).replace(/^#/, '').trim();
    if (!code) return { skip: 'sem código' };

    // `alias<N>` no <b> do código: único por cupom e estável entre renders (ao contrário
    // do id `_r_XXX_`). Não é usado como chave de negócio — o índice do banco é
    // (user_id, marketplace, code) — mas é o que permite distinguir dois cupons de MESMO
    // desconto no diagnóstico.
    var aliasMatch = /(?:^|\s)(alias\d+)(?:\s|$)/.exec((codeEl && codeEl.className) || '');

    var discountRaw = text(card.querySelector('[class*="__inner-details-title"]'));
    var discount = parseCardDiscount(discountRaw);

    // ⚠️ O seletor NÃO exige [href] — e isso é o coração do bug de 26/jul/2026.
    //
    // A premissa antiga ("o link só existe com href em cupom ativo, então a ausência já
    // descarta o inativo") é falsa nos dois sentidos: o cupom ATIVO nasce com o <a> sem
    // href (a URL chega depois — ver waitForCouponHrefs), e o cupom INATIVO nem <a> tem
    // (vira <span> com __disabled). Quem descarta inativo é, e sempre foi, isDisabled().
    //
    // Com [href] no seletor, todo cupom ativo era lido como "sem Ver produtos" e a
    // sincronização devolvia zero.
    var linkEl = card.querySelector(LINK_SELECTOR);
    var linkHref = linkEl ? linkEl.getAttribute('href') : null;
    // `.href` absolutiza; só faz sentido quando o atributo existe (sem ele o DOM
    // devolveria a URL da PÁGINA DE CUPONS, e o vínculo casaria com a aba errada).
    var productsUrl = linkHref ? linkEl.href : null;

    var budgetEl = card.querySelector('[class*="__budget"] .andes-money-amount[aria-label]')
      || card.querySelector('.andes-money-amount[aria-label]');
    var budgetRemainingCents = budgetEl
      ? parseAndesMoneyToCents(budgetEl.getAttribute('aria-label'))
      : null;

    return {
      code: code,
      aliasId: aliasMatch ? aliasMatch[1] : null,
      // Distingue "o ML ainda não resolveu a URL" (hasLink true, productsUrl null) de
      // "este card não tem link nenhum" (cupom inativo). Sem essa distinção o
      // diagnóstico volta a dizer só "sem Ver produtos" para dois defeitos diferentes.
      hasLink: !!linkEl,
      discountRaw: discountRaw || null,
      discountType: discount ? discount.discountType : null,
      discountValue: discount ? discount.discountValue : null,
      // "Vence em 18 de agosto" — SEM ano. Fica só como rótulo do sidepanel; a data
      // que vale vem do modal (que traz o ano) e é parseada no servidor.
      expirationRaw: text(card.querySelector('[class*="__expiration"]')) || null,
      // `[class*="__category"]` sozinho casaria também `__category-link`, que
      // ENVOLVE o link — a categoria sairia como "Casa e Decoração Ver produtos".
      couponCategory:
        text(card.querySelector('[class*="__category"]:not([class*="__category-link"])')) || null,
      productsUrl: productsUrl,
      budgetRemainingCents: budgetRemainingCents,
      cardText: text(card).slice(0, 400),
    };
  }

  /**
   * Único lugar que decide descartar um cupom lido. Devolve o motivo, ou null.
   *
   * É uma função à parte para que a regra seja testável sem DOM — e para que a ausência
   * de `productsUrl` NUNCA volte a virar motivo de descarte por distração: foi assim que
   * a sincronização de 26/jul/2026 devolveu zero cupons tendo dez na tela. Cupom sem URL
   * é cupom EXIBIDO com aviso; quem trata a falta da URL é o painel.
   */
  /**
   * Reencontra um card pelo CÓDIGO no DOM atual.
   *
   * A chave é o código porque é o único identificador estável do cupom: o `id` do card
   * (`_r_XXX_`) muda a cada render, e a posição no grid pode mudar com ele.
   */
  function findCardByCode(code) {
    if (!code) return null;
    var atuais = document.querySelectorAll(CARD_SELECTOR);
    for (var i = 0; i < atuais.length; i++) {
      var b =
        atuais[i].querySelector('[class*="__inner-content"] b') || atuais[i].querySelector('b');
      if (text(b).replace(/^#/, '').trim() === code) return atuais[i];
    }
    return null;
  }

  function skipReason(data) {
    if (!data) return 'card vazio';
    if (data.skip) return data.skip;
    // Orçamento zerado = cupom esgotado; a lista dele é podada no servidor.
    if (data.budgetRemainingCents === 0) return data.code + ': orçamento zerado';
    return null;
  }

  function findModalTrigger(card) {
    var candidates = card.querySelectorAll('[class*="__modal-trigger"], [data-testid="info-icon"]');
    for (var i = 0; i < candidates.length; i++) {
      // O span embrulha texto E um <img>; conferir o texto evita clicar no ícone errado.
      if (/condi/i.test(text(candidates[i])) || candidates[i].getAttribute('data-testid') === 'info-icon') {
        return candidates[i];
      }
    }
    return candidates.length > 0 ? candidates[0] : null;
  }

  var MODAL_CONTENT_SELECTOR =
    '.coupons-grid__conditions-modal .andes-modal__content, .andes-modal__content';

  /** Texto útil de um nó — o que de fato vai virar `rawText`. */
  function modalText(el) {
    if (!el) return '';
    return String(el.innerText || el.textContent || '').replace(/ /g, ' ').trim();
  }

  /**
   * Espera o modal ter TEXTO, não apenas existir.
   *
   * O container do Andes fica montado e vazio na página; esperar pelo elemento fazia a
   * leitura resolver instantaneamente com conteúdo vazio. O piso de 20 caracteres separa
   * "ainda renderizando" de "condições de verdade" — o menor modal real do ML tem a
   * linha do ID mais a de vigência, muito acima disso.
   *
   * Varre TODOS os candidatos porque, com mais de um `.andes-modal__content` no DOM, o
   * primeiro costuma ser o de outro componente (menu, tooltip), não o das condições.
   */
  function waitForModalContent(timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function poll() {
        var nodes = document.querySelectorAll(MODAL_CONTENT_SELECTOR);
        for (var i = 0; i < nodes.length; i++) {
          if (modalText(nodes[i]).length >= 20) return resolve(nodes[i]);
        }
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(poll, 200);
      })();
    });
  }

  /**
   * O modal está aberto DE VERDADE?
   *
   * Presença do container não serve como resposta: o Andes o deixa montado e vazio na
   * página. Usar `querySelector('.andes-modal__content')` como sinal de "aberto" faz
   * `closeModal` girar até o timeout e devolver false para todo cupom — a leitura
   * inteira vira "modal preso" e nenhuma condição é lida. Só conta modal com a classe
   * de ativo ou com texto de verdade.
   */
  function modalIsOpen() {
    if (document.querySelector('.andes-modal--active')) return true;
    var nodes = document.querySelectorAll(MODAL_CONTENT_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      if (modalText(nodes[i]).length >= 20) return true;
    }
    return false;
  }

  /**
   * Fotografa o estado dos containers de modal no instante de uma desistência.
   * Vai inteiro para o dump de diagnóstico — é a única testemunha do que o ML
   * mostrou (ou não mostrou) dentro do modal que a leitura considerou vazio.
   */
  function modalFailSample() {
    var nodes = document.querySelectorAll(MODAL_CONTENT_SELECTOR);
    var html = [];
    for (var i = 0; i < nodes.length && i < 3; i++) {
      html.push(String(nodes[i].innerHTML || '').slice(0, 600));
    }
    return {
      active: !!document.querySelector('.andes-modal--active'),
      nodes: nodes.length,
      html: html,
    };
  }

  async function closeModal() {
    var closeBtn = document.querySelector('.andes-modal__close-button, .andes-modal button[aria-label*="ech"]');
    if (closeBtn) {
      closeBtn.click();
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    // O modal é SINGLETON: se o anterior não fechar, o próximo clique reabre o mesmo
    // conteúdo e todos os cupons herdariam as condições do primeiro. Por isso o
    // resultado é DEVOLVIDO — quem chama precisa saber que não fechou.
    var start = Date.now();
    while (modalIsOpen()) {
      if (Date.now() - start > 3000) return false;
      await sleep(150);
    }
    // Folga depois do fechamento: o Andes remonta o grid ao desmontar o modal, e clicar
    // no gatilho seguinte durante esse repinte cai num nó que está sendo substituído.
    await sleep(400);
    return true;
  }

  /**
   * Abre o modal "Condições do cupom" e devolve o texto bruto.
   *
   * TRAVA ANTI-TROCA — TRÊS CAMADAS, e nenhuma é redundante:
   *
   * 1. TÍTULO: o modal repete o desconto do card. Se divergir, as condições são
   *    DESCARTADAS em vez de atribuídas ao cupom errado.
   * 2. FECHAMENTO CONFIRMADO: o modal é singleton. Se o anterior não fechou, o clique
   *    seguinte reexibe o mesmo conteúdo — e a camada 1 NÃO pega isso quando os dois
   *    cupons têm o mesmo desconto.
   * 3. TEXTO REPETIDO EM DESCONTO AMBÍGUO: `ambiguousDiscount` marca o card cujo
   *    desconto aparece em mais de um cupom. Nesses, rawText byte-idêntico ao do cupom
   *    anterior é indistinguível de modal preso — e o texto é descartado.
   *
   * A camada 1 sozinha era falsa segurança: nos 10 cupons reais do usuário há DOIS pares
   * de desconto idêntico (R$ 300 OFF ×2, R$ 20 OFF ×2). Modal preso passaria pela
   * checagem de título e a lista herdaria mínimo, teto e VALIDADE de outro cupom —
   * anunciando preço que o checkout recusa.
   *
   * Descartar o rawText não perde o cupom: ele entra sem preço calculado, com validade
   * de 48 h, e o card avisa. Errar o rawText é que é irreversível para o assinante.
   */
  async function readConditions(card, cardData, previousRawText) {
    var trigger = findModalTrigger(card);
    if (!trigger) return { rawText: null, warning: 'sem gatilho de condições' };

    // Camada 2 (preventiva): sobra de modal do card anterior contaminaria esta leitura.
    if (modalIsOpen()) {
      if (!(await closeModal())) {
        return { rawText: null, warning: 'modal anterior não fechou', modalStuck: true };
      }
    }

    trigger.click();
    // Espera CONTEÚDO, não o elemento. O Andes deixa o container do modal montado e
    // vazio no DOM: `waitFor('.andes-modal__content')` voltava no ato com um nó sem
    // texto, o rawText saía string vazia e o servidor gravava conditionsParsed=false —
    // foi assim que 4 cupons chegaram ao banco com rawLen=0 em 26/jul/2026, e o painel
    // dizia "condições não lidas" sem que ninguém soubesse por quê.
    var content = await waitForModalContent(8000);
    if (!content) {
      // SEGUNDA TENTATIVA, com o nó REVIVIDO. O grid remonta na mesma cadência a cada
      // sincronização (mesmos cupons, mesma ordem), então o clique que cai num nó
      // recém-substituído falha nos MESMOS cupons todas as vezes — no teste de
      // 29/jul/2026 foram sempre os 3 mesmos, com staleCards 14 de 22. O gatilho é
      // relido do DOM atual porque o `trigger` da primeira tentativa pode ser
      // exatamente o nó morto que causou a falha.
      var sample = modalFailSample();
      await closeModal();
      var vivoAgora = card.isConnected ? card : findCardByCode(cardData.code);
      var triggerVivo = vivoAgora ? findModalTrigger(vivoAgora) : null;
      if (triggerVivo) {
        triggerVivo.click();
        content = await waitForModalContent(8000);
      }
      if (!content) {
        var vazio = document.querySelector(MODAL_CONTENT_SELECTOR);
        await closeModal();
        return {
          rawText: null,
          // A distinção importa para calibrar: "não abriu" é gatilho/clique; "abriu
          // vazio" é conteúdo que chega depois ou vem de outro nó.
          warning: (vazio ? 'modal abriu sem texto' : 'modal não abriu') + ' (2 tentativas)',
          modalFailed: true,
          // O que havia DENTRO do modal quando a 1ª tentativa desistiu: spinner,
          // esqueleto, erro do ML ou nada — é o dado que separa "nosso clique morreu"
          // de "o ML não entrega as condições desta campanha".
          failSample: sample,
        };
      }
    }

    var modalRoot = content.closest('.andes-modal') || document;
    var title = text(modalRoot.querySelector('.andes-modal__title'));
    var rawText = modalText(content);
    var closed = await closeModal();

    if (cardData.discountRaw && title) {
      var normalize = function (s) { return s.replace(/\s+/g, '').toLowerCase(); };
      if (normalize(title).indexOf(normalize(cardData.discountRaw)) === -1) {
        return {
          rawText: null,
          warning: 'título do modal ("' + title + '") não bate com o card ("' + cardData.discountRaw + '")',
          modalStuck: !closed,
        };
      }
    }

    // Camada 3: só em desconto ambíguo — dois cupons distintos PODEM ter condições
    // idênticas de verdade, e descartar isso sempre seria perda gratuita.
    if (cardData.ambiguousDiscount && previousRawText && rawText === previousRawText) {
      return {
        rawText: null,
        warning: 'condições iguais às do cupom anterior com desconto ambíguo — descartadas por segurança',
        modalStuck: !closed,
      };
    }

    return { rawText: rawText.slice(0, 4000), warning: null, modalStuck: !closed };
  }

  /**
   * Estado que atravessa as PÁGINAS de uma mesma sincronização.
   *
   * Cada página é uma mensagem separada (o service worker intercala leitura e captura de
   * URL — ver `extractMlCouponsPage`), então o que era variável local do laço agora
   * precisa sobreviver entre chamadas: o `seen` deduplica cupom que reaparece noutra
   * página, o `previousRawText` é a camada 3 da trava anti-troca do modal, e o
   * `modalGaveUp` não pode ressuscitar a cada página nova.
   */
  var estadoLeitura = null;

  function novoEstadoLeitura() {
    return {
      seen: {},
      discountTally: {},
      previousRawText: null,
      modalFailStreak: 0,
      modalGaveUp: false,
      paginasLidas: 0,
      tabResult: null,
    };
  }

  /**
   * Lê UMA página do grid "Códigos gerados".
   *
   * `first: true` reinicia o estado e seleciona a aba; nas seguintes o grid já está na
   * página certa (quem navegou foi `goToNextCouponPage`).
   */
  async function extractMlCouponsPage(first) {
    if (first || !estadoLeitura) {
      estadoLeitura = novoEstadoLeitura();
      var tabResult = await selectGeneratedTab();
      if (!tabResult.ok) {
        estadoLeitura = null;
        return { success: false, error: tabResult.reason, data: [], count: 0, sourceUrl: COUPONS_URL };
      }
      estadoLeitura.tabResult = tabResult;
    }
    var est = estadoLeitura;
    est.paginasLidas += 1;
    var tabResult = est.tabResult || { clicked: false, count: 0, withHref: 0 };

    var cards = Array.prototype.slice.call(document.querySelectorAll(CARD_SELECTOR));
    var coupons = [];
    var skipped = [];
    var seen = est.seen;
    // Cards INATIVOS desta página. A premissa antiga — "o ML empurra os vencidos para o
    // fim, então o primeiro inativo encerra a varredura" — se provou falsa na prática:
    // havia cupom válido DEPOIS de um inativo, e a parada precoce o deixava de fora.
    // Hoje `foundInactive` é só diagnóstico; quem encerra a varredura é `allInactive`
    // (página inteira sem nenhum cupom válido), decidido no service worker.
    var foundInactive = false;
    var inativos = 0;

    // Descontos repetidos: alimenta a camada 3 da trava anti-troca. O tally é ACUMULADO
    // entre páginas, não por página: dois cupons de mesmo desconto em páginas diferentes
    // são tão ambíguos quanto dois na mesma, e a leitura deles é sequencial do mesmo
    // jeito (a última do card da página N e a primeira da N+1 são vizinhas).
    var discountTally = est.discountTally;
    for (var d = 0; d < cards.length; d++) {
      var raw = text(cards[d].querySelector('[class*="__inner-details-title"]'));
      if (raw) discountTally[raw] = (discountTally[raw] || 0) + 1;
    }

    // Fail-fast do modal: cada leitura travada custa até 8 s de espera + 3 s de
    // fechamento. Com o timeout de 180 s do service worker, insistir em 10 cupons com o
    // modal quebrado devolveria "Timeout na leitura dos cupons" — ou seja, ZERO cupons
    // de novo, agora por outro motivo. Após 2 falhas seguidas os cupons restantes entram
    // sem condições (com aviso), que é degradação, não perda.
    var modalFailStreak = est.modalFailStreak;
    var modalGaveUp = est.modalGaveUp;
    var previousRawText = est.previousRawText;

    var staleCards = 0;
    var modalFailSamples = [];

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (isDisabled(card)) {
        foundInactive = true;
        inativos += 1;
        skipped.push('inativo');
        continue;
      }

      var data = extractCard(card);
      var motivo = skipReason(data);
      if (motivo) { skipped.push(motivo); continue; }
      if (seen[data.code]) continue;
      seen[data.code] = true;

      // ⚠️ RELÊ O CARD PELO DOM ATUAL antes de qualquer interação.
      //
      // O array `cards` é uma fotografia: o React remonta o grid (ao fechar o modal, ao
      // resolver as URLs dos cupons) e os nós fotografados saem do documento. Um nó
      // desses aceita `.click()` sem efeito nenhum e devolve o estado ANTIGO dos
      // atributos — foi exatamente o que a sincronização de 26/jul/2026 15:12 mostrou:
      // o 1º cupom leu o modal e todos os seguintes deram "modal não abriu", enquanto o
      // diagnóstico contava 13 âncoras COM href na página e 9 cupons SEM URL.
      var vivo = card.isConnected ? card : findCardByCode(data.code);
      if (vivo && vivo !== card) {
        staleCards += 1;
        card = vivo;
        // Relê tudo do nó vivo: o href do "Ver produtos" costuma chegar justamente
        // nesse re-render, e é a última chance de capturá-lo.
        var refeito = extractCard(card);
        if (!refeito.skip) {
          refeito.ambiguousDiscount = data.ambiguousDiscount;
          data = refeito;
        }
      } else if (!vivo) {
        staleCards += 1;
        // Sem nó vivo não há modal a abrir: o cupom entra com o que já foi lido.
        data.warning = 'card saiu da página durante a leitura';
        data.ambiguousDiscount = !!(data.discountRaw && discountTally[data.discountRaw] > 1);
        coupons.push(data);
        continue;
      }

      // ⚠️ Cupom SEM URL NÃO é descartado (era exatamente isso que zerava a
      // sincronização). Sem a URL ele não vira lista sozinho — o vínculo aba↔cupom
      // depende dela —, mas aparece no painel, com aviso e caminho manual de vínculo.
      // Sumir em silêncio é o pior dos dois mundos: o usuário vê "0 cupons" tendo 10.
      data.ambiguousDiscount = !!(data.discountRaw && discountTally[data.discountRaw] > 1);

      if (modalGaveUp) {
        data.rawText = null;
        data.warning = 'condições não lidas: o modal parou de responder nesta página';
      } else {
        // Sequencial de propósito: o modal é singleton, então abrir o próximo antes de
        // fechar o anterior misturaria as condições.
        var conditions = await readConditions(card, data, previousRawText);
        data.rawText = conditions.rawText;
        if (conditions.warning) data.warning = conditions.warning;
        if (conditions.failSample) {
          // Vai no debug da página, NÃO no cupom: `data` é o payload do upsert.
          modalFailSamples.push({ code: data.code, sample: conditions.failSample });
        }
        if (conditions.rawText) previousRawText = conditions.rawText;

        if (conditions.modalFailed || conditions.modalStuck) {
          modalFailStreak += 1;
          // 3, não 2: a primeira versão desistia rápido demais. Na sincronização de
          // 26/jul/2026 o 2º e o 3º cupom falharam por nó obsoleto — defeito já
          // corrigido acima — e o fail-fast cancelou a leitura dos SEIS restantes, que
          // teriam funcionado. Uma tentativa a mais custa ~8 s; desistir cedo custa a
          // feature.
          if (modalFailStreak >= 3) modalGaveUp = true;
        } else {
          modalFailStreak = 0;
        }
      }

      coupons.push(data);
    }

    // Segunda passada pelas URLs. O ML resolve o href do "Ver produtos" bem depois de
    // montar o card — mais do que os 8 s que a espera inicial concede —, e o laço acima
    // acabou de gastar vários segundos abrindo modais. Reler agora custa um
    // querySelectorAll e recupera cupons que sairiam sem link.
    var recuperadas = 0;
    for (var u = 0; u < coupons.length; u++) {
      if (coupons[u].productsUrl) continue;
      var atual = findCardByCode(coupons[u].code);
      if (!atual) continue;
      var linkEl = atual.querySelector(LINK_SELECTOR);
      var href = linkEl ? linkEl.getAttribute('href') : null;
      if (href) {
        coupons[u].productsUrl = linkEl.href;
        recuperadas += 1;
      }
    }

    // Devolve o estado do modal para a próxima página: `modalGaveUp` que ressuscitasse a
    // cada página faria a leitura insistir 8 s por cupom numa página inteira já sabida
    // quebrada.
    est.modalFailStreak = modalFailStreak;
    est.modalGaveUp = modalGaveUp;
    est.previousRawText = previousRawText;

    var cardsWithHref = countCouponHrefs();
    var semUrl = coupons.filter(function (c) { return !c.productsUrl; }).length;
    var semCondicoes = coupons.filter(function (c) { return !c.rawText; }).length;

    var result = {
      success: true,
      data: coupons,
      // Sinais da paginação, lidos DEPOIS da leitura (o grid pode ter remontado).
      pageNumber: currentPageNumber() || est.paginasLidas,
      hasNext: !!nextPageButton(),
      foundInactive: foundInactive,
      // Fim da varredura: TODOS os cards da página com badge/estado de inativo
      // (isDisabled). Card pulado por outro motivo (sem código, orçamento zerado) NÃO
      // conta — na dúvida a varredura continua, que é o lado que não perde cupom. Uma
      // página mista segue paginando; os inativos já saíram via `skipped`.
      allInactive: cards.length > 0 && inativos === cards.length,
      count: coupons.length,
      skipped: skipped,
      cardsFound: cards.length,
      couponsWithoutUrl: semUrl,
      sourceUrl: COUPONS_URL,
    };

    // O diagnóstico sai também em SUCESSO PARCIAL. Na falha de 26/jul/2026 os 10 cards
    // foram lidos e todos descartados; o dump chegou ao servidor sem o `skipped`, que
    // era a única linha que dizia "BL267POFF: sem Ver produtos" — e sem ela a
    // investigação começou pelo lado errado. Cupom sem URL é sintoma do mesmo defeito,
    // então também dispara o dump.
    if (coupons.length === 0 || skipped.length > 0 || semUrl > 0 || semCondicoes > 0) {
      result.debug = {
        url: window.location.href,
        title: document.title,
        pageNumber: result.pageNumber,
        hasNext: result.hasNext,
        foundInactive: foundInactive,
        allInactive: result.allInactive,
        tabClicked: tabResult.clicked,
        stableCount: tabResult.count,
        cardsFound: cards.length,
        couponsFound: coupons.length,
        couponsWithoutUrl: semUrl,
        // Distingue "o href ainda não chegou" de "o seletor do card está errado" — os
        // dois se apresentam como zero cupons e têm correções opostas.
        //
        // Contados DENTRO dos cards (ver countCouponHrefs). Os campos antigos
        // `linksWithHrefAfterWait`/`linksWithHrefNow` varriam o documento inteiro e
        // reportavam 13 numa página com zero href de cupom — os nomes mudaram junto
        // com a conta para que nenhum dump velho seja lido como se fosse desta versão.
        cardsWithHrefAfterWait: tabResult.withHref,
        cardsWithHrefNow: cardsWithHref,
        activeCards: countActiveCards(),
        modalGaveUp: modalGaveUp,
        couponsWithoutConditions: semCondicoes,
        // Quantos cards o React substituiu no meio da leitura, e quantas URLs a segunda
        // passada recuperou. Se `staleCards` for alto, o grid está sendo remontado a
        // cada modal — e é aí que mora qualquer falha em cascata a partir do 2º cupom.
        staleCards: staleCards,
        urlsRecoveredOnSecondPass: recuperadas,
        // O motivo POR CUPOM. Sem isto, "condições não lidas" é um beco sem saída: não
        // se sabe se o gatilho não foi achado, se o modal não abriu, se abriu vazio ou
        // se a trava anti-troca descartou o texto — e cada caso tem conserto diferente.
        modalWarnings: coupons
          .filter(function (c) { return c.warning; })
          .slice(0, 20)
          .map(function (c) { return c.code + ': ' + c.warning; }),
        modalFailSamples: modalFailSamples.slice(0, 5),
        // Amostra do modal ainda no DOM, para calibrar o seletor sem browser.
        modalSample: (function () {
          var n = document.querySelector(MODAL_CONTENT_SELECTOR);
          return n ? String(n.innerHTML || '').slice(0, 3000) : null;
        })(),
        modalNodes: document.querySelectorAll(MODAL_CONTENT_SELECTOR).length,
        skipped: skipped.slice(0, 40),
        availableCards: document.querySelectorAll('.available-coupon-item').length,
        htmlSample: (document.querySelector('.coupons-grid__content') || document.body).innerHTML.slice(0, 60000),
      };
    }
    return result;
  }

  function install() {
    console.log('[AchadinhoPRO:MLCupons] Content script carregado');

    chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
      if (!isContextValid()) return false;

      // Actions exclusivas: 'ping' e 'extractAllOffers' são do ml-scraper.js, que está
      // ativo nesta mesma aba. Responder a elas quebraria a extração de produto.
      if (message.action === 'pingMlCoupons') {
        sendResponse({ status: 'ok', marketplace: 'ml', scraper: 'coupons' });
        return true;
      }

      // UMA PÁGINA POR MENSAGEM, e não o grid inteiro numa chamada só. O motivo é o
      // "Ver produtos": a URL dele só existe depois que a sonda do service worker CLICA
      // no card, e o card só existe no DOM enquanto sua página está montada. Lendo tudo
      // de uma vez, a sonda chegaria com as páginas 1..N-1 já desmontadas e só os cupons
      // da última teriam link.
      if (message.action === 'extractMlCouponsPage') {
        extractMlCouponsPage(!!(message && message.first))
          .then(function (result) {
            console.log(
              '[AchadinhoPRO:MLCupons] página', result.pageNumber, '→', result.count,
              'cupons de', result.cardsFound, 'cards',
              result.allInactive
                ? '(página só com inativos: fim da varredura)'
                : result.foundInactive ? '(inativos pulados, varredura segue)' : '',
            );
            sendResponse(result);
          })
          .catch(function (err) {
            sendResponse({ success: false, error: (err && err.message) || String(err), data: [], count: 0 });
          });
        return true; // resposta assíncrona
      }

      if (message.action === 'mlCouponNextPage') {
        goToNextCouponPage()
          .then(function (r) { sendResponse(r); })
          .catch(function (err) {
            sendResponse({ ok: false, reason: (err && err.message) || String(err) });
          });
        return true;
      }

      return false;
    });
  }

  return {
    // Entradas de runtime
    _install: install,
    extractMlCouponsPage: extractMlCouponsPage,
    goToNextCouponPage: goToNextCouponPage,
    selectGeneratedTab: selectGeneratedTab,
    // Primitivas puras (expostas para teste)
    parseAndesMoneyToCents: parseAndesMoneyToCents,
    parseCardDiscount: parseCardDiscount,
    extractCard: extractCard,
    countCouponHrefs: countCouponHrefs,
    countActiveCards: countActiveCards,
    skipReason: skipReason,
    isDisabled: isDisabled,
    findModalTrigger: findModalTrigger,
    paginationRoot: paginationRoot,
    currentPageNumber: currentPageNumber,
    nextPageButton: nextPageButton,
    firstCardCode: firstCardCode,
    TAB_GENERATED: TAB_GENERATED,
    CARD_SELECTOR: CARD_SELECTOR,
    LINK_SELECTOR: LINK_SELECTOR,
    LINK_WITH_HREF_SELECTOR: LINK_WITH_HREF_SELECTOR,
  };
});
