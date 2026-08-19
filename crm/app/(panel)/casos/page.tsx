import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroCasos } from '@/lib/permisos';
import { fecha, pesos } from '@/lib/formato';
import { Insignia, Tarjeta, TituloSeccion, Vacio } from '@/componentes/ui';

export const metadata = { title: 'Casos legales — CRM' };

export default async function Casos() {
  const sesion = await exigir('casos');

  const casos = await prisma.caso.findMany({
    where: filtroCasos(sesion),
    include: {
      etapaActual: true,
      abogado: true,
      tipoTramite: true,
      venta: { include: { cliente: true } },
      documentos: true,
    },
    orderBy: { creadoEn: 'desc' },
  });

  return (
    <>
      <TituloSeccion etiqueta="Legal">Casos legales</TituloSeccion>

      {!casos.length ? (
        <Vacio>
          Todavía no hay expedientes. Se abren solos cuando una venta se cierra como ganada.
        </Vacio>
      ) : (
        <Tarjeta className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-borde bg-slate-50 text-left text-xs uppercase tracking-wide text-tenue">
              <tr>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Trámite</th>
                <th className="px-4 py-3">Etapa</th>
                <th className="px-4 py-3">Abogado</th>
                <th className="px-4 py-3">Dependencia</th>
                <th className="px-4 py-3">Documentos</th>
                <th className="px-4 py-3">Presentado</th>
                <th className="px-4 py-3">Monto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-borde">
              {casos.map((c) => {
                const entregados = c.documentos.filter((d) => d.estatus === 'ENTREGADO').length;
                return (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link href={`/casos/${c.id}`} className="font-semibold text-tinta hover:text-marca">
                        {c.venta.cliente.nombre}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-suave">{c.tipoTramite.nombre}</td>
                    <td className="px-4 py-3">
                      <Insignia tono="info">{c.etapaActual?.nombre ?? 'Sin etapa'}</Insignia>
                    </td>
                    <td className="px-4 py-3 text-suave">{c.abogado?.nombre ?? 'Sin asignar'}</td>
                    <td className="px-4 py-3 text-suave">{c.dependencia ?? '—'}</td>
                    <td className="px-4 py-3 text-suave">
                      {entregados}/{c.documentos.length}
                    </td>
                    <td className="px-4 py-3 text-suave">{fecha(c.fechaPresentacion)}</td>
                    <td className="px-4 py-3">{pesos(c.venta.montoTotal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Tarjeta>
      )}
    </>
  );
}
