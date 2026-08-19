'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function EnlacesMenu({ modulos }: { modulos: { href: string; nombre: string }[] }) {
  const ruta = usePathname();

  return (
    <nav className="flex-1 space-y-0.5 px-3">
      {modulos.map((m) => {
        const activo = m.href === '/' ? ruta === '/' : ruta.startsWith(m.href);
        return (
          <Link
            key={m.href}
            href={m.href}
            aria-current={activo ? 'page' : undefined}
            className={`block rounded-lg px-3 py-2 text-sm transition ${
              activo
                ? 'bg-white/10 font-semibold text-white'
                : 'text-slate-300 hover:bg-white/5 hover:text-white'
            }`}
          >
            {m.nombre}
          </Link>
        );
      })}
    </nav>
  );
}
