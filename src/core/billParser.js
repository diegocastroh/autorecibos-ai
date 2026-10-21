/**
 * Motor Inteligente Híbrido de Lectura de Recibos (IA Multimodal Gemini 3.8 Flash + Parser Determinista Peruano).
 * Soporta textos de correos (IMAP), archivos PDF adjuntos e imágenes de recibos de:
 * - Sedapal (Agua)
 * - Pluz Energía / Enel / Luz del Sur (Electricidad)
 * - Cálidda (Gas Natural)
 * - Internet (Win, Claro, Movistar, Wow, Entel)
 */

import { GoogleGenAI } from '@google/genai';

const BILL_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    isBill: {
      type: 'boolean',
      description: 'true si el documento o correo corresponde a un recibo o aviso de facturación de servicio.'
    },
    serviceCode: {
      type: 'string',
      enum: ['SEDAPAL', 'PLUZ', 'CALIDDA', 'INTERNET', 'OTRO'],
      description: 'Código estandarizado del servicio detectado.'
    },
    providerName: {
      type: 'string',
      description: 'Nombre comercial del proveedor (ej. Sedapal, Pluz Energía Perú, Cálidda, Win Internet, Claro).'
    },
    supplyNumber: {
      type: 'string',
      description: 'Número de suministro, código de cliente o contrato.'
    },
    invoiceNumber: {
      type: 'string',
      description: 'Número de recibo o comprobante electrónico (ej. S870-00062506, F001-99812).'
    },
    billingPeriod: {
      type: 'string',
      description: 'Periodo facturado (ej. Octubre 2026, 2026-10).'
    },
    issueDate: {
      type: 'string',
      description: 'Fecha de emisión en formato DD/MM/YYYY o YYYY-MM-DD.'
    },
    dueDate: {
      type: 'string',
      description: 'Fecha de vencimiento del recibo en formato DD/MM/YYYY o YYYY-MM-DD.'
    },
    totalAmount: {
      type: 'number',
      description: 'Monto total a pagar en Soles (PEN), como número decimal (ej. 147.40).'
    },
    consumptionSummary: {
      type: 'string',
      description: 'Resumen corto del consumo físico si figura (ej. 22 m3, 195 kWh, Plan 600 Mbps).'
    }
  },
  required: ['isBill', 'serviceCode', 'providerName', 'totalAmount']
};

const MONTHS_MAP = {
  ene: '01', enero: '01',
  feb: '02', febrero: '02',
  mar: '03', marzo: '03',
  abr: '04', abril: '04',
  may: '05', mayo: '05',
  jun: '06', junio: '06',
  jul: '07', julio: '07',
  ago: '08', agosto: '08',
  set: '09', sep: '09', septiembre: '09', setiembre: '09',
  oct: '10', octubre: '10',
  nov: '11', noviembre: '11',
  dic: '12', diciembre: '12'
};

const MONTH_NAMES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

/**
 * Normaliza fechas peruanas ("07/JUL/2026", "30-10-2026", "2026-10-28") a "DD/MM/YYYY"
 * y devuelve también el ISO "YYYY-MM-DD" para cálculos de vencimiento.
 */
export function normalizeDateString(rawDate) {
  if (!rawDate || typeof rawDate !== 'string') return { display: 'Por confirmar', iso: null };
  const clean = rawDate.trim();

  // Formato YYYY-MM-DD
  const isoMatch = clean.match(/\b(20\d{2})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    const [, yyyy, mm, dd] = isoMatch;
    return { display: `${dd}/${mm}/${yyyy}`, iso: `${yyyy}-${mm}-${dd}` };
  }

  // Formato DD/MM/YYYY o DD-MM-YYYY
  const dmyMatch = clean.match(/\b(0?[1-9]|[12]\d|3[01])[/-](0?[1-9]|1[0-2])[/-](20\d{2})\b/);
  if (dmyMatch) {
    const dd = dmyMatch[1].padStart(2, '0');
    const mm = dmyMatch[2].padStart(2, '0');
    const yyyy = dmyMatch[3];
    return { display: `${dd}/${mm}/${yyyy}`, iso: `${yyyy}-${mm}-${dd}` };
  }

  // Formato DD/MES/YYYY o "15 de Octubre de 2026"
  const textMonthMatch = clean.match(
    /\b(0?[1-9]|[12]\d|3[01])(?:\s*de\s*|[/-]|\s+)([a-záéíóú]{3,10})(?:\s*de\s*|[/-]|\s+)(20\d{2})\b/i
  );
  if (textMonthMatch) {
    const dd = textMonthMatch[1].padStart(2, '0');
    const rawM = textMonthMatch[2].toLowerCase();
    const mm = MONTHS_MAP[rawM] || MONTHS_MAP[rawM.slice(0, 3)];
    const yyyy = textMonthMatch[3];
    if (mm) {
      return { display: `${dd}/${mm}/${yyyy}`, iso: `${yyyy}-${mm}-${dd}` };
    }
  }

  return { display: clean, iso: null };
}

/**
 * Extrae texto legible de un buffer PDF simple si contiene cadenas de texto o streams sin comprimir.
 */
export function extractTextFromPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return '';
  const raw = buffer.toString('latin1');
  const textSegments = [];

  // Extraer bloques entre paréntesis de operadores TJ / Tj de PDF
  const literalMatches = raw.matchAll(/\(([^()\\]{2,200})\)/g);
  for (const m of literalMatches) {
    const piece = m[1].replace(/[^\x20-\x7EÁÉÍÓÚáéíóúÑñ]/g, ' ').trim();
    if (piece.length >= 2) textSegments.push(piece);
  }

  if (textSegments.length > 0) {
    return textSegments.join(' ');
  }

  return raw.replace(/[^\x20-\x7EÁÉÍÓÚáéíóúÑñ\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parser determinista especializado en recibos peruanos (Sedapal, Pluz, Luz del Sur, Cálidda, Internet).
 * Actúa como motor rápido local y fallback infalible cuando no hay API Key de Gemini.
 */
export function parseBillDeterministic(textInput = '', configuredServices = []) {
  const text = String(textInput || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();

  // 1. Identificar el tipo de servicio y proveedor
  let serviceCode = 'OTRO';
  let providerName = 'Servicio General';

  if (lower.includes('sedapal') || lower.includes('agua potable') || lower.includes('alcantarillado')) {
    serviceCode = 'SEDAPAL';
    providerName = 'Sedapal';
  } else if (
    lower.includes('pluz') ||
    lower.includes('enel') ||
    lower.includes('luz del sur') ||
    lower.includes('hidrandina') ||
    lower.includes('kwh') ||
    lower.includes('energía eléctrica')
  ) {
    serviceCode = 'PLUZ';
    providerName = lower.includes('luz del sur') ? 'Luz del Sur' : 'Pluz Energía Perú';
  } else if (
    lower.includes('calidda') ||
    lower.includes('cálidda') ||
    lower.includes('gas natural')
  ) {
    serviceCode = 'CALIDDA';
    providerName = 'Cálidda Gas Natural';
  } else if (
    lower.includes('win') ||
    lower.includes('claro') ||
    lower.includes('movistar') ||
    lower.includes('internet') ||
    lower.includes('fibra') ||
    lower.includes('wow') ||
    lower.includes('entel')
  ) {
    serviceCode = 'INTERNET';
    if (lower.includes('win')) providerName = 'Win Internet Fibra';
    else if (lower.includes('claro')) providerName = 'Claro Perú Internet';
    else if (lower.includes('movistar')) providerName = 'Movistar Internet';
    else if (lower.includes('wow')) providerName = 'Wow Internet';
    else providerName = 'Internet Fibra';
  } else if (Array.isArray(configuredServices)) {
    for (const svc of configuredServices) {
      const kws = svc.senderKeywords || [];
      if (kws.some((kw) => lower.includes(String(kw).toLowerCase()))) {
        serviceCode = svc.code || svc.id?.toUpperCase() || 'OTRO';
        providerName = svc.name || providerName;
        break;
      }
    }
  }

  // 2. Extraer el monto total en Soles (S/ o S/. o PEN)
  let totalAmount = 0;
  const priorityPatterns = [
    /(?:total\s+a\s+pagar|monto\s+total(?:\s+a\s+pagar)?|importe\s+total|total\s+mes\s+actual|total\s+del\s+recibo|consumo\s+del\s+mes|total\s+recibo|pagar\s+hasta)[^0-9]{0,25}(?:s\/\.?|pen)?\s*([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}|[0-9]+\.[0-9]{2})/i,
    /(?:s\/\.?|pen)\s*([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}|[0-9]+\.[0-9]{2})/gi
  ];

  const firstMatch = text.match(priorityPatterns[0]);
  if (firstMatch && firstMatch[1]) {
    totalAmount = Number(firstMatch[1].replace(/,/g, ''));
  } else {
    const allAmounts = [...text.matchAll(priorityPatterns[1])].map((m) =>
      Number(m[1].replace(/,/g, ''))
    );
    if (allAmounts.length > 0) {
      totalAmount = Math.max(...allAmounts);
    }
  }

  // 3. Extraer número de suministro / cliente / contrato
  let supplyNumber = '';
  const supplyMatch = text.match(
    /(?:suministro|c[óo]digo\s+de\s+cliente|n[°º]\s*suministro|cliente\s+n[°º]?|contrato|nis)\s*(?:n[°º]?)?\s*[:#-]?\s*([A-Z0-9-]{5,18})/i
  );
  if (supplyMatch) {
    supplyNumber = supplyMatch[1].trim();
  }

  // 4. Extraer número de recibo / comprobante electrónico
  let invoiceNumber = '';
  const invoiceMatch = text.match(
    /(?:recibo(?:\s+digital|\s+electr[óo]nico)?|factura(?:\s+electr[óo]nica)?|comprobante|boleta)\s*(?:n[°º]?)?\s*[:#-]?\s*([A-Z0-9]{2,5}-[0-9]{5,12}|[0-9]{6,14})/i
  );
  if (invoiceMatch) {
    invoiceNumber = invoiceMatch[1].trim();
  }

  // 5. Extraer fecha de vencimiento
  let dueDate = 'Por confirmar';
  let dueDateIso = null;
  const dueMatch = text.match(
    /(?:vencimiento|fecha\s+de\s+vencimiento|vence(?:\s+el)?|pague\s+antes\s+del|último\s+día\s+de\s+pago)\s*[:#-]?\s*([0-9]{1,2}[/-][0-9A-Za-z]{2,10}[/-]20[0-9]{2}|20[0-9]{2}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\s+de\s+[a-záéíóú]+\s+de\s+20[0-9]{2})/i
  );
  if (dueMatch) {
    const norm = normalizeDateString(dueMatch[1]);
    dueDate = norm.display;
    dueDateIso = norm.iso;
  }

  // 6. Extraer periodo de facturación
  let billingPeriod = '';
  const periodMatch = text.match(
    /(?:periodo(?:\s+de\s+facturaci[óo]n)?|mes\s+facturado|facturaci[óo]n)\s*[:#-]?\s*([A-Za-záéíóú]{3,12}\s*20[0-9]{2}|20[0-9]{2}-[0-9]{2})/i
  );
  if (periodMatch) {
    billingPeriod = periodMatch[1].trim();
  } else if (dueDateIso) {
    const [y, m] = dueDateIso.split('-');
    const monthName = MONTH_NAMES_ES[Number(m) - 1] || m;
    billingPeriod = `${monthName} ${y}`;
  } else {
    const now = new Date();
    billingPeriod = `${MONTH_NAMES_ES[now.getMonth()]} ${now.getFullYear()}`;
  }

  // 7. Extraer consumo físico si aparece (m3, kWh, Mbps)
  let consumptionSummary = null;
  const consumptionMatch = text.match(
    /(\d+(?:\.\d+)?\s*(?:m3|m³|kwh|mbps|gbps))/i
  );
  if (consumptionMatch) {
    consumptionSummary = consumptionMatch[1];
  }

  const isBill =
    totalAmount > 0 &&
    (serviceCode !== 'OTRO' ||
      lower.includes('recibo') ||
      lower.includes('factura') ||
      lower.includes('vencimiento') ||
      lower.includes('total'));

  return {
    isBill,
    serviceCode,
    providerName,
    supplyNumber: supplyNumber || 'No especificado',
    invoiceNumber: invoiceNumber || 'S/N',
    billingPeriod,
    issueDate: null,
    dueDate,
    dueDateIso,
    totalAmount,
    consumptionSummary,
    extractionEngine: 'deterministic-peru-parser'
  };
}

/**
 * Analiza un recibo utilizando Gemini 3.8 Flash (`@google/genai`) con salida estructurada JSON
 * y combina el resultado con el parser determinista para máxima precisión.
 *
 * @param {Object} inputPayload
 * @param {string} [inputPayload.text] - Texto del correo o recibo
 * @param {Buffer} [inputPayload.fileBuffer] - Buffer de PDF o imagen adjunta
 * @param {string} [inputPayload.mimeType] - MIME type ('application/pdf', 'image/png', 'image/jpeg')
 * @param {Array} [configuredServices] - Lista de servicios configurados
 */
export async function parseBillIntelligent(inputPayload = {}, configuredServices = []) {
  const { text = '', fileBuffer = null, mimeType = '' } = inputPayload;

  // Extraer texto base si hay un PDF adjunto para alimentar también el fallback determinista
  let combinedText = text || '';
  if (fileBuffer && mimeType === 'application/pdf') {
    const pdfText = extractTextFromPdfBuffer(fileBuffer);
    if (pdfText) {
      combinedText = `${combinedText}\n${pdfText}`.trim();
    }
  }

  const deterministicResult = parseBillDeterministic(combinedText, configuredServices);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return deterministicResult;
  }

  try {
    const client = new GoogleGenAI({ apiKey });

    const promptText = `Eres un experto contable en servicios públicos de Perú (Sedapal, Pluz Energía, Luz del Sur, Cálidda Gas Natural, Win/Claro/Movistar Internet).
Analiza el siguiente recibo o correo de facturación y extrae los datos exactos en JSON.
Si hay varios montos, extrae el TOTAL A PAGAR del mes actual en Soles (PEN).
Texto adicional del correo/documento:
${combinedText.slice(0, 12000)}`;

    const inputParts = [{ type: 'text', text: promptText }];

    if (fileBuffer && mimeType) {
      const base64Data = fileBuffer.toString('base64');
      if (mimeType === 'application/pdf') {
        inputParts.push({
          type: 'document',
          data: base64Data,
          mime_type: 'application/pdf'
        });
      } else if (mimeType.startsWith('image/')) {
        inputParts.push({
          type: 'image',
          data: base64Data,
          mime_type: mimeType
        });
      }
    }

    const interaction = await client.interactions.create({
      model: 'gemini-3.8-flash',
      input: inputParts,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: BILL_EXTRACTION_SCHEMA
      }
    });

    const parsedAi = JSON.parse(interaction.output_text || '{}');
    const normDue = normalizeDateString(parsedAi.dueDate || deterministicResult.dueDate);

    return {
      isBill: parsedAi.isBill ?? deterministicResult.isBill,
      serviceCode:
        parsedAi.serviceCode && parsedAi.serviceCode !== 'OTRO'
          ? parsedAi.serviceCode
          : deterministicResult.serviceCode,
      providerName: parsedAi.providerName || deterministicResult.providerName,
      supplyNumber: parsedAi.supplyNumber || deterministicResult.supplyNumber,
      invoiceNumber: parsedAi.invoiceNumber || deterministicResult.invoiceNumber,
      billingPeriod: parsedAi.billingPeriod || deterministicResult.billingPeriod,
      issueDate: parsedAi.issueDate || deterministicResult.issueDate,
      dueDate: normDue.display,
      dueDateIso: normDue.iso || deterministicResult.dueDateIso,
      totalAmount:
        Number(parsedAi.totalAmount) > 0
          ? Number(parsedAi.totalAmount)
          : deterministicResult.totalAmount,
      consumptionSummary:
        parsedAi.consumptionSummary || deterministicResult.consumptionSummary,
      extractionEngine: 'gemini-3.8-flash'
    };
  } catch (err) {
    console.warn(`[AutoRecibos AI] Fallback determinista activado (${err.message})`);
    return deterministicResult;
  }
}

/**
 * Genera una huella única (fingerprint) para evitar enviar el mismo recibo dos veces.
 */
export function buildBillFingerprint(bill) {
  const code = String(bill.serviceCode || 'OTRO').toUpperCase();
  const inv = String(bill.invoiceNumber || '').trim().toUpperCase();
  const period = String(bill.billingPeriod || '').trim().toUpperCase();
  const amount = Number(bill.totalAmount || 0).toFixed(2);

  if (inv && inv !== 'S/N') {
    return `${code}::${inv}::${amount}`;
  }
  return `${code}::${period}::${amount}`;
}
