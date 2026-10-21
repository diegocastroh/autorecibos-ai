/**
 * Servidor Web e Interfaz REST API para el Panel de Control de AutoRecibos AI.
 */

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  saveConfig,
  loadProcessedBills,
  saveProcessedBills
} from './services/configManager.js';
import { processSingleBillInput, runDailyAutomation } from './core/pipelineProcessor.js';
import {
  getWhatsAppStatus,
  startBaileysSession,
  disconnectWhatsApp,
  listWhatsAppGroups,
  exportAuthStateToBase64,
  sendWhatsAppMessage
} from './services/whatsappService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15 MB máx para PDFs/imágenes de recibos
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(PUBLIC_DIR));

// Obtener configuración y estado del sistema
app.get('/api/config', (req, res) => {
  try {
    const config = loadConfig();
    res.json({
      config,
      envStatus: {
        hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
        hasEmailCreds: Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS),
        emailUser: process.env.EMAIL_USER || '',
        whatsappStatus: getWhatsAppStatus()
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Guardar configuración completa
app.put('/api/config', (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || !Array.isArray(newConfig.services)) {
      return res.status(400).json({ error: 'Formato de configuración inválido: falta la lista de servicios.' });
    }
    const saved = saveConfig(newConfig);
    res.json({ success: true, config: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener historial de recibos procesados
app.get('/api/bills', (req, res) => {
  try {
    const ledger = loadProcessedBills();
    res.json(ledger);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Marcar un recibo como pagado / pendiente
app.patch('/api/bills/:id/paid', (req, res) => {
  try {
    const ledger = loadProcessedBills();
    const item = (ledger.bills || []).find((b) => b.id === req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Recibo no encontrado.' });
    }
    item.paid = Boolean(req.body.paid);
    saveProcessedBills(ledger);
    res.json({ success: true, bill: item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar un recibo del historial
app.delete('/api/bills/:id', (req, res) => {
  try {
    const ledger = loadProcessedBills();
    ledger.bills = (ledger.bills || []).filter((b) => b.id !== req.params.id);
    saveProcessedBills(ledger);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analizar un recibo subido manualmente (PDF, Imagen o Texto) y previsualizar su distribución por %
app.post('/api/analyze', upload.single('file'), async (req, res) => {
  try {
    const text = req.body?.text || '';
    const forceServiceId = req.body?.serviceId || '';
    const fileBuffer = req.file ? req.file.buffer : null;
    const mimeType = req.file ? req.file.mimetype : '';

    const result = await processSingleBillInput({
      text,
      fileBuffer,
      mimeType,
      forceServiceId
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Guardar un recibo analizado y enviarlo al grupo de WhatsApp (o simular envío)
app.post('/api/bills/confirm-and-send', async (req, res) => {
  try {
    const { processedBill, dryRun = false } = req.body;
    if (!processedBill || !processedBill.distribution) {
      return res.status(400).json({ error: 'Datos de recibo procesado incompletos.' });
    }

    const config = loadConfig();
    const ledger = loadProcessedBills();
    ledger.bills = Array.isArray(ledger.bills) ? ledger.bills : [];

    const dist = processedBill.distribution;
    const targetJid = dist.whatsappGroup?.jid || config.whatsapp?.defaultGroupJid || '';

    const delivery = await sendWhatsAppMessage({
      targetJid,
      messageText: processedBill.whatsappMessage,
      whatsappConfig: config.whatsapp,
      dryRun: Boolean(dryRun)
    });

    const billRecord = {
      id: `bill_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      fingerprint: processedBill.fingerprint || `${dist.serviceCode}::${Date.now()}`,
      createdAt: new Date().toISOString(),
      sourceEmailId: 'manual-upload',
      sourceSubject: `Subida Manual - ${dist.serviceName}`,
      serviceId: dist.serviceId,
      serviceCode: dist.serviceCode,
      serviceName: dist.serviceName,
      serviceIcon: dist.serviceIcon,
      providerName: dist.providerName,
      supplyNumber: dist.supplyNumber,
      invoiceNumber: dist.invoiceNumber,
      billingPeriod: dist.billingPeriod,
      dueDate: dist.dueDate,
      dueDateIso: processedBill.extracted?.dueDateIso || null,
      totalAmount: dist.totalAmount,
      formattedTotal: dist.formattedTotal,
      whatsappGroup: dist.whatsappGroup,
      shares: dist.shares,
      whatsappMessage: processedBill.whatsappMessage,
      extractionEngine: processedBill.extracted?.extractionEngine || 'manual',
      paid: false,
      remindersSent: [],
      lastDelivery: delivery
    };

    ledger.bills.unshift(billRecord);
    ledger.lastRunAt = new Date().toISOString();
    saveProcessedBills(ledger);

    res.json({ success: true, bill: billRecord, delivery });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ejecutar el ciclo diario completo bajo demanda (Demo o IMAP real)
app.post('/api/run-daily', async (req, res) => {
  try {
    const { demoMode = false, dryRun = true, forceResend = false } = req.body || {};
    const report = await runDailyAutomation({
      demoMode: Boolean(demoMode),
      dryRun: Boolean(dryRun),
      forceResend: Boolean(forceResend)
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoints de WhatsApp (QR, estado, grupos, exportar sesión para GitHub Actions)
app.get('/api/whatsapp/status', (req, res) => {
  res.json(getWhatsAppStatus());
});

app.post('/api/whatsapp/connect', async (req, res) => {
  try {
    await startBaileysSession({ waitForOpenMs: 0 });
    res.json(getWhatsAppStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    const logout = Boolean(req.body?.logout);
    await disconnectWhatsApp(logout);
    res.json(getWhatsAppStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/groups', async (req, res) => {
  try {
    const groups = await listWhatsAppGroups();
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/export-session', (req, res) => {
  const base64 = exportAuthStateToBase64();
  if (!base64) {
    return res.status(404).json({
      error: 'Aún no hay una sesión vinculada de WhatsApp para exportar. Vincúlala primero con QR.'
    });
  }
  res.json({ base64 });
});

app.post('/api/whatsapp/send-test', async (req, res) => {
  try {
    const { targetJid, messageText, dryRun = false } = req.body;
    const config = loadConfig();
    const delivery = await sendWhatsAppMessage({
      targetJid,
      messageText,
      whatsappConfig: config.whatsapp,
      dryRun: Boolean(dryRun)
    });
    res.json(delivery);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export function startServer(port = Number(process.env.PORT || 3080)) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`🚀 AutoRecibos AI Panel Web activo en: http://localhost:${port}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer();
}

export default app;
