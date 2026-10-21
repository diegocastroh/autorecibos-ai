/**
 * Servicio Multi-Motor de WhatsApp para AutoRecibos AI:
 * 1. Baileys (@whiskeysockets/baileys) -> Número propio logueado por QR (soporta Grupos @g.us y contactos).
 *    Permite exportar/importar sesión en Base64 (WHATSAPP_SESSION_BASE64) para ejecución stateless en GitHub Actions.
 * 2. Green-API Free Plan -> Envío a grupos y números vía REST API gratuita.
 * 3. CallMeBot / Webhook Personalizado -> Alternativas gratuitas HTTP.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const AUTH_DIR = path.join(ROOT_DIR, 'data', 'whatsapp_auth');

let activeSocket = null;
let isStartingSession = false;
let connectionState = {
  status: 'DISCONNECTED', // DISCONNECTED | CONNECTING | QR_READY | PAIRING | CONNECTED
  qrDataUrl: null,
  qrRaw: null,
  connectedUser: null,
  lastError: null,
  groupsCache: []
};

/**
 * Normaliza un destino de WhatsApp a JID válido:
 * - Si ya termina en @g.us o @s.whatsapp.net, se conserva.
 * - Si contiene un guion largo o más de 15 dígitos sin prefijo, se asume grupo @g.us.
 * - Si es un teléfono (ej. 999888777 o 51999888777), se formatea a 51...@s.whatsapp.net.
 */
export function normalizeWhatsAppJid(target) {
  if (!target) return '';
  const clean = String(target).trim();
  if (clean.endsWith('@g.us') || clean.endsWith('@s.whatsapp.net')) {
    return clean;
  }
  const digits = clean.replace(/[^\d-]/g, '');
  if (digits.includes('-') || digits.length >= 16) {
    return `${digits}@g.us`;
  }
  const onlyNums = digits.replace(/\D/g, '');
  if (!onlyNums) return '';
  const withCountry = onlyNums.length === 9 ? `51${onlyNums}` : onlyNums;
  return `${withCountry}@s.whatsapp.net`;
}

/**
 * Restaura la carpeta de sesión Baileys desde la variable de entorno WHATSAPP_SESSION_BASE64
 * (Ideal para GitHub Actions donde el contenedor es efímero).
 */
export function restoreAuthStateFromBase64(base64String = process.env.WHATSAPP_SESSION_BASE64) {
  if (!base64String || typeof base64String !== 'string' || !base64String.trim()) {
    return false;
  }
  try {
    const decodedJson = Buffer.from(base64String.trim(), 'base64').toString('utf-8');
    const filesMap = JSON.parse(decodedJson);
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
    for (const [fileName, fileContent] of Object.entries(filesMap)) {
      const safeName = path.basename(fileName);
      fs.writeFileSync(path.join(AUTH_DIR, safeName), fileContent, 'utf-8');
    }
    return true;
  } catch (err) {
    console.warn(`[WhatsApp] Error restaurando WHATSAPP_SESSION_BASE64: ${err.message}`);
    return false;
  }
}

/**
 * Exporta los archivos esenciales de autenticación de Baileys (creds.json y llaves)
 * a un string Base64 compacto para guardarlo en GitHub Secrets (WHATSAPP_SESSION_BASE64).
 */
export function exportAuthStateToBase64() {
  if (!fs.existsSync(AUTH_DIR)) return null;
  const files = fs.readdirSync(AUTH_DIR);
  if (!files.includes('creds.json')) return null;

  const bundle = {};
  for (const file of files) {
    if (file === 'creds.json' || file.startsWith('app-state-sync-key') || file.startsWith('pre-key')) {
      const fullPath = path.join(AUTH_DIR, file);
      if (fs.statSync(fullPath).isFile()) {
        bundle[file] = fs.readFileSync(fullPath, 'utf-8');
      }
    }
  }
  return Buffer.from(JSON.stringify(bundle), 'utf-8').toString('base64');
}

export function hasSavedBaileysSession() {
  const credsPath = path.join(AUTH_DIR, 'creds.json');
  if (!fs.existsSync(credsPath)) return false;
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    return Boolean(creds?.me?.id || creds?.registered);
  } catch {
    return false;
  }
}

export function getWhatsAppStatus() {
  return {
    ...connectionState,
    hasSavedSession: hasSavedBaileysSession()
  };
}

/**
 * Inicia o reutiliza la conexión con WhatsApp mediante Baileys.
 * Maneja automáticamente el código 515 (restartRequired tras escanear QR) y limpia sesiones corruptas.
 */
export async function startBaileysSession(options = {}) {
  const { waitForOpenMs = 0, onQr = null, forceReset = false } = options;

  if (forceReset) {
    await disconnectWhatsApp(true);
  }

  if (!hasSavedBaileysSession() && process.env.WHATSAPP_SESSION_BASE64 && !forceReset) {
    restoreAuthStateFromBase64(process.env.WHATSAPP_SESSION_BASE64);
  }

  if (activeSocket && (connectionState.status === 'CONNECTED' || connectionState.status === 'QR_READY')) {
    return activeSocket;
  }

  if (isStartingSession && activeSocket) {
    return activeSocket;
  }

  isStartingSession = true;

  // Si hay archivos a medio crear sin registrar y se pide nuevo inicio, limpiar para asegurar QR fresco
  if (!hasSavedBaileysSession() && fs.existsSync(AUTH_DIR) && connectionState.status === 'DISCONNECTED') {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch {
      // Ignorar
    }
  }

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  connectionState.status = 'CONNECTING';
  connectionState.lastError = null;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version = [2, 3000, 1015901307];
  try {
    const latest = await fetchLatestBaileysVersion();
    if (latest?.version) version = latest.version;
  } catch {
    // Usar versión por defecto si falla la consulta
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  activeSocket = sock;
  isStartingSession = false;

  sock.ev.on('creds.update', saveCreds);

  const openPromise = new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = null;

    if (waitForOpenMs > 0) {
      timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Tiempo de espera agotado (${waitForOpenMs}ms) conectando a WhatsApp.`));
        }
      }, waitForOpenMs);
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionState.status = 'QR_READY';
        connectionState.qrRaw = qr;
        connectionState.lastError = null;
        try {
          connectionState.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 280 });
        } catch {
          connectionState.qrDataUrl = null;
        }
        if (typeof onQr === 'function') {
          onQr(qr, connectionState.qrDataUrl);
        }
      }

      if (connection === 'open') {
        connectionState.status = 'CONNECTED';
        connectionState.qrDataUrl = null;
        connectionState.qrRaw = null;
        connectionState.lastError = null;
        connectionState.connectedUser = {
          id: sock.user?.id || '',
          name: sock.user?.name || 'Número Vinculado'
        };

        try {
          const groupsObj = await sock.groupFetchAllParticipating();
          connectionState.groupsCache = Object.values(groupsObj || {}).map((g) => ({
            jid: g.id,
            name: g.subject || g.id,
            participantsCount: Array.isArray(g.participants) ? g.participants.length : 0
          }));
        } catch {
          // Ignorar si tarda en sincronizar grupos
        }

        if (!settled) {
          settled = true;
          if (timeoutId) clearTimeout(timeoutId);
          resolve(sock);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const isRestartRequired =
          statusCode === DisconnectReason.restartRequired || statusCode === 515;

        activeSocket = null;
        connectionState.qrDataUrl = null;
        connectionState.qrRaw = null;

        if (isLoggedOut) {
          connectionState.status = 'DISCONNECTED';
          connectionState.connectedUser = null;
          connectionState.lastError = 'Sesión cerrada o expirada. Haz clic en Generar QR para vincular de nuevo.';
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch {
            // Ignorar
          }
          if (!settled) {
            settled = true;
            if (timeoutId) clearTimeout(timeoutId);
            reject(new Error(connectionState.lastError));
          }
          return;
        }

        // Tras escanear el QR, WhatsApp envía código 515 (restartRequired) para reconectar ya autenticado
        if (isRestartRequired || statusCode !== DisconnectReason.loggedOut) {
          connectionState.status = isRestartRequired ? 'PAIRING' : 'CONNECTING';
          connectionState.lastError = isRestartRequired
            ? 'Completando vinculación tras escaneo de QR...'
            : `Reconectando a WhatsApp (código ${statusCode || 'red'})...`;

          setTimeout(() => {
            startBaileysSession({ waitForOpenMs: 0, onQr })
              .then((newSock) => {
                if (!settled) {
                  settled = true;
                  if (timeoutId) clearTimeout(timeoutId);
                  resolve(newSock);
                }
              })
              .catch(() => {});
          }, isRestartRequired ? 800 : 2500);
        }
      }
    });
  });

  if (waitForOpenMs > 0) {
    return openPromise;
  }

  openPromise.catch(() => {});
  return sock;
}

/**
 * Cierra la sesión actual de WhatsApp y elimina las credenciales locales si logout=true.
 */
export async function disconnectWhatsApp(logout = false) {
  if (activeSocket) {
    try {
      if (logout) {
        await activeSocket.logout();
      } else {
        activeSocket.end(undefined);
      }
    } catch {
      // Ignorar errores al cerrar
    }
    activeSocket = null;
  }
  isStartingSession = false;
  if (logout && fs.existsSync(AUTH_DIR)) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch {
      // Ignorar
    }
  }
  connectionState = {
    status: 'DISCONNECTED',
    qrDataUrl: null,
    qrRaw: null,
    connectedUser: null,
    lastError: null,
    groupsCache: []
  };
}

/**
 * Obtiene la lista de grupos de WhatsApp donde participa el número logueado.
 */
export async function listWhatsAppGroups() {
  if (activeSocket && connectionState.status === 'CONNECTED') {
    try {
      const groupsObj = await activeSocket.groupFetchAllParticipating();
      connectionState.groupsCache = Object.values(groupsObj || {}).map((g) => ({
        jid: g.id,
        name: g.subject || g.id,
        participantsCount: Array.isArray(g.participants) ? g.participants.length : 0
      }));
    } catch {
      // Retornar caché si hay error temporal
    }
  }
  return connectionState.groupsCache;
}

/**
 * Envía un mensaje por Green-API (Plan Developer Gratuito, soporta grupos @g.us y números @c.us).
 */
async function sendViaGreenApi(targetJid, messageText, greenConfig = {}) {
  const apiUrl = process.env.GREEN_API_URL || greenConfig.apiUrl || 'https://api.green-api.com';
  const idInstance = process.env.GREEN_API_ID_INSTANCE || greenConfig.idInstance;
  const apiTokenInstance = process.env.GREEN_API_TOKEN || greenConfig.apiTokenInstance;

  if (!idInstance || !apiTokenInstance) {
    throw new Error('Faltan credenciales de Green-API (idInstance y apiTokenInstance).');
  }

  const chatId = targetJid.endsWith('@s.whatsapp.net')
    ? targetJid.replace('@s.whatsapp.net', '@c.us')
    : targetJid;

  const url = `${apiUrl.replace(/\/$/, '')}/waInstance${idInstance}/sendMessage/${apiTokenInstance}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatId,
      message: messageText
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Green-API respondió HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return {
    provider: 'green-api',
    chatId,
    messageId: data.idMessage || 'ok'
  };
}

/**
 * Envía un mensaje por CallMeBot (API Gratuita).
 */
async function sendViaCallMeBot(messageText, callmebotConfig = {}) {
  const phone = (process.env.CALLMEBOT_PHONE || callmebotConfig.phone || '').replace(/\D/g, '');
  const apiKey = (process.env.CALLMEBOT_APIKEY || callmebotConfig.apiKey || '').trim();

  if (!phone || !apiKey) {
    throw new Error('Faltan credenciales de CallMeBot (phone y apiKey).');
  }

  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(messageText)}&apikey=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CallMeBot respondió HTTP ${response.status}`);
  }

  return {
    provider: 'callmebot',
    chatId: phone,
    messageId: `cmb-${Date.now()}`
  };
}

/**
 * Envía un mensaje de WhatsApp usando el motor configurado (Baileys QR, Green-API, CallMeBot o Webhook)
 * con soporte para modo simulación (dryRun).
 */
export async function sendWhatsAppMessage({
  targetJid,
  messageText,
  whatsappConfig = {},
  dryRun = false
}) {
  const normalizedJid = normalizeWhatsAppJid(targetJid || whatsappConfig.defaultGroupJid);

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      provider: 'dry-run-simulator',
      targetJid: normalizedJid || 'grupo-simulado@g.us',
      timestamp: new Date().toISOString()
    };
  }

  const preferredProvider =
    process.env.WHATSAPP_PROVIDER || whatsappConfig.activeProvider || 'baileys';

  // 1. Motor Green-API si fue seleccionado o tiene credenciales en entorno
  if (
    preferredProvider === 'green-api' ||
    (process.env.GREEN_API_ID_INSTANCE && process.env.GREEN_API_TOKEN && preferredProvider !== 'baileys')
  ) {
    const res = await sendViaGreenApi(normalizedJid, messageText, whatsappConfig.greenApi);
    return { success: true, ...res, timestamp: new Date().toISOString() };
  }

  // 2. Motor CallMeBot si fue seleccionado
  if (preferredProvider === 'callmebot') {
    const res = await sendViaCallMeBot(messageText, whatsappConfig.callmebot);
    return { success: true, ...res, timestamp: new Date().toISOString() };
  }

  // 3. Motor Webhook Personalizado
  if (preferredProvider === 'webhook') {
    const webhookUrl = process.env.WHATSAPP_WEBHOOK_URL || whatsappConfig.webhook?.url;
    if (!webhookUrl) {
      throw new Error('No se ha configurado la URL del Webhook de WhatsApp.');
    }
    const headers = { 'Content-Type': 'application/json' };
    if (whatsappConfig.webhook?.secretHeader) {
      headers['X-Webhook-Secret'] = whatsappConfig.webhook.secretHeader;
    }
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ targetJid: normalizedJid, message: messageText })
    });
    if (!resp.ok) {
      throw new Error(`Webhook respondió HTTP ${resp.status}`);
    }
    return {
      success: true,
      provider: 'webhook',
      targetJid: normalizedJid,
      timestamp: new Date().toISOString()
    };
  }

  // 4. Motor Principal: Baileys (Número propio logueado por QR)
  if (!normalizedJid) {
    throw new Error('No se especificó el JID del grupo o número de WhatsApp destino.');
  }

  const sock = await startBaileysSession({ waitForOpenMs: 25000 });
  const sent = await sock.sendMessage(normalizedJid, { text: messageText });

  return {
    success: true,
    provider: 'baileys',
    targetJid: normalizedJid,
    messageId: sent?.key?.id || `wa-${Date.now()}`,
    timestamp: new Date().toISOString()
  };
}
