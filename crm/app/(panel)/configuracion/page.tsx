import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { Tarjeta, TituloSeccion } from '@/componentes/ui';

export const metadata = { title: 'Configuración — CRM' };

export default async function Configuracion() {
  await exigir('configuracion');

  const [tramites, origenes, motivos, plantillas, alertas, usuarios] = await Promise.all([
    prisma.tipoTramite.count(),
    prisma.origenProspecto.count({ where: { activo: true } }),
    prisma.motivoPerdida.count({ where: { activo: true } }),
    prisma.plantillaComision.count({ where: { activa: true } }),
    prisma.configAlerta.count({ where: { activa: true } }),
    prisma.usuario.count({ where: { activo: true } }),
  ]);

  const secciones = [
    {
      href: '/configuracion/tramites',
      titulo: 'Tipos de trámite',
      detalle: `${tramites} configurados`,
      texto:
        'Las etapas del expediente y el checklist de documentos de cada trámite. De aquí sale lo que se exige en cada caso nuevo.',
    },
    {
      href: '/configuracion/catalogos',
      titulo: 'Catálogos',
      detalle: `${origenes} orígenes · ${motivos} motivos de pérdida`,
      texto: 'Las opciones que aparecen al capturar un cliente y al cerrar una venta como perdida.',
    },
    {
      href: '/configuracion/comisiones',
      titulo: 'Plantillas de comisión',
      detalle: `${plantillas} activas`,
      texto:
        'El reparto que se aplica al cerrar una venta. Cambiarlo no altera las comisiones ya calculadas.',
    },
    {
      href: '/configuracion/alertas',
      titulo: 'Motor de alertas',
      detalle: `${alertas} activas`,
      texto: 'Con cuántos días de anticipación avisa cada recordatorio y a quién se le notifica.',
    },
    {
      href: '/configuracion/usuarios',
      titulo: 'Usuarios y permisos',
      detalle: `${usuarios} activos`,
      texto: 'Quién entra al sistema, con qué rol, y qué ve cada quien.',
    },
  ];

  return (
    <>
      <TituloSeccion>Configuración</TituloSeccion>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {secciones.map((s) => (
          <Link key={s.href} href={s.href} className="block">
            <Tarjeta className="h-full p-6 transition hover:border-marca hover:shadow-md">
              <h2 className="text-base font-bold text-tinta">{s.titulo}</h2>
              <p className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-marca">
                {s.detalle}
              </p>
              <p className="mt-3 text-sm text-suave">{s.texto}</p>
            </Tarjeta>
          </Link>
        ))}
      </div>
    </>
  );
}
