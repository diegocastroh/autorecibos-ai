/**
 * Lector Automático de Correos IMAP (Gmail / Outlook / Corporativo)
 * Extrae el cuerpo del correo y los archivos PDF o imágenes adjuntas de los recibos.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

function stripHtmlTags(html = '') {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Conecta por IMAP y descarga correos recientes que coincidan con palabras clave de servicios.
 */
export async function fetchRecentBillEmails(emailConfig = {}) {
  const host = process.env.EMAIL_HOST || emailConfig.host || 'imap.gmail.com';
  const port = Number(process.env.EMAIL_PORT || emailConfig.port || 993);
  const user = (process.env.EMAIL_USER || emailConfig.user || '').trim();
  const pass = (process.env.EMAIL_PASS || emailConfig.pass || '').replace(/\s+/g, '').trim();

  if (!user || !pass) {
    throw new Error(
      'Faltan credenciales IMAP (EMAIL_USER y EMAIL_PASS). Configura tu correo y Contraseña de Aplicación de 16 caracteres.'
    );
  }

  const lookbackDays = Number(emailConfig.lookbackDays || 15);
  const sinceDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const keywords =
    Array.isArray(emailConfig.searchKeywords) && emailConfig.searchKeywords.length > 0
      ? emailConfig.searchKeywords.map((k) => k.toLowerCase())
      : ['sedapal', 'pluz', 'enel', 'luz del sur', 'calidda', 'cálidda', 'win', 'claro', 'movistar', 'recibo'];

  const client = new ImapFlow({
    host,
    port,
    secure: emailConfig.secure !== false,
    auth: { user, pass },
    logger: false
  });

  const matchedEmails = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ since: sinceDate }, { uid: true });
      const recentUids = uids.slice(-40); // Revisar hasta los 40 correos más recientes del periodo

      for (const uid of recentUids) {
        const msg = await client.fetchOne(
          uid,
          { uid: true, envelope: true, source: true },
          { uid: true }
        );
        if (!msg || !msg.source) continue;

        const parsed = await simpleParser(msg.source);
        const subject = parsed.subject || 'Sin asunto';
        const fromText = parsed.from?.text || '';
        const plainText = parsed.text || stripHtmlTags(parsed.html || '');
        const combinedSearch = `${subject} ${fromText} ${plainText.slice(0, 600)}`.toLowerCase();

        const isRelevant = keywords.some((kw) => combinedSearch.includes(kw));
        if (!isRelevant) continue;

        // Buscar adjunto PDF o imagen del recibo si existe
        let attachmentBuffer = null;
        let attachmentMimeType = '';
        let attachmentFilename = '';

        if (Array.isArray(parsed.attachments)) {
          const validAtt = parsed.attachments.find(
            (att) =>
              att.contentType === 'application/pdf' ||
              att.filename?.toLowerCase().endsWith('.pdf') ||
              att.contentType?.startsWith('image/')
          );
          if (validAtt && validAtt.content) {
            attachmentBuffer = validAtt.content;
            attachmentMimeType = validAtt.contentType || 'application/pdf';
            attachmentFilename = validAtt.filename || 'recibo.pdf';
          }
        }

        matchedEmails.push({
          id: `imap-${uid}`,
          subject,
          from: fromText,
          date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
          text: `Asunto: ${subject}\nRemitente: ${fromText}\nContenido:\n${plainText}`,
          fileBuffer: attachmentBuffer,
          mimeType: attachmentMimeType,
          filename: attachmentFilename
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return matchedEmails;
}

/**
 * Genera recibos de demostración realistas (Sedapal, Pluz, Cálidda, Internet Fibra)
 * para pruebas inmediatas en el Panel Web o ejecución demo (--demo).
 */
export function getDemoBillsEmailPayloads() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');

  return [
    {
      id: 'demo-sedapal-1',
      subject: 'Recibo Digital SEDAPAL - Servicio de Agua Potable y Alcantarillado',
      from: 'recibodigital@sedapal.com.pe',
      date: now.toISOString(),
      text: `SEDAPAL - Servicio de Agua Potable y Alcantarillado.
Suministro N° 5028332-4
Recibo Electrónico N° S001-08492015
Periodo de Facturación: Octubre ${year}
Consumo registrado: 24 m3
Total a Pagar: S/ 148.60
Fecha de Vencimiento: 28/${month}/${year}`
    },
    {
      id: 'demo-pluz-1',
      subject: 'Tu recibo digital Pluz Energía Perú está disponible',
      from: 'notificaciones@pluz.pe',
      date: now.toISOString(),
      text: `Pluz Energía Perú S.A.A.
Recibo Digital N° S870-0006250622
Cliente / Suministro N°: 1194649
Periodo: Octubre ${year}
Consumo de energía: 215 kWh
TOTAL Mes Actual: S/ 324.80
Fecha de Vencimiento: 25/${month}/${year}`
    },
    {
      id: 'demo-calidda-1',
      subject: 'Recibo de Gas Natural Cálidda - Facturación Mensual',
      from: 'recibos@calidda.com.pe',
      date: now.toISOString(),
      text: `Cálidda - Gas Natural de Lima y Callao
Suministro N°: 8841209
Recibo N°: B004-04918231
Periodo de Facturación: Octubre ${year}
Consumo: 18 m3
Monto Total a Pagar: S/ 67.50
Fecha de Vencimiento: 29/${month}/${year}`
    },
    {
      id: 'demo-internet-1',
      subject: 'Comprobante Electrónico WIN Internet Fibra Óptica',
      from: 'facturacion@win.pe',
      date: now.toISOString(),
      text: `WIN Internet 100% Fibra Óptica
Código de Cliente: WIN-904512
Factura Electrónica N°: F002-01928374
Periodo: Octubre ${year}
Plan contratado: 600 Mbps Simétrico
Importe Total a Pagar: S/ 119.00
Fecha de Vencimiento: 30/${month}/${year}`
    }
  ];
}
