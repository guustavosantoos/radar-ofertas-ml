import { CategoryHighlight, CategoryTrend, NormalizedProduct } from '@radar-ofertas/domain';
import { MercadoLivreClient, MLAuthConfig } from './client.js';
import { normalizeMLCatalogProduct, normalizeMLScrapedDeal } from './normalizer.js';

export class MercadoLivreService {
  private client: MercadoLivreClient;

  constructor(config: MLAuthConfig) {
    this.client = new MercadoLivreClient(config);
  }

  // Cache em memória para não refazer as 32 requisições a cada chamada
  private _categoryCache: Array<{ id: string; name: string; parentId: string | null }> | null = null;
  // Cache de ofertas e mais vendidos em memória (TTL: 5 minutos)
  private _dealsCache: Map<string, { timestamp: number; data: NormalizedProduct[] }> = new Map();
  private _CACHE_TTL_MS = 5 * 60 * 1000;

  /**
   * Obtém todas as categorias do ML Brasil — principais e subcategorias (≈479 categorias).
   * Resultado cacheado em memória durante o processo.
   */
  async getAllCategories(): Promise<Array<{ id: string; name: string; parentId: string | null }>> {
    if (this._categoryCache) return this._categoryCache;

    try {
      const topCats = await this.client.get<Array<{ id: string; name: string }>>('/sites/MLB/categories');
      if (!topCats || !topCats.length) return [];

      // Busca detalhes de todas as categorias principais em paralelo
      const details = await Promise.all(
        topCats.map(cat =>
          this.client
            .get<{ id: string; name: string; children_categories?: Array<{ id: string; name: string }> }>(`/categories/${cat.id}`)
            .catch(() => null)
        )
      );

      const all: Array<{ id: string; name: string; parentId: string | null }> = [];
      for (const d of details) {
        if (!d?.id) continue;
        all.push({ id: d.id, name: d.name, parentId: null });
        for (const child of d.children_categories || []) {
          all.push({ id: child.id, name: child.name, parentId: d.id });
        }
      }

      // Deduplica por id
      const seen = new Set<string>();
      this._categoryCache = all.filter(c => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });

      console.log(`[MercadoLivreService] Categorias carregadas: ${this._categoryCache.length}`);
      return this._categoryCache;
    } catch (error) {
      console.error('[MercadoLivreService] Erro ao buscar todas as categorias:', error);
      return [];
    }
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
    const { chromium } = await import('playwright');

    const browser = await chromium.launch({
      headless: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-sandbox', '--disable-gpu'],
    });

    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'pt-BR',
      });

      const page = await context.newPage();
      const url = categoryId 
        ? `https://www.mercadolivre.com.br/ofertas?category=${categoryId}`
        : `https://www.mercadolivre.com.br/ofertas?promotion_type=deal_of_the_day`;

      console.log(`[MercadoLivreService] Coletando ofertas de: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const rawCards = await page.evaluate(() => {
        const extractPrice = (el: Element | null): string | null => {
          if (!el) return null;
          const fraction = el.querySelector('.andes-money-amount__fraction')?.textContent?.trim();
          const cents = el.querySelector('.andes-money-amount__cents, .dynamic-carousel__price-decimals')?.textContent?.trim();
          if (fraction) return cents ? `${fraction},${cents}` : fraction;

          const clone = el.cloneNode(true) as Element;
          const cloneCents = clone.querySelector('.andes-money-amount__cents, .dynamic-carousel__price-decimals');
          const extractedCents = cloneCents?.textContent?.trim() || '';
          if (cloneCents) cloneCents.remove();
          const main = clone.textContent?.trim() || '';
          if (!main) return null;
          return extractedCents ? `${main},${extractedCents}` : main;
        };

        const cards = document.querySelectorAll('div.poly-card, .promotion-item__container, li.promotion-item');
        return Array.from(cards).map((c: Element) => {
          const title = c.querySelector('.poly-component__title, .promotion-item__title, h2, a[class*="title"]')?.textContent?.trim() || '';

          const currentEl = c.querySelector('.poly-price__current');
          const oldEl = c.querySelector('s.andes-money-amount--previous, .poly-price__labels .andes-money-amount--previous');

          const currentPrice = extractPrice(currentEl);
          const oldPrice = extractPrice(oldEl);

          const discount = c.querySelector('.poly-price__discount-polylabel, .andes-money-amount__discount, .promotion-item__discount')?.textContent?.trim() || null;
          const installments = c.querySelector('.poly-price__installments')?.textContent?.trim() || null;
          const shipping = c.querySelector('.poly-component__shipping-v2, .poly-component__shipping')?.textContent?.trim() || null;
          const rating = c.querySelector('.poly-component__review-compacted, .poly-reviews__rating')?.textContent?.trim() || null;

          const link = c.querySelector('a[href*="mercadolivre.com.br"]')?.getAttribute('href') || null;
          const img = c.querySelector('img')?.getAttribute('src') || c.querySelector('img')?.getAttribute('data-src') || null;

          return {
            title,
            price: currentPrice || '',
            oldPrice,
            discount,
            installments,
            shipping,
            rating,
            link,
            image: img,
          };
        }).filter(item => item.title && item.price);
      });

      await browser.close();

      const normalized = rawCards.map(normalizeMLScrapedDeal);
      this._dealsCache.set(key, { timestamp: Date.now(), data: normalized });
      return normalized;
    } catch (error) {
      await browser.close();
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
    const { chromium } = await import('playwright');

    const browser = await chromium.launch({
      headless: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-sandbox', '--disable-gpu'],
    });

    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'pt-BR',
      });

      const page = await context.newPage();
      const url = 'https://www.mercadolivre.com.br/mais-vendidos#origin=stripe';

      console.log(`[MercadoLivreService] Coletando mais vendidos de: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3500);

      const rawCards = await page.evaluate(() => {
        const extractPrice = (el: Element | null): string | null => {
          if (!el) return null;
          const fraction = el.querySelector('.andes-money-amount__fraction')?.textContent?.trim();
          const cents = el.querySelector('.andes-money-amount__cents, .dynamic-carousel__price-decimals')?.textContent?.trim();
          if (fraction) return cents ? `${fraction},${cents}` : fraction;

          const clone = el.cloneNode(true) as Element;
          const cloneCents = clone.querySelector('.andes-money-amount__cents, .dynamic-carousel__price-decimals');
          const extractedCents = cloneCents?.textContent?.trim() || '';
          if (cloneCents) cloneCents.remove();
          const main = clone.textContent?.trim() || '';
          if (!main) return null;
          return extractedCents ? `${main},${extractedCents}` : main;
        };

        const cards = document.querySelectorAll('.dynamic-carousel__item-container, div.poly-card');
        return Array.from(cards).map((c: Element) => {
          const title = c.querySelector('.dynamic-carousel__title, .poly-component__title')?.textContent?.trim() || c.querySelector('img')?.getAttribute('alt') || '';
          
          const currentEl = c.querySelector('.dynamic-carousel__price, .poly-price__current');
          const oldEl = c.querySelector('.dynamic-carousel__oldprice, s.andes-money-amount--previous');

          const currentPrice = extractPrice(currentEl);
          const oldPrice = extractPrice(oldEl);
          const discount = c.querySelector('.dynamic-carousel__discount, .poly-price__discount-polylabel')?.textContent?.trim() || null;

          const link = c.querySelector('a[href*="mercadolivre.com.br"]')?.getAttribute('href') || null;
          const img = c.querySelector('img')?.getAttribute('src') || c.querySelector('img')?.getAttribute('data-src') || null;

          return {
            title,
            price: currentPrice || '',
            oldPrice,
            discount,
            installments: null,
            shipping: 'Frete grátis',
            rating: '4.9',
            link,
            image: img,
          };
        }).filter(item => item.title && item.price);
      });

      await browser.close();

      const normalized = rawCards.map(raw => {
        const item = normalizeMLScrapedDeal(raw);
        return {
          ...item,
          freeShipping: true,
        };
      });

      this._dealsCache.set(cacheKey, { timestamp: Date.now(), data: normalized });
      return normalized;
    } catch (error) {
      await browser.close();
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
