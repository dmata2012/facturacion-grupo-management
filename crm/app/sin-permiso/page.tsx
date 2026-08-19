import { BotonEnlace } from '@/componentes/ui';

export default function SinPermiso() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-5xl font-bold text-marca">403</p>
      <h1 className="text-xl font-bold text-tinta">Tu rol no tiene acceso a esta sección</h1>
      <p className="max-w-md text-sm text-suave">
        Si necesitas entrar aquí, pídelo a la dirección del despacho: los permisos se asignan por
        rol.
      </p>
      <BotonEnlace href="/" estilo="suave">
        Volver al inicio
      </BotonEnlace>
    </main>
  );
}
