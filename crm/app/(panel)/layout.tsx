import Image from 'next/image';
import { signOut } from '@/auth';
import { sesionActual } from '@/lib/sesion';
import { modulosVisibles, ETIQUETA_ROL } from '@/lib/permisos';
import { EnlacesMenu } from '@/componentes/nav';
import { MenuMovil } from '@/componentes/menu-movil';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const sesion = await sesionActual();
  const modulos = modulosVisibles(sesion.rol);

  async function salir() {
    'use server';
    await signOut({ redirectTo: '/ingresar' });
  }

  return (
    <div className="flex min-h-screen">
      {/* La barra lateral fija aparece a partir de escritorio. En celular y
          tableta el mismo menú vive detrás del botón hamburguesa, para no
          comerse el ancho útil de la pantalla. */}
      <aside className="relative hidden w-60 shrink-0 flex-col overflow-hidden grad-tinta py-6 lg:flex">
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
        <MenuMovil
          modulos={modulos}
          nombre={sesion.nombre}
          rol={ETIQUETA_ROL[sesion.rol]}
          salir={salir}
        />
        <main className="grad-lienzo min-w-0 flex-1 px-4 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
