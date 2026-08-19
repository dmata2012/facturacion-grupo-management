import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroClientes } from '@/lib/permisos';
import { fecha } from '@/lib/formato';
import { BotonEnlace, Insignia, Tarjeta, TituloSeccion, Vacio } from '@/componentes/ui';

export const metadata = { title: 'Clientes — CRM' };

export default async function Clientes({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const sesion = await exigir('clientes');

  const clientes = await prisma.cliente.findMany({
    where: {
      AND: [
        filtroClientes(sesion),
        q ? { nombre: { contains: q, mode: 'insensitive' } } : {},
      ],
    },
    include: {
      ventas: { include: { tipoTramite: true, caso: { include: { etapaActual: true } } }, orderBy: { creadoEn: 'desc' }, take: 1 },
      leads: { include: { tipoTramite: true }, orderBy: { creadoEn: 'desc' }, take: 1 },
    },
    orderBy: { creadoEn: 'desc' },
    take: 200,
  });

  return (
    <>
      <TituloSeccion etiqueta="Cartera" accion={<BotonEnlace href="/clientes/nuevo">Nuevo cliente</BotonEnlace>}>
        Clientes
      </TituloSeccion>

      <form className="mb-5">
        <input
          name="q"
          defaultValue={q ?? ''}
          placeholder="Buscar por nombre…"
          className="w-full max-w-sm rounded-lg border border-borde bg-white px-3 py-2 text-sm"
        />
      </form>

      {!clientes.length ? (
        <Vacio>No hay clientes que coincidan.</Vacio>
      ) : (
        <Tarjeta className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-borde bg-slate-50 text-left text-xs uppercase tracking-wide text-tenue">
              <tr>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Nacionalidad</th>
                <th className="px-4 py-3">Ubicación</th>
                <th className="px-4 py-3">Trámite</th>
                <th className="px-4 py-3">Etapa del caso</th>
                <th className="px-4 py-3">Alta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-borde">
              {clientes.map((c) => {
                const venta = c.ventas[0];
                const tramite = venta?.tipoTramite.nombre ?? c.leads[0]?.tipoTramite.nombre;
                return (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link href={`/clientes/${c.id}`} className="font-semibold text-tinta hover:text-marca">
                        {c.nombre}
                      </Link>
                      {c.archivado && <span className="ml-2"><Insignia tono="alerta">Archivado</Insignia></span>}
                    </td>
                    <td className="px-4 py-3 text-suave">{c.nacionalidad}</td>
                    <td className="px-4 py-3 text-suave">{c.ciudad}, {c.estado}</td>
                    <td className="px-4 py-3 text-suave">{tramite ?? '—'}</td>
                    <td className="px-4 py-3">
                      {venta?.caso?.etapaActual ? (
                        <Insignia tono="info">{venta.caso.etapaActual.nombre}</Insignia>
                      ) : (
                        <span className="text-tenue">Sin expediente</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-suave">{fecha(c.creadoEn)}</td>
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
