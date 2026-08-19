import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authConfig } from '@/auth.config';

const credenciales = z.object({
  correo: z.email(),
  password: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { correo: {}, password: {} },
      async authorize(datos) {
        const parseado = credenciales.safeParse(datos);
        if (!parseado.success) return null;

        const usuario = await prisma.usuario.findUnique({
          where: { correo: parseado.data.correo.toLowerCase() },
        });
        // Misma respuesta si el correo no existe o la contraseña no coincide:
        // así el formulario no revela qué correos están dados de alta.
        if (!usuario || !usuario.activo) return null;

        const coincide = await bcrypt.compare(parseado.data.password, usuario.passwordHash);
        if (!coincide) return null;

        return { id: usuario.id, name: usuario.nombre, email: usuario.correo, rol: usuario.rol };
      },
    }),
  ],
});
