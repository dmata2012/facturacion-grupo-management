import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { ETIQUETA_ROL } from '@/lib/permisos';
import { Boton, BotonEnlace, Tarjeta, TituloSeccion } from '@/componentes/ui';
import { guardarAlerta } from '../acciones';
import type { Rol, TipoAlerta } from '@prisma/client';

export const metadata = { title: 'Motor de alertas — CRM' };

const ROLES: Rol[] = ['VENDEDOR', 'ABOGADO', 'DIRECTOR', 'ASISTENTE', 'CONTADOR'];

const DESCRIPCION: Record<TipoAlerta, { titulo: string; texto: string; unidad: string }> = {
  CUOTA_POR_VENCER: {
    titulo: 'Cuota próxima a vencer',
    texto: 'Avisa antes de la fecha pactada de cada cuota del plan de pagos.',
    unidad: 'días antes del vencimiento',
  },
  CUOTA_VENCIDA: {
    titulo: 'Cuota vencida',
    texto: 'Avisa cuando pasó la fecha pactada y no hay pago registrado.',
    unidad: 'días después del vencimiento',
  },
  DOCUMENTO_POR_CADUCAR: {
    titulo: 'Documento por caducar',
    texto: 'Para pasaportes, visas y permisos con fecha de vigencia capturada.',
    unidad: 'días antes de la caducidad',
  },
  RESOLUCION_PROXIMA: {
    titulo: 'Resolución tentativa próxima',
    texto: 'Avisa antes de la fecha máxima de resolución que fijó el abogado.',
    unidad: 'días antes de la fecha',
  },
  PROXIMO_SEGUIMIENTO: {
    titulo: 'Seguimiento pactado',
    texto: 'El "llámenme en 15 días" que se registra al capturar una interacción.',
    unidad: 'días antes de la fecha',
  },
};

export default async function Alertas() {
  await exigir('configuracion');
  const alertas = await prisma.configAlerta.findMany({ orderBy: { tipo: 'asc' } });

  return (
    <>
      <TituloSeccion accion={<BotonEnlace href="/configuracion" estilo="suave">Volver</BotonEnlace>}>
        Motor de alertas
      </TituloSeccion>

      <div className="mb-5 max-w-3xl rounded-lg border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>Todavía no se envía nada.</strong> Esta configuración ya se guarda y es la que usará
        el motor, pero falta conectar el proveedor de WhatsApp y el de correo. Es lo siguiente que
        toca construir.
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {alertas.map((a) => {
          const info = DESCRIPCION[a.tipo];
          return (
            <Tarjeta key={a.id} className="p-5">
              <form action={guardarAlerta} className="space-y-4">
                <input type="hidden" name="id" value={a.id} />

                <div>
                  <h2 className="text-sm font-bold text-tinta">{info.titulo}</h2>
                  <p className="text-xs text-tenue">{info.texto}</p>
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="activa" defaultChecked={a.activa} />
                  Alerta activa
                </label>

                <label className="flex flex-wrap items-center gap-2 text-sm">
                  <input
                    type="number"
                    name="diasAnticipacion"
                    min="0"
                    max="365"
                    defaultValue={a.diasAnticipacion}
                    className="w-20 rounded-md border border-borde px-2 py-1"
                  />
                  <span className="text-suave">{info.unidad}</span>
                </label>

                <label className="block text-sm">
                  <span className="mb-1 block font-semibold">Canal</span>
                  <select
                    name="canal"
                    defaultValue={a.canal}
                    className="rounded-md border border-borde px-2 py-1"
                  >
                    <option value="WHATSAPP">WhatsApp</option>
                    <option value="CORREO">Correo</option>
                    <option value="AMBOS">Ambos</option>
                  </select>
                </label>

                <fieldset>
                  <legend className="mb-1 text-sm font-semibold">A quién se le avisa</legend>
                  <div className="flex flex-wrap gap-3">
                    {ROLES.map((rol) => (
                      <label key={rol} className="flex items-center gap-1.5 text-xs text-suave">
                        <input
                          type="checkbox"
                          name="destinatarios"
                          value={rol}
                          defaultChecked={a.destinatarios.includes(rol)}
                        />
                        {ETIQUETA_ROL[rol]}
                      </label>
                    ))}
                    <label className="flex items-center gap-1.5 text-xs text-suave">
                      <input type="checkbox" name="notificarCliente" defaultChecked={a.notificarCliente} />
                      También al cliente
                    </label>
                  </div>
                </fieldset>

                <Boton type="submit" estilo="suave" className="px-3 py-1.5 text-xs">
                  Guardar
                </Boton>
              </form>
            </Tarjeta>
          );
        })}
      </div>
    </>
  );
}
