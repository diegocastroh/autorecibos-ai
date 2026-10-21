import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calculateDistribution, formatWhatsAppMessage } from '../src/core/costDistributor.js';
import {
  parseBillDeterministic,
  normalizeDateString,
  buildBillFingerprint
} from '../src/core/billParser.js';
import { normalizeWhatsAppJid } from '../src/services/whatsappService.js';
import { runDailyAutomation } from '../src/core/pipelineProcessor.js';

describe('AutoRecibos AI - Suite de Pruebas Automatizadas', () => {
  test('1. Conservación exacta de céntimos (Método Hamilton) en divisiones inexactas', () => {
    const bill = {
      serviceCode: 'PLUZ',
      providerName: 'Pluz Energía Perú',
      supplyNumber: '1194649',
      invoiceNumber: 'S870-00062506',
      billingPeriod: 'Octubre 2026',
      dueDate: '25/10/2026',
      totalAmount: 100.0
    };

    const serviceConfig = {
      id: 'pluz',
      code: 'PLUZ',
      name: 'Pluz Energía',
      icon: '⚡',
      whatsappGroup: { name: 'Casa', jid: '120363000001@g.us' },
      members: [
        { id: '1', name: 'Piso 1', percentage: 33.33 },
        { id: '2', name: 'Piso 2', percentage: 33.33 },
        { id: '3', name: 'Piso 3', percentage: 33.34 }
      ]
    };

    const dist = calculateDistribution(bill, serviceConfig);
    assert.equal(dist.totalAmount, 100.0);
    assert.equal(dist.sumDistributed, 100.0);

    const sumCents = dist.shares.reduce((acc, s) => acc + s.amountCents, 0);
    assert.equal(sumCents, 10000);
    assert.equal(dist.shares[0].amount, 33.33);
    assert.equal(dist.shares[1].amount, 33.33);
    assert.equal(dist.shares[2].amount, 33.34);
  });

  test('2. Distribución porcentual exacta para Sedapal (45% / 30% / 25%) con céntimos impares', () => {
    const bill = {
      serviceCode: 'SEDAPAL',
      totalAmount: 147.43,
      supplyNumber: '5028332-4',
      invoiceNumber: 'S001-99812',
      dueDate: '28/10/2026'
    };
    const serviceConfig = {
      id: 'sedapal',
      code: 'SEDAPAL',
      name: 'Sedapal Agua',
      icon: '💧',
      members: [
        { id: 'm1', name: 'Piso 1', percentage: 45 },
        { id: 'm2', name: 'Piso 2', percentage: 30 },
        { id: 'm3', name: 'Piso 3', percentage: 25 }
      ]
    };

    const dist = calculateDistribution(bill, serviceConfig);
    const sumAmounts = Number(
      dist.shares.reduce((acc, s) => acc + s.amount, 0).toFixed(2)
    );
    assert.equal(sumAmounts, 147.43);
  });

  test('3. Parser determinista extrae correctamente Sedapal, Pluz, Cálidda e Internet', () => {
    const sedapalRaw =
      'SEDAPAL - Servicio de Agua Potable. Suministro N° 5028332-4. Recibo N° S001-08492015. Consumo: 24 m3. Total a Pagar: S/ 1,248.60. Vencimiento: 28/10/2026';
    const parsedSedapal = parseBillDeterministic(sedapalRaw);
    assert.equal(parsedSedapal.isBill, true);
    assert.equal(parsedSedapal.serviceCode, 'SEDAPAL');
    assert.equal(parsedSedapal.totalAmount, 1248.6);
    assert.equal(parsedSedapal.supplyNumber, '5028332-4');
    assert.equal(parsedSedapal.dueDate, '28/10/2026');
    assert.equal(parsedSedapal.dueDateIso, '2026-10-28');

    const caliddaRaw =
      'Cálidda Gas Natural de Lima y Callao. Suministro: 8841209. Monto Total a Pagar: S/ 67.50. Fecha de Vencimiento: 07/NOV/2026';
    const parsedCalidda = parseBillDeterministic(caliddaRaw);
    assert.equal(parsedCalidda.serviceCode, 'CALIDDA');
    assert.equal(parsedCalidda.totalAmount, 67.5);
    assert.equal(parsedCalidda.dueDate, '07/11/2026');

    const internetRaw =
      'WIN Internet Fibra Óptica. Código de Cliente: WIN-904512. Plan 600 Mbps. Importe Total a Pagar: S/ 119.00. Vencimiento: 2026-10-30';
    const parsedInternet = parseBillDeterministic(internetRaw);
    assert.equal(parsedInternet.serviceCode, 'INTERNET');
    assert.equal(parsedInternet.totalAmount, 119.0);
    assert.equal(parsedInternet.dueDate, '30/10/2026');
  });

  test('4. Formateador de mensaje de WhatsApp incluye porcentajes, montos y medios de pago', () => {
    const bill = {
      serviceCode: 'CALIDDA',
      totalAmount: 80.0,
      supplyNumber: '8841209',
      invoiceNumber: 'B004-112233',
      billingPeriod: 'Octubre 2026',
      dueDate: '29/10/2026'
    };
    const serviceConfig = {
      id: 'calidda',
      code: 'CALIDDA',
      name: 'Cálidda (Gas Natural)',
      icon: '🔥',
      members: [
        { id: '1', name: 'Piso 1', percentage: 60 },
        { id: '2', name: 'Piso 2', percentage: 40 }
      ]
    };

    const dist = calculateDistribution(bill, serviceConfig);
    const msg = formatWhatsAppMessage(dist, {
      collectorName: 'Diego',
      yapeNumber: '999-888-777',
      bankAccount: 'BCP 191-0000'
    });

    assert.match(msg, /Cálidda \(Gas Natural\)/);
    assert.match(msg, /Piso 1\* \(60%\): \*S\/ 48\.00/);
    assert.match(msg, /Piso 2\* \(40%\): \*S\/ 32\.00/);
    assert.match(msg, /999-888-777/);
  });

  test('5. Normalización de JIDs de grupos y teléfonos de WhatsApp', () => {
    assert.equal(
      normalizeWhatsAppJid('120363000000000001@g.us'),
      '120363000000000001@g.us'
    );
    assert.equal(normalizeWhatsAppJid('999888777'), '51999888777@s.whatsapp.net');
    assert.equal(normalizeWhatsAppJid('+51 999 888 777'), '51999888777@s.whatsapp.net');
  });

  test('6. Pipeline diario procesa los 4 servicios y evita duplicados en segunda corrida', async () => {
    const firstRun = await runDailyAutomation({
      demoMode: true,
      dryRun: true,
      forceResend: true
    });
    assert.equal(firstRun.emailsScanned, 4);
    assert.equal(firstRun.newBillsDetected, 4);

    // Segunda ejecución sin forceResend debe omitir los 4 recibos por deduplicación
    const secondRun = await runDailyAutomation({
      demoMode: true,
      dryRun: true,
      forceResend: false
    });
    assert.equal(secondRun.newBillsDetected, 0);
    assert.equal(secondRun.skippedDuplicates.length, 4);
  });
});
