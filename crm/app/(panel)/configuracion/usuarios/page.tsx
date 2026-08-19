import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { ETIQUETA_ROL } from '@/lib/permisos';
import { fecha } from '@/lib/formato';
import { Aviso, Boton, BotonEnlace, Insignia, Tarjeta, TituloSeccion, claseInput } from '@/componentes/ui';
import { alternarUsuario, cambiarRol, crearUsuario, restablecerPassword } from '../acciones';
import type { Rol } from '@prisma/client';

export const metadata = { title: 'Usuarios — CRM' };

const ROLES: Rol[] = ['DIRECTOR', 'VENDEDOR', 'ABOGADO', 'ASISTENTE', 'CONTADOR'];

const ERRORES: Record<string, string> = {
  faltan: 'Faltan el nombre o el correo.',
  'password-corta': 'La contraseña debe tener al menos 8 caracteres.',
  'correo-duplicado': 'Ya existe un usuario con ese correo.',
  'ultimo-director': 'Es el único director activo. Si le quitas el rol o lo desactivas, nadie podría entrar a configuración ni a los reportes.',
  'auto-desactivar': 'No puedes desactivarte a ti mismo: quedarías fuera del sistema de inmediato.',
};

export default async function Usuarios({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const sesion = await exigir('usuarios');

  const usuarios = await prisma.usuario.findMany({
    include: {
      _count: { select: { ventasComoVendedor: true, casosComoAbogado: true, comisiones: true } },
    },
    orderBy: [{ activo: 'desc' }, { nombre: 'asc' }],
  });

  return (
    <>
      <TituloSeccion accion={<BotonEnlace href="/configuracion" estilo="suave">Volver</BotonEnlace>}>
        Usuarios y permisos
      </TituloSeccion>

      {error === 'password-lista' ? (
        <Aviso tono="exito">Contraseña restablecida. Pásasela al usuario por un medio seguro.</Aviso>
      ) : (
        error && <Aviso>{ERRORES[error] ?? 'No se pudo completar la operación.'}</Aviso>
      )}

      <Tarjeta className="mb-6 p-5">
        <h2 className="mb-3 text-sm font-bold text-tinta">Dar de alta un usuario</h2>
        <form action={crearUsuario} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label>
            <span className="mb-1 block text-xs font-semibold">Nombre</span>
            <input name="nombre" required className={claseInput} />
          </label>
          <label>
            <span className="mb-1 block text-xs font-semibold">Correo</span>
            <input name="correo" type="email" required className={claseInput} />
          </label>
          <label>
            <span className="mb-1 block text-xs font-semibold">Rol</span>
            <select name="rol" required className={claseInput} defaultValue="VENDEDOR">
              {ROLES.map((r) => (
                <option key={r} value={r}>{ETIQUETA_ROL[r]}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-xs font-semibold">Contraseña</span>
            <input name="password" type="password" required minLength={8} className={claseInput} />
          </label>
          <div className="sm:col-span-2 lg:col-span-4">
            <Boton type="submit">Crear usuario</Boton>
          </div>
        </form>
      </Tarjeta>

      <Tarjeta className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b border-borde bg-slate-50 text-left text-xs uppercase tracking-wide text-tenue">
            <tr>
              <th className="px-4 py-3">Usuario</th>
              <th className="px-4 py-3">Rol</th>
              <th className="px-4 py-3">Actividad</th>
              <th className="px-4 py-3">Alta</th>
              <th className="px-4 py-3">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-borde">
            {usuarios.map((u) => (
              <tr key={u.id} className={u.activo ? '' : 'bg-slate-50/60'}>
                <td className="px-4 py-3">
                  <span className="font-semibold">{u.nombre}</span>
                  {u.id === sesion.id && <span className="ml-2 text-xs text-marca">(tú)</span>}
                  <span className="block text-xs text-tenue">{u.correo}</span>
                </td>
                <td className="px-4 py-3">
                  <form action={cambiarRol} className="flex items-center gap-1">
                    <input type="hidden" name="id" value={u.id} />
                    <select
                      name="rol"
                      defaultValue={u.rol}
                      aria-label={`Rol de ${u.nombre}`}
                      className="rounded-md border border-borde px-2 py-1 text-xs"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>{ETIQUETA_ROL[r]}</option>
                      ))}
                    </select>
                    <button className="rounded border border-borde px-2 py-1 text-xs hover:bg-slate-50">
                      Cambiar
                    </button>
                  </form>
                </td>
                <td className="px-4 py-3 text-xs text-suave">
                  {u._count.ventasComoVendedor} ventas · {u._count.casosComoAbogado} casos ·{' '}
                  {u._count.comisiones} comisiones
                </td>
                <td className="px-4 py-3 text-xs text-suave">{fecha(u.creadoEn)}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Insignia tono={u.activo ? 'exito' : 'neutro'}>
                      {u.activo ? 'Activo' : 'Inactivo'}
                    </Insignia>
                    <form action={alternarUsuario}>
                      <input type="hidden" name="id" value={u.id} />
                      <button className="rounded border border-borde px-2 py-1 text-xs hover:bg-slate-50">
                        {u.activo ? 'Desactivar' : 'Reactivar'}
                      </button>
                    </form>
                    <form action={restablecerPassword} className="flex items-center gap-1">
                      <input type="hidden" name="id" value={u.id} />
                      <input
                        type="password"
                        name="password"
                        placeholder="Nueva contraseña"
                        minLength={8}
                        required
                        aria-label={`Nueva contraseña de ${u.nombre}`}
                        className="w-36 rounded-md border border-borde px-2 py-1 text-xs"
                      />
                      <button className="rounded border border-borde px-2 py-1 text-xs hover:bg-slate-50">
                        Restablecer
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Tarjeta>

      <p className="mt-4 max-w-3xl text-xs text-tenue">
        Los usuarios no se borran: cada venta, cambio de etapa y comisión guarda quién lo hizo, y
        borrarlos dejaría ese historial sin dueño. Al desactivar a alguien, deja de poder entrar de
        inmediato y su trabajo pasado se conserva intacto.
      </p>
    </>
  );
}
