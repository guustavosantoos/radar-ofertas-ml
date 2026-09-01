import { CategoryHighlight, CategoryTrend, NormalizedProduct } from '@radar-ofertas/domain';
import { MercadoLivreClient, MLAuthConfig } from './client.js';
import { normalizeMLCatalogProduct, normalizeMLScrapedDeal } from './normalizer.js';
import { ML_CATEGORIES_TREE } from './categories-data.js';

export class MercadoLivreService {
  private client: MercadoLivreClient;

  constructor(config: MLAuthConfig) {
    this.client = new MercadoLivreClient(config);
  }

  // Cache em memória
  private _categoryCache: Array<{ id: string; name: string; parentId: string | null }> | null = null;
  // Cache de ofertas e mais vendidos em memória (TTL: 5 minutos)
  private _dealsCache: Map<string, { timestamp: number; data: NormalizedProduct[] }> = new Map();
  private _CACHE_TTL_MS = 5 * 60 * 1000;

  /**
   * Obtém todas as categorias do ML Brasil — principais e subcategorias.
   * Carregamento instantâneo via taxonomia oficial predefinida.
   */
  async getAllCategories(): Promise<Array<{ id: string; name: string; parentId: string | null }>> {
    return ML_CATEGORIES_TREE;
  }

  /**
   * Mantido por compatibilidade — retorna apenas as categorias principais.
   */
  async getCategories(): Promise<Array<{ id: string; name: string }>> {
    const all = await this.getAllCategories();
    return all.filter(c => c.parentId === null);
  }

  /**
   * Obtém as tendências de busca em tempo real para uma categoria
   */
  async getCategoryTrends(categoryId: string): Promise<CategoryTrend[]> {
    try {
      const data = await this.client.get<Array<{ keyword: string; url: string }>>(`/trends/MLB/${categoryId}`);
      return (data || []).map(item => ({
        keyword: item.keyword,
        url: item.url,
      }));
    } catch (error) {
      console.error(`[MercadoLivreService] Erro ao buscar tendências da categoria ${categoryId}:`, error);
      return [];
    }
  }

  /**
   * Obtém os produtos mais vendidos / destaques da categoria
   */
  async getCategoryHighlights(categoryId: string, limit: number = 5): Promise<CategoryHighlight[]> {
    try {
      const data = await this.client.get<{
        content: Array<{ id: string; position: number; type: string }>;
      }>(`/highlights/MLB/category/${categoryId}`);

      const items = (data.content || []).slice(0, limit);
      const highlights: CategoryHighlight[] = [];

      for (const item of items) {
        let product: NormalizedProduct | undefined = undefined;
        try {
          if (item.type === 'PRODUCT') {
            const rawCatalog = await this.client.get<any>(`/products/${item.id}`);
            product = normalizeMLCatalogProduct(rawCatalog);
          }
        } catch (e) {
          // Ignora se algum produto individual falhar no catálogo
        }

        highlights.push({
          id: item.id,
          position: item.position,
          type: item.type,
          product,
        });
      }

      return highlights;
    } catch (error) {
      console.error(`[MercadoLivreService] Erro ao buscar destaques da categoria ${categoryId}:`, error);
      return [];
    }
  }

  /**
   * Realiza a varredura das ofertas do dia no hub de ofertas do Mercado Livre (com cache instantâneo de 5 min)
   */
  async getDeals(categoryId?: string, forceRefresh = false): Promise<NormalizedProduct[]> {
    const cacheKey = categoryId || 'DEAL_OF_THE_DAY';
    const cached = this._dealsCache.get(cacheKey);
    const now = Date.now();

    // Se temos cache válido (< 5 min), retorna instantaneamente sem esperar Playwright!
    if (!forceRefresh && cached && (now - cached.timestamp < this._CACHE_TTL_MS)) {
      return cached.data;
    }

    // Se temos cache expirado, retorna ele imediatamente e dispara renovação em segundo plano
    if (!forceRefresh && cached && cached.data.length > 0) {
      console.log(`[MercadoLivreService] Servindo cache instantâneo de ${cacheKey} e renovando em background...`);
      this._fetchAndCacheDeals(categoryId, cacheKey).catch(console.error);
      return cached.data;
    }

    return this._fetchAndCacheDeals(categoryId, cacheKey);
  }

  private async _fetchAndCacheDeals(categoryId?: string, cacheKey?: string): Promise<NormalizedProduct[]> {
    const key = cacheKey || categoryId || 'DEAL_OF_THE_DAY';

    try {
      const url = categoryId 
        ? `https://www.mercadolivre.com.br/ofertas?category=${categoryId}`
        : `https://www.mercadolivre.com.br/ofertas?promotion_type=deal_of_the_day`;

      console.log(`[MercadoLivreService] Coletando ofertas via HTTP de: ${url}`);
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
        }
      });

      const html = await res.text();
      const { load } = await import('cheerio');
      const $ = load(html);
      const rawCards: any[] = [];

      $('div.poly-card, .promotion-item__container, li.promotion-item, div.ui-search-result').each((_, el) => {
        const card = $(el);
        const title = card.find('.poly-component__title, .promotion-item__title, h2, a[class*="title"]').first().text().trim();
        const currentPrice = card.find('.poly-price__current .andes-money-amount__fraction, .promotion-item__price .andes-money-amount__fraction').first().text().trim();
        const oldPrice = card.find('s.andes-money-amount--previous .andes-money-amount__fraction, .promotion-item__old-price .andes-money-amount__fraction').first().text().trim();
        const discount = card.find('.poly-price__discount-polylabel, .andes-money-amount__discount, .promotion-item__discount').first().text().trim() || null;
        const installments = card.find('.poly-price__installments, .promotion-item__installments').first().text().trim() || null;
        const shipping = card.find('.poly-component__shipping-v2, .poly-component__shipping, .promotion-item__shipping').first().text().trim() || null;
        const rating = card.find('.poly-component__review-compacted, .poly-reviews__rating').first().text().trim() || '4.8';
        const link = card.find('a[href*="mercadolivre.com.br"]').first().attr('href') || null;
        const image = card.find('img').first().attr('src') || card.find('img').first().attr('data-src') || null;

        if (title && currentPrice) {
          rawCards.push({
            title,
            price: currentPrice,
            oldPrice: oldPrice || null,
            discount,
            installments,
            shipping,
            rating,
            link,
            image,
          });
        }
      });

      const normalized = rawCards.map(normalizeMLScrapedDeal);
      this._dealsCache.set(key, { timestamp: Date.now(), data: normalized });
      console.log(`[MercadoLivreService] Ofertas coletadas com sucesso (${key}): ${normalized.length} itens`);
      return normalized;
    } catch (error) {
      console.error('[MercadoLivreService] Erro durante a varredura de ofertas:', error);
      return [];
    }
  }

  /**
   * Realiza a varredura dos produtos MAIS VENDIDOS do Mercado Livre (com cache instantâneo de 5 min)
   */
  async getBestSellers(forceRefresh = false): Promise<NormalizedProduct[]> {
    const cacheKey = 'BEST_SELLERS';
    const cached = this._dealsCache.get(cacheKey);
    const now = Date.now();

    if (!forceRefresh && cached && (now - cached.timestamp < this._CACHE_TTL_MS)) {
      return cached.data;
    }

    if (!forceRefresh && cached && cached.data.length > 0) {
      console.log(`[MercadoLivreService] Servindo cache instantâneo de BEST_SELLERS e renovando em background...`);
      this._fetchAndCacheBestSellers().catch(console.error);
      return cached.data;
    }

    return this._fetchAndCacheBestSellers();
  }

  private async _fetchAndCacheBestSellers(): Promise<NormalizedProduct[]> {
    const cacheKey = 'BEST_SELLERS';

    try {
      const url = 'https://www.mercadolivre.com.br/mais-vendidos#origin=stripe';
      console.log(`[MercadoLivreService] Coletando mais vendidos via HTTP de: ${url}`);

      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
        }
      });

      const html = await res.text();
      const { load } = await import('cheerio');
      const $ = load(html);
      const rawCards: any[] = [];

      $('.dynamic-carousel__item-container, div.poly-card, div.ui-search-result').each((_, el) => {
        const card = $(el);
        const title = card.find('.dynamic-carousel__title, .poly-component__title, h2').first().text().trim() || card.find('img').first().attr('alt') || '';
        const currentPrice = card.find('.dynamic-carousel__price .andes-money-amount__fraction, .poly-price__current .andes-money-amount__fraction').first().text().trim();
        const oldPrice = card.find('.dynamic-carousel__oldprice .andes-money-amount__fraction, s.andes-money-amount--previous .andes-money-amount__fraction').first().text().trim();
        const discount = card.find('.dynamic-carousel__discount, .poly-price__discount-polylabel').first().text().trim() || null;
        const link = card.find('a[href*="mercadolivre.com.br"]').first().attr('href') || null;
        const image = card.find('img').first().attr('src') || card.find('img').first().attr('data-src') || null;

        if (title && currentPrice) {
          rawCards.push({
            title,
            price: currentPrice,
            oldPrice: oldPrice || null,
            discount,
            installments: null,
            shipping: 'Frete grátis',
            rating: '4.9',
            link,
            image,
          });
        }
      });

      const normalized = rawCards.map(normalizeMLScrapedDeal);
      this._dealsCache.set(cacheKey, { timestamp: Date.now(), data: normalized });
      console.log(`[MercadoLivreService] Mais vendidos coletados com sucesso: ${normalized.length} itens`);
      return normalized;
    } catch (error) {
      console.error('[MercadoLivreService] Erro durante a varredura de mais vendidos:', error);
      return [];
    }
  }

  /**
   * Inicia a varredura periódica em segundo plano das categorias principais e mais vendidos
   */
  startAutoScanner(intervalMinutes = 5) {
    const ms = intervalMinutes * 60 * 1000;
    console.log(`[MercadoLivreService] 🔄 Scanner de fundo ativado! Renovação a cada ${intervalMinutes} minutos.`);

    const scan = async () => {
      console.log('[MercadoLivreService] ⏰ Iniciando ciclo automático de atualização em segundo plano...');
      try {
        await this.getDeals(undefined, true);
        await this.getBestSellers(true);
        console.log('[MercadoLivreService] ✅ Ciclo de atualização em segundo plano concluído!');
      } catch (err) {
        console.error('[MercadoLivreService] Erro no ciclo de atualização em segundo plano:', err);
      }
    };

    // Executa a primeira varredura após 8 segundos da API subir
    setTimeout(scan, 8000);
    // Executa periodicamente a cada X minutos
    setInterval(scan, ms);
  }
}
