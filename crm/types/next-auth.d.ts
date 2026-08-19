import type { Rol } from '@prisma/client';
import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: { id: string; rol: Rol } & DefaultSession['user'];
  }
  interface User {
    rol: Rol;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    rol: Rol;
  }
}
