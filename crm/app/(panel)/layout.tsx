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
      <aside className="hidden w-60 shrink-0 flex-col bg-tinta py-6 md:flex">
        <div className="px-6 pb-6">
          <p className="text-sm font-bold tracking-tight text-white">CRM Migratorio</p>
          <p className="text-xs text-slate-400">Despacho de abogados</p>
        </div>

        <EnlacesMenu modulos={modulos} />

        <div className="mt-6 border-t border-white/10 px-6 pt-4">
          <p className="truncate text-sm font-semibold text-white">{sesion.nombre}</p>
          <p className="text-xs text-slate-400">{ETIQUETA_ROL[sesion.rol]}</p>
          <form action={salir}>
            <button className="mt-3 text-xs font-semibold text-slate-300 underline-offset-2 hover:text-white hover:underline">
              Cerrar sesión
            </button>
          </form>
        </div>
      </aside>

      {/* En pantallas chicas el menú se vuelve una barra horizontal arriba. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 overflow-x-auto bg-tinta px-4 py-3 md:hidden">
          {modulos.map((m) => (
            <a key={m.href} href={m.href} className="whitespace-nowrap text-sm text-slate-200">
              {m.nombre}
            </a>
          ))}
        </div>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
