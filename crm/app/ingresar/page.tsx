import { redirect } from 'next/navigation';
import { AuthError } from 'next-auth';
import { signIn } from '@/auth';
import { Boton, Campo, claseInput } from '@/componentes/ui';

export const metadata = { title: 'Acceso — CRM Migratorio' };

export default async function Ingresar({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; volverA?: string }>;
}) {
  const { error, volverA } = await searchParams;

  async function entrar(datos: FormData) {
    'use server';
    const destino = (datos.get('volverA') as string) || '/';
    try {
      await signIn('credentials', {
        correo: String(datos.get('correo') ?? '').trim(),
        password: String(datos.get('password') ?? ''),
        redirectTo: destino,
      });
    } catch (e) {
      // signIn lanza una redirección cuando sale bien; hay que dejarla pasar.
      if (e instanceof AuthError) {
        redirect(`/ingresar?error=1${destino ? `&volverA=${encodeURIComponent(destino)}` : ''}`);
      }
      throw e;
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-tinta px-4 py-12">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 60% 60% at 30% 40%, rgba(155,21,40,.35) 0%, transparent 70%)',
        }}
      />
      <div className="relative w-full max-w-sm rounded-2xl bg-white p-8 shadow-2xl">
        <h1 className="text-xl font-bold tracking-tight text-tinta">CRM Migratorio</h1>
        <p className="mt-1 mb-6 text-sm text-tenue">Acceso para el equipo del despacho</p>

        {error && (
          <p className="mb-4 rounded-lg border-l-4 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700">
            Correo o contraseña incorrectos.
          </p>
        )}

        <form action={entrar} className="space-y-4">
          <input type="hidden" name="volverA" value={volverA ?? '/'} />
          <Campo etiqueta="Correo" requerido>
            <input
              name="correo"
              type="email"
              required
              autoComplete="username"
              className={claseInput}
              placeholder="usuario@despacho.mx"
            />
          </Campo>
          <Campo etiqueta="Contraseña" requerido>
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className={claseInput}
            />
          </Campo>
          <Boton type="submit" className="w-full">
            Entrar
          </Boton>
        </form>
      </div>
    </main>
  );
}
