import 'dotenv/config';
import { createInterface, type Interface } from 'node:readline';
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
const MINIMO_PASSWORD = 8;

function preguntar(consola: Interface, texto: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Si la entrada se agota (por ejemplo si el comando se ejecuta con datos
    // canalizados en vez de a mano), el script terminaba en silencio sin crear
    // nada ni explicar por qué. Mejor decirlo.
    consola.once('close', () =>
      reject(new Error('La entrada se cerró antes de terminar. Ejecuta el comando en una terminal y responde las preguntas a mano.'))
    );
    consola.question(texto, (respuesta) => {
      consola.removeAllListeners('close');
      resolve(respuesta);
    });
  });
}

/**
 * Igual que preguntar, pero sin mostrar lo que se teclea: una contraseña no
 * debe quedar a la vista en la pantalla, ni en la consola del servidor ni si
 * alguien está mirando. readline no lo hace por su cuenta, así que se
 * intercepta lo que escribe al terminal.
 */
function preguntarOculto(consola: Interface, texto: string): Promise<string> {
  return new Promise((resolve) => {
    const interno = consola as Interface & {
      _writeToOutput: (s: string) => void;
      output: NodeJS.WritableStream;
    };
    const escribirOriginal = interno._writeToOutput.bind(interno);
    let ocultando = false;

    interno._writeToOutput = (s: string) => {
      if (!ocultando) return escribirOriginal(s);
      // Se conservan los saltos de línea; el resto se sustituye por asteriscos.
      escribirOriginal(s.includes('\n') ? '\n' : '*');
    };

    interno.output.write(texto);
    ocultando = true;
    consola.question('', (respuesta) => {
      ocultando = false;
      interno._writeToOutput = escribirOriginal;
      interno.output.write('\n');
      resolve(respuesta);
    });
  });
}

async function main() {
  const consola = createInterface({ input: process.stdin, output: process.stdout });

  const nombre = (await preguntar(consola, 'Nombre completo: ')).trim();
  const correo = (await preguntar(consola, 'Correo: ')).trim().toLowerCase();
  console.log(`Roles disponibles: ${ROLES.join(', ')}`);
  const rol = (await preguntar(consola, 'Rol: ')).trim().toUpperCase() as Rol;

  // Se valida todo lo demás ANTES de pedir la contraseña: así un dato mal
  // escrito no obliga a teclearla dos veces.
  if (!nombre) throw new Error('El nombre es obligatorio.');
  if (!correo) throw new Error('El correo es obligatorio.');
  if (!ROLES.includes(rol)) throw new Error(`Rol inválido. Usa uno de: ${ROLES.join(', ')}`);

  const existente = await prisma.usuario.findUnique({ where: { correo } });
  if (existente) throw new Error(`Ya existe un usuario con el correo ${correo}.`);

  let password = '';
  while (true) {
    password = await preguntarOculto(consola, `Contraseña (mínimo ${MINIMO_PASSWORD} caracteres): `);
    if (password.length < MINIMO_PASSWORD) {
      // Se vuelve a preguntar en vez de abortar: antes había que reiniciar todo
      // el script por una contraseña corta.
      console.log(`  La contraseña tiene ${password.length} caracteres; se necesitan ${MINIMO_PASSWORD}.`);
      continue;
    }
    const confirmacion = await preguntarOculto(consola, 'Repite la contraseña: ');
    if (password !== confirmacion) {
      console.log('  Las contraseñas no coinciden.');
      continue;
    }
    break;
  }
  consola.close();

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
