import { Router } from 'express';
import {
  getGroupsByUser,
  insertGroup,
  deleteGroup,
  getTemplatesByUser,
  insertTemplate,
  deleteTemplate,
} from '../lib/supabase-admin.js';

const router = Router();

/**
 * GET /api/v1/whatsapp/status
 * Status da integração (sem conexão real por enquanto — retorna estado do usuário)
 */
router.get('/status', (req, res) => {
  res.json({
    success: true,
    data: {
      connected: false,
      provider: 'direct',
      userId: req.user?.id,
      message: 'Configure a integração via Z-API ou Evolution API para envio automático.',
    },
  });
});

/**
 * GET /api/v1/whatsapp/groups
 * Lista os grupos WhatsApp do usuário autenticado (persistido no Supabase)
 */
router.get('/groups', async (req, res) => {
  try {
    const groups = await getGroupsByUser(req.user!.id);
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
 * Cadastra um novo grupo para o usuário autenticado
 */
router.post('/groups', async (req, res) => {
  try {
    const { id, name, participantsCount } = req.body;
    if (!id || !name) {
      return res.status(400).json({
        success: false,
        error: 'Campos id (JID do grupo) e name são obrigatórios',
      });
    }
    const created = await insertGroup(req.user!.id, id, name, Number(participantsCount) || 1);
    res.json({ success: true, data: created });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/v1/whatsapp/groups/:id
 * Remove um grupo do usuário autenticado
 */
router.delete('/groups/:id', async (req, res) => {
  try {
    await deleteGroup(req.user!.id, req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/whatsapp/custom-templates
 * Lista os templates de mensagens do usuário autenticado
 */
router.get('/custom-templates', async (req, res) => {
  try {
    const templates = await getTemplatesByUser(req.user!.id);
    res.json({
      success: true,
      count: templates.length,
      data: templates,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/whatsapp/custom-templates
 * Salva um novo template para o usuário autenticado
 */
router.post('/custom-templates', async (req, res) => {
  try {
    const { name, templateText } = req.body;
    if (!name || !templateText) {
      return res.status(400).json({
        success: false,
        error: 'Os campos name e templateText são obrigatórios',
      });
    }
    const created = await insertTemplate(req.user!.id, name, templateText);
    res.json({ success: true, data: created });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/v1/whatsapp/custom-templates/:id
 * Remove um template do usuário autenticado
 */
router.delete('/custom-templates/:id', async (req, res) => {
  try {
    await deleteTemplate(req.user!.id, req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/whatsapp/dispatch
 * Envia mensagem para os grupos (requer integração Z-API / Evolution)
 */
router.post('/dispatch', async (req, res) => {
  try {
    const { groupIds, messageText } = req.body;
    if (!groupIds || !Array.isArray(groupIds) || groupIds.length === 0) {
      return res.status(400).json({ success: false, error: 'A lista de groupIds é obrigatória' });
    }
    if (!messageText) {
      return res.status(400).json({ success: false, error: 'O parâmetro messageText é obrigatório' });
    }

    // Retorna sucesso com instrução — integração real via Z-API será configurada pelo usuário
    res.json({
      success: true,
      data: {
        dispatched: 0,
        groupIds,
        message: 'Configure Z-API ou Evolution API em Configurações para envio automático.',
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
