# 🧾 AutoRecibos AI — Distribución Automática de Recibos por % y Envío a WhatsApp

Sistema inteligente **100% automático y configurable** que detecta tus recibos de servicios públicos peruanos (**Sedapal, Pluz Energía / Luz del Sur, Cálidda, Win/Claro/Movistar Internet**, y cualquier otro servicio), calcula al céntimo (`S/ 0.01`) cuánto le corresponde pagar a cada piso/integrante según su **porcentaje (%)**, y envía el detalle automáticamente al **Grupo de WhatsApp** de cada servicio.

---

## ✨ Características Principales

1. **Lectura Híbrida de Recibos (Automática + Manual):**
   - **Correo Automático (IMAP Gmail / Outlook):** Escanea todos los días los correos nuevos y sus adjuntos PDF de Sedapal, Pluz, Cálidda e Internet.
   - **Panel Web Interactivo (Drag & Drop):** Permite subir manualmente cualquier PDF, foto de recibo o texto de correo y enviarlo con 1 clic.
   - **IA Multimodal (`gemini-3.8-flash` con `@google/genai`) + Parser Determinista Peruano:** Funciona con IA de Google y cuenta con un motor determinista de respaldo calibrado para recibos peruanos (nunca falla incluso sin API Key).

2. **Distribución Matemática Exacta al Céntimo (`%`):**
   - Configura diferentes porcentajes para cada servicio (ej. Agua 45% / 30% / 25%, Luz 40% / 35% / 25%, Gas 50% / 30% / 20%, Internet 40% / 30% / 30%).
   - Utiliza el **Método del Mayor Resto (Hamilton)** en céntimos enteros para garantizar que la suma de las cuotas individuales cuadre **exactamente** con el total del recibo.

3. **Envío a Grupos de WhatsApp (Multi-Motor 100% Gratuito):**
   - **Motor 1 (Baileys QR):** Vincula tu propio número de WhatsApp escaneando un código QR desde el Panel Web o terminal. Lista tus grupos de WhatsApp (`@g.us`) y exporta la sesión (`WHATSAPP_SESSION_BASE64`) para correr en **GitHub Actions** sin servidor.
   - **Motor 2 (Green-API Free Plan):** Envía mensajes a grupos de WhatsApp mediante la instancia gratuita de desarrollador de `green-api.com`.
   - **Motor 3 (CallMeBot / Webhook):** Alternativa ligera por HTTP.

4. **Ejecución Diaria 100% Gratuita en la Nube:**
   - **GitHub Actions (`.github/workflows/daily-recibos.yml`):** Se ejecuta todos los días a las **08:00 AM (Hora Perú)**, envía los recibos nuevos o recordatorios de vencimiento (3 y 1 día antes) y guarda el historial en `data/processed_bills.json`.
   - **Google Apps Script (`cloud/google-apps-script.gs`):** Alternativa lista para pegar en `script.google.com` dentro de tu cuenta de Gmail y Google Sheets.

---

## 🚀 Uso Rápido en Local (Panel Web)

```bash
# 1. Instalar dependencias
npm install

# 2. Iniciar el Panel Web Interactivo (http://localhost:3080)
npm start

# 3. Probar el ciclo diario por consola con los 4 recibos de ejemplo
npm run daily:demo

# 4. Ejecutar pruebas automatizadas
npm test
```
