'use client';

import { useRef, useTransition } from 'react';

/**
 * Casilla de un renglón del checklist. Guarda sola al marcarla: obligar a
 * pulsar "Guardar" por cada documento haría tedioso lo que en la práctica es
 * ir palomeando una lista con el cliente enfrente.
 */
export function CasillaEntrega({
  documentoId,
  entregado,
  nombre,
  accion,
}: {
  documentoId: string;
  entregado: boolean;
  nombre: string;
  accion: (datos: FormData) => Promise<void>;
}) {
  const formulario = useRef<HTMLFormElement>(null);
  const [guardando, empezar] = useTransition();

  return (
    <form
      ref={formulario}
      action={(datos) => empezar(() => accion(datos).then(() => {}))}
      className="flex items-center"
    >
      <input type="hidden" name="documentoId" value={documentoId} />
      <label
        className={`flex cursor-pointer items-center gap-2.5 ${guardando ? 'opacity-50' : ''}`}
      >
        <input
          type="checkbox"
          name="entregado"
          defaultChecked={entregado}
          disabled={guardando}
          onChange={() => formulario.current?.requestSubmit()}
          aria-label={`Marcar ${nombre} como entregado`}
          className="h-5 w-5 shrink-0 cursor-pointer rounded border-borde text-marca focus:ring-marca"
        />
        <span
          className={`text-sm font-semibold ${entregado ? 'text-tenue line-through' : 'text-tinta'}`}
        >
          {nombre}
        </span>
      </label>
    </form>
  );
}

/** Barra de avance del checklist: cuántos documentos van de cuántos. */
export function AvanceChecklist({ entregados, total }: { entregados: number; total: number }) {
  const porcentaje = total ? Math.round((entregados / total) * 100) : 0;
  const completo = total > 0 && entregados === total;

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-tinta">
          {entregados} de {total} documentos entregados
        </span>
        <span className={`text-xs font-bold ${completo ? 'text-green-700' : 'text-tenue'}`}>
          {completo ? 'Expediente completo' : `${porcentaje}%`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-borde">
        <div
          className={`h-full rounded-full transition-all duration-300 ${completo ? 'bg-green-500' : 'grad-marca'}`}
          style={{ width: `${porcentaje}%` }}
        />
      </div>
    </div>
  );
}
