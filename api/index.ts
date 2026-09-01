import express from 'express';
import cors from 'cors';
import marketplaceRouter from '../apps/api/src/routes/marketplace.js';
import whatsappRouter from '../apps/api/src/routes/whatsapp.js';

const app = express();

app.use(cors());
app.use(express.json());

// Health Check Serverless
app.get('/api/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Radar de Ofertas ML - Serverless API Vercel',
    timestamp: new Date().toISOString(),
  });
});

// Rotas do Marketplace e WhatsApp
app.use('/api/v1/marketplace', marketplaceRouter);
app.use('/api/v1/whatsapp', whatsappRouter);

export default app;
