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
 * Decodifica e valida um JWT usando HMAC-SHA256 (algoritmo HS256 do Supabase).
 * Retorna o payload se válido, null caso contrário.
 */
function verifyJwt(token: string, secret: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verifica a assinatura
    const signingInput = `${headerB64}.${payloadB64}`;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(signingInput)
      .digest('base64url');

    if (expectedSig !== signatureB64) return null;

    // Decodifica e verifica expiração
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;

    return payload;
  } catch {
    return null;
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

  const token = authHeader.slice(7);

  if (!JWT_SECRET) {
    // Modo desenvolvimento: aceita qualquer token e tenta ler o payload sem verificar assinatura
    try {
      const parts = token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      req.user = { id: payload.sub, email: payload.email || '' };
      next();
    } catch {
      res.status(401).json({ success: false, error: 'Token inválido' });
    }
    return;
  }

  const payload = verifyJwt(token, JWT_SECRET);

  if (!payload || !payload.sub) {
    res.status(401).json({
      success: false,
      error: 'Token inválido ou expirado. Faça login novamente.',
    });
    return;
  }

  req.user = {
    id: payload.sub as string,
    email: (payload.email as string) || '',
  };

  next();
}
