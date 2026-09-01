import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import marketplaceRouter from '../apps/api/src/routes/marketplace.js';
import whatsappRouter from '../apps/api/src/routes/whatsapp.js';
import { requireAuth } from '../apps/api/src/middleware/auth.js';

// Carrega variáveis de ambiente
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const app = express();

app.use(cors());
app.use(express.json());

// ─── Rotas Públicas ───────────────────────────────────────────────────────────
app.get('/api/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Radar de Ofertas ML - Serverless API Vercel',
    timestamp: new Date().toISOString(),
  });
});

// Marketplace: rotas públicas (sem autenticação)
// O requireAuth está aplicado diretamente nos handlers protegidos dentro de marketplaceRouter
app.use('/api/v1/marketplace', marketplaceRouter);

// WhatsApp: todas as rotas requerem JWT
app.use('/api/v1/whatsapp', requireAuth, whatsappRouter);

export default app;
