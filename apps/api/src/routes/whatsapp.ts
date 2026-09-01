import { Router } from 'express';
import { WhatsAppService, WhatsAppCredentials } from '@radar-ofertas/messaging';

const router = Router();
export const whatsappService = new WhatsAppService({ provider: 'direct' });

/**
 * GET /api/v1/whatsapp/status
 * Retorna o status da conexão real da API do WhatsApp
 */
router.get('/status', async (_req, res) => {
  try {
    const status = await whatsappService.getStatus();
    res.json({ success: true, data: status });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/whatsapp/configure
 * Configura as credenciais da API Oficial Meta Cloud, Z-API/Evolution ou Modo Direto
 */
router.post('/configure', async (req, res) => {
  try {
    const creds: WhatsAppCredentials = req.body && req.body.provider ? req.body : { provider: 'direct' };
    const status = whatsappService.configure(creds);
    res.json({ success: true, data: status });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/whatsapp/disconnect
 * Desconecta a API de WhatsApp
 */
router.post('/disconnect', async (_req, res) => {
  try {
    const status = whatsappService.disconnect();
    res.json({ success: true, data: status });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/whatsapp/groups
 * Retorna os grupos cadastrados do WhatsApp
 */
router.get('/groups', async (_req, res) => {
  try {
    const groups = await whatsappService.getGroups();
    res.json({
      success: true,
      count: groups.length,
      data: groups,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/whatsapp/groups
 * Adiciona um novo grupo real pelo ID/JID e Nome
 */
router.post('/groups', async (req, res) => {
  try {
    const { id, name, participantsCount } = req.body;
    if (!id || !name) {
      return res.status(400).json({ success: false, error: 'Campos id (JID do grupo) e name são obrigatórios' });
    }
    const created = await whatsappService.addGroup({ id, name, participantsCount: Number(participantsCount) || 1 });
    res.json({ success: true, data: created });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/v1/whatsapp/groups/:id
 * Remove um grupo cadastrado
 */
router.delete('/groups/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const ok = await whatsappService.removeGroup(id);
    res.json({ success: ok });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/whatsapp/custom-templates
 * Lista os templates de mensagens criados pelo usuário
 */
router.get('/custom-templates', async (_req, res) => {
  try {
    const templates = await whatsappService.getCustomTemplates();
    res.json({ success: true, count: templates.length, data: templates });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/whatsapp/custom-templates
 * Salva um novo template de mensagem customizada
 */
router.post('/custom-templates', async (req, res) => {
  try {
    const { name, templateText } = req.body;
    if (!name || !templateText) {
      return res.status(400).json({ success: false, error: 'Os campos name e templateText são obrigatórios' });
    }
    const created = await whatsappService.saveCustomTemplate(name, templateText);
    res.json({ success: true, data: created });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/v1/whatsapp/custom-templates/:id
 * Remove um template customizado
 */
router.delete('/custom-templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const ok = await whatsappService.deleteCustomTemplate(id);
    res.json({ success: ok });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/whatsapp/dispatch
 * Envia mensagens para os grupos configurados
 */
router.post('/dispatch', async (req, res) => {
  try {
    const { groupIds, messageText, productId } = req.body;
    if (!groupIds || !Array.isArray(groupIds) || groupIds.length === 0) {
      return res.status(400).json({ success: false, error: 'A lista de groupIds é obrigatória' });
    }
    if (!messageText) {
      return res.status(400).json({ success: false, error: 'O parâmetro messageText é obrigatório' });
    }

    const result = await whatsappService.dispatchToGroups({
      groupIds,
      messageText,
      productId,
    });

    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
