/**
 * Script de Ejecución Diaria Automática (GitHub Actions Cron / Ejecución en Nube o Local).
 * Uso:
 *   node src/cli/dailyRunner.js               -> Ejecución real (lee IMAP + envía WhatsApp)
 *   node src/cli/dailyRunner.js --dry-run     -> Simulación sin enviar mensajes reales
 *   node src/cli/dailyRunner.js --demo        ->Prueba completa con los 4 recibos demo (Sedapal, Pluz, Cálidda, Internet)
 */

import 'dotenv/config';
import { runDailyAutomation } from '../core/pipelineProcessor.js';
import { disconnectWhatsApp } from '../services/whatsappService.js';

async function main() {
  const args = process.argv.slice(2);
  const demoMode = args.includes('--demo');
  const dryRun = args.includes('--dry-run') || demoMode;
  const forceResend = args.includes('--force');

  console.log('==============================================================');
  console.log('🤖 AUTORECIBOS AI - EJECUCIÓN AUTOMÁTICA DIARIA');
  console.log(`📅 Fecha/Hora: ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}`);
  console.log(`⚙️  Modo: ${demoMode ? 'DEMO (4 servicios peruanos)' : 'PRODUCCIÓN (IMAP)'} | DryRun: ${dryRun}`);
  console.log('==============================================================\n');

  try {
    const report = await runDailyAutomation({ demoMode, dryRun, forceResend });

    console.log(`📧 Correos analizados:       ${report.emailsScanned}`);
    console.log(`🧾 Nuevos recibos procesados: ${report.newBillsDetected}`);
    console.log(`⏰ Recordatorios enviados:    ${report.remindersSent}`);
    console.log(`⏭️  Duplicados omitidos:       ${report.skippedDuplicates.length}`);

    if (report.messagesDispatched.length > 0) {
      console.log('\n📲 RESUMEN DE ENVÍOS A GRUPOS DE WHATSAPP:');
      for (const item of report.messagesDispatched) {
        console.log(
          `  • [${item.type}] ${item.serviceName} -> Total: S/ ${Number(item.totalAmount).toFixed(2)} -> Grupo: "${item.groupName}" (${item.targetJid})`
        );
      }
    }

    if (report.errors.length > 0) {
      console.warn('\n⚠️ ADVERTENCIAS / ERRORES REGISTRADOS:');
      for (const err of report.errors) {
        console.warn(`  - ${err}`);
      }
    }

    console.log('\n✅ Ciclo diario finalizado correctamente.');
  } catch (err) {
    console.error('\n❌ Error crítico en la ejecución diaria:', err.message);
    process.exitCode = 1;
  } finally {
    await disconnectWhatsApp(false);
  }
}

main();
