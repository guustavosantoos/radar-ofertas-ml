/**
 * Bridge de cupons: roda na página do webapp (achadinhopro.com.br / achadinho.pro).
 *
 * A página dispara um CustomEvent; o bridge relaya ao service worker e devolve o
 * resultado por outro CustomEvent. Dois fluxos INDEPENDENTES passam por aqui:
 *
 *   'achadinho-import-coupons'      → importCoupons        → 'achadinho-coupons-imported'
 *   'achadinho-open-coupon-products'→ openMlCouponProducts → 'achadinho-coupon-products-opened'
 *
 * Os pares são separados de propósito: não há correlação de requisição neste protocolo
 * (um evento fixo por sentido), então misturar os dois faria a resposta de um cair no
 * handler do outro — a página desistiria por timeout enquanto o trabalho deu certo.
 *
 * ⚠️ O RELAY DO SEGUNDO FLUXO PRECISA SER SÍNCRONO. O clique do usuário viaja até o
 * service worker como gesto e é ele que autoriza `chrome.sidePanel.open()`; qualquer
 * trabalho assíncrono antes do sendMessage mata essa autorização e o painel não abre.
 *
 * Padrão UMD como os demais módulos compartilhados: em Node exporta as funções puras
 * para o teste de regressão (tests/couponsBridge.test.ts), no browser instala os
 * listeners.
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime) {
    return; // Node/teste: só as funções puras.
  }
  api._install();
})(function () {
  'use strict';

  var FLOWS = {
    import: {
      inEvent: 'achadinho-import-coupons',
      outEvent: 'achadinho-coupons-imported',
      buildMessage: function (detail) {
        return { action: 'importCoupons', marketplace: (detail && detail.marketplace) || 'shopee' };
      },
    },
    couponProducts: {
      inEvent: 'achadinho-open-coupon-products',
      outEvent: 'achadinho-coupon-products-opened',
      buildMessage: function (detail) {
        // O cupom vai INTEIRO, e isso não é preguiça: o painel usa `code`, os rótulos e
        // — principalmente — `rawText`, que o servidor reexige ao criar a lista. Um
        // payload podado faria o "Salvar" reescrever o cupom sem as condições.
        return { action: 'openMlCouponProducts', coupon: (detail && detail.coupon) || null };
      },
    },
  };

  function emit(flow, detail) {
    window.dispatchEvent(new CustomEvent(flow.outEvent, { detail: detail }));
  }

  function relay(flow, detail) {
    try {
      chrome.runtime.sendMessage(flow.buildMessage(detail), function (response) {
        if (chrome.runtime.lastError) {
          emit(flow, { success: false, error: chrome.runtime.lastError.message });
          return;
        }
        emit(flow, response || { success: false, error: 'Sem resposta da extensão' });
      });
    } catch (e) {
      emit(flow, { success: false, error: e.message });
    }
  }

  function install() {
    Object.keys(FLOWS).forEach(function (key) {
      var flow = FLOWS[key];
      window.addEventListener(flow.inEvent, function (ev) {
        relay(flow, ev && ev.detail);
      });
    });

    // Sinaliza à página que o bridge está pronto (a UI pode habilitar o botão).
    window.dispatchEvent(new CustomEvent('achadinho-coupons-bridge-ready'));
    setTimeout(function () {
      window.dispatchEvent(new CustomEvent('achadinho-coupons-bridge-ready'));
    }, 2000);
  }

  return {
    _install: install,
    FLOWS: FLOWS,
    relay: relay,
  };
});
