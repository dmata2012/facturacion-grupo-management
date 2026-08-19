import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { ETIQUETA_ROL } from '@/lib/permisos';
import { Insignia, Tarjeta, TituloSeccion } from '@/componentes/ui';

export const metadata = { title: 'Configuración — CRM' };

export default async function Configuracion() {
  await exigir('configuracion');

  const [tramites, origenes, motivos, plantillas, alertas, usuarios] = await Promise.all([
    prisma.tipoTramite.findMany({
      include: { etapas: { orderBy: { orden: 'asc' } }, documentos: { orderBy: { orden: 'asc' } } },
      orderBy: { nombre: 'asc' },
    }),
    prisma.origenProspecto.findMany({ orderBy: { nombre: 'asc' } }),
    prisma.motivoPerdida.findMany({ orderBy: { nombre: 'asc' } }),
    prisma.plantillaComision.findMany({ include: { items: true }, orderBy: { nombre: 'asc' } }),
    prisma.configAlerta.findMany({ orderBy: { tipo: 'asc' } }),
    prisma.usuario.findMany({ orderBy: { nombre: 'asc' } }),
  ]);

  return (
    <>
      <TituloSeccion>Configuración</TituloSeccion>
      <p className="mb-6 text-sm text-suave">
        Estos catálogos ya gobiernan el sistema: las plantillas de trámite generan el checklist de
        cada expediente y la plantilla de comisiones se aplica al cerrar una venta. Por ahora se
        consultan aquí y se editan desde la base; la pantalla de edición es la siguiente entrega.
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <Tarjeta className="p-6 lg:col-span-2">
          <h2 className="mb-4 text-sm font-bold text-tinta">Tipos de trámite y sus plantillas</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {tramites.map((t) => (
              <div key={t.id} className="rounded-lg border border-borde p-4">
                <p className="text-sm font-bold text-tinta">{t.nombre}</p>
                <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-tenue">
                  Etapas ({t.etapas.length})
                </p>
                <p className="text-xs text-suave">{t.etapas.map((e) => e.nombre).join(' → ')}</p>
                <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-tenue">
                  Documentos ({t.documentos.length})
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-suave">
                  {t.documentos.map((d) => (
                    <li key={d.id}>
                      {d.nombre}
                      {d.requiereVigencia && <span className="text-amber-600"> · con vigencia</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Tarjeta>

        <Tarjeta className="p-6">
          <h2 className="mb-3 text-sm font-bold text-tinta">Plantillas de comisión</h2>
          {plantillas.map((p) => (
            <div key={p.id} className="mb-3">
              <p className="text-sm font-semibold">
                {p.nombre} <span className="text-xs text-tenue">v{p.version}</span>
                {p.esPredeterminada && <span className="ml-2"><Insignia tono="marca">Predeterminada</Insignia></span>}
              </p>
              <p className="text-xs text-suave">
                {p.items.map((i) => `${ETIQUETA_ROL[i.rol]} ${Number(i.porcentaje)}%`).join(' · ')}
              </p>
            </div>
          ))}
          <p className="mt-3 text-xs text-tenue">
            Cada porcentaje se aplica directo sobre el total de la venta; no se reparten entre sí.
          </p>
        </Tarjeta>

        <Tarjeta className="p-6">
          <h2 className="mb-3 text-sm font-bold text-tinta">Motor de alertas</h2>
          <ul className="space-y-2 text-sm">
            {alertas.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <span className="text-suave">{a.tipo.replaceAll('_', ' ').toLowerCase()}</span>
                <Insignia>{a.diasAnticipacion} días antes</Insignia>
                <Insignia tono="info">{a.canal.toLowerCase()}</Insignia>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-tenue">
            La configuración ya está guardada; el envío por WhatsApp y correo es la fase 2.
          </p>
        </Tarjeta>

        <Tarjeta className="p-6">
          <h2 className="mb-3 text-sm font-bold text-tinta">Catálogos</h2>
          <p className="text-xs font-semibold uppercase tracking-wide text-tenue">Origen del prospecto</p>
          <p className="mb-3 text-sm text-suave">{origenes.map((o) => o.nombre).join(', ')}</p>
          <p className="text-xs font-semibold uppercase tracking-wide text-tenue">Motivos de pérdida</p>
          <p className="text-sm text-suave">{motivos.map((m) => m.nombre).join(', ')}</p>
        </Tarjeta>

        <Tarjeta className="p-6">
          <h2 className="mb-3 text-sm font-bold text-tinta">Usuarios</h2>
          <ul className="space-y-2 text-sm">
            {usuarios.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3">
                <span>
                  <span className="font-semibold">{u.nombre}</span>
                  <span className="block text-xs text-tenue">{u.correo}</span>
                </span>
                <Insignia tono={u.activo ? 'neutro' : 'alerta'}>{ETIQUETA_ROL[u.rol]}</Insignia>
              </li>
            ))}
          </ul>
        </Tarjeta>
      </div>
    </>
  );
}
