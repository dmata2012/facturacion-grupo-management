import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroComisiones, filtroVentas, puede } from '@/lib/permisos';
import { ETIQUETA_CUOTA, estatusCuota, resumenCobranza, type EstatusCuota } from '@/lib/cuotas';
import { fecha, paraInput, pesos } from '@/lib/formato';
import { Boton, Insignia, Kpi, Tarjeta, TituloSeccion, Vacio, type Tono } from '@/componentes/ui';
import { pagarComision, registrarPago } from './acciones';

export const metadata = { title: 'Cobros y comisiones — CRM' };

const TONO: Record<EstatusCuota, Tono> = {
  PAGADO: 'exito',
  VENCIDO: 'alerta',
  POR_VENCER: 'aviso',
  AL_CORRIENTE: 'neutro',
};

export default async function Cobros({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: EstatusCuota | 'TODAS' }>;
}) {
  const { filtro = 'TODAS' } = await searchParams;
  const sesion = await exigir('cobros');

  const [cuotas, comisiones, metodosPago] = await Promise.all([
    prisma.cuota.findMany({
      where: { venta: filtroVentas(sesion) },
      include: { venta: { include: { cliente: true } }, metodoPago: true },
      orderBy: { fechaPactada: 'asc' },
    }),
    prisma.comision.findMany({
      where: filtroComisiones(sesion),
      include: { participante: true, venta: { include: { cliente: true } } },
      orderBy: { estatus: 'asc' },
    }),
    prisma.metodoPago.findMany({
      where: { activo: true },
      orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
    }),
  ]);

  const resumen = resumenCobranza(cuotas);
  const visibles = filtro === 'TODAS' ? cuotas : cuotas.filter((c) => estatusCuota(c) === filtro);

  const comisionesPendientes = comisiones.filter((c) => c.estatus === 'PENDIENTE');
  const totalPendiente = comisionesPendientes.reduce((t, c) => t + Number(c.montoCalculado), 0);
  const totalPagadas = comisiones
    .filter((c) => c.estatus === 'PAGADA')
    .reduce((t, c) => t + Number(c.montoCalculado), 0);

  const filtros: (EstatusCuota | 'TODAS')[] = ['TODAS', 'VENCIDO', 'POR_VENCER', 'AL_CORRIENTE', 'PAGADO'];

  return (
    <>
      <TituloSeccion etiqueta="Cobranza">Cobros y comisiones</TituloSeccion>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi etiqueta="Por cobrar" valor={pesos(resumen.total - resumen.pagado)} />
        <Kpi etiqueta="Vencido" valor={pesos(resumen.vencido)} tono="alerta" />
        <Kpi etiqueta="Por vencer" valor={pesos(resumen.porVencer)} tono="aviso" />
        <Kpi etiqueta="Cobrado" valor={pesos(resumen.pagado)} tono="exito" />
      </div>

      <h2 className="mb-3 text-sm font-bold text-tinta">Plan de pagos de todos los casos</h2>
      <div className="mb-3 flex flex-wrap gap-2">
        {filtros.map((f) => (
          <Link
            key={f}
            href={`/cobros?filtro=${f}`}
            className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset transition ${
              filtro === f
                ? 'bg-tinta text-white ring-tinta'
                : 'bg-white text-suave ring-borde hover:text-tinta'
            }`}
          >
            {f === 'TODAS' ? 'Todas' : ETIQUETA_CUOTA[f]}
          </Link>
        ))}
      </div>

      {!visibles.length ? (
        <Vacio>No hay cuotas en este filtro.</Vacio>
      ) : (
        <Tarjeta className="mb-8 overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-borde bg-lienzo text-left text-xs uppercase tracking-wide text-tenue">
              <tr>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Cuota</th>
                <th className="px-4 py-3">Fecha pactada</th>
                <th className="px-4 py-3">Monto</th>
                <th className="px-4 py-3">Estatus</th>
                <th className="px-4 py-3">Medio</th>
                <th className="px-4 py-3">Pago</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-borde">
              {visibles.map((c) => {
                const estatus = estatusCuota(c);
                return (
                  <tr key={c.id} className="hover:bg-lienzo">
                    <td className="px-4 py-3">
                      <Link href={`/clientes/${c.venta.clienteId}?pestana=pagos`} className="font-semibold hover:text-marca">
                        {c.venta.cliente.nombre}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-suave">
                      {c.esInicial ? 'Inicial' : `Cuota ${c.numero}`}
                    </td>
                    <td className="px-4 py-3 text-suave">{fecha(c.fechaPactada)}</td>
                    <td className="px-4 py-3">{pesos(c.monto, true)}</td>
                    <td className="px-4 py-3">
                      <Insignia tono={TONO[estatus]}>{ETIQUETA_CUOTA[estatus]}</Insignia>
                    </td>
                    <td className="px-4 py-3 text-xs text-suave">{c.metodoPago?.nombre ?? '—'}</td>
                    <td className="px-4 py-3">
                      {c.pagadoEn ? (
                        <span className="text-xs text-suave">{fecha(c.pagadoEn)}</span>
                      ) : puede(sesion.rol, 'cobros', 'editar') ? (
                        <form action={registrarPago} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="cuotaId" value={c.id} />
                          <input
                            type="date"
                            name="fechaPago"
                            defaultValue={paraInput(new Date())}
                            aria-label="Fecha de pago"
                            className="rounded-sm border border-borde px-2 py-1 text-xs"
                          />
                          <select
                            name="metodoPagoId"
                            aria-label="Medio de pago"
                            defaultValue=""
                            className="rounded-sm border border-borde px-2 py-1 text-xs"
                          >
                            <option value="">Medio de pago…</option>
                            {metodosPago.map((m) => (
                              <option key={m.id} value={m.id}>{m.nombre}</option>
                            ))}
                          </select>
                          <Boton type="submit" estilo="suave" className="px-3 py-1 text-xs">
                            Registrar pago
                          </Boton>
                        </form>
                      ) : (
                        <span className="text-xs text-tenue">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Tarjeta>
      )}

      {puede(sesion.rol, 'comisiones', 'ver') && (
        <>
          <h2 className="mb-3 text-sm font-bold text-tinta">Comisiones</h2>
          <div className="mb-3 grid gap-4 sm:grid-cols-2">
            <Kpi etiqueta="Comisiones pendientes" valor={pesos(totalPendiente)} tono="aviso" />
            <Kpi etiqueta="Comisiones pagadas" valor={pesos(totalPagadas)} tono="exito" />
          </div>

          {!comisiones.length ? (
            <Vacio>Todavía no hay comisiones generadas.</Vacio>
          ) : (
            <Tarjeta className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b border-borde bg-lienzo text-left text-xs uppercase tracking-wide text-tenue">
                  <tr>
                    <th className="px-4 py-3">Cliente</th>
                    <th className="px-4 py-3">Participante</th>
                    <th className="px-4 py-3">Rol</th>
                    <th className="px-4 py-3">%</th>
                    <th className="px-4 py-3">Monto</th>
                    <th className="px-4 py-3">Estatus</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-borde">
                  {comisiones.map((c) => (
                    <tr key={c.id} className="hover:bg-lienzo">
                      <td className="px-4 py-3">{c.venta.cliente.nombre}</td>
                      <td className="px-4 py-3 font-semibold">{c.participante.nombre}</td>
                      <td className="px-4 py-3 text-suave">{c.rol.toLowerCase()}</td>
                      <td className="px-4 py-3">{Number(c.porcentaje)}%</td>
                      <td className="px-4 py-3">{pesos(c.montoCalculado, true)}</td>
                      <td className="px-4 py-3">
                        {c.estatus === 'PAGADA' ? (
                          <Insignia tono="exito">Pagada {fecha(c.fechaPago)}</Insignia>
                        ) : puede(sesion.rol, 'comisiones', 'editar') ? (
                          <form action={pagarComision}>
                            <input type="hidden" name="comisionId" value={c.id} />
                            <Boton type="submit" estilo="suave" className="px-3 py-1 text-xs">
                              Marcar pagada
                            </Boton>
                          </form>
                        ) : (
                          <Insignia tono="aviso">Pendiente</Insignia>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Tarjeta>
          )}
        </>
      )}
    </>
  );
}
