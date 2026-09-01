import { Router } from 'express';
import { MercadoLivreService, MercadoLivreAffiliateService } from '@radar-ofertas/marketplace';
import { rankDeals } from '@radar-ofertas/deal-engine';
import { MessageComposer, FLASH_IMPERDIVEL_TEMPLATE, DEFAULT_WHATSAPP_TEMPLATE, ACHADINHOS_MELI_TEMPLATE } from '@radar-ofertas/messaging';
import dotenv from 'dotenv';
import path from 'node:path';

// Carrega o .env da raiz do projeto
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const router = Router();

export const mlService = new MercadoLivreService({
  clientId: process.env.ML_CLIENT_ID || '',
  clientSecret: process.env.ML_CLIENT_SECRET || '',
  refreshToken: process.env.ML_REFRESH_TOKEN || '',
  redirectUri: process.env.ML_REDIRECT_URI || '',
});

/**
 * GET /api/v1/marketplace/mercadolivre/categories
 * Retorna todas as categorias do ML Brasil — principais + subcategorias (≈479).
 */
router.get('/mercadolivre/categories', async (req, res) => {
  try {
    const categories = await mlService.getAllCategories();
    res.json({
      success: true,
      count: categories.length,
      data: categories,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao buscar categorias do Mercado Livre',
    });
  }
});

/**
 * GET /api/v1/marketplace/mercadolivre/search?q=notebook
 * Busca categorias do ML que correspondem ao termo e retorna as ofertas.
 * Tenta múltiplas categorias em sequência até encontrar uma com ofertas ativas.
 */
router.get('/mercadolivre/search', async (req, res) => {
  try {
    const q = (req.query.q as string || '').trim();
    const templateType = (req.query.template as string) || 'achadinhos';
    const affiliateTag = (req.query.affiliateTag as string) || process.env.ML_AFFILIATE_TAG || '';

    if (!q) {
      return res.status(400).json({ success: false, error: 'Parâmetro q é obrigatório' });
    }

    const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const normQ = normalize(q);

    // Dicionário de sinônimos PT-BR → termos de busca de categoria ML
    const SYNONYMS: Record<string, string[]> = {
      'notebook': ['informatica', 'computador'],
      'laptop': ['informatica'],
      'pc': ['informatica', 'computador'],
      'computador': ['informatica'],
      'tv': ['televisao', 'televisor', 'eletronicos'],
      'televisao': ['televisor', 'eletronicos'],
      'geladeira': ['refrigerador', 'eletrodomesticos'],
      'refrigerador': ['eletrodomesticos'],
      'fogao': ['eletrodomesticos'],
      'micro-ondas': ['eletrodomesticos'],
      'maquina de lavar': ['eletrodomesticos'],
      'roupa': ['moda', 'vestuario'],
      'tenis': ['calcados', 'moda', 'esporte'],
      'sapato': ['calcados', 'moda'],
      'calcado': ['moda'],
      'carro': ['automoveis', 'veiculos', 'acessorios para veiculos'],
      'automovel': ['veiculos', 'carros'],
      'moto': ['motos', 'veiculos'],
      'videogame': ['videogames', 'games', 'jogos'],
      'game': ['videogames', 'games'],
      'fone': ['audio', 'eletronicos', 'telefone'],
      'headphone': ['audio', 'eletronicos'],
      'camara': ['cameras', 'fotografia'],
      'camera': ['cameras', 'fotografia'],
      'ferramenta': ['ferramentas', 'construcao'],
      'movel': ['moveis', 'casa'],
      'sofa': ['moveis'],
      'cama': ['moveis', 'colchao'],
      'bicicleta': ['ciclismo', 'esporte'],
      'academia': ['fitness', 'esporte'],
      'proteina': ['suplementos', 'esporte', 'alimentos'],
      'whey': ['suplementos', 'esporte', 'alimentos'],
      'relogio': ['relogios', 'acessorios'],
      'oculos': ['otica', 'acessorios'],
      'perfume': ['beleza', 'cosmeticos'],
      'livro': ['livros'],
      'brinquedo': ['brinquedos'],
      'infantil': ['brinquedos', 'bebes'],
      'bebe': ['bebes'],
      'pet': ['animais', 'pets'],
      'cachorro': ['animais'],
      'gato': ['animais'],
    };

    // Aplica sinônimos: se o termo não encontrar categorias, tenta termos alternativos
    const getSearchTerms = (term: string): string[] => {
      const synonyms = SYNONYMS[term] || [];
      return [term, ...synonyms];
    };

    // Encontrar categorias correspondentes ao termo de busca
    const allCats = await mlService.getAllCategories();
    // Tenta o termo direto; se não houver match, tenta os sinônimos
    const searchTerms = getSearchTerms(normQ);
    let matches: typeof allCats = [];
    let effectiveTerm = normQ;

    for (const term of searchTerms) {
      const found = allCats.filter(c => normalize(c.name).includes(term));
      if (found.length > 0) {
        matches = found;
        effectiveTerm = term;
        break;
      }
    }

    // Ordenar: exact match > starts with > includes; subcategorias com nomes mais curtos são mais específicas
    matches.sort((a, b) => {
      const normA = normalize(a.name);
      const normB = normalize(b.name);
      const scoreA = normA === effectiveTerm ? 0 : normA.startsWith(effectiveTerm) ? 1 : 2;
      const scoreB = normB === effectiveTerm ? 0 : normB.startsWith(effectiveTerm) ? 1 : 2;
      if (scoreA !== scoreB) return scoreA - scoreB;
      return a.name.length - b.name.length; // nome mais curto = mais específico
    });

    if (matches.length === 0) {
      return res.json({ success: true, query: q, matchedCategory: null, count: 0, data: [] });
    }

    let templateToUse = DEFAULT_WHATSAPP_TEMPLATE;
    if (templateType === 'flash') templateToUse = FLASH_IMPERDIVEL_TEMPLATE;
    else if (templateType === 'achadinhos' || templateType === 'meli') templateToUse = ACHADINHOS_MELI_TEMPLATE;

    const affiliateService = new MercadoLivreAffiliateService({ affiliateTag });

    const buildPromoList = async (catId: string) => {
      const rawDeals = await mlService.getDeals(catId);
      const scoredList = rankDeals(rawDeals);
      const list = await Promise.all(
        scoredList.map(async item => {
          const affiliateUrl = await affiliateService.generateAffiliateUrl(item.product.url, affiliateTag);
          const scoredItem = { ...item, product: { ...item.product, affiliateUrl } };
          const message = MessageComposer.compose(scoredItem, templateToUse);
          return { deal: scoredItem, messaging: message };
        })
      );
      // Deduplica
      const seen = new Set<string>();
      return list.filter(item => {
        const id = item.deal.product.id;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    };

    // Tentar as primeiras 5 categorias correspondentes em sequência
    let deduped: any[] = [];
    let usedCategory = matches[0];
    const tryLimit = Math.min(5, matches.length);

    for (let i = 0; i < tryLimit; i++) {
      console.log(`[search] Tentando categoria: ${matches[i].name} (${matches[i].id})`);
      const result = await buildPromoList(matches[i].id);
      if (result.length > 0) {
        deduped = result;
        usedCategory = matches[i];
        break;
      }
    }

    return res.json({
      success: true,
      query: q,
      matchedCategory: usedCategory,
      otherMatches: matches.filter(m => m.id !== usedCategory.id).slice(0, 4),
      hasDeals: deduped.length > 0,
      count: deduped.length,
      data: deduped,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Erro na busca por palavra-chave',
    });
  }
});

/**
 * GET /api/v1/marketplace/mercadolivre/highlights?category=MLB1051
 */
router.get('/mercadolivre/highlights', async (req, res) => {
  try {
    const categoryId = (req.query.category as string) || 'MLB1051';
    const limit = parseInt((req.query.limit as string) || '5', 10);
    const highlights = await mlService.getCategoryHighlights(categoryId, limit);
    
    res.json({
      success: true,
      categoryId,
      count: highlights.length,
      data: highlights,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao buscar destaques do Mercado Livre',
    });
  }
});

/**
 * GET /api/v1/marketplace/mercadolivre/trends?category=MLB1051
 */
router.get('/mercadolivre/trends', async (req, res) => {
  try {
    const categoryId = (req.query.category as string) || 'MLB1051';
    const trends = await mlService.getCategoryTrends(categoryId);

    res.json({
      success: true,
      categoryId,
      count: trends.length,
      data: trends,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao buscar tendências do Mercado Livre',
    });
  }
});

/**
 * GET /api/v1/marketplace/mercadolivre/deals?category=MLB1051
 */
router.get('/mercadolivre/deals', async (req, res) => {
  try {
    const categoryId = req.query.category as string | undefined;
    const deals = await mlService.getDeals(categoryId);

    res.json({
      success: true,
      categoryId: categoryId || 'DEAL_OF_THE_DAY',
      count: deals.length,
      data: deals,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao buscar ofertas do Mercado Livre',
    });
  }
});

/**
 * GET /api/v1/marketplace/mercadolivre/discounted-deals
 * Busca apenas produtos COM DESCONTO REAL e injeta o LINK DE AFILIADO monetizado!
 */
router.get('/mercadolivre/discounted-deals', async (req, res) => {
  try {
    const categoryId = req.query.category as string | undefined;
    const minDiscount = parseInt((req.query.minDiscount as string) || '5', 10);
    const affiliateTag = (req.query.affiliateTag as string) || process.env.ML_AFFILIATE_TAG || '';

    const affiliateService = new MercadoLivreAffiliateService({ affiliateTag });

    const allDeals = await mlService.getDeals(categoryId);

    // Filtra apenas os produtos com desconto real maior ou igual a minDiscount
    const filtered = allDeals.filter(p => p.discountPercentage && p.discountPercentage >= minDiscount);
    const discountedDeals = await Promise.all(
      filtered.map(async p => ({
        ...p,
        affiliateUrl: await affiliateService.generateAffiliateUrl(p.url, affiliateTag),
      }))
    );

    res.json({
      success: true,
      appliedFilter: {
        minDiscountPercentage: `${minDiscount}%`,
        affiliateTagUsed: affiliateTag,
      },
      count: discountedDeals.length,
      data: discountedDeals,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao buscar ofertas com desconto',
    });
  }
});

/**
 * GET /api/v1/marketplace/mercadolivre/scored-deals
 * Avalia, pontua (0 a 100) e classifica todas as ofertas por Nível (IMPERDÍVEL, ÓTIMA, BOA, NORMAL)
 */
router.get('/mercadolivre/scored-deals', async (req, res) => {
  try {
    const categoryId = req.query.category as string | undefined;
    const minScore = parseInt((req.query.minScore as string) || '0', 10);
    const targetTier = (req.query.tier as string)?.toUpperCase();
    const affiliateTag = (req.query.affiliateTag as string) || process.env.ML_AFFILIATE_TAG || '';

    const affiliateService = new MercadoLivreAffiliateService({ affiliateTag });

    // 1. Busca ofertas do dia
    const rawDeals = await mlService.getDeals(categoryId);

    // 2. Busca destaques da categoria para bonificação no score
    let highlightIds = new Set<string>();
    if (categoryId) {
      const highlights = await mlService.getCategoryHighlights(categoryId, 10);
      highlightIds = new Set(highlights.map(h => h.id));
    }

    // 3. Avalia e ranqueia as ofertas
    let scoredList = rankDeals(rawDeals, highlightIds);

    // 4. Injeta o link de afiliado monetizado
    scoredList = await Promise.all(
      scoredList.map(async item => ({
        ...item,
        product: {
          ...item.product,
          affiliateUrl: await affiliateService.generateAffiliateUrl(item.product.url, affiliateTag),
        },
      }))
    );

    // 5. Aplica filtros se informados (minScore ou tier)
    if (minScore > 0) {
      scoredList = scoredList.filter(item => item.score >= minScore);
    }
    if (targetTier) {
      scoredList = scoredList.filter(item => item.tier === targetTier);
    }

    res.json({
      success: true,
      appliedFilter: {
        minScore,
        targetTier: targetTier || 'TODOS',
        affiliateTagUsed: affiliateTag,
      },
      count: scoredList.length,
      data: scoredList,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao pontuar ofertas',
    });
  }
});

/**
 * GET /api/v1/marketplace/mercadolivre/promotional-messages
 * Gera ofertas com mensagens formatadas prontas para copiar e enviar no WhatsApp!
 */
router.get('/mercadolivre/promotional-messages', async (req, res) => {
  try {
    const categoryId = req.query.category as string | undefined;
    const searchQuery = (req.query.q || req.query.search) as string | undefined;
    const minScoreParam = req.query.minScore as string | undefined;
    // Se o usuário está fazendo uma busca específica por palavra-chave, usa minScore=0 para trazer todas as correspondências
    const minScore = parseInt(minScoreParam || (searchQuery ? '0' : '30'), 10);
    const templateType = (req.query.template as string) || 'default';
    const affiliateTag = (req.query.affiliateTag as string) || process.env.ML_AFFILIATE_TAG || '';

    const affiliateService = new MercadoLivreAffiliateService({ affiliateTag });

    const rawDeals = categoryId === 'best_sellers'
      ? await mlService.getBestSellers()
      : await mlService.getDeals(categoryId);
    let scoredList = rankDeals(rawDeals);

    // Se houver busca por palavra-chave, filtra pelo título normalizado
    if (searchQuery && searchQuery.trim().length > 0) {
      const normQuery = searchQuery.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      scoredList = scoredList.filter(item => {
        const normTitle = item.product.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return normTitle.includes(normQuery);
      });
    }

    let templateToUse = DEFAULT_WHATSAPP_TEMPLATE;
    if (templateType === 'flash') {
      templateToUse = FLASH_IMPERDIVEL_TEMPLATE;
    } else if (templateType === 'achadinhos' || templateType === 'meli') {
      templateToUse = ACHADINHOS_MELI_TEMPLATE;
    }

    const filtered = scoredList.filter(item => item.score >= minScore);

    const promotionalList = await Promise.all(
      filtered.map(async item => {
        const affiliateUrl = await affiliateService.generateAffiliateUrl(item.product.url, affiliateTag);
        const monetizedProduct = {
          ...item.product,
          affiliateUrl,
        };

        const scoredItem = { ...item, product: monetizedProduct };
        const message = MessageComposer.compose(scoredItem, templateToUse);

        return {
          deal: scoredItem,
          messaging: message,
        };
      })
    );

    // Deduplica por product.id para evitar chaves duplicadas no React
    const seenIds = new Set<string>();
    const deduped = promotionalList.filter(item => {
      const id = item.deal.product.id;
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    res.json({
      success: true,
      templateUsed: templateToUse.id,
      count: deduped.length,
      data: deduped,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao gerar mensagens promocionais',
    });
  }
});

/**
 * GET /api/v1/marketplace/mercadolivre/best-sellers
 * Retorna os produtos MAIS VENDIDOS do Mercado Livre (https://www.mercadolivre.com.br/mais-vendidos)
 */
router.get('/mercadolivre/best-sellers', async (req, res) => {
  try {
    const templateType = (req.query.template as string) || 'achadinhos';
    const affiliateTag = (req.query.affiliateTag as string) || process.env.ML_AFFILIATE_TAG || '';

    const affiliateService = new MercadoLivreAffiliateService({ affiliateTag });

    const rawDeals = await mlService.getBestSellers();
    const scoredList = rankDeals(rawDeals);

    let templateToUse = DEFAULT_WHATSAPP_TEMPLATE;
    if (templateType === 'flash') templateToUse = FLASH_IMPERDIVEL_TEMPLATE;
    else if (templateType === 'achadinhos' || templateType === 'meli') templateToUse = ACHADINHOS_MELI_TEMPLATE;

    const promotionalList = await Promise.all(
      scoredList.map(async item => {
        const affiliateUrl = await affiliateService.generateAffiliateUrl(item.product.url, affiliateTag);
        const scoredItem = { ...item, tier: 'ÓTIMA', product: { ...item.product, affiliateUrl } };
        const message = MessageComposer.compose(scoredItem, templateToUse);
        return { deal: scoredItem, messaging: message };
      })
    );

    const seenIds = new Set<string>();
    const deduped = promotionalList.filter(item => {
      const id = item.deal.product.id;
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    res.json({
      success: true,
      count: deduped.length,
      data: deduped,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao buscar mais vendidos do Mercado Livre',
    });
  }
});

export default router;
