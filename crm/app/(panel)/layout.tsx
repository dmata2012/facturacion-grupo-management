import Image from 'next/image';
import { signOut } from '@/auth';
import { sesionActual } from '@/lib/sesion';
import { modulosVisibles, ETIQUETA_ROL } from '@/lib/permisos';
import { EnlacesMenu } from '@/componentes/nav';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const sesion = await sesionActual();
  const modulos = modulosVisibles(sesion.rol);

  async function salir() {
    'use server';
    await signOut({ redirectTo: '/ingresar' });
  }

  return (
    <div className="flex min-h-screen">
      {/* La barra lateral repite el fondo oscuro con resplandor rojo de la
          portada del sitio: es lo que hace reconocible la marca. */}
      <aside className="relative hidden w-60 shrink-0 flex-col overflow-hidden grad-tinta py-6 md:flex">
        <div className="resplandor-marca pointer-events-none absolute inset-0" />

        <div className="relative px-6 pb-6">
          <Image
            src="/logo.png"
            alt="Grupo Management"
            width={148}
            height={40}
            className="mb-3 h-9 w-auto brightness-0 invert"
            priority
          />
          <p className="text-sm font-bold tracking-tight text-white">CRM Migratorio</p>
          <p className="text-xs text-slate-400">Despacho de abogados</p>
        </div>

        <div className="relative flex flex-1 flex-col">
          <EnlacesMenu modulos={modulos} />

          <div className="mt-6 border-t border-white/10 px-6 pt-4">
            <p className="truncate text-sm font-semibold text-white">{sesion.nombre}</p>
            <p className="text-xs text-slate-400">{ETIQUETA_ROL[sesion.rol]}</p>
            <form action={salir}>
              <button className="mt-3 text-xs font-semibold text-slate-300 underline-offset-2 transition hover:text-white hover:underline">
                Cerrar sesión
              </button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* En pantallas chicas el menú se vuelve una barra horizontal arriba. */}
        <div className="relative flex items-center gap-1 overflow-x-auto grad-tinta px-4 py-3 md:hidden">
          {modulos.map((m) => (
            <a
              key={m.href}
              href={m.href}
              className="whitespace-nowrap rounded-sm px-2.5 py-1.5 text-sm text-slate-200 hover:bg-white/10 hover:text-white"
            >
              {m.nombre}
            </a>
          ))}
        </div>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
