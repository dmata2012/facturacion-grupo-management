'use client';

import { useMemo, useState } from 'react';
import { Avatar } from '@/componentes/avatar';

/* Captura de presupuesto.
   El descuadre entre lo cotizado y lo que se va a cobrar se ve mientras se
   captura, no al enviar: es el error que más caro sale y el que más veces se
   comete, porque los pagos se reparten a ojo. */

type Concepto = { id: number; descripcion: string; monto: string };
type Pago = { id: number; descripcion: string; fecha: string; monto: string };

const pesos = (n: number) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n);

const hoy = () => new Date().toISOString().slice(0, 10);
const enMeses = (meses: number) => {
  const d = new Date();
  d.setMonth(d.getMonth() + meses);
  return d.toISOString().slice(0, 10);
};

const enDias = (dias: number) => {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
};

let contador = 0;
const nuevoId = () => ++contador;

export function FormularioPresupuesto({
  cliente,
  tramite,
  vendedor,
  ventaId,
  accion,
}: {
  cliente: { nombre: string; nacionalidad: string; ciudad: string; estado: string; fotoUrl: string | null };
  tramite: string;
  vendedor: string;
  ventaId: string;
  accion: (datos: FormData) => Promise<void>;
}) {
  const [conceptos, setConceptos] = useState<Concepto[]>([
    { id: nuevoId(), descripcion: 'Honorarios profesionales', monto: '' },
  ]);
  const [pagos, setPagos] = useState<Pago[]>([
    { id: nuevoId(), descripcion: 'Anticipo a la firma', fecha: hoy(), monto: '' },
  ]);

  const total = useMemo(
    () => conceptos.reduce((t, c) => t + (Number(c.monto) || 0), 0),
    [conceptos]
  );
  const sumaPagos = useMemo(() => pagos.reduce((t, p) => t + (Number(p.monto) || 0), 0), [pagos]);
  const diferencia = total - sumaPagos;
  const cuadra = total > 0 && Math.abs(diferencia) <= 1;
  const listo = cuadra && conceptos.some((c) => c.descripcion.trim() && Number(c.monto) > 0);

  /** Reparte el total en N pagos mensuales, redondeando el ajuste en el primero. */
  function repartir(partes: number) {
    if (total <= 0) return;
    const base = Math.floor((total / partes) / 50) * 50;
    const primero = total - base * (partes - 1);
    setPagos(
      Array.from({ length: partes }, (_, i) => ({
        id: nuevoId(),
        descripcion: i === 0 ? 'Anticipo a la firma' : `Pago ${i + 1}`,
        fecha: i === 0 ? hoy() : enMeses(i),
        monto: String(i === 0 ? primero : base),
      }))
    );
  }

  const claseCampo =
    'w-full rounded-sm border border-borde bg-white px-3 py-2 text-sm transition ' +
    'focus:border-marca focus:outline-none focus:ring-2 focus:ring-marca/15';

  return (
    <form action={accion} className="grid gap-6 lg:grid-cols-[1fr_320px] lg:items-start">
      <input type="hidden" name="ventaId" value={ventaId} />

      <div className="space-y-5">
        {/* Contexto: para quién es y de qué trámite, siempre a la vista. */}
        <div className="flex flex-wrap items-center gap-4 rounded-tarjeta border border-borde bg-white p-5 shadow-suave">
          <Avatar nombre={cliente.nombre} fotoUrl={cliente.fotoUrl} tamano={52} />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-extrabold tracking-tight text-tinta">{cliente.nombre}</p>
            <p className="text-sm text-suave">
              {cliente.nacionalidad} · {cliente.ciudad}, {cliente.estado}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-bold uppercase tracking-wider text-tenue">Trámite</p>
            <p className="text-sm font-semibold text-tinta">{tramite}</p>
            <p className="text-xs text-tenue">Atiende: {vendedor}</p>
          </div>
        </div>

        {/* ── Conceptos ── */}
        <Seccion numero={1} titulo="¿Qué incluye el servicio?"
          descripcion="Desglosa honorarios, derechos de gobierno y gestoría. El cliente ve por qué paga lo que paga.">
          <div className="space-y-2">
            {conceptos.map((c, i) => (
              <div key={c.id} className="flex items-center gap-2">
                <input
                  name="conceptoDescripcion"
                  value={c.descripcion}
                  onChange={(e) =>
                    setConceptos((prev) =>
                      prev.map((x) => (x.id === c.id ? { ...x, descripcion: e.target.value } : x))
                    )
                  }
                  placeholder="Concepto"
                  aria-label={`Concepto ${i + 1}`}
                  className={`${claseCampo} flex-1`}
                />
                <CampoMonto
                  nombre="conceptoMonto"
                  valor={c.monto}
                  etiqueta={`Importe del concepto ${i + 1}`}
                  alCambiar={(v) =>
                    setConceptos((prev) => prev.map((x) => (x.id === c.id ? { ...x, monto: v } : x)))
                  }
                />
                <BotonQuitar
                  visible={conceptos.length > 1}
                  etiqueta={`Quitar concepto ${i + 1}`}
                  alPulsar={() => setConceptos((prev) => prev.filter((x) => x.id !== c.id))}
                />
              </div>
            ))}
          </div>
          <BotonAgregar
            texto="Agregar concepto"
            alPulsar={() =>
              setConceptos((prev) => [...prev, { id: nuevoId(), descripcion: '', monto: '' }])
            }
          />
        </Seccion>

        {/* ── Pagos ── */}
        <Seccion numero={2} titulo="¿Cómo lo va a pagar?"
          descripcion="Al aceptarse el presupuesto, estos pagos se vuelven el plan de cobranza del caso.">
          {total > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-tenue">Repartir en:</span>
              {[1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => repartir(n)}
                  className="rounded-full border border-borde px-3 py-1 text-xs font-semibold text-suave transition hover:border-marca hover:text-marca"
                >
                  {n === 1 ? 'un solo pago' : `${n} pagos`}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-2">
            {pagos.map((p, i) => (
              <div
                key={p.id}
                className="grid grid-cols-[1fr_auto] items-center gap-2 sm:grid-cols-[20px_1fr_150px_144px_28px]"
              >
                <span className="hidden text-center text-xs font-bold text-tenue sm:block">{i + 1}</span>
                <input
                  name="pagoDescripcion"
                  value={p.descripcion}
                  onChange={(e) =>
                    setPagos((prev) =>
                      prev.map((x) => (x.id === p.id ? { ...x, descripcion: e.target.value } : x))
                    )
                  }
                  placeholder="Descripción"
                  aria-label={`Descripción del pago ${i + 1}`}
                  className={`${claseCampo} col-span-2 sm:col-span-1`}
                />
                <input
                  type="date"
                  name="pagoFecha"
                  value={p.fecha}
                  onChange={(e) =>
                    setPagos((prev) =>
                      prev.map((x) => (x.id === p.id ? { ...x, fecha: e.target.value } : x))
                    )
                  }
                  aria-label={`Fecha del pago ${i + 1}`}
                  className={claseCampo}
                />
                <CampoMonto
                  nombre="pagoMonto"
                  valor={p.monto}
                  ancho="w-full"
                  etiqueta={`Importe del pago ${i + 1}`}
                  alCambiar={(v) =>
                    setPagos((prev) => prev.map((x) => (x.id === p.id ? { ...x, monto: v } : x)))
                  }
                />
                <BotonQuitar
                  visible={pagos.length > 1}
                  etiqueta={`Quitar pago ${i + 1}`}
                  alPulsar={() => setPagos((prev) => prev.filter((x) => x.id !== p.id))}
                />
              </div>
            ))}
          </div>
          <BotonAgregar
            texto="Agregar pago"
            alPulsar={() =>
              setPagos((prev) => [
                ...prev,
                { id: nuevoId(), descripcion: `Pago ${prev.length + 1}`, fecha: enMeses(prev.length), monto: '' },
              ])
            }
          />
        </Seccion>

        {/* ── Condiciones ── */}
        <Seccion numero={3} titulo="Condiciones y vigencia"
          descripcion="Lo que el cliente lee antes de aprobar. Aparece tal cual en el PDF.">
          <label className="mb-4 block max-w-xs">
            <span className="mb-1.5 block text-sm font-semibold text-tinta">
              El precio se sostiene hasta
            </span>
            <input type="date" name="validoHasta" defaultValue={enDias(15)} className={claseCampo} />
          </label>

          <textarea
            name="condiciones"
            rows={4}
            className={claseCampo}
            defaultValue={
              'El precio incluye la integración y presentación del expediente ante la autoridad migratoria.\n' +
              'No incluye derechos de terceros, traducciones ni apostillas, salvo que se indique en los conceptos.\n' +
              'Los tiempos de resolución dependen de la autoridad y no son atribuibles al despacho.'
            }
          />

          <label className="mt-4 block">
            <span className="mb-1.5 block text-sm font-semibold text-tinta">Notas internas</span>
            <textarea name="notas" rows={2} className={claseCampo} placeholder="No aparecen en el documento del cliente." />
          </label>
        </Seccion>
      </div>

      {/* ── Resumen que acompaña al capturar ── */}
      <aside className="lg:sticky lg:top-6">
        <div className="overflow-hidden rounded-tarjeta border border-borde bg-white shadow-media">
          <div className="grad-tinta relative overflow-hidden px-5 py-5">
            <div className="resplandor-marca pointer-events-none absolute inset-0" />
            <p className="relative text-[11px] font-bold uppercase tracking-wider text-slate-300">
              Total del presupuesto
            </p>
            <p className="relative mt-1 text-[32px] font-extrabold leading-none tracking-tight text-white">
              {pesos(total)}
            </p>
          </div>

          <div className="space-y-3 p-5">
            <Renglon etiqueta="Suma de los pagos" valor={pesos(sumaPagos)} />
            <div className="h-px bg-borde" />

            <div
              className={`rounded-sm px-3 py-2.5 text-sm font-semibold ${
                total === 0
                  ? 'bg-lienzo text-tenue'
                  : cuadra
                    ? 'bg-green-50 text-green-800'
                    : 'bg-amber-50 text-amber-800'
              }`}
            >
              {total === 0
                ? 'Captura los conceptos para empezar.'
                : cuadra
                  ? '✓ Los pagos cuadran con el total.'
                  : diferencia > 0
                    ? `Faltan ${pesos(diferencia)} por repartir en pagos.`
                    : `Los pagos exceden el total en ${pesos(-diferencia)}.`}
            </div>

            <button
              type="submit"
              disabled={!listo}
              className={`w-full rounded-sm px-4 py-3 text-sm font-bold transition ${
                listo
                  ? 'grad-marca text-white shadow-marca hover:shadow-marca-alta hover:-translate-y-0.5'
                  : 'cursor-not-allowed bg-lienzo text-tenue'
              }`}
            >
              Generar presupuesto
            </button>

            <p className="text-center text-xs text-tenue">
              Se crea como borrador: podrás revisarlo antes de mandarlo.
            </p>
          </div>
        </div>
      </aside>
    </form>
  );
}

function Seccion({
  numero,
  titulo,
  descripcion,
  children,
}: {
  numero: number;
  titulo: string;
  descripcion: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-tarjeta border border-borde bg-white p-5 shadow-suave">
      <header className="mb-4 flex gap-3">
        <span className="grad-marca flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white">
          {numero}
        </span>
        <div>
          <h2 className="text-base font-bold text-tinta">{titulo}</h2>
          <p className="text-xs text-tenue">{descripcion}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

/** Campo de importe con el signo dentro, para que se lea como dinero. */
function CampoMonto({
  nombre,
  valor,
  etiqueta,
  alCambiar,
  ancho = 'w-36',
}: {
  nombre: string;
  valor: string;
  etiqueta: string;
  alCambiar: (v: string) => void;
  ancho?: string;
}) {
  return (
    <div className={`relative ${ancho}`}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-tenue">
        $
      </span>
      <input
        name={nombre}
        type="number"
        min="0"
        step="0.01"
        value={valor}
        onChange={(e) => alCambiar(e.target.value)}
        placeholder="0.00"
        aria-label={etiqueta}
        className="w-full rounded-sm border border-borde bg-white py-2 pl-7 pr-3 text-right text-sm font-semibold transition focus:border-marca focus:outline-none focus:ring-2 focus:ring-marca/15"
      />
    </div>
  );
}

function BotonAgregar({ texto, alPulsar }: { texto: string; alPulsar: () => void }) {
  return (
    <button
      type="button"
      onClick={alPulsar}
      className="mt-3 inline-flex items-center gap-1.5 rounded-sm border border-dashed border-borde px-3 py-2 text-xs font-semibold text-suave transition hover:border-marca hover:text-marca"
    >
      <span className="text-base leading-none">+</span> {texto}
    </button>
  );
}

function BotonQuitar({
  visible,
  etiqueta,
  alPulsar,
}: {
  visible: boolean;
  etiqueta: string;
  alPulsar: () => void;
}) {
  if (!visible) return <span className="w-7" aria-hidden="true" />;
  return (
    <button
      type="button"
      onClick={alPulsar}
      aria-label={etiqueta}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-tenue transition hover:bg-red-50 hover:text-red-600"
    >
      ✕
    </button>
  );
}

function Renglon({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-sm text-suave">{etiqueta}</span>
      <span className="text-sm font-bold text-tinta">{valor}</span>
    </div>
  );
}
