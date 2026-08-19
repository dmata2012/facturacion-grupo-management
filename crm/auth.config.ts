import type { NextAuthConfig } from 'next-auth';
import type { Rol } from '@prisma/client';

/**
 * Configuración ligera de autenticación: solo lo que el middleware necesita.
 *
 * El middleware corre en el runtime Edge, donde no existen ni Prisma ni
 * bcrypt. Por eso aquí NO va el proveedor de credenciales: eso vive en
 * auth.ts, que solo se carga en el servidor Node.
 */
export const authConfig = {
  session: { strategy: 'jwt' },
  pages: { signIn: '/ingresar' },
  trustHost: true,
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.rol = (user as { rol: Rol }).rol;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id as string;
      session.user.rol = token.rol as Rol;
      return session;
    },
  },
} satisfies NextAuthConfig;
