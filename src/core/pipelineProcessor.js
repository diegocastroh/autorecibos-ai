/**
 * Orquestador Central del Pipeline Diario de AutoRecibos AI.
 * 1. Sincroniza configuración (Local + Google Sheets opcional)
 * 2. Lee correos IMAP (o payloads manuales / demo)
 * 3. Extrae datos con IA (Gemini 3.8 Flash) + Parser Determinista Peruano
 * 4. Calcula distribución porcentual exacta al céntimo por servicio y grupo
 * 5. Envía el desglose a cada grupo de WhatsApp y gestiona recordatorios de vencimiento
 */

import {
  loadConfig,
  loadProcessedBills,
  saveProcessedBills,
  matchServiceConfig,
  syncConfigFromGoogleSheetsIfEnabled,
  calculateDaysUntilDue
} from '../services/configManager.js';
import { fetchRecentBillEmails, getDemoBillsEmailPayloads } from '../services/emailReader.js';
import { parseBillIntelligent, buildBillFingerprint } from './billParser.js';
import { calculateDistribution, formatWhatsAppMessage } from './costDistributor.js';
import { sendWhatsAppMessage } from '../services/whatsappService.js';

/**
 * Procesa un único recibo (desde correo, subida PDF/imagen en panel web o texto)
 * y devuelve su extracción, distribución por % y mensaje de WhatsApp.
 */
export async function processSingleBillInput(inputPayload, options = {}) {
  const config = options.config || loadConfig();
  const extracted = await parseBillIntelligent(inputPayload, config.services);

  if (!extracted.isBill || extracted.totalAmount <= 0) {
    return {
      isBill: false,
      extracted,
      reason: 'El documento o texto no parece ser un recibo válido con monto mayor a S/ 0.00.'
    };
  }

  // Permitir forzar el servicio si el usuario lo eligió manualmente en el panel
  let serviceConfig = null;
  if (inputPayload.forceServiceId) {
    serviceConfig = (config.services || []).find(
      (s) => s.id === inputPayload.forceServiceId || s.code === inputPayload.forceServiceId
    );
  }
  if (!serviceConfig) {
    serviceConfig = matchServiceConfig(extracted, config);
  }

  if (!serviceConfig) {
    throw new Error(`No se encontró configuración activa para el servicio ${extracted.serviceCode}`);
  }

  const distribution = calculateDistribution(extracted, serviceConfig);
  const whatsappMessage = formatWhatsAppMessage(distribution, config.paymentInfo, {
    mode: options.mode || 'NEW_BILL',
    daysUntilDue: calculateDaysUntilDue(extracted.dueDateIso)
  });
  const fingerprint = buildBillFingerprint(extracted);

  return {
    isBill: true,
    fingerprint,
    extracted,
    serviceConfig,
    distribution,
    whatsappMessage
  };
}

/**
 * Ejecuta el ciclo diario completo (lectura de correo + detección de nuevos recibos + recordatorios de vencimiento).
 */
export async function runDailyAutomation(options = {}) {
  const {
    demoMode = false,
    dryRun = false,
    forceResend = false
  } = options;

  let config = loadConfig();
  config = await syncConfigFromGoogleSheetsIfEnabled(config);
  const ledger = loadProcessedBills();
  ledger.bills = Array.isArray(ledger.bills) ? ledger.bills : [];

  const summary = {
    startedAt: new Date().toISOString(),
    mode: demoMode ? 'DEMO' : 'IMAP_REAL',
    dryRun,
    emailsScanned: 0,
    newBillsDetected: 0,
    remindersSent: 0,
    messagesDispatched: [],
    skippedDuplicates: [],
    errors: []
  };

  // 1. Obtener correos de recibos (Demo o IMAP real)
  let rawEmails = [];
  try {
    if (demoMode) {
      rawEmails = getDemoBillsEmailPayloads();
    } else if (config.email?.enabled !== false) {
      rawEmails = await fetchRecentBillEmails(config.email);
    }
  } catch (err) {
    summary.errors.push(`Lectura de correo: ${err.message}`);
  }

  summary.emailsScanned = rawEmails.length;

  // 2. Procesar cada correo encontrado
  for (const emailItem of rawEmails) {
    try {
      const processed = await processSingleBillInput(
        {
          text: emailItem.text,
          fileBuffer: emailItem.fileBuffer,
          mimeType: emailItem.mimeType
        },
        { config, mode: 'NEW_BILL' }
      );

      if (!processed.isBill) continue;

      const existingEntry = ledger.bills.find((b) => b.fingerprint === processed.fingerprint);
      if (existingEntry && !forceResend) {
        summary.skippedDuplicates.push({
          fingerprint: processed.fingerprint,
          serviceName: processed.distribution.serviceName,
          totalAmount: processed.distribution.totalAmount
        });
        continue;
      }

      const targetJid =
        processed.distribution.whatsappGroup?.jid || config.whatsapp?.defaultGroupJid || '';

      let sendResult = {
        success: true,
        dryRun: true,
        provider: 'dry-run',
        targetJid
      };

      if (config.schedule?.sendOnNewBill !== false) {
        try {
          sendResult = await sendWhatsAppMessage({
            targetJid,
            messageText: processed.whatsappMessage,
            whatsappConfig: config.whatsapp,
            dryRun
          });
        } catch (waErr) {
          summary.errors.push(
            `Error enviando WhatsApp (${processed.distribution.serviceName}): ${waErr.message}`
          );
          sendResult = {
            success: false,
            error: waErr.message,
            targetJid
          };
        }
      }

      const billRecord = {
        id: `bill_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        fingerprint: processed.fingerprint,
        createdAt: new Date().toISOString(),
        sourceEmailId: emailItem.id,
        sourceSubject: emailItem.subject,
        serviceId: processed.distribution.serviceId,
        serviceCode: processed.distribution.serviceCode,
        serviceName: processed.distribution.serviceName,
        serviceIcon: processed.distribution.serviceIcon,
        providerName: processed.distribution.providerName,
        supplyNumber: processed.distribution.supplyNumber,
        invoiceNumber: processed.distribution.invoiceNumber,
        billingPeriod: processed.distribution.billingPeriod,
        dueDate: processed.distribution.dueDate,
        dueDateIso: processed.extracted.dueDateIso,
        totalAmount: processed.distribution.totalAmount,
        formattedTotal: processed.distribution.formattedTotal,
        whatsappGroup: processed.distribution.whatsappGroup,
        shares: processed.distribution.shares,
        whatsappMessage: processed.whatsappMessage,
        extractionEngine: processed.extracted.extractionEngine,
        paid: false,
        remindersSent: [],
        lastDelivery: sendResult
      };

      if (existingEntry) {
        Object.assign(existingEntry, billRecord);
      } else {
        ledger.bills.unshift(billRecord);
      }

      summary.newBillsDetected += 1;
      summary.messagesDispatched.push({
        type: 'NEW_BILL',
        serviceName: billRecord.serviceName,
        totalAmount: billRecord.totalAmount,
        groupName: billRecord.whatsappGroup?.name,
        targetJid,
        delivery: sendResult
      });
    } catch (itemErr) {
      summary.errors.push(`Error procesando correo "${emailItem.subject}": ${itemErr.message}`);
    }
  }

  // 3. Revisar recordatorios automáticos de vencimiento (ej. faltan 3 días o 1 día)
  const reminderDays = Array.isArray(config.schedule?.sendReminderDaysBeforeDue)
    ? config.schedule.sendReminderDaysBeforeDue
    : [3, 1];

  for (const savedBill of ledger.bills) {
    if (savedBill.paid || !savedBill.dueDateIso) continue;
    const daysLeft = calculateDaysUntilDue(savedBill.dueDateIso);
    if (daysLeft === null || !reminderDays.includes(daysLeft)) continue;

    savedBill.remindersSent = Array.isArray(savedBill.remindersSent) ? savedBill.remindersSent : [];
    const reminderTag = `D-${daysLeft}`;
    if (savedBill.remindersSent.includes(reminderTag)) continue;

    const serviceConfig =
      matchServiceConfig({ serviceCode: savedBill.serviceCode }, config) || {
        id: savedBill.serviceId,
        code: savedBill.serviceCode,
        name: savedBill.serviceName,
        icon: savedBill.serviceIcon,
        whatsappGroup: savedBill.whatsappGroup,
        members: savedBill.shares
      };

    const distribution = calculateDistribution(savedBill, serviceConfig);
    const reminderMsg = formatWhatsAppMessage(distribution, config.paymentInfo, {
      mode: 'REMINDER',
      daysUntilDue: daysLeft
    });
    const targetJid =
      distribution.whatsappGroup?.jid || config.whatsapp?.defaultGroupJid || '';

    try {
      const sendResult = await sendWhatsAppMessage({
        targetJid,
        messageText: reminderMsg,
        whatsappConfig: config.whatsapp,
        dryRun
      });
      savedBill.remindersSent.push(reminderTag);
      summary.remindersSent += 1;
      summary.messagesDispatched.push({
        type: 'REMINDER',
        daysUntilDue: daysLeft,
        serviceName: savedBill.serviceName,
        totalAmount: savedBill.totalAmount,
        groupName: savedBill.whatsappGroup?.name,
        targetJid,
        delivery: sendResult
      });
    } catch (remErr) {
      summary.errors.push(`Error enviando recordatorio (${savedBill.serviceName}): ${remErr.message}`);
    }
  }

  ledger.lastRunAt = new Date().toISOString();
  saveProcessedBills(ledger);
  summary.finishedAt = ledger.lastRunAt;

  return summary;
}
