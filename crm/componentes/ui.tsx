import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';

/* Piezas visuales compartidas. Existen para que todas las pantallas se vean
   iguales sin repetir cadenas de clases por todos lados. */

export function Tarjeta({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-tarjeta border border-borde bg-white shadow-suave ${className}`}>{children}</div>
  );
}

export function TituloSeccion({
  children,
  accion,
  etiqueta,
}: {
  children: ReactNode;
  accion?: ReactNode;
  etiqueta?: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        {etiqueta && <Etiqueta>{etiqueta}</Etiqueta>}
        <h1 className="text-[28px] font-extrabold leading-tight text-tinta sm:text-[32px]">{children}</h1>
      </div>
      {accion}
    </div>
  );
}

/** Rótulo en versalitas rojas que el sitio usa sobre cada título. */
export function Etiqueta({ children }: { children: ReactNode }) {
  return (
    <span className="mb-2 block text-[11px] font-bold uppercase tracking-[1.8px] text-marca">
      {children}
    </span>
  );
}

const TONOS = {
  neutro: 'bg-slate-100 text-slate-700 ring-slate-200',
  marca: 'bg-marca-tenue text-marca ring-cyan-200',
  exito: 'bg-green-50 text-green-700 ring-green-200',
  aviso: 'bg-amber-50 text-amber-700 ring-amber-200',
  alerta: 'bg-red-50 text-red-700 ring-red-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
} as const;

export type Tono = keyof typeof TONOS;

export function Insignia({ children, tono = 'neutro' }: { children: ReactNode; tono?: Tono }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${TONOS[tono]}`}
    >
      {children}
    </span>
  );
}

const BOTONES = {
  principal: 'grad-marca text-white shadow-marca hover:shadow-marca-alta hover:-translate-y-0.5',
  suave: 'bg-white text-tinta ring-1 ring-borde hover:ring-marca hover:text-marca hover:-translate-y-0.5',
  peligro: 'bg-white text-red-700 ring-1 ring-red-200 hover:bg-red-50',
} as const;

type EstiloBoton = keyof typeof BOTONES;

const BASE_BOTON =
  'inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2 text-sm font-semibold ' +
  'transition duration-150 active:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed';

export function Boton({
  children,
  estilo = 'principal',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { estilo?: EstiloBoton }) {
  return (
    <button className={`${BASE_BOTON} ${BOTONES[estilo]} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function BotonEnlace({
  children,
  href,
  estilo = 'principal',
  className = '',
}: {
  children: ReactNode;
  href: string;
  estilo?: EstiloBoton;
  className?: string;
}) {
  return (
    <Link href={href} className={`${BASE_BOTON} ${BOTONES[estilo]} ${className}`}>
      {children}
    </Link>
  );
}

export function Campo({
  etiqueta,
  children,
  ayuda,
  requerido,
}: {
  etiqueta: string;
  children: ReactNode;
  ayuda?: string;
  requerido?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold text-tinta">
        {etiqueta} {requerido && <span className="text-marca">*</span>}
      </span>
      {children}
      {ayuda && <span className="mt-1 block text-xs text-tenue">{ayuda}</span>}
    </label>
  );
}

export const claseInput =
  'w-full rounded-sm border border-borde bg-white px-3 py-2 text-sm text-tinta ' +
  'placeholder:text-tenue transition focus:border-marca focus:outline-none focus:ring-2 focus:ring-marca/15';

export function Vacio({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-tarjeta border border-dashed border-borde bg-white/60 px-6 py-10 text-center text-sm text-tenue">
      {children}
    </div>
  );
}

export function Dato({ etiqueta, valor }: { etiqueta: string; valor: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-tenue">{etiqueta}</dt>
      <dd className="mt-0.5 text-sm text-tinta">{valor || '—'}</dd>
    </div>
  );
}

export function Kpi({
  etiqueta,
  valor,
  detalle,
  tono = 'neutro',
}: {
  etiqueta: string;
  valor: string;
  detalle?: string;
  tono?: Tono;
}) {
  const acento = {
    neutro: 'text-tinta',
    marca: 'text-marca',
    exito: 'text-green-700',
    aviso: 'text-amber-600',
    alerta: 'text-red-700',
    info: 'text-blue-700',
  }[tono];
  const filo = {
    neutro: 'bg-borde',
    marca: 'grad-marca',
    exito: 'bg-green-500',
    aviso: 'bg-amber-500',
    alerta: 'bg-red-500',
    info: 'bg-blue-500',
  }[tono];
  return (
    <Tarjeta className="relative overflow-hidden p-5 transition duration-200 hover:-translate-y-1 hover:shadow-media">
      {/* Filo de color arriba: identifica el indicador de un vistazo, sin
          teñir toda la tarjeta. */}
      <span className={`absolute inset-x-0 top-0 h-1 ${filo}`} />
      <div className="text-[11px] font-bold uppercase tracking-[1.2px] text-tenue">{etiqueta}</div>
      <div className={`mt-2.5 text-[30px] font-extrabold leading-none tracking-[-0.03em] ${acento}`}>
        {valor}
      </div>
      {detalle && <div className="mt-1.5 text-xs text-suave">{detalle}</div>}
    </Tarjeta>
  );
}

/** Aviso de error de un formulario, con el mismo aspecto en todo el sistema. */
export function Aviso({ children, tono = 'alerta' }: { children: ReactNode; tono?: 'alerta' | 'exito' }) {
  const estilo =
    tono === 'exito'
      ? 'border-green-500 bg-green-50 text-green-800'
      : 'border-red-500 bg-red-50 text-red-700';
  return (
    <p className={`mb-4 rounded-sm border-l-4 px-3 py-2 text-sm ${estilo}`} role="status">
      {children}
    </p>
  );
}

/** Iniciales del nombre: "María Fernanda Rojas" → "MR". */
function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  const primera = partes[0][0];
  // Se toma el apellido, no el segundo nombre, que distingue mejor entre
  // clientes que comparten nombre de pila.
  const segunda = partes.length > 2 ? partes[2][0] : partes[1]?.[0] ?? '';
  return (primera + segunda).toUpperCase();
}

/**
 * Fotografía del cliente en formato redondo. Cuando no hay foto muestra las
 * iniciales, para que la tarjeta no quede con un hueco ni con un icono
 * genérico repetido en todas.
 */
export function Avatar({
  nombre,
  fotoUrl,
  tamano = 40,
}: {
  nombre: string;
  fotoUrl?: string | null;
  tamano?: number;
}) {
  if (fotoUrl) {
    return (
      <Image
        src={fotoUrl}
        alt={`Fotografía de ${nombre}`}
        width={tamano}
        height={tamano}
        unoptimized
        style={{ width: tamano, height: tamano }}
        className="shrink-0 rounded-full border border-borde object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: tamano, height: tamano, fontSize: Math.round(tamano * 0.36) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-marca-tenue font-bold text-marca ring-1 ring-inset ring-cyan-200"
    >
      {iniciales(nombre)}
    </span>
  );
}
