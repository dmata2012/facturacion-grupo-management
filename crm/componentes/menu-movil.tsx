'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { IconoModulo } from '@/componentes/iconos';

type Modulo = { href: string; nombre: string };

/**
 * Menú de celular y tableta. En pantallas chicas la barra lateral fija se
 * comería el ancho útil, así que se guarda detrás del botón hamburguesa y
 * entra deslizándose desde la izquierda.
 */
export function MenuMovil({
  modulos,
  nombre,
  rol,
  salir,
}: {
  modulos: Modulo[];
  nombre: string;
  rol: string;
  salir: () => Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const ruta = usePathname();
  const botonCerrar = useRef<HTMLButtonElement>(null);

  // Al navegar, el panel se cierra solo: si no, quedaría tapando la pantalla
  // a la que acabas de entrar.
  useEffect(() => setAbierto(false), [ruta]);

  useEffect(() => {
    if (!abierto) return;
    // Con el panel abierto, el fondo no debe poder desplazarse.
    const previo = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    botonCerrar.current?.focus();

    const alPresionar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAbierto(false);
    };
    document.addEventListener('keydown', alPresionar);
    return () => {
      document.body.style.overflow = previo;
      document.removeEventListener('keydown', alPresionar);
    };
  }, [abierto]);

  return (
    <>
      <header className="relative flex items-center gap-3 overflow-hidden grad-tinta px-4 py-3 md:hidden">
        <div className="resplandor-marca pointer-events-none absolute inset-0" />

        <button
          type="button"
          onClick={() => setAbierto(true)}
          aria-label="Abrir menú"
          aria-expanded={abierto}
          aria-controls="menu-lateral"
          className="relative rounded-sm p-2 text-white transition hover:bg-white/10"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>

        <div className="relative min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-white">CRM Migratorio</p>
          <p className="truncate text-xs text-slate-400">{nombre}</p>
        </div>

        <Image
          src="/logo.png"
          alt="Grupo Management"
          width={120}
          height={32}
          className="relative h-7 w-auto brightness-0 invert"
        />
      </header>

      {/* Fondo oscurecido: tocarlo cierra el menú. */}
      <div
        onClick={() => setAbierto(false)}
        aria-hidden="true"
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden ${
          abierto ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      <aside
        id="menu-lateral"
        aria-hidden={!abierto}
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col overflow-y-auto grad-tinta shadow-alta transition-transform duration-200 md:hidden ${
          abierto ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="resplandor-marca pointer-events-none absolute inset-0" />

        <div className="relative flex items-start justify-between gap-2 px-5 py-5">
          <div>
            <Image
              src="/logo.png"
              alt="Grupo Management"
              width={148}
              height={40}
              className="mb-3 h-8 w-auto brightness-0 invert"
            />
            <p className="text-sm font-bold text-white">CRM Migratorio</p>
            <p className="text-xs text-slate-400">Despacho de abogados</p>
          </div>
          <button
            ref={botonCerrar}
            type="button"
            onClick={() => setAbierto(false)}
            aria-label="Cerrar menú"
            className="rounded-sm p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <nav className="relative flex-1 space-y-0.5 px-3">
          {modulos.map((m) => {
            const activo = m.href === '/' ? ruta === '/' : ruta.startsWith(m.href);
            return (
              <Link
                key={m.href}
                href={m.href}
                aria-current={activo ? 'page' : undefined}
                className={`relative flex items-center gap-2.5 rounded-sm px-3 py-2.5 text-sm transition ${
                  activo ? 'bg-white/10 font-semibold text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white'
                }`}
              >
                {activo && <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-marca-clara" />}
                <IconoModulo href={m.href} />
                {m.nombre}
              </Link>
            );
          })}
        </nav>

        <div className="relative mt-4 border-t border-white/10 px-5 py-4">
          <p className="truncate text-sm font-semibold text-white">{nombre}</p>
          <p className="text-xs text-slate-400">{rol}</p>
          <form action={salir}>
            <button className="mt-3 text-xs font-semibold text-slate-300 underline-offset-2 transition hover:text-white hover:underline">
              Cerrar sesión
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
