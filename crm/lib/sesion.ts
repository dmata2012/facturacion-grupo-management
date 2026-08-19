import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { puede, type Accion, type Recurso, type Sesion } from '@/lib/permisos';

/** Sesión del usuario actual. Si no hay, manda a la pantalla de acceso. */
export async function sesionActual(): Promise<Sesion & { nombre: string; correo: string }> {
  const sesion = await auth();
  if (!sesion?.user?.id) redirect('/ingresar');
  return {
    id: sesion.user.id,
    rol: sesion.user.rol,
    nombre: sesion.user.name ?? '',
    correo: sesion.user.email ?? '',
  };
}

/**
 * Igual que la anterior, pero además exige permiso sobre un módulo. Se usa al
 * inicio de cada página y de cada acción de servidor: ocultar un botón no es
 * seguridad, cortar la petición sí.
 */
export async function exigir(recurso: Recurso, accion: Accion = 'ver') {
  const s = await sesionActual();
  if (!puede(s.rol, recurso, accion)) redirect('/sin-permiso');
  return s;
}
