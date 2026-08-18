/* Sitio Grupo Management — interacciones básicas.
   Todo lo esencial (contenido, enlaces, contacto) funciona sin JavaScript;
   esto solo agrega comodidades. */

(function () {
  'use strict';

  // ── Menú móvil ──────────────────────────────
  const boton   = document.querySelector('[data-menu]');
  const enlaces = document.querySelector('[data-enlaces]');

  if (boton && enlaces) {
    // El menú arranca oculto solo si hay JS: sin JS debe verse siempre.
    const esMovil = () => window.matchMedia('(max-width: 760px)').matches;
    const cerrar  = () => { enlaces.hidden = true;  boton.setAttribute('aria-expanded', 'false'); };
    const abrir   = () => { enlaces.hidden = false; boton.setAttribute('aria-expanded', 'true');  };

    if (esMovil()) cerrar();

    boton.addEventListener('click', () => (enlaces.hidden ? abrir() : cerrar()));

    // Al tocar un enlace del menú se cierra solo, y al volver a escritorio
    // el menú debe reaparecer aunque se hubiera cerrado en móvil.
    enlaces.addEventListener('click', (e) => {
      if (e.target.closest('a') && esMovil()) cerrar();
    });
    window.addEventListener('resize', () => { if (!esMovil()) enlaces.hidden = false; });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && esMovil() && !enlaces.hidden) { cerrar(); boton.focus(); }
    });
  }

  // ── Enlace activo ───────────────────────────
  // Se marca aquí para que la barra de navegación sea idéntica en las 4 páginas.
  const actual = location.pathname.replace(/\/$/, '').split('/').pop() || 'index.html';
  document.querySelectorAll('[data-enlaces] a[href]').forEach((a) => {
    const destino = a.getAttribute('href').split('/').pop();
    if (destino === actual || (actual === 'index.html' && destino === 'index.html')) {
      a.classList.add('activo');
      a.setAttribute('aria-current', 'page');
    }
  });

  // ── Año del pie ─────────────────────────────
  const anio = document.querySelector('[data-anio]');
  if (anio) anio.textContent = new Date().getFullYear();

  // ── Formulario de contacto ──────────────────
  // Validación en el navegador y aviso de recibido. Todavía no hay backend:
  // ver sitio/README.md para conectarlo cuando exista el endpoint.
  const forma = document.querySelector('[data-forma-contacto]');
  if (forma) {
    const aviso = forma.querySelector('[data-aviso]');

    const marcarError = (campo, mensaje) => {
      const contenedor = campo.closest('.campo');
      contenedor.classList.toggle('campo--error', Boolean(mensaje));
      const salida = contenedor.querySelector('.campo__error');
      if (salida) salida.textContent = mensaje || '';
      campo.setAttribute('aria-invalid', mensaje ? 'true' : 'false');
    };

    const validar = (campo) => {
      const valor = campo.value.trim();
      if (campo.required && !valor) {
        marcarError(campo, 'Este dato es obligatorio.');
        return false;
      }
      if (campo.type === 'email' && valor && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(valor)) {
        marcarError(campo, 'Revisa el correo: falta algo.');
        return false;
      }
      marcarError(campo, '');
      return true;
    };

    const campos = Array.from(forma.querySelectorAll('input, select, textarea'));
    campos.forEach((c) => c.addEventListener('blur', () => validar(c)));

    forma.addEventListener('submit', (e) => {
      e.preventDefault();
      // Se validan todos para que el usuario vea de una vez todo lo que falta.
      const valido = campos.map(validar).every(Boolean);
      if (!valido) {
        forma.querySelector('.campo--error input, .campo--error select, .campo--error textarea')?.focus();
        return;
      }
      if (aviso) {
        aviso.hidden = false;
        aviso.textContent = '¡Gracias! Recibimos tus datos y te contactamos en menos de 24 horas hábiles.';
      }
      forma.reset();
    });
  }
})();
