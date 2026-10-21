/**
 * Gestor de Configuración Persistente, Sincronización opcional con Google Sheets
 * y Registro Histórico de Recibos Procesados (Deduplicación + Recordatorios de Vencimiento).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const PROCESSED_PATH = path.join(DATA_DIR, 'processed_bills.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadConfig() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`No se encontró el archivo de configuración en ${CONFIG_PATH}`);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

export function saveConfig(newConfig) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf-8');
  return newConfig;
}

export function loadProcessedBills() {
  ensureDataDir();
  if (!fs.existsSync(PROCESSED_PATH)) {
    const initial = { lastRunAt: null, bills: [] };
    fs.writeFileSync(PROCESSED_PATH, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf-8'));
  } catch {
    return { lastRunAt: null, bills: [] };
  }
}

export function saveProcessedBills(ledger) {
  ensureDataDir();
  fs.writeFileSync(PROCESSED_PATH, JSON.stringify(ledger, null, 2), 'utf-8');
  return ledger;
}

/**
 * Busca la configuración del servicio (Sedapal, Pluz, Cálidda, Internet, etc.)
 * que corresponde a un recibo extraído.
 */
export function matchServiceConfig(bill, config) {
  const services = Array.isArray(config?.services) ? config.services : [];
  const enabledServices = services.filter((s) => s.enabled !== false);

  const codeUpper = String(bill.serviceCode || '').toUpperCase();
  const byCode = enabledServices.find(
    (s) =>
      String(s.code || '').toUpperCase() === codeUpper ||
      String(s.id || '').toUpperCase() === codeUpper
  );
  if (byCode) return byCode;

  const combined = `${bill.providerName || ''} ${bill.supplyNumber || ''}`.toLowerCase();
  const byKeyword = enabledServices.find((s) =>
    (s.senderKeywords || []).some((kw) => combined.includes(String(kw).toLowerCase()))
  );
  return byKeyword || enabledServices[0] || null;
}

/**
 * Sincroniza porcentajes desde una hoja de Google Sheets publicada como CSV (opcional).
 * Formato esperado de columnas CSV:
 * ServicioCodigo,MiembroNombre,Porcentaje,Telefono,GrupoWhatsAppJID,GrupoWhatsAppNombre
 */
export async function syncConfigFromGoogleSheetsIfEnabled(config) {
  const csvUrl = process.env.GOOGLE_SHEETS_CSV_URL || config?.googleSheets?.csvConfigUrl;
  if (!csvUrl || (!config?.googleSheets?.enabled && !process.env.GOOGLE_SHEETS_CSV_URL)) {
    return config;
  }

  try {
    const response = await fetch(csvUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const csvText = await response.text();
    const lines = csvText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length < 2) return config;

    const grouped = new Map();
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.replace(/^"|"$/g, '').trim());
      if (cols.length < 3) continue;
      const [serviceCode, memberName, pctStr, phone = '', groupJid = '', groupName = ''] = cols;
      const pct = Number(pctStr);
      if (!serviceCode || !memberName || !Number.isFinite(pct)) continue;

      const key = serviceCode.toUpperCase();
      if (!grouped.has(key)) {
        grouped.set(key, { members: [], groupJid, groupName });
      }
      const entry = grouped.get(key);
      entry.members.push({
        id: `gs_${entry.members.length + 1}`,
        name: memberName,
        percentage: pct,
        phone
      });
      if (groupJid) entry.groupJid = groupJid;
      if (groupName) entry.groupName = groupName;
    }

    for (const svc of config.services || []) {
      const key = String(svc.code || svc.id || '').toUpperCase();
      if (grouped.has(key)) {
        const gsData = grouped.get(key);
        if (gsData.members.length > 0) {
          svc.members = gsData.members;
        }
        if (gsData.groupJid) {
          svc.whatsappGroup = svc.whatsappGroup || {};
          svc.whatsappGroup.jid = gsData.groupJid;
        }
        if (gsData.groupName) {
          svc.whatsappGroup = svc.whatsappGroup || {};
          svc.whatsappGroup.name = gsData.groupName;
        }
      }
    }

    saveConfig(config);
    return config;
  } catch (err) {
    console.warn(`[AutoRecibos AI] No se pudo sincronizar Google Sheets CSV (${err.message}). Usando config.json local.`);
    return config;
  }
}

/**
 * Calcula cuántos días faltan para la fecha de vencimiento (YYYY-MM-DD).
 */
export function calculateDaysUntilDue(dueDateIso, referenceDate = new Date()) {
  if (!dueDateIso || !/^\d{4}-\d{2}-\d{2}$/.test(dueDateIso)) return null;
  const [y, m, d] = dueDateIso.split('-').map(Number);
  const dueUtc = Date.UTC(y, m - 1, d);
  const refUtc = Date.UTC(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate()
  );
  return Math.round((dueUtc - refUtc) / (1000 * 60 * 60 * 24));
}
