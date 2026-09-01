import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import marketplaceRouter, { mlService } from './routes/marketplace.js';
import whatsappRouter from './routes/whatsapp.js';
import { requireAuth } from './middleware/auth.js';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── Rotas Públicas ───────────────────────────────────────────────────────────
app.get('/api/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Radar de Ofertas ML - API Backend',
    timestamp: new Date().toISOString(),
  });
});

// Endpoint público para busca de ofertas sem login (usado pelo dashboard inicial)
app.use('/api/v1/marketplace/mercadolivre/deals', marketplaceRouter);
app.use('/api/v1/marketplace/mercadolivre/best-sellers', marketplaceRouter);

// ─── Rotas Protegidas (requerem JWT do Supabase) ──────────────────────────────
app.use('/api/v1/marketplace', requireAuth, marketplaceRouter);
app.use('/api/v1/whatsapp', requireAuth, whatsappRouter);

// ─── Servidor Local ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🚀 RADAR DE OFERTAS API RODANDO NA PORTA ${PORT}`);
    console.log(`📍 Health Check: http://localhost:${PORT}/api/v1/health`);
    console.log(`📍 Mercado Livre Ofertas: http://localhost:${PORT}/api/v1/marketplace/mercadolivre/deals`);
    console.log(`📍 Mensagens Promocionais (auth): http://localhost:${PORT}/api/v1/marketplace/mercadolivre/promotional-messages`);
    console.log(`==================================================`);

    // Scanner automático só funciona em servidor dedicado (não Vercel)
    mlService.startAutoScanner(5);
  });
}

export default app;


