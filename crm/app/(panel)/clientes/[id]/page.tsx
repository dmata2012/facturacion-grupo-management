import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroClientes, filtroComisiones, puede } from '@/lib/permisos';
import { ETIQUETA_CUOTA, estatusCuota, resumenCobranza } from '@/lib/cuotas';
import { fecha, fechaHora, paraInput, pesos } from '@/lib/formato';
import {
  Boton, BotonEnlace, Campo, Dato, Insignia, Tarjeta, TituloSeccion, Vacio, claseInput,
  type Tono,
} from '@/componentes/ui';
import { guardarObservaciones, nuevaInteraccion } from '../acciones';
import { subirDocumento } from '../../casos/acciones';
import { pagarComision, registrarPago } from '../../cobros/acciones';

type Pestana = 'general' | 'documentos' | 'pagos' | 'comisiones' | 'notas';

const PESTANAS: { clave: Pestana; nombre: string }[] = [
  { clave: 'general', nombre: 'Información general' },
  { clave: 'documentos', nombre: 'Documentos' },
  { clave: 'pagos', nombre: 'Plan de pagos' },
  { clave: 'comisiones', nombre: 'Comisiones' },
  { clave: 'notas', nombre: 'Notas e interacciones' },
];

const TONO_CUOTA: Record<string, Tono> = {
  PAGADO: 'exito',
  VENCIDO: 'alerta',
  POR_VENCER: 'aviso',
  AL_CORRIENTE: 'neutro',
};

export default async function FichaCliente({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pestana?: Pestana }>;
}) {
  const { id } = await params;
  const { pestana = 'general' } = await searchParams;
  const sesion = await exigir('clientes');

  const cliente = await prisma.cliente.findFirst({
    where: { AND: [{ id }, filtroClientes(sesion)] },
    include: {
      origenProspecto: true,
      leads: { include: { tipoTramite: true, vendedor: true }, orderBy: { creadoEn: 'desc' } },
      ventas: {
        orderBy: { creadoEn: 'desc' },
        include: {
          tipoTramite: true,
          vendedor: true,
          motivoPerdida: true,
          cuotas: { orderBy: { numero: 'asc' } },
          comisiones: { include: { participante: true }, orderBy: { rol: 'asc' } },
          caso: {
            include: {
              etapaActual: true,
              abogado: true,
              documentos: { include: { plantilla: true }, orderBy: { nombre: 'asc' } },
            },
          },
        },
      },
      interacciones: { include: { usuario: true }, orderBy: { fecha: 'desc' }, take: 50 },
      seguimientos: { where: { estatus: 'PENDIENTE' }, orderBy: { fecha: 'asc' } },
    },
  });
  if (!cliente) notFound();

  const ventaActiva = cliente.ventas[0] ?? null;
  const caso = ventaActiva?.caso ?? null;
  const cuotas = ventaActiva?.cuotas ?? [];
  const resumen = resumenCobranza(cuotas);

  // Un vendedor no debe ver el reparto de sus compañeros: se filtra igual que
  // en el módulo de comisiones, aunque aquí sea "su" cliente.
  const filtroCom = filtroComisiones(sesion);
  const comisiones = (ventaActiva?.comisiones ?? []).filter(
    (c) => !filtroCom.participanteId || c.participanteId === sesion.id
  );

  const pestanasVisibles = PESTANAS.filter((p) => {
    if (p.clave === 'comisiones') return puede(sesion.rol, 'comisiones', 'ver');
    if (p.clave === 'pagos') return puede(sesion.rol, 'cobros', 'ver') || puede(sesion.rol, 'ventas', 'ver');
    if (p.clave === 'notas') return puede(sesion.rol, 'notas', 'ver');
    if (p.clave === 'documentos') return puede(sesion.rol, 'documentos', 'ver') || puede(sesion.rol, 'casos', 'ver');
    return true;
  });

  return (
    <>
      <TituloSeccion
        etiqueta="Cartera"
        accion={
          <div className="flex flex-wrap gap-2">
            {caso && (
              <BotonEnlace href={`/casos/${caso.id}`} estilo="suave">
                Ver expediente legal
              </BotonEnlace>
            )}
            {puede(sesion.rol, 'clientes', 'editar') && (
              <BotonEnlace href={`/clientes/${cliente.id}/editar`}>Editar datos</BotonEnlace>
            )}
          </div>
        }
      >
        {cliente.nombre}
      </TituloSeccion>

      <div className="mb-5 flex flex-wrap items-center gap-2 text-sm text-suave">
        <Insignia tono="marca">{cliente.nacionalidad}</Insignia>
        <span>{cliente.ciudad}, {cliente.estado}</span>
        {ventaActiva && <span>· {ventaActiva.tipoTramite.nombre}</span>}
        {cliente.archivado && <Insignia tono="alerta">Archivado</Insignia>}
      </div>

      {cliente.observacionesGenerales && (
        <div className="mb-5 rounded-lg border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong className="font-semibold">Observaciones: </strong>
          {cliente.observacionesGenerales}
        </div>
      )}

      <nav className="mb-5 flex flex-wrap gap-1 border-b border-borde">
        {pestanasVisibles.map((p) => (
          <Link
            key={p.clave}
            href={`/clientes/${cliente.id}?pestana=${p.clave}`}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition ${
              pestana === p.clave
                ? 'border-marca text-marca'
                : 'border-transparent text-suave hover:text-tinta'
            }`}
          >
            {p.nombre}
          </Link>
        ))}
      </nav>

      {/* ── Información general ── */}
      {pestana === 'general' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Tarjeta className="p-6">
            <h2 className="mb-4 text-sm font-bold text-tinta">Datos generales</h2>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Dato etiqueta="Nacionalidad" valor={cliente.nacionalidad} />
              <Dato etiqueta="Ubicación del cliente" valor={`${cliente.ciudad}, ${cliente.estado}`} />
              <Dato etiqueta="Correo" valor={cliente.correo} />
              <Dato etiqueta="Teléfono / WhatsApp" valor={cliente.telefono} />
              <Dato etiqueta="Origen del prospecto" valor={cliente.origenProspecto?.nombre} />
              <Dato etiqueta="Alta en el sistema" valor={fecha(cliente.creadoEn)} />
              <Dato etiqueta="Cierre de venta" valor={fecha(ventaActiva?.fechaCierre)} />
              <Dato etiqueta="Vendedor" valor={ventaActiva?.vendedor.nombre ?? cliente.leads[0]?.vendedor.nombre} />
            </dl>
            {cliente.fotoUrl && (
              <Image
                src={cliente.fotoUrl}
                alt={`Fotografía de ${cliente.nombre}`}
                width={128}
                height={128}
                unoptimized
                className="mt-5 h-32 w-32 rounded-tarjeta border border-borde object-cover"
              />
            )}
          </Tarjeta>

          <Tarjeta className="p-6">
            <h2 className="mb-1 text-sm font-bold text-tinta">Observaciones generales</h2>
            <p className="mb-4 text-xs text-tenue">
              Nota fija de la ficha. El historial de contactos va en la pestaña de notas.
            </p>
            <form action={guardarObservaciones} className="space-y-3">
              <input type="hidden" name="clienteId" value={cliente.id} />
              <textarea
                name="observaciones"
                rows={4}
                defaultValue={cliente.observacionesGenerales ?? ''}
                className={claseInput}
              />
              <Boton type="submit" estilo="suave">Guardar</Boton>
            </form>

            {cliente.leads[0]?.notasEntrevista && (
              <div className="mt-6 border-t border-borde pt-4">
                <h3 className="text-xs font-bold uppercase tracking-wide text-tenue">
                  Entrevista de valoración
                </h3>
                <p className="mt-1 text-sm text-suave">{cliente.leads[0].notasEntrevista}</p>
              </div>
            )}
          </Tarjeta>
        </div>
      )}

      {/* ── Documentos ── */}
      {pestana === 'documentos' && (
        <Tarjeta className="p-6">
          {!caso ? (
            <Vacio>
              El checklist de documentos se genera cuando la venta se cierra como ganada y se abre el
              expediente.
            </Vacio>
          ) : (
            <ul className="divide-y divide-borde">
              {caso.documentos.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-56 flex-1">
                    <p className="text-sm font-semibold text-tinta">{d.nombre}</p>
                    {d.fechaSubida && (
                      <p className="text-xs text-tenue">
                        Subido el {fecha(d.fechaSubida)}
                        {d.fechaVigencia && ` · vigente hasta ${fecha(d.fechaVigencia)}`}
                      </p>
                    )}
                  </div>
                  <Insignia tono={d.estatus === 'ENTREGADO' ? 'exito' : 'neutro'}>
                    {d.estatus === 'ENTREGADO' ? 'Entregado' : 'Pendiente'}
                  </Insignia>
                  {d.archivoUrl && (
                    <a href={d.archivoUrl} target="_blank" className="text-sm font-semibold text-marca hover:underline">
                      Ver archivo
                    </a>
                  )}
                  <form action={subirDocumento} className="flex items-center gap-2">
                    <input type="hidden" name="documentoId" value={d.id} />
                    <input
                      type="file"
                      name="archivo"
                      required
                      aria-label={`Subir ${d.nombre}`}
                      className="max-w-44 text-xs file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs file:font-semibold"
                    />
                    {d.plantilla?.requiereVigencia && (
                      <input
                        type="date"
                        name="fechaVigencia"
                        aria-label={`Vigencia de ${d.nombre}`}
                        defaultValue={paraInput(d.fechaVigencia)}
                        className="rounded border border-borde px-2 py-1 text-xs"
                      />
                    )}
                    <Boton type="submit" estilo="suave" className="px-3 py-1 text-xs">
                      Subir
                    </Boton>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Tarjeta>
      )}

      {/* ── Plan de pagos ── */}
      {pestana === 'pagos' && (
        <div className="space-y-5">
          {!cuotas.length ? (
            <Vacio>El plan de pagos se captura al cerrar la venta como ganada.</Vacio>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-4">
                <ResumenMonto etiqueta="Total del plan" valor={resumen.total} />
                <ResumenMonto etiqueta="Cobrado" valor={resumen.pagado} tono="exito" />
                <ResumenMonto etiqueta="Vencido" valor={resumen.vencido} tono="alerta" />
                <ResumenMonto etiqueta="Por vencer" valor={resumen.porVencer} tono="aviso" />
              </div>

              <Tarjeta className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="border-b border-borde bg-lienzo text-left text-xs uppercase tracking-wide text-tenue">
                    <tr>
                      <th className="px-4 py-3">Cuota</th>
                      <th className="px-4 py-3">Fecha pactada</th>
                      <th className="px-4 py-3">Monto</th>
                      <th className="px-4 py-3">Estatus</th>
                      <th className="px-4 py-3">Pago</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-borde">
                    {cuotas.map((c) => {
                      const estatus = estatusCuota(c);
                      return (
                        <tr key={c.id}>
                          <td className="px-4 py-3 font-semibold">
                            {c.esInicial ? 'Inicial' : `Cuota ${c.numero}`}
                          </td>
                          <td className="px-4 py-3">{fecha(c.fechaPactada)}</td>
                          <td className="px-4 py-3">{pesos(c.monto, true)}</td>
                          <td className="px-4 py-3">
                            <Insignia tono={TONO_CUOTA[estatus]}>{ETIQUETA_CUOTA[estatus]}</Insignia>
                          </td>
                          <td className="px-4 py-3">
                            {c.pagadoEn ? (
                              <span className="text-xs text-suave">
                                {fecha(c.pagadoEn)} {c.metodoPago && `· ${c.metodoPago}`}
                              </span>
                            ) : puede(sesion.rol, 'cobros', 'editar') ? (
                              <form action={registrarPago} className="flex items-center gap-2">
                                <input type="hidden" name="cuotaId" value={c.id} />
                                <input
                                  type="date"
                                  name="fechaPago"
                                  defaultValue={paraInput(new Date())}
                                  aria-label="Fecha de pago"
                                  className="rounded border border-borde px-2 py-1 text-xs"
                                />
                                <input
                                  name="metodoPago"
                                  placeholder="Método"
                                  aria-label="Método de pago"
                                  className="w-24 rounded border border-borde px-2 py-1 text-xs"
                                />
                                <Boton type="submit" estilo="suave" className="px-3 py-1 text-xs">
                                  Registrar
                                </Boton>
                              </form>
                            ) : (
                              <span className="text-xs text-tenue">Sin registrar</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Tarjeta>
            </>
          )}
        </div>
      )}

      {/* ── Comisiones ── */}
      {pestana === 'comisiones' && (
        <Tarjeta className="overflow-x-auto">
          {!comisiones.length ? (
            <div className="p-6">
              <Vacio>
                Las comisiones se generan al cerrar la venta, con la plantilla de reparto elegida.
              </Vacio>
            </div>
          ) : (
            <>
              <p className="border-b border-borde px-4 py-3 text-xs text-tenue">
                Cada participante cobra su porcentaje directo sobre el total de la venta
                ({pesos(ventaActiva!.montoTotal)}). No es una bolsa que se reparta entre todos.
              </p>
              <table className="w-full min-w-[560px] text-sm">
                <thead className="border-b border-borde bg-lienzo text-left text-xs uppercase tracking-wide text-tenue">
                  <tr>
                    <th className="px-4 py-3">Participante</th>
                    <th className="px-4 py-3">Rol</th>
                    <th className="px-4 py-3">%</th>
                    <th className="px-4 py-3">Monto</th>
                    <th className="px-4 py-3">Estatus</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-borde">
                  {comisiones.map((c) => (
                    <tr key={c.id}>
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
            </>
          )}
        </Tarjeta>
      )}

      {/* ── Notas e interacciones ── */}
      {pestana === 'notas' && (
        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <Tarjeta className="h-fit p-6">
            <h2 className="mb-4 text-sm font-bold text-tinta">Registrar contacto</h2>
            <form action={nuevaInteraccion} className="space-y-4">
              <input type="hidden" name="clienteId" value={cliente.id} />
              <Campo etiqueta="Medio" requerido>
                <select name="medio" required className={claseInput} defaultValue="LLAMADA">
                  <option value="LLAMADA">Llamada</option>
                  <option value="WHATSAPP">WhatsApp</option>
                  <option value="CORREO">Correo</option>
                  <option value="PRESENCIAL">Presencial</option>
                </select>
              </Campo>
              <Campo etiqueta="Resultado / lo que indicó el cliente" requerido>
                <textarea name="resultado" rows={3} required className={claseInput} />
              </Campo>
              <div className="rounded-lg bg-lienzo p-3">
                <p className="mb-2 text-xs font-semibold text-suave">
                  Próximo seguimiento (opcional)
                </p>
                <div className="space-y-3">
                  <Campo etiqueta="Fecha">
                    <input type="date" name="fechaSeguimiento" className={claseInput} />
                  </Campo>
                  <Campo etiqueta="Motivo">
                    <input name="motivoSeguimiento" className={claseInput} placeholder="Volver a llamar" />
                  </Campo>
                </div>
                <p className="mt-2 text-xs text-tenue">
                  Si pones fecha, se agenda solo y avisa ese día.
                </p>
              </div>
              <Boton type="submit">Guardar</Boton>
            </form>
          </Tarjeta>

          <div className="space-y-4">
            {cliente.seguimientos.length > 0 && (
              <Tarjeta className="p-4">
                <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-tenue">
                  Seguimientos pendientes
                </h3>
                <ul className="space-y-1 text-sm">
                  {cliente.seguimientos.map((s) => (
                    <li key={s.id} className="flex gap-2">
                      <Insignia tono="aviso">{fecha(s.fecha)}</Insignia>
                      <span className="text-suave">{s.motivo}</span>
                    </li>
                  ))}
                </ul>
              </Tarjeta>
            )}

            <Tarjeta className="divide-y divide-borde">
              {!cliente.interacciones.length && (
                <p className="p-6 text-sm text-tenue">Todavía no hay contactos registrados.</p>
              )}
              {cliente.interacciones.map((i) => (
                <article key={i.id} className="p-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-tenue">
                    <Insignia>{i.medio.toLowerCase()}</Insignia>
                    <span>{fechaHora(i.fecha)}</span>
                    {i.usuario && <span>· {i.usuario.nombre}</span>}
                  </div>
                  <p className="mt-2 text-sm text-tinta">{i.resultado}</p>
                </article>
              ))}
            </Tarjeta>
          </div>
        </div>
      )}
    </>
  );
}

function ResumenMonto({ etiqueta, valor, tono }: { etiqueta: string; valor: number; tono?: Tono }) {
  const color =
    tono === 'exito' ? 'text-green-700' : tono === 'alerta' ? 'text-red-700' : tono === 'aviso' ? 'text-amber-600' : 'text-tinta';
  return (
    <Tarjeta className="p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-tenue">{etiqueta}</p>
      <p className={`mt-1 text-lg font-bold ${color}`}>{pesos(valor)}</p>
    </Tarjeta>
  );
}
