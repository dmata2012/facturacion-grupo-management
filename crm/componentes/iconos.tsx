/**
 * Iconos del menú lateral. Van dibujados a mano y no como paquete: son ocho
 * trazos, y una dependencia más solo para esto no se paga sola.
 *
 * Todos comparten caja de 24 y heredan el color del texto, así que el icono
 * se aclara y se oscurece junto con el nombre del módulo.
 */
const TRAZOS: Record<string, React.ReactNode> = {
  // Inicio: una casa.
  '/': <path d="M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5M10 20v-5.5h4V20" />,
  // Reportes: barras.
  '/reportes': <path d="M4 20h16M7.5 20v-7M12 20V6M16.5 20v-10" />,
  // Pipeline: columnas del tablero.
  '/pipeline': <path d="M4 4h4.5v16H4zM9.75 4h4.5v11h-4.5zM15.5 4H20v7h-4.5z" />,
  // Casos: portafolio.
  '/casos': (
    <path d="M3.5 8h17v11.5h-17zM9 8V5.5h6V8M3.5 13h17" />
  ),
  // Clientes: dos personas.
  '/clientes': (
    <path d="M9 11.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5ZM2.5 20c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5M16 5.6a3.25 3.25 0 0 1 0 6.3M17.5 14.9c2.5.6 4 2.4 4 5.1" />
  ),
  // Agenda: calendario.
  '/agenda': <path d="M4 6h16v14H4zM4 10.5h16M8.5 3.5V7M15.5 3.5V7" />,
  // Cobros: billete con moneda.
  '/cobros': (
    <path d="M2.5 6.5h19v11h-19zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 6.5v11M18 6.5v11" />
  ),
  // Configuración: engrane simplificado.
  '/configuracion': (
    <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM12 2.8l1.4 2.6 2.9-.5 1 2.8 2.5 1.5-1.1 2.8 1.1 2.8-2.5 1.5-1 2.8-2.9-.5L12 21.2l-1.4-2.6-2.9.5-1-2.8-2.5-1.5L5.3 12 4.2 9.2l2.5-1.5 1-2.8 2.9.5Z" />
  ),
};

export function IconoModulo({ href }: { href: string }) {
  const trazo = TRAZOS[href];
  if (!trazo) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-[18px] w-[18px] shrink-0"
    >
      {trazo}
    </svg>
  );
}
