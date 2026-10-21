/**
 * ALTERNATIVA 100% EN GOOGLE CLOUD GRATUITO: GOOGLE APPS SCRIPT (Gmail + Google Sheets + WhatsApp)
 *
 * Instrucciones:
 * 1. Entra a https://script.google.com y crea un nuevo proyecto.
 * 2. Pega este código en Code.gs.
 * 3. En "Activadores" (icono de reloj a la izquierda), añade un activador diario (ej. 8:00 AM - 9:00 AM)
 *    para la función `ejecutarAutoRecibosDiario`.
 */

const CONFIG_SERVICIOS = {
  SEDAPAL: {
    nombre: '💧 Sedapal (Agua y Alcantarillado)',
    grupoChatId: '120363000000000001@g.us',
    miembros: [
      { nombre: 'Piso 1 (Familia Principal)', porcentaje: 45 },
      { nombre: 'Piso 2 (Departamento A)', porcentaje: 30 },
      { nombre: 'Piso 3 (Departamento B)', porcentaje: 25 }
    ]
  },
  PLUZ: {
    nombre: '⚡ Pluz Energía / Luz',
    grupoChatId: '120363000000000001@g.us',
    miembros: [
      { nombre: 'Piso 1 (Familia Principal)', porcentaje: 40 },
      { nombre: 'Piso 2 (Departamento A)', porcentaje: 35 },
      { nombre: 'Piso 3 (Departamento B)', porcentaje: 25 }
    ]
  },
  CALIDDA: {
    nombre: '🔥 Cálidda (Gas Natural)',
    grupoChatId: '120363000000000002@g.us',
    miembros: [
      { nombre: 'Piso 1 (Cocina + Terma)', porcentaje: 50 },
      { nombre: 'Piso 2 (Cocina + Terma)', porcentaje: 30 },
      { nombre: 'Piso 3 (Cocina)', porcentaje: 20 }
    ]
  },
  INTERNET: {
    nombre: '🌐 Internet Fibra (Win / Claro / Movistar)',
    grupoChatId: '120363000000000003@g.us',
    miembros: [
      { nombre: 'Diego (Piso 1)', porcentaje: 40 },
      { nombre: 'Carlos (Piso 2)', porcentaje: 30 },
      { nombre: 'Lucía (Piso 3)', porcentaje: 30 }
    ]
  }
};

const DATOS_PAGO = {
  titular: 'Diego (Administrador)',
  yape: '999-888-777',
  plin: '999-888-777',
  banco: 'BCP Soles: 191-00000000-0-00'
};

function ejecutarAutoRecibosDiario() {
  const query = 'newer_than:7d (sedapal OR pluz OR enel OR "luz del sur" OR calidda OR cálidda OR win OR claro OR movistar) (recibo OR factura OR comprobante)';
  const threads = GmailApp.search(query, 0, 20);
  const props = PropertiesService.getScriptProperties();

  threads.forEach((thread) => {
    const messages = thread.getMessages();
    const msg = messages[messages.length - 1];
    const msgId = msg.getId();

    if (props.getProperty('PROCESSED_' + msgId)) {
      return; // Ya fue enviado
    }

    const texto = msg.getSubject() + '\n' + msg.getPlainBody();
    const datos = extraerDatosRecibo(texto);
    if (!datos || datos.montoTotal <= 0) return;

    const servicio = CONFIG_SERVICIOS[datos.codigo];
    if (!servicio) return;

    const cuotas = calcularCuotasExactas(datos.montoTotal, servicio.miembros);
    const mensajeWA = construirMensajeWhatsApp(servicio.nombre, datos, cuotas);

    enviarWhatsAppGreenApi(servicio.grupoChatId, mensajeWA);
    props.setProperty('PROCESSED_' + msgId, new Date().toISOString());
  });
}

function extraerDatosRecibo(texto) {
  const lower = texto.toLowerCase();
  let codigo = null;
  if (lower.indexOf('sedapal') !== -1 || lower.indexOf('agua potable') !== -1) codigo = 'SEDAPAL';
  else if (lower.indexOf('pluz') !== -1 || lower.indexOf('enel') !== -1 || lower.indexOf('luz del sur') !== -1) codigo = 'PLUZ';
  else if (lower.indexOf('calidda') !== -1 || lower.indexOf('cálidda') !== -1 || lower.indexOf('gas natural') !== -1) codigo = 'CALIDDA';
  else if (lower.indexOf('win') !== -1 || lower.indexOf('claro') !== -1 || lower.indexOf('movistar') !== -1) codigo = 'INTERNET';

  if (!codigo) return null;

  const matchMonto = texto.match(/(?:total\s+a\s+pagar|importe\s+total|total\s+mes\s+actual|s\/\.?)\s*([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}|[0-9]+\.[0-9]{2})/i);
  const montoTotal = matchMonto ? parseFloat(matchMonto[1].replace(/,/g, '')) : 0;

  const matchVenc = texto.match(/(?:vencimiento|vence)\s*[:#-]?\s*([0-9]{1,2}[/-][0-9A-Za-z]{2,10}[/-]20[0-9]{2})/i);
  const vencimiento = matchVenc ? matchVenc[1] : 'Por confirmar';

  return { codigo, montoTotal, vencimiento };
}

function calcularCuotasExactas(montoTotal, miembros) {
  const totalCents = Math.round(montoTotal * 100);
  const items = miembros.map((m, i) => {
    const exact = (totalCents * m.porcentaje) / 100;
    const fl = Math.floor(exact);
    return { index: i, nombre: m.nombre, porcentaje: m.porcentaje, cents: fl, rem: exact - fl };
  });
  let diff = totalCents - items.reduce((a, b) => a + b.cents, 0);
  items.sort((a, b) => b.rem - a.rem);
  for (let i = 0; i < diff; i++) items[i % items.length].cents += 1;
  items.sort((a, b) => a.index - b.index);
  return items.map((x) => ({
    nombre: x.nombre,
    porcentaje: x.porcentaje,
    monto: (x.cents / 100).toFixed(2)
  }));
}

function construirMensajeWhatsApp(nombreServicio, datos, cuotas) {
  let msg = '🧾 *NUEVO RECIBO DETECTADO - DISTRIBUCIÓN DE COSTOS*\n';
  msg += '*' + nombreServicio + '*\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━━\n';
  msg += '⏳ *Vencimiento:* *' + datos.vencimiento + '*\n';
  msg += '💰 *TOTAL DEL RECIBO:* *S/ ' + datos.montoTotal.toFixed(2) + '*\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━━\n';
  msg += '📐 *DISTRIBUCIÓN POR PORCENTAJE (%):*\n\n';
  cuotas.forEach((c) => {
    msg += '🔸 *' + c.nombre + '* (' + c.porcentaje + '%): *S/ ' + c.monto + '*\n';
  });
  msg += '━━━━━━━━━━━━━━━━━━━━━━\n';
  msg += '🏦 *Yape / Plin:* ' + DATOS_PAGO.yape + ' (' + DATOS_PAGO.titular + ')\n';
  msg += '💳 *Cuenta:* ' + DATOS_PAGO.banco;
  return msg;
}

function enviarWhatsAppGreenApi(chatId, mensaje) {
  const props = PropertiesService.getScriptProperties();
  const idInstance = props.getProperty('GREEN_API_ID_INSTANCE');
  const apiToken = props.getProperty('GREEN_API_TOKEN');
  if (!idInstance || !apiToken) {
    Logger.log('Simulación WhatsApp -> ' + chatId + ':\n' + mensaje);
    return;
  }
  const url = 'https://api.green-api.com/waInstance' + idInstance + '/sendMessage/' + apiToken;
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chatId: chatId, message: mensaje })
  });
}
