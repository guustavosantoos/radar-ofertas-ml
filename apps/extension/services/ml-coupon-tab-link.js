/**
 * Vínculo aba ↔ cupom do fluxo "Lista Cupons" do Mercado Livre.
 *
 * Este arquivo existe por dois motivos, nenhum deles estético:
 *
 * 1. **A mesma regra roda em dois mundos.** O service worker precisa da chave do
 *    container ao registrar `tabId → cupom`; o sidepanel precisa dela a cada evento
 *    de navegação para decidir se ainda está na listagem daquele cupom. Duplicar as
 *    duas linhas de regex em dois arquivos garante que um dia elas divirjam — e uma
 *    divergência aqui despeja produtos de OUTRA página na Lista Cupons, anunciando
 *    desconto que o produto não tem.
 * 2. **É a única parte testável do fluxo.** Aba, mensagem e DOM não são; a decisão
 *    "aceito ou não estes produtos como sendo deste cupom" é. Ver
 *    tests/mlCouponTabLink.test.ts.
 *
 * Padrão UMD igual ao ml-coupon-scraper.js: `globalThis.MlCouponTabLink` para o
 * service worker (ESM, importa por efeito colateral) e para o sidepanel (script
 * clássico), `module.exports` para o teste em Node.
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.MlCouponTabLink = api;
  }
})(function () {
  'use strict';

  /**
   * Chave ESTÁVEL da listagem de produtos de um cupom.
   *
   * A URL muda a cada paginada (`_Desde_49`, `_Desde_97`, `_NoIndex_True`), então
   * comparar a URL inteira invalidaria o vínculo já na segunda página. O que permanece
   * é o par que identifica a campanha.
   *
   * DOIS FORMATOS, e os dois são do próprio "Ver produtos" do ML:
   *
   * 1. `_Container_<slug>-seller-<id>` — o que o ML servia até 26/jul/2026:
   *
   *      /_Container_pega-mais-7-off-seller-1784312723
   *      /_Desde_49_Container_pega-mais-7-off-seller-1784312723_NoIndex_True
   *
   *    O slug é capturado sem gula (`+?`) porque `-seller-<id>` aparece no fim; com
   *    `.+` o slug engoliria o próprio sufixo em URLs com mais de um "-seller-".
   *
   * 2. `_CustId_<sellerId>?coupon_campaign_id=<id>` — o que ele passou a servir, flagrado
   *    no dump de 27/jul/2026 16:57 (`clickProbe.stats.recusadas`):
   *
   *      /_CustId_223427258?coupon_campaign_id=13384335
   *
   *    O `coupon_campaign_id` é o MESMO número do `alias<N>` que o card do cupom carrega
   *    no `<b>` do código — é ele que amarra a listagem àquele cupom, e não o vendedor.
   *
   * ⚠️ O `coupon_campaign_id` é OBRIGATÓRIO no formato 2. `_CustId_` sozinho é a vitrine
   * inteira do vendedor: aceitá-lo deixaria entrar na Lista Cupons produto que o cupom
   * não cobre — a mensagem sairia prometendo desconto que o checkout recusa. Sem ele a
   * chave é `null`, a aba fica `'suspended'` e nada é acumulado, que é a falha segura.
   */
  function containerKeyFromUrl(url) {
    var s = String(url || '');
    // O host precisa ser do Mercado Livre: os regex abaixo casam só PATH/QUERY, então uma
    // página de terceiro com esses mesmos padrões na URL forjaria o vínculo de listagem.
    try {
      var host = new URL(s).hostname;
      if (!/(^|\.)mercadolivre\.com\.br$/.test(host) && !/(^|\.)mercadolibre\.com(\.[a-z]{2})?$/.test(host)) {
        return null;
      }
    } catch (e) {
      return null;
    }
    var m = /_Container_(.+?)-seller-(\d+)/.exec(s);
    if (m) return m[1] + '|' + m[2];
    var cust = /_CustId_(\d+)/.exec(s);
    var campanha = /[?&]coupon_campaign_id=(\d+)/.exec(s);
    if (cust && campanha) return 'custid-' + cust[1] + '|' + campanha[1];
    return null;
  }

  /**
   * A aba continua na listagem DAQUELE cupom?
   *
   *  - `'match'`     → mesma listagem, inclusive paginada;
   *  - `'suspended'` → o usuário saiu dela (abriu a PDP de um produto, foi para uma
   *    busca, voltou para a home). O vínculo NÃO é apagado — voltar para a listagem
   *    o restaura —, mas nada é acumulado enquanto ele estiver fora.
   *
   * O estado `'suspended'` para URL sem `_Container_` é o que impede o pior defeito
   * possível deste fluxo: com o vínculo valendo para qualquer página, uma busca
   * qualquer feita naquela aba jogaria produtos SEM direito ao cupom dentro da Lista
   * Cupons — e a mensagem sairia prometendo um desconto que o checkout não dá.
   */
  function containerState(url, contextKey) {
    var key = containerKeyFromUrl(url);
    if (!key) return 'suspended';
    if (!contextKey) return 'match'; // sem chave registrada, o vínculo é a própria aba
    return key === contextKey ? 'match' : 'suspended';
  }

  /**
   * Identidade do produto para dedup e para o manifesto de reconciliação.
   *
   * Normaliza (maiúsculas, sem hífen) porque o mesmo MLB aparece como `MLB1234567`
   * no `__PRELOADED_STATE__` e como `MLB-1234567` quando é derivado da URL. Sem
   * normalizar, o mesmo produto entraria duas vezes na acumulação e — pior — o
   * manifesto da reconciliação não casaria com o que está gravado, fazendo o
   * servidor remover item elegível.
   */
  function normalizeItemId(id) {
    if (id == null) return null;
    var s = String(id).trim().toUpperCase().replace(/-/g, '');
    return s || null;
  }

  function couponProductKey(product) {
    if (!product) return null;
    return normalizeItemId(product.mlItemId || product.platformItemId || null);
  }

  /** Estado de acumulação de uma varredura (uma aba, um cupom). */
  function createAccumulator() {
    return { products: [], ids: new Set() };
  }

  /**
   * Acumula os produtos de UMA página no estado da varredura. Devolve quantos
   * entraram de fato.
   *
   * Acumula em vez de substituir porque o usuário navega 1 → 2 → 3 e a seleção das
   * páginas anteriores não pode sumir; deduplica porque a mesma página é lida mais
   * de uma vez (o auto-extract do content script e a extração ativa do painel
   * chegam os dois, e o ML repete itens entre páginas quando o estoque muda).
   */
  function accumulate(state, products) {
    var added = 0;
    if (!state || !Array.isArray(products)) return added;
    for (var i = 0; i < products.length; i++) {
      var key = couponProductKey(products[i]);
      if (!key || state.ids.has(key)) continue;
      state.ids.add(key);
      state.products.push(products[i]);
      added++;
    }
    return added;
  }

  /**
   * Varredura salva → acumulador vivo.
   *
   * POR QUE PRECISA SER PERSISTIDA: o painel do Chrome é tab-specific (o service worker
   * chama `sidePanel.setOptions` por tabId), então o documento é DESTRUÍDO e recriado a
   * cada troca de aba — e com ele o acumulador, que vive só em memória. No 2º E2E de
   * 26/jul/2026 isso se somou ao pior: o contorno que o usuário achou para os produtos
   * aparecerem era justamente sair da aba e voltar, ou seja, ele zerava a varredura toda
   * vez que a fazia funcionar.
   *
   * O `code` viaja junto porque a varredura pertence a UM cupom: reidratar produtos de
   * outro cupom na mesma aba anunciaria desconto que aqueles itens não têm.
   */
  function serializeScan(code, state) {
    return { code: code || null, products: (state && state.products) || [] };
  }

  function restoreScan(saved, code) {
    var acc = createAccumulator();
    if (!saved || !saved.code || saved.code !== code) return acc;
    accumulate(acc, saved.products || []);
    return acc;
  }

  var MONTHS_PT = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
  ];

  /**
   * Nome sugerido da Lista Cupons: `BL267POFF-18/08`, editável.
   *
   * Espelha suggestCouponListName() do servidor, mas parte do rótulo do CARD
   * ("Vence em 18 de agosto") porque o painel precisa do nome antes de qualquer
   * ida ao servidor. O ano não entra: o card não o traz, e a validade que vale é
   * sempre a do banco — o nome é rótulo, nunca fonte de data (R12 do plano).
   */
  function suggestListName(code, expirationRaw) {
    if (!code) return '';
    var m = /(\d{1,2})\s+de\s+([a-zç]+)/i.exec(expirationRaw || '');
    if (m) {
      var month = MONTHS_PT.indexOf(m[2].toLowerCase());
      if (month >= 0) {
        var day = String(parseInt(m[1], 10)).padStart(2, '0');
        return code + '-' + day + '/' + String(month + 1).padStart(2, '0');
      }
    }
    return code;
  }

  /**
   * Reconstrói o rótulo "Vence em 18 de agosto" a partir da data do BANCO.
   *
   * Existe porque o cupom tem duas origens agora. Vindo da extensão, ele carrega
   * `expirationRaw` lido do card do ML. Vindo do web app (botão "Ver produtos" da
   * página /cupons), ele vem do banco — onde `validUntil` é timestamp e o rótulo cru
   * nunca foi persistido. Sem esta conversão o painel abriria o modo produtos com o
   * banner pelado e o nome da lista sem a data, porque `suggestListName` só entende o
   * formato por extenso.
   *
   * Formata em America/Sao_Paulo: a data é a validade comercial do cupom no Brasil, e
   * num navegador em outro fuso o dia viraria o anterior perto da meia-noite.
   */
  function expirationRawFromDate(value) {
    if (!value) return null;
    var d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return null;
    var partes = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: 'numeric',
      month: 'numeric',
    }).format(d).split('/');
    var dia = parseInt(partes[0], 10);
    var mes = parseInt(partes[1], 10);
    if (!dia || !mes || mes < 1 || mes > 12) return null;
    return 'Vence em ' + dia + ' de ' + MONTHS_PT[mes - 1];
  }

  /** "7% OFF" / "R$ 300 OFF" a partir dos campos do banco. */
  function discountRawFromValues(discountType, discountValue) {
    if (!discountValue) return null;
    if (discountType === 'percent') return discountValue + '% OFF';
    if (discountType === 'fixed') {
      return 'R$ ' + (discountValue / 100).toFixed(2).replace('.', ',') + ' OFF';
    }
    return null;
  }

  return {
    containerKeyFromUrl: containerKeyFromUrl,
    containerState: containerState,
    normalizeItemId: normalizeItemId,
    couponProductKey: couponProductKey,
    createAccumulator: createAccumulator,
    accumulate: accumulate,
    serializeScan: serializeScan,
    restoreScan: restoreScan,
    suggestListName: suggestListName,
    expirationRawFromDate: expirationRawFromDate,
    discountRawFromValues: discountRawFromValues,
  };
});
