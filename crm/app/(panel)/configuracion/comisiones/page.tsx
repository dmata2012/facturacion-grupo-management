import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { ETIQUETA_ROL } from '@/lib/permisos';
import { Aviso, Boton, BotonEnlace, Insignia, Tarjeta, TituloSeccion, claseInput } from '@/componentes/ui';
import { crearPlantillaComision, guardarPlantillaComision, marcarPredeterminada } from '../acciones';
import type { Rol } from '@prisma/client';

export const metadata = { title: 'Plantillas de comisión — CRM' };

const ROLES: Rol[] = ['VENDEDOR', 'ABOGADO', 'DIRECTOR', 'ASISTENTE', 'CONTADOR'];

export default async function Comisiones({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  await exigir('configuracion');

  const plantillas = await prisma.plantillaComision.findMany({
    include: { items: true, _count: { select: { comisiones: true } } },
    orderBy: { nombre: 'asc' },
  });

  return (
    <>
      <TituloSeccion accion={<BotonEnlace href="/configuracion" estilo="suave">Volver</BotonEnlace>}>
        Plantillas de comisión
      </TituloSeccion>

      <div className="mb-5 max-w-3xl space-y-2 text-sm text-suave">
        <p>
          Cada porcentaje se calcula <strong>directo sobre el total de la venta</strong>. No es una
          bolsa que se reparta entre los participantes: si el vendedor tiene 10% y el operador 5%,
          cada quien recibe eso del total, y la suma no tiene por qué dar 100.
        </p>
        <p>
          Al guardar un cambio, la plantilla sube de versión. <strong>Las comisiones ya calculadas
          no se mueven</strong>: guardan su porcentaje, su monto y la versión con la que se
          calcularon.
        </p>
      </div>

      {error && (
        <Aviso>
          {error === 'duplicado' ? 'Ya existe una plantilla con ese nombre.' : 'Escribe un nombre.'}
        </Aviso>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {plantillas.map((p) => (
          <Tarjeta key={p.id} className="p-5">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-tinta">{p.nombre}</h2>
              <Insignia>v{p.version}</Insignia>
              {p.esPredeterminada && <Insignia tono="marca">Predeterminada</Insignia>}
              {p._count.comisiones > 0 && (
                <Insignia tono="info">{p._count.comisiones} comisiones calculadas</Insignia>
              )}
            </div>

            <form action={guardarPlantillaComision} className="space-y-2">
              <input type="hidden" name="id" value={p.id} />
              {ROLES.map((rol) => {
                const item = p.items.find((i) => i.rol === rol);
                return (
                  <label key={rol} className="flex items-center gap-3">
                    <span className="w-40 text-sm text-suave">{ETIQUETA_ROL[rol]}</span>
                    <input
                      type="number"
                      name={`porcentaje-${rol}`}
                      min="0"
                      max="100"
                      step="0.5"
                      defaultValue={item ? Number(item.porcentaje) : 0}
                      className="w-24 rounded-md border border-borde px-2 py-1 text-sm"
                    />
                    <span className="text-sm text-tenue">%</span>
                  </label>
                );
              })}
              <div className="flex flex-wrap gap-2 pt-3">
                <Boton type="submit" estilo="suave" className="px-3 py-1.5 text-xs">
                  Guardar cambios
                </Boton>
                {!p.esPredeterminada && (
                  <Boton
                    type="submit"
                    formAction={marcarPredeterminada}
                    estilo="suave"
                    className="px-3 py-1.5 text-xs"
                  >
                    Usar como predeterminada
                  </Boton>
                )}
              </div>
            </form>
            <p className="mt-3 text-xs text-tenue">
              Un porcentaje en cero significa que ese rol no participa en el reparto.
            </p>
          </Tarjeta>
        ))}
      </div>

      <Tarjeta className="mt-6 p-5">
        <form action={crearPlantillaComision} className="flex flex-wrap items-end gap-3">
          <label className="min-w-56 flex-1">
            <span className="mb-1.5 block text-sm font-semibold">Nueva plantilla</span>
            <input name="nombre" required className={claseInput} placeholder="Casos referidos" />
          </label>
          <Boton type="submit">Crear</Boton>
        </form>
        <p className="mt-2 text-xs text-tenue">
          Útil cuando cierto tipo de casos reparte distinto. Al cerrar una venta se elige cuál
          aplicar.
        </p>
      </Tarjeta>
    </>
  );
}
