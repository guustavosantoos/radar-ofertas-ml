import { ScoredDeal, NormalizedProduct } from '@radar-ofertas/domain';
import { MessageTemplate, DEFAULT_WHATSAPP_TEMPLATE } from './templates.js';

export interface FormattedMessage {
  messageText: string;
  waMeUrl: string;
  templateId: string;
}

export class MessageComposer {
  /**
   * Compõe a mensagem promocional com base no produto/oferta e no template selecionado.
   */
  static compose(deal: ScoredDeal | { product: NormalizedProduct; score?: number; tier?: string }, templateConfig: MessageTemplate = DEFAULT_WHATSAPP_TEMPLATE): FormattedMessage {
    const product = deal.product;
    const score = deal.score ?? 50;
    const tier = deal.tier ?? 'BOA';

    const getEmoji = (tierStr: string) => {
      switch (tierStr) {
        case 'IMPERDÍVEL': return '🚨';
        case 'ÓTIMA': return '⚡';
        case 'BOA': return '🎯';
        default: return '🛍️';
      }
    };

    const formatCurrency = (val?: number) => {
      if (!val) return '';
      return `R$ ${val.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    };

    const hasOriginalPrice = !!(product.originalPrice && product.originalPrice > product.price);
    const precoFormatted = formatCurrency(product.price);
    const precoAntigoFormatted = hasOriginalPrice ? formatCurrency(product.originalPrice!) : '';
    const descontoFormatted = product.discountPercentage ? `${product.discountPercentage}%` : '';
    const freteFormatted = product.freeShipping ? 'Frete Grátis 🚚' : 'Consulte o frete';
    const avaliacaoFormatted = product.rating ? `${product.rating} ★` : '4.5 ★';
    const parcelamentoFormatted = product.installments ? product.installments.text || `${product.installments.count}x R$ ${product.installments.amount}` : 'Consulte parcelamento';
    const linkFormatted = product.affiliateUrl || product.url;

    // Substituição dos placeholders
    let message = templateConfig.template;
    message = message.replace(/\{produto\}/g, product.title);
    message = message.replace(/\{preco\}/g, precoFormatted);

    if (hasOriginalPrice) {
      message = message.replace(/\{precoAntigo\}/g, precoAntigoFormatted);
    } else {
      // Se não tem preço antigo, remove linhas que dependem de {precoAntigo}
      message = message.split('\n').filter(line => !line.includes('{precoAntigo}')).join('\n');
    }

    if (product.discountPercentage) {
      message = message.replace(/\{desconto\}/g, descontoFormatted);
    } else {
      // Se não tem %, limpa placeholders de desconto do texto
      message = message.replace(/\(\{desconto\} OFF\)/g, '')
                       .replace(/\(\{desconto\} de desconto\)/g, '')
                       .replace(/\{desconto\}/g, '');
    }

    message = message.replace(/\{frete\}/g, freteFormatted);
    message = message.replace(/\{avaliacao\}/g, avaliacaoFormatted);
    message = message.replace(/\{parcelamento\}/g, parcelamentoFormatted);
    message = message.replace(/\{link\}/g, linkFormatted);
    message = message.replace(/\{nivel\}/g, tier);
    message = message.replace(/\{emoji\}/g, getEmoji(tier));
    message = message.replace(/\{score\}/g, String(score));

    // Limpa linhas vazias duplas se algum parâmetro for opcional
    message = message.replace(/\n\n\n+/g, '\n\n').trim();

    // Gera a URL wa.me com encodamento de URI para envio imediato
    const waMeUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;

    return {
      messageText: message,
      waMeUrl,
      templateId: templateConfig.id,
    };
  }
}
