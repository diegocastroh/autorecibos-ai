/**
 * Motor matemático de distribución porcentual exacta al céntimo (Método Hamilton / Largest Remainder)
 * y generador de mensajes para grupos de WhatsApp.
 */

/**
 * Calcula la distribución exacta en céntimos para que la suma de las cuotas
 * de todos los miembros sea 100% idéntica al total del recibo (sin pérdida ni exceso de S/ 0.01).
 *
 * @param {Object} bill - Datos extraídos del recibo
 * @param {Object} serviceConfig - Configuración del servicio y miembros con porcentajes
 * @returns {Object} Resultado detallado de la distribución
 */
export function calculateDistribution(bill, serviceConfig) {
  const rawTotal = Number(bill?.totalAmount ?? 0);
  if (!Number.isFinite(rawTotal) || rawTotal <= 0) {
    throw new Error(`Monto total inválido para distribución: ${bill?.totalAmount}`);
  }

  const members = Array.isArray(serviceConfig?.members)
    ? serviceConfig.members.filter((m) => Number(m.percentage) > 0)
    : [];

  if (members.length === 0) {
    throw new Error(`El servicio "${serviceConfig?.name || bill?.serviceCode}" no tiene miembros activos con porcentaje > 0.`);
  }

  const fixedFeePerMember = Math.max(0, Number(serviceConfig?.fixedFee ?? 0));
  const totalFixedCents = Math.round(fixedFeePerMember * 100) * members.length;
  const totalBillCents = Math.round(rawTotal * 100);
  const distributableCents = Math.max(0, totalBillCents - totalFixedCents);

  const rawPercentageSum = members.reduce((acc, m) => acc + Number(m.percentage || 0), 0);
  const isExact100 = Math.abs(rawPercentageSum - 100) < 0.01;

  // Cálculo con método del Mayor Resto (Hamilton) en céntimos enteros
  const quotaItems = members.map((member, index) => {
    const rawPct = Number(member.percentage || 0);
    const normalizedPct = rawPercentageSum > 0 ? (rawPct / rawPercentageSum) * 100 : 0;
    const exactVarCents = (distributableCents * normalizedPct) / 100;
    const floorVarCents = Math.floor(exactVarCents);
    const remainder = exactVarCents - floorVarCents;

    return {
      index,
      id: member.id || `m_${index + 1}`,
      name: member.name,
      phone: member.phone || '',
      configuredPercentage: Number(rawPct.toFixed(2)),
      effectivePercentage: Number(normalizedPct.toFixed(2)),
      floorCents: floorVarCents + Math.round(fixedFeePerMember * 100),
      remainder
    };
  });

  const currentSumCents = quotaItems.reduce((acc, item) => acc + item.floorCents, 0);
  let remainingCents = totalBillCents - currentSumCents;

  // Ordenar por mayor residuo decimal (y en empate, por mayor porcentaje o índice original)
  const sortedByRemainder = [...quotaItems].sort((a, b) => {
    if (Math.abs(b.remainder - a.remainder) > 1e-9) {
      return b.remainder - a.remainder;
    }
    if (b.effectivePercentage !== a.effectivePercentage) {
      return b.effectivePercentage - a.effectivePercentage;
    }
    return a.index - b.index;
  });

  let i = 0;
  while (remainingCents > 0 && sortedByRemainder.length > 0) {
    sortedByRemainder[i % sortedByRemainder.length].floorCents += 1;
    remainingCents -= 1;
    i += 1;
  }

  const shares = quotaItems.map((item) => {
    const amount = Number((item.floorCents / 100).toFixed(2));
    return {
      id: item.id,
      name: item.name,
      phone: item.phone,
      percentage: item.configuredPercentage,
      effectivePercentage: item.effectivePercentage,
      amountCents: item.floorCents,
      amount,
      formattedAmount: `S/ ${amount.toFixed(2)}`
    };
  });

  const sumDistributed = Number((shares.reduce((acc, s) => acc + s.amountCents, 0) / 100).toFixed(2));

  return {
    serviceId: serviceConfig.id || bill.serviceCode?.toLowerCase() || 'servicio',
    serviceCode: serviceConfig.code || bill.serviceCode || 'OTRO',
    serviceName: serviceConfig.name || bill.providerName || 'Servicio',
    serviceIcon: serviceConfig.icon || '📄',
    providerName: bill.providerName || serviceConfig.name || 'Proveedor',
    supplyNumber: bill.supplyNumber || serviceConfig.supplyNumber || 'No especificado',
    invoiceNumber: bill.invoiceNumber || 'S/N',
    billingPeriod: bill.billingPeriod || 'Mes Actual',
    issueDate: bill.issueDate || null,
    dueDate: bill.dueDate || 'Por confirmar',
    consumptionSummary: bill.consumptionSummary || null,
    totalAmount: Number((totalBillCents / 100).toFixed(2)),
    formattedTotal: `S/ ${(totalBillCents / 100).toFixed(2)}`,
    sumDistributed,
    percentageWarning: !isExact100
      ? `Los porcentajes configurados suman ${rawPercentageSum.toFixed(2)}% (fueron normalizados al 100%).`
      : null,
    whatsappGroup: serviceConfig.whatsappGroup || {
      name: 'Grupo Principal',
      jid: ''
    },
    shares
  };
}

/**
 * Genera el mensaje enriquecido para enviar al grupo de WhatsApp correspondiente.
 *
 * @param {Object} distribution - Resultado de calculateDistribution()
 * @param {Object} paymentInfo - Datos de pago (Yape, Plin, Banco, Titular)
 * @param {Object} [options] - Opciones adicionales ({ mode: 'NEW_BILL' | 'REMINDER', daysUntilDue })
 * @returns {string} Mensaje listo para WhatsApp
 */
export function formatWhatsAppMessage(distribution, paymentInfo = {}, options = {}) {
  const mode = options.mode || 'NEW_BILL';
  const daysUntilDue = options.daysUntilDue;

  const headerBadge =
    mode === 'REMINDER'
      ? `⏰ *RECORDATORIO DE VENCIMIENTO${typeof daysUntilDue === 'number' ? ` (${daysUntilDue === 0 ? 'VENCE HOY' : `FALTAN ${daysUntilDue} DÍA(S)`})` : ''}*`
      : `🧾 *NUEVO RECIBO DETECTADO - DISTRIBUCIÓN DE COSTOS*`;

  const lines = [
    headerBadge,
    `${distribution.serviceIcon} *${distribution.serviceName}*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `📌 *Suministro / Cliente:* ${distribution.supplyNumber}`,
    `🔢 *N° Recibo:* ${distribution.invoiceNumber}`,
    `🗓️ *Periodo:* ${distribution.billingPeriod}`
  ];

  if (distribution.consumptionSummary) {
    lines.push(`📊 *Consumo:* ${distribution.consumptionSummary}`);
  }

  lines.push(
    `⏳ *Fecha de Vencimiento:* *${distribution.dueDate}*`,
    `💰 *TOTAL DEL RECIBO:* *${distribution.formattedTotal}*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `📐 *DISTRIBUCIÓN POR PORCENTAJE (%):*`,
    ``
  );

  for (const share of distribution.shares) {
    lines.push(
      `🔸 *${share.name}* (${share.percentage}%): *${share.formattedAmount}*`
    );
  }

  if (distribution.percentageWarning) {
    lines.push(``, `ℹ️ _Nota: ${distribution.percentageWarning}_`);
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━━━`);

  if (paymentInfo && (paymentInfo.yapeNumber || paymentInfo.plinNumber || paymentInfo.bankAccount)) {
    lines.push(`🏦 *MEDIOS DE PAGO:*`);
    if (paymentInfo.collectorName) {
      lines.push(`👤 *Titular:* ${paymentInfo.collectorName}`);
    }
    if (paymentInfo.yapeNumber) {
      lines.push(`📱 *Yape:* ${paymentInfo.yapeNumber}`);
    }
    if (paymentInfo.plinNumber && paymentInfo.plinNumber !== paymentInfo.yapeNumber) {
      lines.push(`📲 *Plin:* ${paymentInfo.plinNumber}`);
    } else if (paymentInfo.plinNumber && paymentInfo.plinNumber === paymentInfo.yapeNumber) {
      lines.push(`📲 *Plin:* ${paymentInfo.plinNumber} (mismo número)`);
    }
    if (paymentInfo.bankAccount) {
      lines.push(`💳 *Cuenta:* ${paymentInfo.bankAccount}`);
    }
    if (paymentInfo.cci) {
      lines.push(`🏛️ *CCI:* ${paymentInfo.cci}`);
    }
    if (paymentInfo.footerNote) {
      lines.push(``, `💬 _${paymentInfo.footerNote}_`);
    }
  }

  lines.push(``, `🤖 _Generado automáticamente por AutoRecibos AI_`);

  return lines.join('\n');
}
