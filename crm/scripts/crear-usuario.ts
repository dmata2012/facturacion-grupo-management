import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { PrismaClient, Rol } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

/**
 * Alta de un usuario real. Se usa sobre todo para crear el primer acceso en
 * producción, donde el seed no siembra los usuarios de prueba.
 *
 *   npm run crear-usuario
 */
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const ROLES = Object.values(Rol);

async function main() {
  const consola = createInterface({ input: process.stdin, output: process.stdout });

  const nombre = (await consola.question('Nombre completo: ')).trim();
  const correo = (await consola.question('Correo: ')).trim().toLowerCase();
  console.log(`Roles disponibles: ${ROLES.join(', ')}`);
  const rol = (await consola.question('Rol: ')).trim().toUpperCase() as Rol;
  const password = (await consola.question('Contraseña: ')).trim();
  consola.close();

  if (!nombre || !correo || !password) throw new Error('Nombre, correo y contraseña son obligatorios.');
  if (!ROLES.includes(rol)) throw new Error(`Rol inválido. Usa uno de: ${ROLES.join(', ')}`);
  if (password.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');

  const existente = await prisma.usuario.findUnique({ where: { correo } });
  if (existente) throw new Error(`Ya existe un usuario con el correo ${correo}.`);

  const usuario = await prisma.usuario.create({
    data: { nombre, correo, rol, passwordHash: await bcrypt.hash(password, 10) },
  });
  console.log(`\n✅ Usuario creado: ${usuario.nombre} (${usuario.correo}) — ${usuario.rol}`);
}

main()
  .catch((e) => {
    console.error(`\n✖ ${e.message}`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
