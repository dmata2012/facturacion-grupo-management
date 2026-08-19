import Link from 'next/link';
import { EtapaComercial } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroVentas } from '@/lib/permisos';
import { pesos } from '@/lib/formato';
import { Avatar, BotonEnlace, Insignia, Tarjeta, TituloSeccion, Vacio } from '@/componentes/ui';
import { moverVenta } from './acciones';

export const metadata = { title: 'Pipeline de ventas — CRM' };

/**
 * El embudo empieza antes de la venta: las dos primeras columnas son
 * contactos iniciales que todavía no pasan la entrevista de valoración, y por
 * eso viven en Lead y no en Venta. Recién calificados se convierten en venta.
 */
const ETAPAS_VENTA: { clave: EtapaComercial; nombre: string }[] = [
  { clave: 'PROSPECTO_CALIFICADO', nombre: 'Prospecto calificado' },
  { clave: 'CONTACTADO', nombre: 'Contactado' },
  { clave: 'CONSULTA_AGENDADA', nombre: 'Consulta agendada' },
  { clave: 'PROPUESTA_ENVIADA', nombre: 'Propuesta enviada' },
  { clave: 'NEGOCIACION', nombre: 'Negociación' },
  { clave: 'CERRADO_GANADO', nombre: 'Cerrado ganado' },
  { clave: 'CERRADO_PERDIDO', nombre: 'Cerrado perdido' },
];

export default async function Pipeline() {
  const sesion = await exigir('ventas');

  const [leads, ventas] = await Promise.all([
    prisma.lead.findMany({
      where: {
        venta: null,
        cliente: { archivado: false },
        ...(sesion.rol === 'VENDEDOR' ? { vendedorId: sesion.id } : {}),
      },
      include: { cliente: true, tipoTramite: true, vendedor: true },
      orderBy: { fechaPrimerContacto: 'desc' },
    }),
    prisma.venta.findMany({
      where: filtroVentas(sesion),
      include: { cliente: true, tipoTramite: true, vendedor: true, motivoPerdida: true },
      orderBy: { actualizadoEn: 'desc' },
    }),
  ]);

  const sinEntrevista = leads.filter((l) => !l.resultadoEntrevista);
  const enValoracion = leads.filter((l) => l.resultadoEntrevista === 'REQUIERE_INFO');

  return (
    <>
      <TituloSeccion etiqueta="Comercial" accion={<BotonEnlace href="/clientes/nuevo">Nuevo cliente</BotonEnlace>}>
        Pipeline de ventas
      </TituloSeccion>

      <div className="flex gap-4 overflow-x-auto pb-4">
        <Columna nombre="Contacto inicial" cantidad={sinEntrevista.length}>
          {sinEntrevista.map((l) => (
            <TarjetaLead key={l.id} lead={l} />
          ))}
          {!sinEntrevista.length && <SinTarjetas />}
        </Columna>

        <Columna nombre="Entrevista de valoración" cantidad={enValoracion.length}>
          {enValoracion.map((l) => (
            <TarjetaLead key={l.id} lead={l} />
          ))}
          {!enValoracion.length && <SinTarjetas />}
        </Columna>

        {ETAPAS_VENTA.map((etapa) => {
          const delEtapa = ventas.filter((v) => v.etapa === etapa.clave);
          return (
            <Columna key={etapa.clave} nombre={etapa.nombre} cantidad={delEtapa.length}>
              {delEtapa.map((v) => (
                <Tarjeta key={v.id} className="p-3">
                  <div className="flex items-start gap-2.5">
                    <Avatar nombre={v.cliente.nombre} fotoUrl={v.cliente.fotoUrl} />
                    <div className="min-w-0">
                      <Link
                        href={`/clientes/${v.clienteId}`}
                        className="block truncate text-sm font-semibold text-tinta hover:text-marca"
                      >
                        {v.cliente.nombre}
                      </Link>
                      <p className="mt-0.5 text-xs text-suave">
                        {v.cliente.nacionalidad} · {v.tipoTramite.nombre}
                      </p>
                      <p className="mt-0.5 text-xs text-tenue">Vendedor: {v.vendedor.nombre}</p>
                    </div>
                  </div>
                  <p className="mt-2 text-sm font-bold text-tinta">{pesos(v.montoTotal)}</p>

                  {v.motivoPerdida && (
                    <p className="mt-2">
                      <Insignia tono="alerta">{v.motivoPerdida.nombre}</Insignia>
                    </p>
                  )}

                  {v.etapa !== 'CERRADO_GANADO' && v.etapa !== 'CERRADO_PERDIDO' && (
                    <Link
                      href={`/presupuestos/nuevo?venta=${v.id}`}
                      className="mt-3 block rounded-sm border border-borde px-2 py-1.5 text-center text-xs font-semibold text-tinta transition hover:border-marca hover:text-marca"
                    >
                      Hacer presupuesto
                    </Link>
                  )}

                  {v.etapa !== 'CERRADO_GANADO' && v.etapa !== 'CERRADO_PERDIDO' && (
                    <form action={moverVenta} className="mt-2 flex gap-1">
                      <input type="hidden" name="ventaId" value={v.id} />
                      <select
                        name="etapa"
                        defaultValue={v.etapa}
                        className="min-w-0 flex-1 rounded-md border border-borde px-2 py-1 text-xs"
                        aria-label={`Mover ${v.cliente.nombre} de etapa`}
                      >
                        {ETAPAS_VENTA.map((e) => (
                          <option key={e.clave} value={e.clave}>
                            {e.nombre}
                          </option>
                        ))}
                      </select>
                      <button className="rounded-md bg-tinta px-2 py-1 text-xs font-semibold text-white">
                        Mover
                      </button>
                    </form>
                  )}
                </Tarjeta>
              ))}
              {!delEtapa.length && <SinTarjetas />}
            </Columna>
          );
        })}
      </div>
    </>
  );
}

function Columna({
  nombre,
  cantidad,
  children,
}: {
  nombre: string;
  cantidad: number;
  children: React.ReactNode;
}) {
  return (
    <section className="w-64 shrink-0">
      <header className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-xs font-bold uppercase tracking-wide text-suave">{nombre}</h2>
        <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-tenue ring-1 ring-borde">
          {cantidad}
        </span>
      </header>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function SinTarjetas() {
  return (
    <p className="rounded-lg border border-dashed border-borde px-3 py-6 text-center text-xs text-tenue">
      Sin registros
    </p>
  );
}

function TarjetaLead({
  lead,
}: {
  lead: {
    id: string;
    clienteId: string;
    cliente: { nombre: string; nacionalidad: string; fotoUrl: string | null };
    tipoTramite: { nombre: string };
    vendedor: { nombre: string };
    resultadoEntrevista: string | null;
  };
}) {
  return (
    <Tarjeta className="p-3">
      <div className="flex items-start gap-2.5">
        <Avatar nombre={lead.cliente.nombre} fotoUrl={lead.cliente.fotoUrl} />
        <div className="min-w-0">
          <Link
            href={`/clientes/${lead.clienteId}`}
            className="block truncate text-sm font-semibold text-tinta hover:text-marca"
          >
            {lead.cliente.nombre}
          </Link>
          <p className="mt-0.5 text-xs text-suave">
            {lead.cliente.nacionalidad} · {lead.tipoTramite.nombre}
          </p>
          <p className="mt-0.5 text-xs text-tenue">Vendedor: {lead.vendedor.nombre}</p>
        </div>
      </div>
      {lead.resultadoEntrevista === 'REQUIERE_INFO' && (
        <p className="mt-2">
          <Insignia tono="aviso">Requiere más información</Insignia>
        </p>
      )}
      <Link
        href={`/pipeline/lead/${lead.id}/entrevista`}
        className="mt-3 block rounded-md bg-tinta px-2 py-1.5 text-center text-xs font-semibold text-white"
      >
        Registrar entrevista
      </Link>
    </Tarjeta>
  );
}
