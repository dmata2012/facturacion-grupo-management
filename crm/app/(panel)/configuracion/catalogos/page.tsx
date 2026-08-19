import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { Aviso, Boton, BotonEnlace, Insignia, Tarjeta, TituloSeccion, claseInput } from '@/componentes/ui';
import {
  alternarMetodoPago, alternarMotivo, alternarOrigen, crearMetodoPago, crearMotivo, crearOrigen,
} from '../acciones';

export const metadata = { title: 'Catálogos — CRM' };

export default async function Catalogos({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  await exigir('configuracion');

  const [origenes, motivos, metodos] = await Promise.all([
    prisma.origenProspecto.findMany({
      include: { _count: { select: { clientes: true } } },
      orderBy: { nombre: 'asc' },
    }),
    prisma.motivoPerdida.findMany({
      include: { _count: { select: { ventas: true } } },
      orderBy: { nombre: 'asc' },
    }),
    prisma.metodoPago.findMany({
      include: { _count: { select: { cuotas: true } } },
      orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
    }),
  ]);

  return (
    <>
      <TituloSeccion accion={<BotonEnlace href="/configuracion" estilo="suave">Volver</BotonEnlace>}>
        Catálogos
      </TituloSeccion>

      {error && (
        <Aviso>
          {error === 'duplicado' ? 'Ya existe una opción con ese nombre.' : 'Escribe un nombre.'}
        </Aviso>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Tarjeta className="p-5 lg:col-span-2">
          <h2 className="text-sm font-bold text-tinta">Medios de pago</h2>
          <p className="mb-4 text-xs text-tenue">
            Las formas en que el despacho cobra. De aquí sale el reporte de cobros por medio de
            pago; por eso es catálogo y no texto libre.
          </p>

          <ul className="mb-4 grid gap-x-8 divide-y divide-borde sm:grid-cols-2 sm:divide-y-0">
            {metodos.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 border-b border-borde py-2.5">
                <span className="text-sm">
                  {m.nombre}
                  <span className="ml-2 text-xs text-tenue">
                    {m._count.cuotas} {m._count.cuotas === 1 ? 'pago' : 'pagos'}
                  </span>
                </span>
                <div className="flex items-center gap-2">
                  <Insignia tono={m.activo ? 'exito' : 'neutro'}>
                    {m.activo ? 'Activo' : 'Inactivo'}
                  </Insignia>
                  <form action={alternarMetodoPago}>
                    <input type="hidden" name="id" value={m.id} />
                    <Boton type="submit" estilo="suave" className="px-2 py-1 text-xs">
                      {m.activo ? 'Desactivar' : 'Activar'}
                    </Boton>
                  </form>
                </div>
              </li>
            ))}
          </ul>

          <form action={crearMetodoPago} className="flex flex-wrap items-end gap-2 border-t border-borde pt-4">
            <input name="nombre" required placeholder="Nuevo medio de pago" className={`${claseInput} min-w-40 flex-1`} />
            <Boton type="submit" className="px-3 py-2 text-sm">Agregar</Boton>
          </form>
        </Tarjeta>

        <Tarjeta className="p-5">
          <h2 className="text-sm font-bold text-tinta">Origen del prospecto</h2>
          <p className="mb-4 text-xs text-tenue">
            Las opciones que aparecen al capturar un cliente. De aquí sale el reporte de por dónde
            llega el trabajo.
          </p>

          <ul className="mb-4 divide-y divide-borde">
            {origenes.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="text-sm">
                  {o.nombre}
                  <span className="ml-2 text-xs text-tenue">{o._count.clientes} clientes</span>
                </span>
                <div className="flex items-center gap-2">
                  <Insignia tono={o.activo ? 'exito' : 'neutro'}>
                    {o.activo ? 'Activo' : 'Inactivo'}
                  </Insignia>
                  <form action={alternarOrigen}>
                    <input type="hidden" name="id" value={o.id} />
                    <Boton type="submit" estilo="suave" className="px-2 py-1 text-xs">
                      {o.activo ? 'Desactivar' : 'Activar'}
                    </Boton>
                  </form>
                </div>
              </li>
            ))}
          </ul>

          <form action={crearOrigen} className="flex flex-wrap items-end gap-2 border-t border-borde pt-4">
            <input name="nombre" required placeholder="Nuevo origen" className={`${claseInput} min-w-40 flex-1`} />
            <Boton type="submit" className="px-3 py-2 text-sm">Agregar</Boton>
          </form>
          <p className="mt-2 text-xs text-tenue">
            Las opciones no se borran, se desactivan: los clientes capturados con ellas conservan su
            origen.
          </p>
        </Tarjeta>

        <Tarjeta className="p-5">
          <h2 className="text-sm font-bold text-tinta">Motivos de pérdida</h2>
          <p className="mb-4 text-xs text-tenue">
            Obligatorios al cerrar una venta como perdida. Son la materia prima del reporte de por
            qué se pierden los prospectos.
          </p>

          <ul className="mb-4 divide-y divide-borde">
            {motivos.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="text-sm">
                  {m.nombre}
                  <span className="ml-2 text-xs text-tenue">{m._count.ventas} ventas</span>
                </span>
                <div className="flex items-center gap-2">
                  <Insignia tono={m.activo ? 'exito' : 'neutro'}>
                    {m.activo ? 'Activo' : 'Inactivo'}
                  </Insignia>
                  <form action={alternarMotivo}>
                    <input type="hidden" name="id" value={m.id} />
                    <Boton type="submit" estilo="suave" className="px-2 py-1 text-xs">
                      {m.activo ? 'Desactivar' : 'Activar'}
                    </Boton>
                  </form>
                </div>
              </li>
            ))}
          </ul>

          <form action={crearMotivo} className="flex flex-wrap items-end gap-2 border-t border-borde pt-4">
            <input name="nombre" required placeholder="Nuevo motivo" className={`${claseInput} min-w-40 flex-1`} />
            <Boton type="submit" className="px-3 py-2 text-sm">Agregar</Boton>
          </form>
        </Tarjeta>
      </div>
    </>
  );
}
