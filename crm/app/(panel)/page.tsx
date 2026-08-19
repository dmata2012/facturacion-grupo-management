import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { sesionActual } from '@/lib/sesion';
import { filtroCasos, filtroComisiones, filtroVentas, modulosVisibles, puede } from '@/lib/permisos';
import { resumenCobranza } from '@/lib/cuotas';
import { pesos } from '@/lib/formato';
import { Kpi, Tarjeta, TituloSeccion, Vacio } from '@/componentes/ui';

export const metadata = { title: 'Reportes — CRM' };

type Periodo = 'semana' | 'mes' | 'anio';

/** "CERRADO_GANADO" → "Cerrado ganado": legible sin deformar el resto. */
function nombreEtapa(etapa: string): string {
  const texto = etapa.replaceAll('_', ' ').toLowerCase();
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Inicio del periodo elegido. Los KPIs de flujo se miden contra esta fecha;
 *  los de saldo (casos activos, cartera) son foto del momento. */
function desde(periodo: Periodo): Date {
  const hoy = new Date();
  if (periodo === 'semana') {
    const d = new Date(hoy);
    d.setDate(hoy.getDate() - 7);
    return d;
  }
  if (periodo === 'anio') return new Date(hoy.getFullYear(), 0, 1);
  return new Date(hoy.getFullYear(), hoy.getMonth(), 1);
}

export default async function Reportes({
  searchParams,
}: {
  searchParams: Promise<{ periodo?: Periodo }>;
}) {
  const { periodo = 'mes' } = await searchParams;
  const sesion = await sesionActual();

  // Reportes es la pantalla de entrada, pero no todos los roles la tienen.
  // En vez de recibirlos con un "sin acceso", se les manda a su primer módulo.
  if (!puede(sesion.rol, 'reportes')) {
    const primero = modulosVisibles(sesion.rol).find((m) => m.href !== '/');
    redirect(primero?.href ?? '/sin-permiso');
  }

  const inicio = desde(periodo);

  const [ventasPeriodo, casos, cuotas, comisiones, porNacionalidad, embudo] = await Promise.all([
    prisma.venta.findMany({
      where: { AND: [filtroVentas(sesion), { etapa: 'CERRADO_GANADO', fechaCierre: { gte: inicio } }] },
      include: { vendedor: true },
    }),
    prisma.caso.findMany({ where: filtroCasos(sesion), include: { etapaActual: true } }),
    prisma.cuota.findMany({ where: { venta: filtroVentas(sesion) } }),
    prisma.comision.findMany({ where: filtroComisiones(sesion) }),
    prisma.cliente.groupBy({ by: ['nacionalidad'], _count: true, orderBy: { _count: { nacionalidad: 'desc' } }, take: 8 }),
    prisma.venta.groupBy({ by: ['etapa'], _count: true, where: filtroVentas(sesion) }),
  ]);

  const totalVendido = ventasPeriodo.reduce((t, v) => t + Number(v.montoTotal), 0);
  const cobranza = resumenCobranza(cuotas);
  const cobradoPeriodo = cuotas
    .filter((c) => c.pagadoEn && c.pagadoEn >= inicio)
    .reduce((t, c) => t + Number(c.monto), 0);

  const comisionesPendientes = comisiones
    .filter((c) => c.estatus === 'PENDIENTE')
    .reduce((t, c) => t + Number(c.montoCalculado), 0);
  const comisionesPagadas = comisiones
    .filter((c) => c.estatus === 'PAGADA')
    .reduce((t, c) => t + Number(c.montoCalculado), 0);

  const casosActivos = casos.filter((c) => c.etapaActual?.nombre !== 'Cerrado').length;

  const porEtapa = new Map<string, number>();
  for (const c of casos) {
    const nombre = c.etapaActual?.nombre ?? 'Sin etapa';
    porEtapa.set(nombre, (porEtapa.get(nombre) ?? 0) + 1);
  }

  const porVendedor = new Map<string, { monto: number; casos: number }>();
  for (const v of ventasPeriodo) {
    const actual = porVendedor.get(v.vendedor.nombre) ?? { monto: 0, casos: 0 };
    porVendedor.set(v.vendedor.nombre, {
      monto: actual.monto + Number(v.montoTotal),
      casos: actual.casos + 1,
    });
  }

  const periodos: { clave: Periodo; nombre: string }[] = [
    { clave: 'semana', nombre: 'Semana' },
    { clave: 'mes', nombre: 'Mes' },
    { clave: 'anio', nombre: 'Año' },
  ];

  return (
    <>
      <TituloSeccion
        accion={
          <div className="flex gap-1 rounded-lg bg-white p-1 ring-1 ring-borde">
            {periodos.map((p) => (
              <Link
                key={p.clave}
                href={`/?periodo=${p.clave}`}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold transition ${
                  periodo === p.clave ? 'bg-tinta text-white' : 'text-suave hover:text-tinta'
                }`}
              >
                {p.nombre}
              </Link>
            ))}
          </div>
        }
        etiqueta="Dirección"
      >
        Reportes
      </TituloSeccion>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi etiqueta="Ventas del periodo" valor={pesos(totalVendido)} detalle={`${ventasPeriodo.length} casos cerrados`} tono="marca" />
        <Kpi etiqueta="Casos activos" valor={String(casosActivos)} detalle="Dato actual, no del periodo" />
        <Kpi etiqueta="Cuentas por cobrar" valor={pesos(cobranza.total - cobranza.pagado)} />
        <Kpi etiqueta="Cobrado en el periodo" valor={pesos(cobradoPeriodo)} tono="exito" />
        <Kpi etiqueta="Cartera vencida" valor={pesos(cobranza.vencido)} tono="alerta" />
        <Kpi etiqueta="Por vencer" valor={pesos(cobranza.porVencer)} tono="aviso" />
        {puede(sesion.rol, 'comisiones', 'ver') && (
          <>
            <Kpi etiqueta="Comisiones pendientes" valor={pesos(comisionesPendientes)} tono="aviso" />
            <Kpi etiqueta="Comisiones pagadas" valor={pesos(comisionesPagadas)} tono="exito" />
          </>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel titulo="Casos por etapa legal">
          <Barras datos={[...porEtapa.entries()].map(([nombre, valor]) => ({ nombre, valor }))} />
        </Panel>

        <Panel titulo="Embudo comercial">
          <Barras
            datos={embudo.map((e) => ({ nombre: nombreEtapa(e.etapa), valor: e._count }))}
          />
        </Panel>

        <Panel titulo="Clientes por nacionalidad">
          <Barras datos={porNacionalidad.map((n) => ({ nombre: n.nacionalidad, valor: n._count }))} />
        </Panel>

        <Panel titulo="Ventas por vendedor (periodo)">
          {!porVendedor.size ? (
            <Vacio>Sin ventas cerradas en el periodo.</Vacio>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-borde">
                {[...porVendedor.entries()].map(([nombre, d]) => (
                  <tr key={nombre}>
                    <td className="py-2 font-semibold">{nombre}</td>
                    <td className="py-2 text-right text-suave">{d.casos} casos</td>
                    <td className="py-2 text-right font-semibold">{pesos(d.monto)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}

function Panel({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <Tarjeta className="p-6">
      <h2 className="mb-4 text-sm font-bold text-tinta">{titulo}</h2>
      {children}
    </Tarjeta>
  );
}

/** Barras en CSS: sin librería de gráficas, se imprimen y se leen igual. */
function Barras({ datos }: { datos: { nombre: string; valor: number }[] }) {
  if (!datos.length) return <Vacio>Sin datos todavía.</Vacio>;
  const max = Math.max(...datos.map((d) => d.valor), 1);

  return (
    <ul className="space-y-2.5">
      {datos.map((d) => (
        <li key={d.nombre}>
          <div className="mb-1 flex justify-between text-xs">
            <span className="text-suave">{d.nombre}</span>
            <span className="font-semibold text-tinta">{d.valor}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-marca"
              style={{ width: `${(d.valor / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
