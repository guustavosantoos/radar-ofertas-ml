import { NormalizedProduct } from '@radar-ofertas/domain';

export function normalizeMLCatalogProduct(raw: any): NormalizedProduct {
  const primaryProduct = raw.pickers?.[0]?.products?.[0];
  const thumbnail = primaryProduct?.thumbnail || raw.pictures?.[0]?.url || raw.pictures?.[0]?.secure_url || '';
  
  return {
    id: `ml-${raw.id}`,
    externalId: raw.id,
    marketplace: 'MERCADO_LIVRE',
    title: raw.name || raw.family_name || 'Produto sem título',
    domainId: raw.domain_id || undefined,
    price: raw.buy_box_winner?.price || 0,
    currency: 'BRL',
    freeShipping: false,
    thumbnail,
    url: raw.permalink || `https://www.mercadolivre.com.br/p/${raw.id}`,
    condition: 'new',
    updatedAt: new Date().toISOString(),
  };
}

/** Gera um identificador estável (não aleatório) a partir de título+preço para evitar chaves duplicadas no React */
function stableId(title: string, price?: string | null): string {
  const base = `${title}|${price || '0'}`;
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = (Math.imul(31, hash) + base.charCodeAt(i)) | 0;
  }
  return `s${Math.abs(hash).toString(36)}`;
}

export function normalizeMLScrapedDeal(raw: {
  title: string;
  price: string;
  oldPrice?: string | null;
  discount?: string | null;
  installments?: string | null;
  shipping?: string | null;
  rating?: string | null;
  reviews?: string | null;
  link?: string | null;
  image?: string | null;
}): NormalizedProduct {
  // Converte "R$ 6.699,33" ou "3.189" para number (6699.33 / 3189)
  const parsePrice = (str?: string | null): number => {
    if (!str) return 0;
    const clean = str.replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.');
    return parseFloat(clean) || 0;
  };

  const currentPrice = parsePrice(raw.price);
  let originalPrice = raw.oldPrice ? parsePrice(raw.oldPrice) : undefined;
  
  let discountPercentage: number | undefined = undefined;
  if (raw.discount) {
    const dMatch = raw.discount.match(/(\d+)%/);
    if (dMatch) discountPercentage = parseInt(dMatch[1], 10);
  }

  // Se houver preço antigo e for maior que o preço atual, valida
  if (originalPrice && originalPrice > currentPrice) {
    if (!discountPercentage) {
      discountPercentage = Math.round(((originalPrice - currentPrice) / originalPrice) * 100);
    }
  } else {
    // Se não veio preço antigo ou veio inválido, mas temos percentual de desconto, calcula o preço original estimado
    if (discountPercentage && discountPercentage > 0 && discountPercentage < 100 && currentPrice > 0) {
      originalPrice = Math.round((currentPrice / (1 - discountPercentage / 100)) * 100) / 100;
    } else {
      originalPrice = undefined;
    }
  }

  // Id extraído da URL; se não disponível, gera id estável com base em título+preço
  let externalId: string;
  if (raw.link) {
    const idMatch = raw.link.match(/MLB-?\d+/i);
    externalId = idMatch ? idMatch[0].replace('-', '') : stableId(raw.title, raw.price);
  } else {
    externalId = stableId(raw.title, raw.price);
  }

  return {
    id: `ml-${externalId}`,
    externalId,
    marketplace: 'MERCADO_LIVRE',
    title: raw.title,
    price: currentPrice,
    originalPrice: originalPrice && originalPrice > currentPrice ? originalPrice : undefined,
    discountPercentage,
    currency: 'BRL',
    freeShipping: Boolean(raw.shipping && raw.shipping.toLowerCase().includes('grátis')),
    thumbnail: raw.image || '',
    url: raw.link || '',
    condition: 'new',
    updatedAt: new Date().toISOString(),
  };
}
