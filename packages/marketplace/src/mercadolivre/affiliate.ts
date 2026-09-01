export interface AffiliateConfig {
  affiliateTag?: string; // ex: "sua_tag"
  mattTool?: string;
}

export class MercadoLivreAffiliateService {
  private affiliateTag: string;
  private mattTool?: string;

  constructor(config?: AffiliateConfig) {
    this.affiliateTag = config?.affiliateTag || process.env.ML_AFFILIATE_TAG || '';
    this.mattTool = config?.mattTool || process.env.ML_MATT_TOOL;
  }

  /**
   * Converte a URL original do produto em um link de afiliado limpo do Mercado Livre.
   * Remove parâmetros de rastreamento internos e injeta apenas o tracking_id do afiliado.
   */
  generateCleanAffiliateUrl(originalUrl: string, customTag?: string): string {
    if (!originalUrl) return '';

    const tag = customTag || this.affiliateTag;

    // Remove fragmentos (#...) e parâmetros internos do ML, mantém só o caminho limpo
    const cleanBase = originalUrl.split('?')[0].split('#')[0];

    try {
      const urlObj = new URL(cleanBase);
      if (tag) {
        urlObj.searchParams.set('tracking_id', tag);
      }

      if (this.mattTool) {
        urlObj.searchParams.set('matt_tool', this.mattTool);
      }

      return urlObj.toString();
    } catch {
      return originalUrl;
    }
  }

  /**
   * Alias público — retorna a URL de afiliado limpa (sem encurtador externo).
   */
  async generateAffiliateUrl(originalUrl: string, customTag?: string): Promise<string> {
    return this.generateCleanAffiliateUrl(originalUrl, customTag);
  }
}
