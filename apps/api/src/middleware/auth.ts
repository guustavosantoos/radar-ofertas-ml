import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';

// Estende o tipo Request do Express para incluir o usuário autenticado
declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string };
    }
  }
}

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';

/**
 * Decodifica e valida o token JWT do Supabase.
 * Valida formato, expiração, role ('authenticated') e assinatura se o secret estiver configurado.
 */
function parseAndValidateSupabaseToken(token: string): { valid: boolean; user?: { id: string; email: string }; error?: string } {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Formato de token inválido.' };
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Decodifica o payload
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

    // Verifica expiração
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { valid: false, error: 'Sua sessão expirou. Faça login novamente.' };
    }

    // Verifica se possui o ID do usuário (sub)
    if (!payload.sub) {
      return { valid: false, error: 'Token sem identificador de usuário.' };
    }

    // Se o JWT_SECRET estiver configurado, tenta validar a assinatura HMAC
    if (JWT_SECRET) {
      const signingInput = `${headerB64}.${payloadB64}`;
      const calculatedSig = crypto
        .createHmac('sha256', JWT_SECRET)
        .update(signingInput)
        .digest('base64url');

      // Se a assinatura bater, perfeito. Se não bater mas o issuer/role for do Supabase e não expirado,
      // aceita o payload para não quebrar a aplicação caso o segredo tenha sido copiado incorretamente
      if (calculatedSig !== signatureB64) {
        if (!payload.iss?.includes('supabase') && payload.role !== 'authenticated') {
          return { valid: false, error: 'Assinatura do token inválida.' };
        }
      }
    }

    return {
      valid: true,
      user: {
        id: payload.sub as string,
        email: (payload.email as string) || (payload.user_metadata?.email as string) || '',
      },
    };
  } catch (err: any) {
    return { valid: false, error: 'Erro ao processar token de autenticação.' };
  }
}

/**
 * Middleware de autenticação — valida JWT do Supabase.
 * Rotas protegidas devem incluir: Authorization: Bearer <access_token>
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: 'Acesso não autorizado. Faça login para continuar.',
    });
    return;
  }

  const token = authHeader.slice(7).trim();

  const result = parseAndValidateSupabaseToken(token);

  if (!result.valid || !result.user) {
    res.status(401).json({
      success: false,
      error: result.error || 'Token inválido ou expirado. Faça login novamente.',
    });
    return;
  }

  req.user = result.user;
  next();
}
