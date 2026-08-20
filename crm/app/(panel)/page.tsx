import { prisma } from '@/lib/prisma';
import { sesionActual } from '@/lib/sesion';
import { puede, filtroVentas, filtroCasos, ETIQUETA_ROL } from '@/lib/permisos';

export const metadata = { title: 'Inicio — CRM Migratorio' };

/** Saludo según la hora, para que la portada no se sienta impersonal. */
function saludo(): string {
  const hora = new Date().getHours();
  if (hora < 12) return 'Buenos días';
  if (hora < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

export default async function Inicio() {
  const sesion = await sesionActual();

  // Tres cifras de contexto, no un tablero: para eso está Reportes. Cada una
  // solo se calcula si el rol puede ver ese módulo — la portada no es una
  // rendija para asomarse a lo que el menú tiene cerrado.
  const enSieteDias = new Date(Date.now() + 7 * 864e5);
  const [prospectos, casosActivos, porCobrar] = await Promise.all([
    puede(sesion.rol, 'ventas')
      ? prisma.venta.count({
          where: { AND: [filtroVentas(sesion), { etapa: { notIn: ['CERRADO_GANADO', 'CERRADO_PERDIDO'] } }] },
        })
      : null,
    puede(sesion.rol, 'casos')
      ? prisma.caso.count({ where: { AND: [filtroCasos(sesion), { etapaActual: { nombre: { not: 'Cerrado' } } }] } })
      : null,
    puede(sesion.rol, 'cobros')
      ? prisma.cuota.count({
          where: { venta: filtroVentas(sesion), pagadoEn: null, fechaPactada: { lte: enSieteDias } },
        })
      : null,
  ]);

  return (
    <div className="relative -mx-4 -my-6 flex min-h-[calc(100dvh-4rem)] flex-col overflow-hidden md:-mx-8 md:-my-8 md:min-h-screen">
      <div className="cubos pointer-events-none absolute inset-0" />
      <div className="flota pointer-events-none absolute -left-40 -top-40 h-[28rem] w-[28rem] rounded-full bg-marca-clara/10 blur-3xl" />
      <div className="flota-lento pointer-events-none absolute -bottom-48 -right-32 h-[30rem] w-[30rem] rounded-full bg-marca/10 blur-3xl" />

      <div className="relative flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <p className="aparece text-sm font-semibold text-suave" style={{ animationDelay: '640ms' }}>
          {saludo()}, {sesion.nombre.split(' ')[0]} · {ETIQUETA_ROL[sesion.rol]}
        </p>

        <div className="relative">
          <div className="halo-portada flota pointer-events-none absolute inset-x-0 -inset-y-10" />
          {/* Las letras entran una por una. El lector de pantalla lee la
              palabra completa, no letra por letra. */}
          <h1
            aria-label="CRM"
            className="relative mt-4 text-[clamp(80px,21vw,210px)] font-extrabold leading-[0.82] tracking-[-0.06em]"
          >
            {['C', 'R', 'M'].map((letra, i) => (
              <span
                key={letra}
                aria-hidden="true"
                className="letra-portada"
                style={{ animationDelay: `${120 + i * 130}ms, 0ms` }}
              >
                {letra}
              </span>
            ))}
          </h1>
        </div>

        <p
          className="aparece mt-1 text-base font-medium tracking-tight text-suave sm:text-xl"
          style={{ animationDelay: '640ms' }}
        >
          Sistema de gestión — <span className="font-bold text-tinta">Despacho migratorio</span>
        </p>

        <div className="aparece mt-9 flex flex-wrap justify-center gap-3" style={{ animationDelay: '760ms' }}>
          <Cifra valor={prospectos} uno="prospecto abierto" varios="prospectos abiertos" />
          <Cifra valor={casosActivos} uno="caso en trámite" varios="casos en trámite" />
          <Cifra valor={porCobrar} uno="cuota por cobrar esta semana" varios="cuotas por cobrar esta semana" acento />
        </div>

        {/* Para navegar está el menú lateral; en celular, detrás del botón de
            arriba. Se dice, porque la portada no lleva accesos propios. */}
        <p className="aparece mt-10 text-xs text-tenue" style={{ animationDelay: '880ms' }}>
          <span className="md:hidden">Abre el menú con el botón de arriba para entrar a un módulo.</span>
          <span className="hidden md:inline">Elige un módulo en el menú de la izquierda.</span>
        </p>
      </div>
    </div>
  );
}

/** Una cifra suelta. Si el rol no puede ver ese módulo llega en `null` y no se pinta. */
function Cifra({
  valor,
  uno,
  varios,
  acento,
}: {
  valor: number | null;
  uno: string;
  varios: string;
  acento?: boolean;
}) {
  if (valor === null) return null;
  return (
    <span className="inline-flex items-baseline gap-2 rounded-full border border-borde bg-white/70 px-4 py-2 shadow-suave backdrop-blur">
      <strong className={`text-xl font-extrabold ${acento && valor > 0 ? 'text-marca' : 'text-tinta'}`}>
        {valor}
      </strong>
      <span className="text-sm text-suave">{valor === 1 ? uno : varios}</span>
    </span>
  );
}
