import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { fechaHora } from '@/lib/formato';
import { Insignia, Tarjeta, TituloSeccion, Vacio, type Tono } from '@/componentes/ui';

export const metadata = { title: 'Agenda — CRM' };

const ETIQUETA_TIPO: Record<string, { texto: string; tono: Tono }> = {
  CONSULTA_NUEVA: { texto: 'Consulta nueva', tono: 'marca' },
  ACTUALIZACION_CASO: { texto: 'Actualización de caso', tono: 'info' },
  SEGUIMIENTO_SALIENTE: { texto: 'Seguimiento saliente', tono: 'aviso' },
};

export default async function Agenda() {
  const sesion = await exigir('agenda');

  // Un vendedor ve su agenda; dirección y asistencia ven la de todos.
  const soloMias = sesion.rol === 'VENDEDOR' || sesion.rol === 'ABOGADO';

  const citas = await prisma.cita.findMany({
    where: soloMias ? { responsableId: sesion.id } : {},
    include: { cliente: true, responsable: true },
    orderBy: { inicio: 'asc' },
    take: 100,
  });

  // Agrupadas por día: es como el despacho revisa su semana.
  const porDia = new Map<string, typeof citas>();
  for (const c of citas) {
    const dia = c.inicio.toISOString().slice(0, 10);
    porDia.set(dia, [...(porDia.get(dia) ?? []), c]);
  }

  return (
    <>
      <TituloSeccion etiqueta="Seguimiento">Agenda</TituloSeccion>

      <p className="mb-5 text-sm text-suave">
        Se alimenta sola de los próximos seguimientos que registras en la ficha del cliente. Las
        vistas de día, semana y mes son la siguiente entrega.
      </p>

      {!porDia.size ? (
        <Vacio>
          No hay nada agendado. Al registrar un contacto en la ficha de un cliente y poner fecha de
          próximo seguimiento, la cita aparece aquí sola.
        </Vacio>
      ) : (
        <div className="space-y-5">
          {[...porDia.entries()].map(([dia, delDia]) => (
            <section key={dia}>
              <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-suave">
                {new Intl.DateTimeFormat('es-MX', {
                  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
                }).format(new Date(dia))}
              </h2>
              <Tarjeta className="divide-y divide-borde">
                {delDia.map((c) => {
                  const tipo = ETIQUETA_TIPO[c.tipo];
                  return (
                    <div key={c.id} className="flex flex-wrap items-center gap-3 p-4">
                      <span className="w-16 text-sm font-semibold text-tinta">
                        {new Intl.DateTimeFormat('es-MX', {
                          hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
                        }).format(c.inicio)}
                      </span>
                      <div className="min-w-48 flex-1">
                        {c.cliente ? (
                          <Link href={`/clientes/${c.clienteId}`} className="text-sm font-semibold hover:text-marca">
                            {c.cliente.nombre}
                          </Link>
                        ) : (
                          <span className="text-sm font-semibold">{c.titulo}</span>
                        )}
                        <p className="text-xs text-tenue">{fechaHora(c.inicio)}</p>
                      </div>
                      <Insignia tono={tipo.tono}>{tipo.texto}</Insignia>
                      <Insignia>{c.modalidad === 'EN_LINEA' ? 'En línea' : 'Presencial'}</Insignia>
                      <span className="text-xs text-suave">{c.responsable?.nombre}</span>
                    </div>
                  );
                })}
              </Tarjeta>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
