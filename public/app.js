let appConfig = null;
let cloudLedger = { lastRunAt: null, bills: [] };
let lastAnalyzedBill = null;
let waPollInterval = null;
let isCloudStaticMode = false;

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/diegocastroh/autorecibos-ai/main/data';
const GITHUB_ACTIONS_URL = 'https://github.com/diegocastroh/autorecibos-ai/actions';

const SAMPLE_TEXTS = {
  SEDAPAL: `SEDAPAL - Servicio de Agua Potable y Alcantarillado.
Suministro N° 5028332-4
Recibo Electrónico N° S001-08492015
Periodo de Facturación: Octubre 2026
Consumo registrado: 24 m3
Total a Pagar: S/ 148.60
Fecha de Vencimiento: 28/10/2026`,

  PLUZ: `Pluz Energía Perú S.A.A.
Recibo Digital N° S870-0006250622
Cliente / Suministro N°: 1194649
Periodo: Octubre 2026
Consumo de energía: 215 kWh
TOTAL Mes Actual: S/ 324.80
Fecha de Vencimiento: 25/10/2026`,

  CALIDDA: `Cálidda - Gas Natural de Lima y Callao
Suministro N°: 8841209
Recibo N°: B004-04918231
Periodo de Facturación: Octubre 2026
Consumo: 18 m3
Monto Total a Pagar: S/ 67.50
Fecha de Vencimiento: 29/10/2026`,

  INTERNET: `WIN Internet 100% Fibra Óptica
Código de Cliente: WIN-904512
Factura Electrónica N°: F002-01928374
Periodo: Octubre 2026
Plan contratado: 600 Mbps Simétrico
Importe Total a Pagar: S/ 119.00
Fecha de Vencimiento: 30/10/2026`
};

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3800);
}

/**
 * Calcula en cliente las cuotas exactas al céntimo (Método Hamilton).
 */
function calculatePreviewShares(totalAmount, members = []) {
  const totalCents = Math.round(Number(totalAmount || 0) * 100);
  const active = members.filter((m) => Number(m.percentage) > 0);
  if (totalCents <= 0 || active.length === 0) return [];

  const sumPct = active.reduce((a, m) => a + Number(m.percentage || 0), 0);
  const items = active.map((m, idx) => {
    const norm = sumPct > 0 ? (Number(m.percentage) / sumPct) * 100 : 0;
    const exact = (totalCents * norm) / 100;
    const fl = Math.floor(exact);
    return {
      idx,
      id: m.id || `m_${idx + 1}`,
      name: m.name,
      phone: m.phone || '',
      percentage: Number(m.percentage),
      floorCents: fl,
      rem: exact - fl
    };
  });

  let remCents = totalCents - items.reduce((a, i) => a + i.floorCents, 0);
  const sorted = [...items].sort((a, b) => b.rem - a.rem);
  let k = 0;
  while (remCents > 0 && sorted.length > 0) {
    sorted[k % sorted.length].floorCents += 1;
    remCents -= 1;
    k += 1;
  }

  return items.map((i) => ({
    id: i.id,
    name: i.name,
    phone: i.phone,
    percentage: i.percentage,
    amountCents: i.floorCents,
    amount: (i.floorCents / 100).toFixed(2),
    formattedAmount: `S/ ${(i.floorCents / 100).toFixed(2)}`
  }));
}

/**
 * Motor en navegador para cuando el Panel Web corre en GitHub Pages (Nube).
 */
function analyzeBillInBrowser(textInput = '', forceServiceId = '') {
  const text = String(textInput || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();

  let serviceCode = 'OTRO';
  let providerName = 'Servicio General';

  if (lower.includes('sedapal') || lower.includes('agua potable') || lower.includes('alcantarillado')) {
    serviceCode = 'SEDAPAL';
    providerName = 'Sedapal';
  } else if (lower.includes('pluz') || lower.includes('enel') || lower.includes('luz del sur') || lower.includes('kwh')) {
    serviceCode = 'PLUZ';
    providerName = lower.includes('luz del sur') ? 'Luz del Sur' : 'Pluz Energía Perú';
  } else if (lower.includes('calidda') || lower.includes('cálidda') || lower.includes('gas natural')) {
    serviceCode = 'CALIDDA';
    providerName = 'Cálidda Gas Natural';
  } else if (lower.includes('win') || lower.includes('claro') || lower.includes('movistar') || lower.includes('internet') || lower.includes('fibra')) {
    serviceCode = 'INTERNET';
    providerName = lower.includes('win') ? 'Win Internet Fibra' : 'Internet Fibra';
  }

  const mAmount = text.match(/(?:total\s+a\s+pagar|monto\s+total(?:\s+a\s+pagar)?|importe\s+total|total\s+mes\s+actual|s\/\.?)\s*(?:s\/\.?)?\s*([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}|[0-9]+\.[0-9]{2})/i);
  const totalAmount = mAmount ? Number(mAmount[1].replace(/,/g, '')) : 0;

  const mSupply = text.match(/(?:suministro|c[óo]digo\s+de\s+cliente|cliente\s+n[°º]?)\s*(?:n[°º]?)?\s*[:#-]?\s*([A-Z0-9-]{5,18})/i);
  const supplyNumber = mSupply ? mSupply[1] : 'No especificado';

  const mInv = text.match(/(?:recibo(?:\s+digital|\s+electr[óo]nico)?|factura(?:\s+electr[óo]nica)?)\s*(?:n[°º]?)?\s*[:#-]?\s*([A-Z0-9]{2,5}-[0-9]{5,12}|[0-9]{6,14})/i);
  const invoiceNumber = mInv ? mInv[1] : 'S/N';

  const mDue = text.match(/(?:vencimiento|fecha\s+de\s+vencimiento|vence)\s*[:#-]?\s*([0-9]{1,2}[/-][0-9A-Za-z]{2,10}[/-]20[0-9]{2}|20[0-9]{2}-[0-9]{2}-[0-9]{2})/i);
  const dueDate = mDue ? mDue[1] : 'Por confirmar';

  const mPeriod = text.match(/(?:periodo(?:\s+de\s+facturaci[óo]n)?)\s*[:#-]?\s*([A-Za-záéíóú]{3,12}\s*20[0-9]{2})/i);
  const billingPeriod = mPeriod ? mPeriod[1] : 'Octubre 2026';

  let svc = null;
  if (forceServiceId) {
    svc = (appConfig?.services || []).find((s) => s.id === forceServiceId || s.code === forceServiceId);
  }
  if (!svc) {
    svc =
      (appConfig?.services || []).find((s) => s.code === serviceCode) ||
      (appConfig?.services || [])[0];
  }

  const shares = calculatePreviewShares(totalAmount, svc.members || []);
  const formattedTotal = `S/ ${totalAmount.toFixed(2)}`;

  const distribution = {
    serviceId: svc.id,
    serviceCode: svc.code,
    serviceName: svc.name,
    serviceIcon: svc.icon || '📄',
    providerName,
    supplyNumber: supplyNumber !== 'No especificado' ? supplyNumber : svc.supplyNumber || 'S/N',
    invoiceNumber,
    billingPeriod,
    dueDate,
    totalAmount,
    formattedTotal,
    whatsappGroup: svc.whatsappGroup || { name: 'Casa Familiar', jid: '' },
    shares
  };

  const p = appConfig?.paymentInfo || {};
  const lines = [
    `🧾 *NUEVO RECIBO DETECTADO - DISTRIBUCIÓN DE COSTOS*`,
    `${distribution.serviceIcon} *${distribution.serviceName}*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `📌 *Suministro / Cliente:* ${distribution.supplyNumber}`,
    `🔢 *N° Recibo:* ${distribution.invoiceNumber}`,
    `🗓️ *Periodo:* ${distribution.billingPeriod}`,
    `⏳ *Fecha de Vencimiento:* *${distribution.dueDate}*`,
    `💰 *TOTAL DEL RECIBO:* *${distribution.formattedTotal}*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `📐 *DISTRIBUCIÓN POR PORCENTAJE (%):*`,
    ``
  ];
  shares.forEach((s) => {
    lines.push(`🔸 *${s.name}* (${s.percentage}%): *${s.formattedAmount}*`);
  });
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━`);
  if (p.yapeNumber || p.bankAccount) {
    lines.push(`🏦 *MEDIOS DE PAGO:*`);
    if (p.collectorName) lines.push(`👤 *Titular:* ${p.collectorName}`);
    if (p.yapeNumber) lines.push(`📱 *Yape / Plin:* ${p.yapeNumber}`);
    if (p.bankAccount) lines.push(`💳 *Cuenta:* ${p.bankAccount}`);
    if (p.cci) lines.push(`🏛️ *CCI:* ${p.cci}`);
    if (p.footerNote) lines.push(``, `💬 _${p.footerNote}_`);
  }
  lines.push(``, `🤖 _Generado automáticamente por AutoRecibos AI_`);

  return {
    isBill: totalAmount > 0,
    fingerprint: `${distribution.serviceCode}::${distribution.invoiceNumber}::${totalAmount.toFixed(2)}`,
    extracted: {
      serviceCode: distribution.serviceCode,
      dueDateIso: null,
      extractionEngine: 'cloud-browser-engine'
    },
    distribution,
    whatsappMessage: lines.join('\n')
  };
}

async function fetchConfigAndInit() {
  try {
    const res = await fetch('./api/config');
    if (!res.ok) throw new Error('Static Cloud Mode');
    const data = await res.json();
    appConfig = data.config;

    const badgeEmail = document.getElementById('badgeEmail');
    if (data.envStatus?.hasEmailCreds) {
      badgeEmail.textContent = `📧 IMAP: ${data.envStatus.emailUser}`;
      badgeEmail.className = 'badge ok';
    } else {
      badgeEmail.textContent = '📧 IMAP: Configurar en GitHub Secrets';
      badgeEmail.className = 'badge warn';
    }
    updateWhatsAppHeaderStatus(data.envStatus?.whatsappStatus);
  } catch {
    // Modo Nube (GitHub Pages): Cargar desde repositorio en la nube + localStorage
    isCloudStaticMode = true;
    const savedLocalCfg = localStorage.getItem('autorecibos_config');
    if (savedLocalCfg) {
      appConfig = JSON.parse(savedLocalCfg);
    } else {
      try {
        const rawRes = await fetch(`${GITHUB_RAW_BASE}/config.json?t=${Date.now()}`);
        appConfig = rawRes.ok ? await rawRes.json() : await (await fetch('./data/config.json')).json();
      } catch {
        const fallbackRes = await fetch('./data/config.json');
        appConfig = await fallbackRes.json();
      }
    }

    const badgeEmail = document.getElementById('badgeEmail');
    badgeEmail.textContent = '☁️ Nube Activa (GitHub Actions + Pages)';
    badgeEmail.className = 'badge ok';
    document.getElementById('waStatusLabel').textContent = 'WhatsApp Nube / Web';
  }

  renderServicesGrid();
  populateAnalyzerSelect();
  populatePaymentAndCloudForm();
  await loadBillsHistory();
}

function updateWhatsAppHeaderStatus(waStatus) {
  if (!waStatus) return;
  const label = document.getElementById('waStatusLabel');
  if (waStatus.status === 'CONNECTED') {
    label.textContent = `WA Conectado (${waStatus.connectedUser?.name || 'Listo'})`;
  } else if (waStatus.hasSavedSession) {
    label.textContent = 'WA Sesión Guardada (Listo)';
  } else {
    label.textContent = 'Vincular WhatsApp QR';
  }
}

function renderServicesGrid() {
  const grid = document.getElementById('servicesGrid');
  grid.innerHTML = '';

  const services = appConfig?.services || [];
  services.forEach((svc, svcIdx) => {
    const sumPct = (svc.members || []).reduce((acc, m) => acc + Number(m.percentage || 0), 0);
    const isExact100 = Math.abs(sumPct - 100) < 0.05;
    const sampleAmount = 150.0;
    const sampleShares = calculatePreviewShares(sampleAmount, svc.members || []);

    const card = document.createElement('article');
    card.className = 'service-card';
    card.innerHTML = `
      <div class="service-card-header">
        <div class="service-title-group">
          <div class="service-icon">${svc.icon || '📄'}</div>
          <div>
            <h3 style="font-size: 1.05rem;">${svc.name}</h3>
            <span style="font-size: 0.76rem; color: var(--text-secondary);">Código: <code>${svc.code}</code></span>
          </div>
        </div>
        <label style="display: flex; align-items: center; gap: 0.4rem; font-size: 0.82rem; cursor: pointer;">
          <input type="checkbox" data-svc-idx="${svcIdx}" class="svc-enabled-toggle" ${svc.enabled !== false ? 'checked' : ''} />
          Activo
        </label>
      </div>

      <div class="form-grid-2">
        <div class="field-group">
          <label>N° Suministro / Cliente</label>
          <input type="text" value="${svc.supplyNumber || ''}" data-svc-idx="${svcIdx}" data-field="supplyNumber" class="svc-field-input" />
        </div>
        <div class="field-group">
          <label>Nombre del Grupo de WhatsApp</label>
          <input type="text" value="${svc.whatsappGroup?.name || ''}" data-svc-idx="${svcIdx}" data-field="groupName" class="svc-field-input" />
        </div>
      </div>

      <div class="field-group">
        <label>JID del Grupo de WhatsApp (ej. <code>1203630xxxx@g.us</code> o número <code>51999888777</code>)</label>
        <input type="text" value="${svc.whatsappGroup?.jid || ''}" data-svc-idx="${svcIdx}" data-field="groupJid" class="svc-field-input" />
      </div>

      <div class="members-list">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.25rem;">
          <strong style="font-size: 0.82rem;">Integrantes / Departamentos y Porcentaje (%)</strong>
          <div style="display: flex; gap: 0.4rem;">
            <button type="button" class="btn btn-outline btn-sm btn-equalize" data-svc-idx="${svcIdx}">⚖️ Partes Iguales</button>
            <button type="button" class="btn btn-outline btn-sm btn-add-member" data-svc-idx="${svcIdx}">➕ Integrante</button>
          </div>
        </div>

        ${(svc.members || [])
          .map(
            (m, mIdx) => `
          <div class="member-row">
            <input type="text" value="${m.name}" placeholder="Nombre / Piso" data-svc-idx="${svcIdx}" data-mem-idx="${mIdx}" data-mfield="name" class="mem-input" />
            <div class="pct-input-wrap">
              <input type="number" step="0.01" min="0" max="100" value="${m.percentage}" data-svc-idx="${svcIdx}" data-mem-idx="${mIdx}" data-mfield="percentage" class="mem-input" />
              <span>%</span>
            </div>
            <input type="text" value="${m.phone || ''}" placeholder="Tel. opcional" data-svc-idx="${svcIdx}" data-mem-idx="${mIdx}" data-mfield="phone" class="mem-input member-phone" />
            <button type="button" class="btn btn-danger btn-sm btn-remove-member" data-svc-idx="${svcIdx}" data-mem-idx="${mIdx}" title="Quitar">✕</button>
          </div>
        `
          )
          .join('')}

        <div class="sum-bar">
          <span>Suma configurada:</span>
          <span class="sum-pill ${isExact100 ? 'valid' : 'invalid'}">
            ${sumPct.toFixed(2)}% ${isExact100 ? '✅ Exacto' : '⚠️ Se normalizará al 100%'}
          </span>
        </div>
      </div>

      <div class="quick-calc-box">
        <div>💡 <strong>Simulación rápida con S/ 150.00:</strong></div>
        <div class="quick-calc-shares">
          ${sampleShares
            .map(
              (s) =>
                `<span class="share-chip"><strong>${s.name}</strong> (${s.percentage}%): <strong>S/ ${s.amount}</strong></span>`
            )
            .join('')}
        </div>
      </div>
    `;

    grid.appendChild(card);
  });

  bindServiceCardListeners();
}

function bindServiceCardListeners() {
  document.querySelectorAll('.svc-enabled-toggle').forEach((el) => {
    el.addEventListener('change', (e) => {
      const idx = Number(e.target.dataset.svcIdx);
      appConfig.services[idx].enabled = e.target.checked;
    });
  });

  document.querySelectorAll('.svc-field-input').forEach((el) => {
    el.addEventListener('input', (e) => {
      const idx = Number(e.target.dataset.svcIdx);
      const field = e.target.dataset.field;
      const svc = appConfig.services[idx];
      svc.whatsappGroup = svc.whatsappGroup || {};
      if (field === 'supplyNumber') svc.supplyNumber = e.target.value;
      if (field === 'groupName') svc.whatsappGroup.name = e.target.value;
      if (field === 'groupJid') svc.whatsappGroup.jid = e.target.value;
    });
  });

  document.querySelectorAll('.mem-input').forEach((el) => {
    el.addEventListener('change', (e) => {
      const sIdx = Number(e.target.dataset.svcIdx);
      const mIdx = Number(e.target.dataset.memIdx);
      const mfield = e.target.dataset.mfield;
      const member = appConfig.services[sIdx].members[mIdx];
      if (mfield === 'percentage') {
        member.percentage = Number(e.target.value || 0);
        renderServicesGrid();
      } else {
        member[mfield] = e.target.value;
        if (mfield === 'name') renderServicesGrid();
      }
    });
  });

  document.querySelectorAll('.btn-equalize').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const sIdx = Number(e.currentTarget.dataset.svcIdx);
      const members = appConfig.services[sIdx].members || [];
      if (members.length === 0) return;
      const base = Math.floor(10000 / members.length) / 100;
      let sum = 0;
      members.forEach((m, idx) => {
        if (idx === members.length - 1) {
          m.percentage = Number((100 - sum).toFixed(2));
        } else {
          m.percentage = base;
          sum += base;
        }
      });
      renderServicesGrid();
    });
  });

  document.querySelectorAll('.btn-add-member').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const sIdx = Number(e.currentTarget.dataset.svcIdx);
      const members = appConfig.services[sIdx].members || [];
      members.push({
        id: `m_${Date.now()}`,
        name: `Integrante ${members.length + 1}`,
        percentage: 0,
        phone: ''
      });
      renderServicesGrid();
    });
  });

  document.querySelectorAll('.btn-remove-member').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const sIdx = Number(e.currentTarget.dataset.svcIdx);
      const mIdx = Number(e.currentTarget.dataset.memIdx);
      if (appConfig.services[sIdx].members.length <= 1) {
        showToast('⚠️ Cada servicio debe tener al menos 1 integrante.');
        return;
      }
      appConfig.services[sIdx].members.splice(mIdx, 1);
      renderServicesGrid();
    });
  });
}

function populateAnalyzerSelect() {
  const sel = document.getElementById('analyzerServiceSelect');
  sel.innerHTML = `<option value="">🔍 Detectar Automáticamente (Sedapal / Pluz / Cálidda / Internet)</option>`;
  (appConfig?.services || []).forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.icon || '📄'} ${s.name}`;
    sel.appendChild(opt);
  });
}

function populatePaymentAndCloudForm() {
  const p = appConfig?.paymentInfo || {};
  document.getElementById('payCollectorName').value = p.collectorName || '';
  document.getElementById('payYape').value = p.yapeNumber || '';
  document.getElementById('payPlin').value = p.plinNumber || '';
  document.getElementById('payBank').value = p.bankAccount || '';
  document.getElementById('payCci').value = p.cci || '';
  document.getElementById('payFooterNote').value = p.footerNote || '';

  const rem = appConfig?.schedule?.sendReminderDaysBeforeDue || [3, 1];
  document.getElementById('schedReminders').value = rem.join(', ');
  document.getElementById('gsCsvUrl').value = appConfig?.googleSheets?.csvConfigUrl || '';
}

async function saveFullConfiguration() {
  localStorage.setItem('autorecibos_config', JSON.stringify(appConfig));
  if (isCloudStaticMode) {
    showToast('✅ Configuración guardada en este navegador.');
    populateAnalyzerSelect();
    return;
  }

  const res = await fetch('./api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(appConfig)
  });
  const data = await res.json();
  if (data.success) {
    showToast('✅ Configuración y porcentajes guardados correctamente.');
    populateAnalyzerSelect();
  } else {
    showToast(`❌ Error: ${data.error}`);
  }
}

function renderAnalysisOutput(result) {
  lastAnalyzedBill = result;
  const dist = result.distribution;

  document.getElementById('analysisResultMeta').innerHTML = `
    <strong>${dist.serviceIcon} ${dist.serviceName}</strong> &bull;
    Recibo: <code>${dist.invoiceNumber}</code> &bull;
    Vence: <strong>${dist.dueDate}</strong> &bull;
    Total: <strong style="color: #34d399;">${dist.formattedTotal}</strong>
    <span style="font-size: 0.75rem; margin-left: 0.4rem; opacity: 0.75;">(Motor: ${result.extracted.extractionEngine})</span>
  `;

  const tableEl = document.getElementById('analysisSharesTable');
  tableEl.style.display = 'block';
  tableEl.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Integrante / Grupo</th>
          <th>Porcentaje (%)</th>
          <th>Monto Exacto (S/)</th>
        </tr>
      </thead>
      <tbody>
        ${dist.shares
          .map(
            (s) => `
          <tr>
            <td><strong>${s.name}</strong></td>
            <td>${s.percentage}%</td>
            <td style="color: #34d399; font-weight: 700;">${s.formattedAmount}</td>
          </tr>
        `
          )
          .join('')}
      </tbody>
    </table>
  `;

  document.getElementById('previewGroupTarget').textContent = `Grupo destino: ${dist.whatsappGroup?.name || 'Principal'} (${dist.whatsappGroup?.jid || 'sin JID'})`;
  document.getElementById('whatsappBubblePreview').textContent = result.whatsappMessage;

  document.getElementById('btnCopyWhatsappMsg').disabled = false;
  document.getElementById('btnSendSimulated').disabled = false;
  document.getElementById('btnSendRealWhatsapp').disabled = false;
  showToast('✅ Recibo analizado y distribuido al céntimo.');
}

async function analyzeCurrentInput() {
  const fileInput = document.getElementById('analyzerFileInput');
  const textInput = document.getElementById('analyzerTextInput');
  const serviceId = document.getElementById('analyzerServiceSelect').value;

  const btn = document.getElementById('btnAnalyzeBill');
  btn.disabled = true;
  btn.textContent = '⏳ Analizando recibo...';

  try {
    if (isCloudStaticMode) {
      let rawText = textInput.value || '';
      if (fileInput.files[0] && !rawText) {
        const buf = await fileInput.files[0].arrayBuffer();
        const dec = new TextDecoder('latin1').decode(buf);
        rawText = dec.replace(/[^\x20-\x7EÁÉÍÓÚáéíóúÑñ]/g, ' ');
      }
      const res = analyzeBillInBrowser(rawText, serviceId);
      if (!res.isBill) {
        showToast('⚠️ Ingresa o selecciona un recibo con monto válido en Soles (S/).');
        return;
      }
      renderAnalysisOutput(res);
      return;
    }

    const formData = new FormData();
    if (fileInput.files[0]) {
      formData.append('file', fileInput.files[0]);
    }
    formData.append('text', textInput.value || '');
    formData.append('serviceId', serviceId);

    const res = await fetch('./api/analyze', {
      method: 'POST',
      body: formData
    });
    const result = await res.json();
    if (!res.ok || !result.isBill) {
      showToast(`⚠️ ${result.reason || result.error || 'No se detectó un recibo válido.'}`);
      return;
    }
    renderAnalysisOutput(result);
  } catch (err) {
    showToast(`❌ Error analizando recibo: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '🧮 Analizar Recibo y Calcular Distribución por %';
  }
}

async function confirmAndDispatchAnalyzedBill(dryRun) {
  if (!lastAnalyzedBill) return;

  if (isCloudStaticMode) {
    const dist = lastAnalyzedBill.distribution;
    const record = {
      id: `bill_${Date.now()}`,
      fingerprint: lastAnalyzedBill.fingerprint,
      createdAt: new Date().toISOString(),
      serviceName: dist.serviceName,
      serviceIcon: dist.serviceIcon,
      supplyNumber: dist.supplyNumber,
      invoiceNumber: dist.invoiceNumber,
      billingPeriod: dist.billingPeriod,
      dueDate: dist.dueDate,
      totalAmount: dist.totalAmount,
      formattedTotal: dist.formattedTotal,
      whatsappGroup: dist.whatsappGroup,
      shares: dist.shares,
      whatsappMessage: lastAnalyzedBill.whatsappMessage,
      paid: false
    };
    cloudLedger.bills.unshift(record);
    localStorage.setItem('autorecibos_ledger', JSON.stringify(cloudLedger));
    await loadBillsHistory();

    if (!dryRun) {
      const encoded = encodeURIComponent(lastAnalyzedBill.whatsappMessage);
      window.open(`https://api.whatsapp.com/send?text=${encoded}`, '_blank', 'noopener');
      showToast('📲 Abriendo WhatsApp con el desglose listo para enviar al grupo.');
    } else {
      showToast('🧪 Recibo registrado en el historial.');
    }
    return;
  }

  try {
    const res = await fetch('./api/bills/confirm-and-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        processedBill: lastAnalyzedBill,
        dryRun
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Fallo en el envío');

    showToast(
      dryRun
        ? '🧪 Recibo registrado en el historial (Envío simulado).'
        : '📲 ¡Mensaje enviado al grupo de WhatsApp y registrado!'
    );
    await loadBillsHistory();
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

async function loadBillsHistory() {
  if (isCloudStaticMode) {
    const savedLocal = localStorage.getItem('autorecibos_ledger');
    if (savedLocal) {
      cloudLedger = JSON.parse(savedLocal);
    } else {
      try {
        const rawRes = await fetch(`${GITHUB_RAW_BASE}/processed_bills.json?t=${Date.now()}`);
        cloudLedger = rawRes.ok
          ? await rawRes.json()
          : await (await fetch('./data/processed_bills.json')).json();
      } catch {
        cloudLedger = { lastRunAt: null, bills: [] };
      }
    }
    renderHistoryRows(cloudLedger.bills || []);
    return;
  }

  const res = await fetch('./api/bills');
  const ledger = await res.json();
  renderHistoryRows(ledger.bills || []);
}

function renderHistoryRows(bills) {
  const tbody = document.getElementById('billsHistoryBody');
  if (!bills || bills.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-secondary); padding: 2rem;">
          Aún no hay recibos registrados. Haz clic en <strong>⚡ Simular Ciclo Diario (4 Recibos)</strong> arriba para probar todo el flujo automático.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = bills
    .map(
      (b) => `
    <tr>
      <td><strong>${b.serviceIcon || '📄'} ${b.serviceName}</strong><br/><small style="color:var(--text-secondary)">Sum: ${b.supplyNumber}</small></td>
      <td><code>${b.invoiceNumber}</code><br/><small style="color:var(--text-secondary)">${b.billingPeriod}</small></td>
      <td><strong>${b.dueDate}</strong></td>
      <td style="color: #34d399; font-weight: 700;">${b.formattedTotal}</td>
      <td>
        <div style="display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem;">
          ${(b.shares || [])
            .map((s) => `<span>• ${s.name} (${s.percentage}%): <strong>${s.formattedAmount}</strong></span>`)
            .join('')}
        </div>
      </td>
      <td><small>${b.whatsappGroup?.name || 'Grupo'}<br/><code>${b.whatsappGroup?.jid || ''}</code></small></td>
      <td>
        <span class="sum-pill ${b.paid ? 'valid' : 'invalid'}">
          ${b.paid ? '✅ Pagado' : '⏳ Pendiente'}
        </span>
      </td>
      <td>
        <div style="display: flex; gap: 0.35rem; flex-wrap: wrap;">
          <button type="button" class="btn btn-outline btn-sm btn-toggle-paid" data-id="${b.id}" data-paid="${!b.paid}">
            ${b.paid ? 'Pendiente' : '✔️ Pagado'}
          </button>
          <button type="button" class="btn btn-primary btn-sm btn-wa-direct" data-id="${b.id}" title="Enviar por WhatsApp">📲 WA</button>
          <button type="button" class="btn btn-danger btn-sm btn-delete-bill" data-id="${b.id}">🗑️</button>
        </div>
      </td>
    </tr>
  `
    )
    .join('');

  tbody.querySelectorAll('.btn-toggle-paid').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      const paid = e.currentTarget.dataset.paid === 'true';
      if (isCloudStaticMode) {
        const item = (cloudLedger.bills || []).find((x) => x.id === id);
        if (item) item.paid = paid;
        localStorage.setItem('autorecibos_ledger', JSON.stringify(cloudLedger));
        renderHistoryRows(cloudLedger.bills);
        return;
      }
      await fetch(`./api/bills/${id}/paid`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid })
      });
      await loadBillsHistory();
    });
  });

  tbody.querySelectorAll('.btn-wa-direct').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      const item = bills.find((x) => x.id === id);
      if (item?.whatsappMessage) {
        window.open(
          `https://api.whatsapp.com/send?text=${encodeURIComponent(item.whatsappMessage)}`,
          '_blank',
          'noopener'
        );
      }
    });
  });

  tbody.querySelectorAll('.btn-delete-bill').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      if (isCloudStaticMode) {
        cloudLedger.bills = (cloudLedger.bills || []).filter((x) => x.id !== id);
        localStorage.setItem('autorecibos_ledger', JSON.stringify(cloudLedger));
        renderHistoryRows(cloudLedger.bills);
        return;
      }
      await fetch(`./api/bills/${id}`, { method: 'DELETE' });
      await loadBillsHistory();
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  fetchConfigAndInit();

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  document.getElementById('btnSaveAllConfig').addEventListener('click', saveFullConfiguration);

  document.querySelectorAll('.sample-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sample;
      document.getElementById('analyzerTextInput').value = SAMPLE_TEXTS[key] || '';
      analyzeCurrentInput();
    });
  });

  document.getElementById('analyzerFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    document.getElementById('dropzoneFileName').textContent = file
      ? `✅ Archivo seleccionado: ${file.name}`
      : 'Haz clic aquí para seleccionar un PDF o Imagen del recibo';
  });

  document.getElementById('btnAnalyzeBill').addEventListener('click', analyzeCurrentInput);

  document.getElementById('btnCopyWhatsappMsg').addEventListener('click', async () => {
    if (!lastAnalyzedBill?.whatsappMessage) return;
    await navigator.clipboard.writeText(lastAnalyzedBill.whatsappMessage);
    showToast('📋 Mensaje de WhatsApp copiado al portapapeles.');
  });

  document.getElementById('btnSendSimulated').addEventListener('click', () =>
    confirmAndDispatchAnalyzedBill(true)
  );
  document.getElementById('btnSendRealWhatsapp').addEventListener('click', () =>
    confirmAndDispatchAnalyzedBill(false)
  );

  // Simular Ciclo Diario completo (4 recibos demo)
  document.getElementById('btnRunDemo').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '⏳ Procesando 4 recibos...';
    try {
      if (isCloudStaticMode) {
        const keys = ['INTERNET', 'CALIDDA', 'PLUZ', 'SEDAPAL'];
        cloudLedger.bills = [];
        keys.forEach((k, idx) => {
          const parsed = analyzeBillInBrowser(SAMPLE_TEXTS[k]);
          const d = parsed.distribution;
          cloudLedger.bills.unshift({
            id: `demo_${Date.now()}_${idx}`,
            fingerprint: parsed.fingerprint,
            createdAt: new Date().toISOString(),
            serviceName: d.serviceName,
            serviceIcon: d.serviceIcon,
            supplyNumber: d.supplyNumber,
            invoiceNumber: d.invoiceNumber,
            billingPeriod: d.billingPeriod,
            dueDate: d.dueDate,
            totalAmount: d.totalAmount,
            formattedTotal: d.formattedTotal,
            whatsappGroup: d.whatsappGroup,
            shares: d.shares,
            whatsappMessage: parsed.whatsappMessage,
            paid: false
          });
        });
        localStorage.setItem('autorecibos_ledger', JSON.stringify(cloudLedger));
        await loadBillsHistory();
        showToast('✅ Demo en Nube completada: 4 recibos calculados y distribuidos por %.');
        document.querySelector('[data-tab="tab-history"]').click();
        return;
      }

      const res = await fetch('./api/run-daily', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ demoMode: true, dryRun: true, forceResend: true })
      });
      const report = await res.json();
      showToast(`✅ Demo completada: ${report.newBillsDetected} recibos calculados y distribuidos por %.`);
      await loadBillsHistory();
      document.querySelector('[data-tab="tab-history"]').click();
    } catch (err) {
      showToast(`❌ Error: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '⚡ Simular Ciclo Diario (4 Recibos)';
    }
  });

  // Escaneo IMAP real o salto a GitHub Actions
  document.getElementById('btnScanRealImap').addEventListener('click', async (e) => {
    if (isCloudStaticMode) {
      window.open(GITHUB_ACTIONS_URL, '_blank', 'noopener');
      showToast('☁️ Abriendo panel de ejecución diaria en GitHub Actions...');
      return;
    }

    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '⏳ Conectando a IMAP...';
    try {
      const res = await fetch('./api/run-daily', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ demoMode: false, dryRun: false, forceResend: false })
      });
      const report = await res.json();
      if (report.errors && report.errors.length > 0) {
        showToast(`⚠️ ${report.errors[0]}`);
      } else {
        showToast(`✅ Escaneo IMAP listo: ${report.newBillsDetected} nuevos recibos procesados.`);
      }
      await loadBillsHistory();
    } catch (err) {
      showToast(`❌ ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '📧 Escanear Bandeja de Correo (IMAP)';
    }
  });

  document.getElementById('btnSavePaymentAndCloud').addEventListener('click', async () => {
    appConfig.paymentInfo = {
      collectorName: document.getElementById('payCollectorName').value.trim(),
      yapeNumber: document.getElementById('payYape').value.trim(),
      plinNumber: document.getElementById('payPlin').value.trim(),
      bankAccount: document.getElementById('payBank').value.trim(),
      cci: document.getElementById('payCci').value.trim(),
      footerNote: document.getElementById('payFooterNote').value.trim()
    };

    const daysArr = document
      .getElementById('schedReminders')
      .value.split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0);

    appConfig.schedule = appConfig.schedule || {};
    appConfig.schedule.sendReminderDaysBeforeDue = daysArr.length > 0 ? daysArr : [3, 1];

    const gsUrl = document.getElementById('gsCsvUrl').value.trim();
    appConfig.googleSheets = {
      enabled: Boolean(gsUrl),
      csvConfigUrl: gsUrl
    };

    await saveFullConfiguration();
  });

  const waDialog = document.getElementById('whatsappDialog');
  document.getElementById('btnOpenWhatsappModal').addEventListener('click', () => {
    waDialog.showModal();
    if (!isCloudStaticMode) {
      refreshWaModalStatus();
      waPollInterval = setInterval(refreshWaModalStatus, 2500);
    } else {
      document.getElementById('waModalStateText').textContent =
        'Modo Nube (Ejecuta npm start en local para escanear QR o usa Green-API en la nube)';
    }
  });

  document.getElementById('btnCloseWhatsappDialog').addEventListener('click', () => {
    waDialog.close();
    if (waPollInterval) clearInterval(waPollInterval);
  });

  const waProviderSelect = document.getElementById('waProviderSelect');
  waProviderSelect.addEventListener('change', () => {
    const val = waProviderSelect.value;
    document.getElementById('waBaileysSection').style.display = val === 'baileys' ? 'block' : 'none';
    document.getElementById('waGreenApiSection').style.display = val === 'green-api' ? 'block' : 'none';
    document.getElementById('waCallMeBotSection').style.display = val === 'callmebot' ? 'block' : 'none';
  });

  document.getElementById('btnStartQr').addEventListener('click', async () => {
    if (isCloudStaticMode) {
      showToast('💡 Para vincular el QR de Baileys por primera vez, usa http://localhost:3080 o elige Green-API.');
      return;
    }
    document.getElementById('waModalStateText').textContent = 'Generando código QR...';
    await fetch('./api/whatsapp/connect', { method: 'POST' });
    setTimeout(refreshWaModalStatus, 1200);
  });

  document.getElementById('btnLogoutWa').addEventListener('click', async () => {
    if (isCloudStaticMode) return;
    await fetch('./api/whatsapp/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logout: true })
    });
    await refreshWaModalStatus();
    showToast('Sesión de WhatsApp cerrada.');
  });

  document.getElementById('btnRefreshGroups').addEventListener('click', async () => {
    if (isCloudStaticMode) return;
    const res = await fetch('./api/whatsapp/groups');
    const data = await res.json();
    renderWaGroupsList(data.groups || []);
  });

  document.getElementById('btnExportSessionBase64').addEventListener('click', async () => {
    if (isCloudStaticMode) {
      showToast('💡 Exporta tu sesión desde http://localhost:3080 tras escanear el QR.');
      return;
    }
    const res = await fetch('./api/whatsapp/export-session');
    const data = await res.json();
    if (!res.ok) {
      showToast(`⚠️ ${data.error}`);
      return;
    }
    await navigator.clipboard.writeText(data.base64);
    showToast('🔐 WHATSAPP_SESSION_BASE64 copiado al portapapeles para GitHub Secrets.');
  });

  document.getElementById('btnSaveWaSettings').addEventListener('click', async () => {
    appConfig.whatsapp = appConfig.whatsapp || {};
    appConfig.whatsapp.activeProvider = waProviderSelect.value;
    appConfig.whatsapp.greenApi = {
      apiUrl: 'https://api.green-api.com',
      idInstance: document.getElementById('greenIdInstance').value.trim(),
      apiTokenInstance: document.getElementById('greenApiToken').value.trim()
    };
    appConfig.whatsapp.callmebot = {
      phone: document.getElementById('cmbPhone').value.trim(),
      apiKey: document.getElementById('cmbApiKey').value.trim()
    };
    await saveFullConfiguration();
    waDialog.close();
    if (waPollInterval) clearInterval(waPollInterval);
  });

  const newSvcDialog = document.getElementById('newServiceDialog');
  document.getElementById('btnOpenNewServiceModal').addEventListener('click', () => {
    newSvcDialog.showModal();
  });
  document.getElementById('btnCloseNewServiceDialog').addEventListener('click', () => {
    newSvcDialog.close();
  });

  document.getElementById('btnConfirmAddService').addEventListener('click', async () => {
    const name = document.getElementById('newSvcName').value.trim();
    const code = document.getElementById('newSvcCode').value.trim().toUpperCase() || 'SERVICIO';
    const icon = document.getElementById('newSvcIcon').value.trim() || '📄';
    const supply = document.getElementById('newSvcSupply').value.trim();
    const kws = document
      .getElementById('newSvcKeywords')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!name) {
      showToast('⚠️ Ingresa un nombre para el servicio.');
      return;
    }

    appConfig.services.push({
      id: code.toLowerCase() + '_' + Date.now().toString(36),
      code,
      name,
      icon,
      enabled: true,
      supplyNumber: supply,
      senderKeywords: kws.length > 0 ? kws : [name.toLowerCase()],
      whatsappGroup: {
        name: 'Casa Familiar - Recibos',
        jid: appConfig.whatsapp?.defaultGroupJid || ''
      },
      fixedFee: 0,
      members: [
        { id: 'm1', name: 'Piso 1', percentage: 50, phone: '' },
        { id: 'm2', name: 'Piso 2', percentage: 50, phone: '' }
      ]
    });

    await saveFullConfiguration();
    renderServicesGrid();
    newSvcDialog.close();
  });
});

async function refreshWaModalStatus() {
  try {
    const res = await fetch('./api/whatsapp/status');
    const st = await res.json();
    updateWhatsAppHeaderStatus(st);

    const stateText = document.getElementById('waModalStateText');
    const qrContainer = document.getElementById('waQrContainer');
    const qrImg = document.getElementById('waQrImg');

    stateText.textContent = st.status;
    if (st.status === 'QR_READY' && st.qrDataUrl) {
      qrContainer.style.display = 'block';
      qrImg.src = st.qrDataUrl;
    } else {
      qrContainer.style.display = 'none';
    }

    if (Array.isArray(st.groupsCache) && st.groupsCache.length > 0) {
      renderWaGroupsList(st.groupsCache);
    }
  } catch {
    // Ignorar errores de red temporales
  }
}

function renderWaGroupsList(groups) {
  const container = document.getElementById('waGroupsList');
  if (!groups || groups.length === 0) {
    container.textContent = 'No se encontraron grupos aún o la sesión no está conectada.';
    return;
  }
  container.innerHTML = groups
    .map(
      (g) =>
        `<div style="display:flex; justify-content:space-between; padding:0.25rem 0; border-bottom:1px solid var(--border-color);">
          <span><strong>${g.name}</strong> (${g.participantsCount})</span>
          <code style="color:#34d399; cursor:pointer;" onclick="navigator.clipboard.writeText('${g.jid}')">${g.jid} 📋</code>
        </div>`
    )
    .join('');
}
