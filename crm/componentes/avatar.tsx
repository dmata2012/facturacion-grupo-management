'use client';

import Image from 'next/image';
import { useState } from 'react';

/** Iniciales del nombre: "María Fernanda Rojas" → "MR". */
function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  const primera = partes[0][0];
  // Se toma el apellido, no el segundo nombre, que distingue mejor entre
  // clientes que comparten nombre de pila.
  const segunda = partes.length > 2 ? partes[2][0] : (partes[1]?.[0] ?? '');
  return (primera + segunda).toUpperCase();
}

/**
 * Fotografía del cliente en formato redondo, con las iniciales como respaldo.
 *
 * El respaldo cubre dos casos, no uno: que el cliente no tenga foto, y que la
 * tenga pero el archivo no se pueda cargar. Sin lo segundo, el navegador
 * dibuja su icono de imagen rota, que es peor que no mostrar nada.
 */
export function Avatar({
  nombre,
  fotoUrl,
  tamano = 40,
}: {
  nombre: string;
  fotoUrl?: string | null;
  tamano?: number;
}) {
  const [falloLaCarga, setFalloLaCarga] = useState(false);

  if (fotoUrl && !falloLaCarga) {
    return (
      <Image
        src={fotoUrl}
        alt={`Fotografía de ${nombre}`}
        width={tamano}
        height={tamano}
        unoptimized
        onError={() => setFalloLaCarga(true)}
        style={{ width: tamano, height: tamano }}
        className="shrink-0 rounded-full border border-borde bg-lienzo object-cover"
      />
    );
  }

  return (
    <span
      title={nombre}
      style={{ width: tamano, height: tamano, fontSize: Math.round(tamano * 0.36) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-marca-tenue font-bold text-marca ring-1 ring-inset ring-cyan-200"
    >
      {iniciales(nombre)}
    </span>
  );
}
