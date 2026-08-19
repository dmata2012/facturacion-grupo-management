import { Rol } from '@prisma/client';
import type { Prisma } from '@prisma/client';

/**
 * Permisos por rol (sección 12 de la especificación).
 *
 * Se resuelve en dos niveles, porque uno solo no alcanza:
 *   1. `puede()` decide si un rol tiene acceso a un módulo — sirve para
 *      ocultar el menú y para cortar la petición en la puerta.
 *   2. Los `filtro*()` recortan QUÉ registros ve dentro del módulo. Un
 *      vendedor entra a Ventas, pero solo a las suyas. Esto va pegado a la
 *      consulta de la base, que es el único lugar donde no se puede burlar.
 */

export type Recurso =
  | 'clientes'
  | 'ventas'
  | 'casos'
  | 'documentos'
  | 'cobros'
  | 'comisiones'
  | 'agenda'
  | 'notas'
  | 'reportes'
  | 'usuarios'
  | 'configuracion';

export type Accion = 'ver' | 'crear' | 'editar' | 'eliminar';

const TODO: Accion[] = ['ver', 'crear', 'editar', 'eliminar'];
const LECTURA: Accion[] = ['ver'];
const CAPTURA: Accion[] = ['ver', 'crear', 'editar'];

const MATRIZ: Record<Rol, Partial<Record<Recurso, Accion[]>>> = {
  DIRECTOR: {
    clientes: TODO, ventas: TODO, casos: TODO, documentos: TODO,
    cobros: TODO, comisiones: TODO, agenda: TODO, notas: TODO,
    reportes: TODO, usuarios: TODO, configuracion: TODO,
  },
  VENDEDOR: {
    // Ve sus prospectos y sus ventas. Los expedientes legales de otros
    // vendedores no le corresponden.
    clientes: CAPTURA, ventas: CAPTURA, agenda: CAPTURA,
    notas: CAPTURA, comisiones: LECTURA, casos: LECTURA,
  },
  ABOGADO: {
    // Trabaja los casos que tiene asignados; las comisiones ajenas no.
    casos: CAPTURA, documentos: CAPTURA, clientes: CAPTURA,
    agenda: CAPTURA, notas: CAPTURA,
  },
  ASISTENTE: {
    clientes: CAPTURA, casos: LECTURA, documentos: CAPTURA,
    agenda: CAPTURA, notas: CAPTURA, ventas: LECTURA,
  },
  CONTADOR: {
    // Dinero sí; notas y detalle legal del caso, no.
    cobros: CAPTURA, comisiones: CAPTURA, reportes: LECTURA,
    clientes: LECTURA, ventas: LECTURA,
  },
};

export function puede(rol: Rol, recurso: Recurso, accion: Accion = 'ver'): boolean {
  return MATRIZ[rol]?.[recurso]?.includes(accion) ?? false;
}

export type Sesion = { id: string; rol: Rol };

/** Ventas visibles: el vendedor solo las propias. */
export function filtroVentas(s: Sesion): Prisma.VentaWhereInput {
  if (s.rol === 'VENDEDOR') return { vendedorId: s.id };
  return {};
}

/** Casos visibles: el abogado los asignados; el vendedor los de sus ventas. */
export function filtroCasos(s: Sesion): Prisma.CasoWhereInput {
  if (s.rol === 'ABOGADO') return { abogadoId: s.id };
  if (s.rol === 'VENDEDOR') return { venta: { vendedorId: s.id } };
  return {};
}

/**
 * Comisiones visibles. Solo dirección y contabilidad ven las de todos;
 * cualquier otro rol ve únicamente las propias — incluida la del vendedor,
 * que no debe conocer el reparto de sus compañeros.
 */
export function filtroComisiones(s: Sesion): Prisma.ComisionWhereInput {
  if (s.rol === 'DIRECTOR' || s.rol === 'CONTADOR') return {};
  return { participanteId: s.id };
}

/** Clientes visibles: el vendedor, los que él trabaja. */
export function filtroClientes(s: Sesion): Prisma.ClienteWhereInput {
  if (s.rol === 'VENDEDOR') {
    return { OR: [{ leads: { some: { vendedorId: s.id } } }, { ventas: { some: { vendedorId: s.id } } }] };
  }
  if (s.rol === 'ABOGADO') {
    return { ventas: { some: { caso: { abogadoId: s.id } } } };
  }
  return {};
}

export const ETIQUETA_ROL: Record<Rol, string> = {
  VENDEDOR: 'Vendedor',
  ABOGADO: 'Abogado / operador',
  DIRECTOR: 'Director / dueño',
  ASISTENTE: 'Asistente',
  CONTADOR: 'Contador',
};

/** Módulos del menú lateral, en orden, filtrados por rol. */
export const MODULOS: { href: string; nombre: string; recurso: Recurso | null }[] = [
  // Inicio no pide permiso: es la portada del sistema y la ve cualquiera que
  // haya entrado.
  { href: '/', nombre: 'Inicio', recurso: null },
  { href: '/reportes', nombre: 'Reportes', recurso: 'reportes' },
  { href: '/pipeline', nombre: 'Pipeline de ventas', recurso: 'ventas' },
  { href: '/casos', nombre: 'Casos legales', recurso: 'casos' },
  { href: '/clientes', nombre: 'Clientes', recurso: 'clientes' },
  { href: '/agenda', nombre: 'Agenda', recurso: 'agenda' },
  { href: '/cobros', nombre: 'Cobros y comisiones', recurso: 'cobros' },
  { href: '/configuracion', nombre: 'Configuración', recurso: 'configuracion' },
];

export function modulosVisibles(rol: Rol) {
  // Se evalúa módulo por módulo contra su propio recurso; los que no piden
  // permiso (Inicio) los ve todo el mundo.
  return MODULOS.filter((m) => m.recurso === null || puede(rol, m.recurso, 'ver'));
}
