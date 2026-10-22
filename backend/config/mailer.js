// ══ ENVÍO DE CORREO ═════════════════════════════════
// El sistema ya leía correo por IMAP para bajar facturas; esto es lo contrario,
// mandarlo. Se apoya en la misma cuenta: las variables FAC_SMTP_* mandan, y si
// no están se cae a las de IMAP, que es el caso normal porque el servidor de
// correo atiende los dos protocolos.
//
// Regla de oro: un fallo al mandar el correo NUNCA debe tumbar la operación que
// lo disparó. Un pago que ya se hizo está hecho aunque el aviso no salga; por
// eso enviar() no lanza excepciones, devuelve el resultado y quien llama decide
// si lo deja asentado.
const nodemailer = require('nodemailer');

const HOST = process.env.FAC_SMTP_HOST || process.env.FAC_IMAP_HOST || 'mail.gmconsultoria.com.mx';
const USER = process.env.FAC_SMTP_USER || process.env.FAC_IMAP_USER;
const PASS = process.env.FAC_SMTP_PASS || process.env.FAC_IMAP_PASS;
// 465 habla TLS desde el saludo; 587 arranca en claro y sube con STARTTLS
const PORT = parseInt(process.env.FAC_SMTP_PORT) || 465;
const DE   = process.env.FAC_SMTP_DE || (USER ? `Grupo Management <${USER}>` : null);

let _transporte = null;
function transporte() {
  if (_transporte) return _transporte;
  if (!USER || !PASS) return null;
  _transporte = nodemailer.createTransport({
    host: HOST, port: PORT, secure: PORT === 465,
    auth: { user: USER, pass: PASS }
  });
  return _transporte;
}

function configurado() { return !!(USER && PASS); }

async function enviar({ para, asunto, html, texto }) {
  if (!para) return { ok: false, motivo: 'sin_destinatario' };

  const t = transporte();
  if (!t) {
    // Sin credenciales no es un error que haya que perseguir: es que todavía no
    // se configura el correo de salida. Se deja dicho y se sigue.
    console.warn(`✉ Correo no enviado a ${para} (SMTP sin configurar): ${asunto}`);
    return { ok: false, motivo: 'smtp_sin_configurar' };
  }

  try {
    await t.sendMail({ from: DE, to: para, subject: asunto, text: texto, html });
    return { ok: true };
  } catch (e) {
    console.warn(`✉ Falló el envío a ${para}: ${e.message}`);
    return { ok: false, motivo: e.message };
  }
}

// Plantilla sobria y sin imágenes: estos avisos se leen casi siempre desde el
// teléfono y muchos clientes bloquean lo remoto.
function plantilla({ titulo, saludo, cuerpo, datos = [], pie }) {
  const filas = datos
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k, v]) => `
      <tr>
        <td style="padding:7px 12px;border-bottom:1px solid #e9ecef;color:#6c757d;font-size:13px;white-space:nowrap">${k}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e9ecef;color:#212529;font-size:13px;font-weight:600">${v}</td>
      </tr>`).join('');

  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;
    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;
                border:1px solid #e4e6eb">
      <div style="background:linear-gradient(135deg,#064e3b,#047857);padding:18px 22px">
        <div style="color:#fff;font-size:17px;font-weight:800">${titulo}</div>
      </div>
      <div style="padding:20px 22px">
        <p style="margin:0 0 14px;font-size:14px;color:#212529">${saludo}</p>
        <p style="margin:0 0 16px;font-size:14px;color:#212529;line-height:1.5">${cuerpo}</p>
        ${filas ? `<table style="width:100%;border-collapse:collapse;border:1px solid #e9ecef;
                    border-radius:8px;overflow:hidden">${filas}</table>` : ''}
        ${pie ? `<p style="margin:16px 0 0;font-size:12px;color:#6c757d;line-height:1.5">${pie}</p>` : ''}
      </div>
      <div style="padding:12px 22px;background:#f8f9fa;border-top:1px solid #e9ecef;
                  font-size:11px;color:#adb5bd">
        Aviso automático del sistema de Facturación · Grupo Management. No respondas a este correo.
      </div>
    </div></body></html>`;
}

module.exports = { enviar, plantilla, configurado };
