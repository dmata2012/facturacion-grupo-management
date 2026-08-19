import nodemailer from 'nodemailer';

/**
 * Envío de correo del despacho.
 *
 * Los datos del servidor viven en variables de entorno, no en el código: se
 * capturan en Render y no viajan al repositorio. Mientras no estén, el sistema
 * no falla ni finge que envió: dice que falta configurarlo.
 */

export type ResultadoCorreo = { enviado: true } | { enviado: false; motivo: string };

const VARIABLES = ['SMTP_HOST', 'SMTP_USUARIO', 'SMTP_CLAVE', 'CORREO_REMITENTE'] as const;

/** Qué falta por configurar. Vacío significa que el correo está listo. */
export function faltaConfigurar(): string[] {
  return VARIABLES.filter((v) => !process.env[v]);
}

export function correoConfigurado(): boolean {
  return faltaConfigurar().length === 0;
}

/** Dirección del remitente, tal como la verá el cliente. */
export function remitente(): string {
  const nombre = process.env.CORREO_NOMBRE || 'Grupo Management';
  return `"${nombre}" <${process.env.CORREO_REMITENTE}>`;
}

function transporte() {
  const puerto = Number(process.env.SMTP_PUERTO || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: puerto,
    // El puerto 465 usa TLS desde el saludo inicial; el 587 lo negocia después.
    secure: process.env.SMTP_SEGURO ? process.env.SMTP_SEGURO === 'true' : puerto === 465,
    auth: { user: process.env.SMTP_USUARIO, pass: process.env.SMTP_CLAVE },
  });
}

export async function enviarCorreo(mensaje: {
  para: string;
  asunto: string;
  texto: string;
  html?: string;
  adjuntos?: { nombre: string; contenido: Buffer; tipo: string }[];
  responderA?: string | null;
}): Promise<ResultadoCorreo> {
  const faltantes = faltaConfigurar();
  if (faltantes.length) {
    return { enviado: false, motivo: `Falta configurar el correo: ${faltantes.join(', ')}.` };
  }

  try {
    await transporte().sendMail({
      from: remitente(),
      to: mensaje.para,
      // Las respuestas del cliente llegan a quien lo atiende, no al buzón
      // genérico del sistema.
      replyTo: mensaje.responderA || undefined,
      subject: mensaje.asunto,
      text: mensaje.texto,
      html: mensaje.html,
      attachments: mensaje.adjuntos?.map((a) => ({
        filename: a.nombre,
        content: a.contenido,
        contentType: a.tipo,
      })),
    });
    return { enviado: true };
  } catch (e) {
    // El motivo se le muestra a quien pulsó el botón: casi siempre es una
    // credencial mal capturada o un puerto bloqueado, y sin el mensaje real
    // no hay forma de saber cuál de los dos.
    return { enviado: false, motivo: e instanceof Error ? e.message : 'Error desconocido al enviar.' };
  }
}
