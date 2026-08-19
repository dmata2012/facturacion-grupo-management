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
    <div className={`rounded-xl border border-borde bg-white shadow-sm ${className}`}>{children}</div>
  );
}

export function TituloSeccion({ children, accion }: { children: ReactNode; accion?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <h1 className="text-2xl font-bold tracking-tight text-tinta">{children}</h1>
      {accion}
    </div>
  );
}

const TONOS = {
  neutro: 'bg-slate-100 text-slate-700 ring-slate-200',
  marca: 'bg-marca-tenue text-marca ring-red-100',
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
  principal: 'bg-marca text-white hover:bg-marca-clara shadow-sm',
  suave: 'bg-white text-tinta ring-1 ring-borde hover:bg-slate-50',
  peligro: 'bg-white text-red-700 ring-1 ring-red-200 hover:bg-red-50',
} as const;

type EstiloBoton = keyof typeof BOTONES;

const BASE_BOTON =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed';

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
  'w-full rounded-lg border border-borde bg-white px-3 py-2 text-sm text-tinta placeholder:text-tenue focus:border-marca focus:outline-none focus:ring-2 focus:ring-marca/15';

export function Vacio({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-borde bg-white/60 px-6 py-10 text-center text-sm text-tenue">
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
    info: 'text-sky-700',
  }[tono];
  return (
    <Tarjeta className="p-5">
      <div className="text-xs font-semibold uppercase tracking-wide text-tenue">{etiqueta}</div>
      <div className={`mt-2 text-2xl font-bold tracking-tight ${acento}`}>{valor}</div>
      {detalle && <div className="mt-1 text-xs text-suave">{detalle}</div>}
    </Tarjeta>
  );
}
