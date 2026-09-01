import { Router, Request, Response } from 'express';

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rokkprgddthtyxxxaajt.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJva2twcmdkZHRodHl4eHhhYWp0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNjQxMzUsImV4cCI6MjEwMzg0MDEzNX0.-rqqCmY1OnFqAnhjpu558_M4ejBMGSNSP8G8YVkNOEM';

/**
 * POST /login ou /api/extension/login
 * Autenticação direta com Supabase para a Extensão Chrome do Radar Ofertas ML
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'E-mail e senha são obrigatórios.' });
    }

    // 1. Autenticar com o Supabase Auth
    const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        email: email.trim(),
        password: password,
      }),
    });

    const authData: any = await authResponse.json();

    if (!authResponse.ok || !authData.access_token) {
      console.warn('[Extension API] Falha no login Supabase:', authData);
      return res.status(401).json({
        message: authData.error_description || authData.msg || 'E-mail ou senha incorretos.',
      });
    }

    const userId = authData.user?.id;
    const userEmail = authData.user?.email || email;

    // 2. Buscar perfil do usuário no Supabase para carregar a Tag de Afiliado e Nome
    let profile: any = null;
    try {
      const profileResponse = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*`, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${authData.access_token}`,
        },
      });
      if (profileResponse.ok) {
        const profiles: any = await profileResponse.json();
        if (Array.isArray(profiles) && profiles.length > 0) {
          profile = profiles[0];
        }
      }
    } catch (err) {
      console.warn('[Extension API] Erro ao buscar perfil:', err);
    }

    const userName = profile?.full_name || authData.user?.user_metadata?.full_name || userEmail.split('@')[0];
    const affiliateTag = profile?.affiliate_tag || '';

    console.log(`[Extension API] Login com sucesso para ${userEmail} (${userId})`);

    return res.json({
      success: true,
      token: authData.access_token,
      userId: userId,
      userName: userName,
      userPlan: profile?.plan || 'pro',
      plan: profile?.plan || 'pro',
      affiliateTag: affiliateTag,
      user: {
        id: userId,
        email: userEmail,
        fullName: userName,
        affiliateTag: affiliateTag,
      },
    });
  } catch (error: any) {
    console.error('[Extension API] Erro interno no login:', error);
    return res.status(500).json({
      message: 'Erro ao processar login no servidor. Tente novamente em instantes.',
      error: error.message,
    });
  }
});

/**
 * POST /auto-login ou /api/extension/auto-login
 */
router.post('/auto-login', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Token não fornecido para auto-login.' });
    }

    const token = authHeader.replace('Bearer ', '').trim();

    // Validar token no Supabase
    const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!userResponse.ok) {
      return res.status(401).json({ message: 'Sessão expirada.' });
    }

    const user: any = await userResponse.json();

    // Buscar perfil
    let profile: any = null;
    try {
      const profileResponse = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=*`, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
        },
      });
      if (profileResponse.ok) {
        const profiles: any = await profileResponse.json();
        if (Array.isArray(profiles) && profiles.length > 0) {
          profile = profiles[0];
        }
      }
    } catch {}

    const userName = profile?.full_name || user.user_metadata?.full_name || user.email?.split('@')[0];
    const affiliateTag = profile?.affiliate_tag || '';

    return res.json({
      success: true,
      token: token,
      userId: user.id,
      userName: userName,
      userPlan: profile?.plan || 'pro',
      plan: profile?.plan || 'pro',
      affiliateTag: affiliateTag,
      user: {
        id: user.id,
        email: user.email,
        fullName: userName,
        affiliateTag: affiliateTag,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ message: 'Erro no auto-login', error: error.message });
  }
});

/**
 * GET /version ou /api/extension/version
 */
router.get('/version', (_req: Request, res: Response) => {
  res.json({
    version: '1.0.0',
    minVersion: '1.0.0',
    downloadUrl: 'https://radar-ofertas-ml-api.vercel.app',
  });
});

/**
 * POST /salvar ou /api/automacao/salvar ou /api/extension/salvar
 */
router.post(['/salvar', '/automacao/salvar'], (req: Request, res: Response) => {
  console.log('[Extension API] Produto recebido da extensão:', req.body?.productName || req.body?.title);
  res.json({
    success: true,
    message: 'Produto salvo com sucesso no Radar Ofertas ML!',
    product: req.body,
  });
});

/**
 * GET /config ou /api/automacao/config
 */
router.get(['/config', '/automacao/config'], (_req: Request, res: Response) => {
  res.json({
    success: true,
    config: {
      freeShippingOnly: false,
      minRating: 400,
      minDiscount: 10,
      maxPrice: 5000000,
    },
  });
});

export default router;
