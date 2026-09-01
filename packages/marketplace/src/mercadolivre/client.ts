import https from 'node:https';

export interface MLAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  redirectUri: string;
}

export class MercadoLivreClient {
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;
  private redirectUri: string;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(config: MLAuthConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.refreshToken = config.refreshToken;
    this.redirectUri = config.redirectUri;
  }

  /**
   * Garante um access_token válido se credenciais OAuth estiverem configuradas.
   */
  async getValidAccessToken(): Promise<string | null> {
    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      return null;
    }

    const now = Date.now();
    if (this.accessToken && this.tokenExpiresAt > now + 60000) {
      return this.accessToken;
    }

    try {
      console.log('[MercadoLivreClient] Renovando access_token via refresh_token...');
      const tokenData = await this.refreshAccessToken();
      this.accessToken = tokenData.access_token;
      this.tokenExpiresAt = Date.now() + tokenData.expires_in * 1000;
      if (tokenData.refresh_token) {
        this.refreshToken = tokenData.refresh_token;
      }
      return this.accessToken;
    } catch (e) {
      console.warn('[MercadoLivreClient] Falha ao renovar token OAuth, continuando em modo público:', e);
      return null;
    }
  }

  /**
   * Executa a troca de refresh_token por um novo access_token
   */
  private refreshAccessToken(): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
      });

      const req = https.request('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`Falha na renovação do token (HTTP ${res.statusCode}): ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Realiza chamadas GET na API pública ou autenticada do Mercado Livre
   */
  async get<T>(endpoint: string): Promise<T> {
    const token = await this.getValidAccessToken();

    return new Promise((resolve, reject) => {
      const url = endpoint.startsWith('http') ? endpoint : `https://api.mercadolibre.com${endpoint}`;

      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      };

      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const req = https.get(url, { headers }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Resposta JSON inválida da API ML: ${data.substring(0, 100)}`));
            }
          } else {
            reject(new Error(`Erro da API ML [HTTP ${res.statusCode} na rota ${endpoint}]: ${data}`));
          }
        });
      });

      // Timeout de 10s para não travar no ambiente serverless
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error(`Timeout na requisição para ${endpoint} (10s)`));
      });

      req.on('error', reject);
    });
  }
}
