import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pdfkit lee sus fuentes desde node_modules en tiempo de ejecución; si el
  // empaquetador lo procesa, esas fuentes no viajan y la generación falla.
  serverExternalPackages: ['pdfkit'],
  experimental: {
    serverActions: {
      // Por defecto Next corta los envíos en 1 MB, y con eso fallaba la subida
      // de cualquier documento escaneado o foto de celular. El tope real del
      // sistema son 10 MB por archivo (lib/archivos.ts); estos 12 dejan margen
      // para el resto del formulario que viaja en el mismo envío.
      bodySizeLimit: '12mb',
    },
    // El proxy interno corre antes que la acción y trunca el cuerpo a 10 MB por
    // su cuenta: sin subir también este tope, el formulario llegaba cortado
    // ("Unexpected end of form") al subir un archivo grande.
    proxyClientMaxBodySize: '15mb',
  },
};

export default nextConfig;
