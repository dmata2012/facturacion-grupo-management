import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

/** Etapas por defecto del pipeline legal. La marcada presenta ante autoridad. */
const ETAPAS_BASE = [
  { nombre: 'Documentación inicial', esPresentacion: false },
  { nombre: 'Preparación de expediente', esPresentacion: false },
  { nombre: 'Presentado ante autoridad', esPresentacion: true },
  { nombre: 'En revisión', esPresentacion: false },
  { nombre: 'Entrevista / cita', esPresentacion: false },
  { nombre: 'Resolución', esPresentacion: false },
  { nombre: 'Trámite complementario', esPresentacion: false },
  { nombre: 'Cerrado', esPresentacion: false },
];

const DOCS_COMUNES = [
  { nombre: 'Pasaporte vigente', requiereVigencia: true },
  { nombre: 'Acta de nacimiento', requiereVigencia: false },
  { nombre: 'Comprobante de domicilio', requiereVigencia: false },
  { nombre: 'Fotografías tamaño infantil', requiereVigencia: false },
];

const TRAMITES: { nombre: string; documentos: { nombre: string; requiereVigencia: boolean }[] }[] = [
  {
    nombre: 'Visa de trabajo',
    documentos: [
      ...DOCS_COMUNES,
      { nombre: 'Oferta de empleo', requiereVigencia: false },
      { nombre: 'Constancia de situación fiscal del empleador', requiereVigencia: false },
      { nombre: 'Permiso de trabajo anterior', requiereVigencia: true },
    ],
  },
  {
    nombre: 'Residencia permanente',
    documentos: [
      ...DOCS_COMUNES,
      { nombre: 'Comprobante de solvencia económica', requiereVigencia: false },
      { nombre: 'Tarjeta de residente temporal', requiereVigencia: true },
    ],
  },
  {
    nombre: 'Ciudadanía',
    documentos: [
      ...DOCS_COMUNES,
      { nombre: 'Carta de naturalización', requiereVigencia: false },
      { nombre: 'Constancia de no antecedentes penales', requiereVigencia: true },
    ],
  },
  {
    nombre: 'Asilo',
    documentos: [
      ...DOCS_COMUNES,
      { nombre: 'Relato de hechos', requiereVigencia: false },
      { nombre: 'Pruebas documentales', requiereVigencia: false },
    ],
  },
  {
    nombre: 'Visa de inversionista',
    documentos: [
      ...DOCS_COMUNES,
      { nombre: 'Acta constitutiva de la empresa', requiereVigencia: false },
      { nombre: 'Estados financieros', requiereVigencia: false },
      { nombre: 'Comprobante de inversión', requiereVigencia: false },
    ],
  },
];

async function main() {
  console.log('Sembrando catálogos…');

  for (const nombre of ['Referido', 'Redes sociales', 'Página web', 'Publicidad', 'Otro']) {
    await prisma.origenProspecto.upsert({ where: { nombre }, update: {}, create: { nombre } });
  }

  for (const nombre of [
    'Precio',
    'No calificó',
    'Se fue con otro despacho',
    'No dio seguimiento',
    'Otro',
  ]) {
    await prisma.motivoPerdida.upsert({ where: { nombre }, update: {}, create: { nombre } });
  }

  for (const t of TRAMITES) {
    const tipo = await prisma.tipoTramite.upsert({
      where: { nombre: t.nombre },
      update: {},
      create: { nombre: t.nombre },
    });
    for (const [i, e] of ETAPAS_BASE.entries()) {
      await prisma.etapaPlantilla.upsert({
        where: { tipoTramiteId_orden: { tipoTramiteId: tipo.id, orden: i + 1 } },
        update: { nombre: e.nombre, esPresentacion: e.esPresentacion },
        create: { tipoTramiteId: tipo.id, nombre: e.nombre, orden: i + 1, esPresentacion: e.esPresentacion },
      });
    }
    for (const [i, d] of t.documentos.entries()) {
      await prisma.documentoPlantilla.upsert({
        where: { tipoTramiteId_nombre: { tipoTramiteId: tipo.id, nombre: d.nombre } },
        update: { orden: i + 1, requiereVigencia: d.requiereVigencia },
        create: { tipoTramiteId: tipo.id, nombre: d.nombre, orden: i + 1, requiereVigencia: d.requiereVigencia },
      });
    }
  }

  console.log('Sembrando plantilla de comisiones…');
  const plantilla = await prisma.plantillaComision.upsert({
    where: { nombre: 'Estándar' },
    update: {},
    create: { nombre: 'Estándar', esPredeterminada: true, version: 1 },
  });
  for (const item of [
    { rol: 'VENDEDOR' as const, porcentaje: 10 },
    { rol: 'ABOGADO' as const, porcentaje: 5 },
    { rol: 'DIRECTOR' as const, porcentaje: 3 },
  ]) {
    await prisma.plantillaComisionItem.upsert({
      where: { plantillaId_rol: { plantillaId: plantilla.id, rol: item.rol } },
      update: { porcentaje: new Prisma.Decimal(item.porcentaje) },
      create: { plantillaId: plantilla.id, rol: item.rol, porcentaje: new Prisma.Decimal(item.porcentaje) },
    });
  }

  console.log('Sembrando configuración de alertas…');
  const alertas = [
    { tipo: 'CUOTA_POR_VENCER' as const, dias: 5 },
    { tipo: 'CUOTA_VENCIDA' as const, dias: 0 },
    { tipo: 'DOCUMENTO_POR_CADUCAR' as const, dias: 30 },
    { tipo: 'RESOLUCION_PROXIMA' as const, dias: 15 },
    { tipo: 'PROXIMO_SEGUIMIENTO' as const, dias: 0 },
  ];
  for (const a of alertas) {
    await prisma.configAlerta.upsert({
      where: { tipo: a.tipo },
      update: {},
      create: { tipo: a.tipo, diasAnticipacion: a.dias, destinatarios: ['VENDEDOR', 'DIRECTOR'] },
    });
  }

  console.log('Sembrando usuarios de prueba…');
  // Contraseña única para todos en desarrollo. En producción se cambia al
  // primer ingreso: está anotado en el README.
  const hash = await bcrypt.hash('demo1234', 10);
  const usuarios = [
    { nombre: 'Dirección General', correo: 'director@despacho.mx', rol: 'DIRECTOR' as const },
    { nombre: 'Laura Vendedora', correo: 'vendedor@despacho.mx', rol: 'VENDEDOR' as const },
    { nombre: 'Lic. Ramírez', correo: 'abogado@despacho.mx', rol: 'ABOGADO' as const },
    { nombre: 'Contabilidad', correo: 'contador@despacho.mx', rol: 'CONTADOR' as const },
    { nombre: 'Recepción', correo: 'asistente@despacho.mx', rol: 'ASISTENTE' as const },
  ];
  for (const u of usuarios) {
    await prisma.usuario.upsert({
      where: { correo: u.correo },
      update: {},
      create: { ...u, passwordHash: hash },
    });
  }

  console.log('Listo.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
