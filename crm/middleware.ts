import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/auth.config';

// Se construye con la config ligera: el middleware no puede cargar Prisma.
const { auth } = NextAuth(authConfig);

/**
 * Puerta de entrada: sin sesión, todo redirige a /ingresar.
 * El permiso fino por rol NO se decide aquí — se decide en cada página y en
 * las consultas a la base (lib/permisos.ts), donde no se puede evadir.
 */
export default auth((req) => {
  const { nextUrl } = req;
  const autenticado = Boolean(req.auth);
  const esLogin = nextUrl.pathname === '/ingresar';

  if (!autenticado && !esLogin) {
    const destino = new URL('/ingresar', nextUrl);
    destino.searchParams.set('volverA', nextUrl.pathname);
    return NextResponse.redirect(destino);
  }
  if (autenticado && esLogin) {
    return NextResponse.redirect(new URL('/', nextUrl));
  }
  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.png$).*)'],
};
