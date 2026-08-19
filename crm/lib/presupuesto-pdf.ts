import path from 'node:path';
import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import type { Prisma } from '@prisma/client';
import { fecha, pesos } from '@/lib/formato';

/** Presupuesto con todo lo que el documento necesita mostrar. */
export type PresupuestoCompleto = Prisma.PresupuestoGetPayload<{
  include: {
    conceptos: true;
    pagos: true;
    creadoPor: true;
    venta: { include: { cliente: true; tipoTramite: true; vendedor: true } };
  };
}>;

/**
 * Arma el PDF del presupuesto en memoria.
 *
 * Vive aparte de la ruta que lo descarga porque el mismo documento se adjunta
 * al correo que se le manda al cliente: si cada uno lo dibujara por su cuenta,
 * tarde o temprano dirían cosas distintas.
 */
export async function generarPdfPresupuesto(presupuesto: PresupuestoCompleto): Promise<Buffer> {
  const { venta } = presupuesto;
  const total = presupuesto.conceptos.reduce((t, c) => t + Number(c.monto), 0);

  const doc = new PDFDocument({ size: 'LETTER', margin: 56 });
  const partes: Buffer[] = [];
  doc.on('data', (parte: Buffer) => partes.push(parte));
  const terminado = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(partes)));
  });

  const AZUL = '#0b1f3a';
  const TURQUESA = '#0e7490';
  const GRIS = '#4a5a72';
  const ancho = doc.page.width - 112;

  // ── Encabezado ──
  const logo = path.join(process.cwd(), 'public', 'logo.png');
  if (existsSync(logo)) doc.image(logo, 56, 46, { height: 34 });

  doc.fillColor(AZUL).fontSize(18).font('Helvetica-Bold')
    .text('PRESUPUESTO', 56, 92);
  doc.fillColor(TURQUESA).fontSize(11).font('Helvetica-Bold')
    .text(presupuesto.folio, 56, 114);

  doc.fillColor(GRIS).fontSize(9).font('Helvetica')
    .text(`Fecha de emisión: ${fecha(presupuesto.creadoEn)}`, 300, 94, { width: ancho - 244, align: 'right' })
    .text(
      presupuesto.validoHasta ? `Válido hasta: ${fecha(presupuesto.validoHasta)}` : 'Sin fecha de vigencia',
      300, 108, { width: ancho - 244, align: 'right' }
    );

  doc.moveTo(56, 138).lineTo(doc.page.width - 56, 138).strokeColor('#dfe6ef').stroke();

  // ── Datos del cliente y del trámite ──
  let y = 156;
  const dato = (titulo: string, valor: string, x: number, anchoCol: number) => {
    doc.fillColor('#7d8ca3').fontSize(7.5).font('Helvetica-Bold').text(titulo.toUpperCase(), x, y);
    doc.fillColor(AZUL).fontSize(10.5).font('Helvetica').text(valor, x, y + 12, { width: anchoCol });
  };

  dato('Cliente', venta.cliente.nombre, 56, 240);
  dato('Trámite solicitado', venta.tipoTramite.nombre, 320, 200);
  y += 40;
  dato('Nacionalidad', venta.cliente.nacionalidad, 56, 240);
  dato('Atiende', venta.vendedor.nombre, 320, 200);
  y += 40;
  dato('Ubicación', `${venta.cliente.ciudad}, ${venta.cliente.estado}`, 56, 240);
  dato('Contacto', venta.cliente.telefono || venta.cliente.correo || '—', 320, 200);
  y += 46;

  // ── Conceptos ──
  doc.fillColor(AZUL).fontSize(11).font('Helvetica-Bold').text('Conceptos', 56, y);
  y += 20;
  doc.rect(56, y - 4, ancho, 20).fill('#f4f7fb');
  doc.fillColor('#7d8ca3').fontSize(8).font('Helvetica-Bold')
    .text('DESCRIPCIÓN', 64, y + 2)
    .text('IMPORTE', 56, y + 2, { width: ancho - 16, align: 'right' });
  y += 24;

  for (const concepto of presupuesto.conceptos) {
    doc.fillColor(AZUL).fontSize(10).font('Helvetica')
      .text(concepto.descripcion, 64, y, { width: ancho - 140 });
    doc.text(pesos(concepto.monto, true), 56, y, { width: ancho - 16, align: 'right' });
    y += Math.max(18, doc.heightOfString(concepto.descripcion, { width: ancho - 140 }) + 6);
  }

  doc.moveTo(56, y + 2).lineTo(doc.page.width - 56, y + 2).strokeColor(AZUL).lineWidth(1.2).stroke();
  y += 10;
  doc.fillColor(AZUL).fontSize(12).font('Helvetica-Bold')
    .text('TOTAL', 64, y)
    .text(pesos(total), 56, y, { width: ancho - 16, align: 'right' });
  y += 34;

  // ── Pagos ──
  doc.fillColor(AZUL).fontSize(11).font('Helvetica-Bold').text('Pagos acordados', 56, y);
  y += 20;
  doc.rect(56, y - 4, ancho, 20).fill('#f4f7fb');
  doc.fillColor('#7d8ca3').fontSize(8).font('Helvetica-Bold')
    .text('PAGO', 64, y + 2)
    .text('FECHA', 250, y + 2)
    .text('IMPORTE', 56, y + 2, { width: ancho - 16, align: 'right' });
  y += 24;

  for (const pago of presupuesto.pagos) {
    const nombre = pago.numero === 1 ? 'Inicial' : `Pago ${pago.numero}`;
    doc.fillColor(AZUL).fontSize(10).font('Helvetica')
      .text(pago.descripcion ? `${nombre} — ${pago.descripcion}` : nombre, 64, y, { width: 180 })
      .text(fecha(pago.fechaPropuesta), 250, y)
      .text(pesos(pago.monto, true), 56, y, { width: ancho - 16, align: 'right' });
    y += 18;
  }
  y += 16;

  // ── Condiciones ──
  if (presupuesto.condiciones) {
    if (y > doc.page.height - 200) { doc.addPage(); y = 56; }
    doc.fillColor(AZUL).fontSize(11).font('Helvetica-Bold').text('Condiciones', 56, y);
    y += 16;
    doc.fillColor(GRIS).fontSize(9.5).font('Helvetica')
      .text(presupuesto.condiciones.replace(/\r/g, ''), 56, y, { width: ancho, align: 'justify' });
    y = doc.y + 24;
  }

  // ── Aceptación ──
  if (y > doc.page.height - 130) { doc.addPage(); y = 56; }
  doc.fillColor('#7d8ca3').fontSize(8.5).font('Helvetica')
    .text(
      'La aprobación de este presupuesto autoriza al despacho a iniciar el trámite y obliga al pago conforme al calendario anterior.',
      56, y, { width: ancho }
    );
  y += 42;
  doc.moveTo(56, y).lineTo(276, y).strokeColor('#dfe6ef').lineWidth(1).stroke();
  doc.moveTo(320, y).lineTo(540, y).stroke();
  doc.fillColor(GRIS).fontSize(8.5)
    .text('Nombre y firma del cliente', 56, y + 6, { width: 220, align: 'center' })
    .text('Por el despacho', 320, y + 6, { width: 220, align: 'center' });

  doc.end();
  return terminado;
}
