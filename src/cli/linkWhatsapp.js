/**
 * Utilidad de Consola para Vincular un Número de WhatsApp mediante Código QR (Baileys)
 * y obtener el string WHATSAPP_SESSION_BASE64 listo para copiar en GitHub Secrets.
 */

import 'dotenv/config';
import QRCode from 'qrcode';
import {
  startBaileysSession,
  exportAuthStateToBase64,
  listWhatsAppGroups,
  disconnectWhatsApp
} from '../services/whatsappService.js';

async function main() {
  console.log('==============================================================');
  console.log('📲 VINCULACIÓN DE WHATSAPP PARA AUTORECIBOS AI (NUBE / GITHUB)');
  console.log('==============================================================');
  console.log('Abre WhatsApp en tu celular -> Dispositivos vinculados -> Vincular un dispositivo.\n');

  try {
    await startBaileysSession({
      waitForOpenMs: 120000,
      onQr: async (qrRaw) => {
        const terminalQr = await QRCode.toString(qrRaw, { type: 'terminal', small: true });
        console.log(terminalQr);
        console.log('👆 Escanea este código QR con tu WhatsApp...\n');
      }
    });

    console.log('\n✅ ¡WhatsApp vinculado exitosamente!');
    const groups = await listWhatsAppGroups();
    if (groups.length > 0) {
      console.log('\n👥 GRUPOS DE WHATSAPP DETECTADOS EN TU CUENTA:');
      for (const g of groups) {
        console.log(`  • "${g.name}"  -->  JID: ${g.jid} (${g.participantsCount} miembros)`);
      }
    }

    const base64Secret = exportAuthStateToBase64();
    if (base64Secret) {
      console.log('\n🔐 SECRET PARA GITHUB ACTIONS (WHATSAPP_SESSION_BASE64):');
      console.log('Copia el siguiente bloque en Settings -> Secrets and variables -> Actions -> WHATSAPP_SESSION_BASE64:\n');
      console.log(base64Secret);
      console.log('\n==============================================================');
    }
  } catch (err) {
    console.error('\n❌ No se completó la vinculación:', err.message);
  } finally {
    await disconnectWhatsApp(false);
  }
}

main();
