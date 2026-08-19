import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// En desarrollo Next.js recarga los módulos en cada cambio; sin este caché
// global se abriría una conexión nueva por recarga hasta agotar el pool.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function crearCliente() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'Falta DATABASE_URL. Copia .env.example a .env y pon ahí la cadena de conexión de PostgreSQL.'
    );
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export const prisma = globalForPrisma.prisma ?? crearCliente();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
