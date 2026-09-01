export interface NormalizedProduct {
  id: string;
  externalId: string;
  marketplace: 'MERCADO_LIVRE' | 'AMAZON' | 'SHOPEE' | 'OUTROS';
  title: string;
  domainId?: string;
  categoryName?: string;
  price: number;
  originalPrice?: number;
  discountPercentage?: number;
  currency: string;
  installments?: {
    count: number;
    amount: number;
    hasInterest: boolean;
    text?: string;
  };
  rating?: number;
  reviewsCount?: number;
  freeShipping: boolean;
  thumbnail: string;
  url: string;
  affiliateUrl?: string;
  sellerId?: string;
  sellerName?: string;
  condition: 'new' | 'used' | 'refurbished' | 'unknown';
  updatedAt: string;
}

export interface CategoryTrend {
  keyword: string;
  url: string;
}

export interface CategoryHighlight {
  id: string;
  position: number;
  type: string;
  product?: NormalizedProduct;
}

export type DealTier = 'IMPERDÍVEL' | 'ÓTIMA' | 'BOA' | 'NORMAL';

export interface ScoredDeal {
  product: NormalizedProduct;
  score: number; // 0 a 100
  tier: DealTier;
  reasons: string[];
}
