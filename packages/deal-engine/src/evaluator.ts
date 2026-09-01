import { NormalizedProduct, ScoredDeal } from '@radar-ofertas/domain';
import { calculateTier } from './tier.js';

export function evaluateDeal(product: NormalizedProduct, isHighlight: boolean = false): ScoredDeal {
  let score = 0;
  const reasons: string[] = [];

  // 1. Pontuação por Percentual de Desconto (Até 50 pontos)
  if (product.discountPercentage && product.discountPercentage > 0) {
    // Desconto de 50% dá 50 pontos (máximo). Desconto de 20% dá 20 pontos.
    const discountScore = Math.min(50, Math.round(product.discountPercentage * 1.0));
    score += discountScore;
    reasons.push(`${product.discountPercentage}% de desconto direto (+${discountScore} pts)`);
  } else if (product.originalPrice && product.originalPrice > product.price) {
    const calcDiscount = Math.round(((product.originalPrice - product.price) / product.originalPrice) * 100);
    const discountScore = Math.min(50, calcDiscount);
    score += discountScore;
    reasons.push(`${calcDiscount}% de desconto calculado (+${discountScore} pts)`);
  }

  // 2. Pontuação por Frete Grátis (15 pontos)
  if (product.freeShipping) {
    score += 15;
    reasons.push('Frete grátis incluso (+15 pts)');
  }

  // 3. Pontuação por Avaliação / Reputação (Até 20 pontos)
  if (product.rating && product.rating > 0) {
    // Nota 5.0 dá 20 pontos. Nota 4.0 dá 16 pontos.
    const ratingScore = Math.round((product.rating / 5.0) * 20);
    score += ratingScore;
    reasons.push(`Avaliação de ${product.rating} ★ (+${ratingScore} pts)`);
  } else {
    // Fallback padrão para produtos novos sem rating explícito
    score += 10;
  }

  // 4. Bônus por Destaque / Mais Vendido (15 pontos)
  if (isHighlight) {
    score += 15;
    reasons.push('Produto é Destaque de Vendas na Categoria (+15 pts)');
  }

  // Bônus por parcelamento sem juros se detectado
  if (product.installments && !product.installments.hasInterest) {
    score += 5;
    reasons.push(`Parcelamento em ${product.installments.count}x sem juros (+5 pts)`);
  }

  // Garante limite entre 0 e 100
  const finalScore = Math.min(100, Math.max(0, score));
  const tier = calculateTier(finalScore);

  return {
    product,
    score: finalScore,
    tier,
    reasons,
  };
}

export function rankDeals(products: NormalizedProduct[], highlightIds: Set<string> = new Set()): ScoredDeal[] {
  const scoredList = products.map(product => {
    const isHighlight = highlightIds.has(product.externalId);
    return evaluateDeal(product, isHighlight);
  });

  // Ordena do MAIOR score para o MENOR
  return scoredList.sort((a, b) => b.score - a.score);
}
