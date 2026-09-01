import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import marketplaceRouter, { mlService } from './routes/marketplace.js';
import whatsappRouter from './routes/whatsapp.js';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health Check
app.get('/api/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Radar de Ofertas ML - API Backend',
    timestamp: new Date().toISOString(),
  });
});

// Rotas do Marketplace e WhatsApp
app.use('/api/v1/marketplace', marketplaceRouter);
app.use('/api/v1/whatsapp', whatsappRouter);

// Inicia o servidor apenas se for executado diretamente
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🚀 RADAR DE OFERTAS API RODANDO NA PORTA ${PORT}`);
    console.log(`📍 Health Check: http://localhost:${PORT}/api/v1/health`);
    console.log(`📍 Mercado Livre Destaques: http://localhost:${PORT}/api/v1/marketplace/mercadolivre/highlights?category=MLB1051`);
    console.log(`📍 Mercado Livre Tendências: http://localhost:${PORT}/api/v1/marketplace/mercadolivre/trends?category=MLB1051`);
    console.log(`📍 Mercado Livre Ofertas: http://localhost:${PORT}/api/v1/marketplace/mercadolivre/deals`);
    console.log(`==================================================`);

    // Inicia o scanner automático de segundo plano (varredura a cada 5 minutos)
    mlService.startAutoScanner(5);
  });
}

export default app;


