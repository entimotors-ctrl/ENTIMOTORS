# Revisión en tamaño de teléfono

Sirve una copia **sin nube** de `taller-demo/` (nunca habla con Supabase ni con el backend), entra con una cuenta local,
carga «Ver un ejemplo» y mide cada pantalla del Taller y el detalle de las órdenes 1–3 con puntero táctil:

- `chicos`: lo que se toca y mide menos de 44 px.
- `fuera`: lo que se toca y queda fuera de la pantalla a lo ancho.
- `tablasCortadas`: tablas más anchas que su caja.

```bash
~/.venvs/playwright/bin/python -I pruebas/ui-telefono/revisar.py --ancho 360 --salida /tmp/capturas
```

Sale con código 1 si alguna pantalla tiene problemas. Necesita Playwright para Python con el Chrome del sistema (`channel="chrome"`).

## Línea base (3.15.1, 2026-11-08, 360 px)

12 de 13 pantallas con problemas (solo la página principal sale limpia). Lo más grave:
- `orden1`: `tablaItems 426>288` y «Editar renglón» / «Quitar ítem» fuera de la pantalla.
- `clientes`: tabla de 655 px en 328, «Recordar» y «Eliminar cliente» fuera.
- `inventario` (447>328), `finanzas` (522 y 604 >326), `creditos` (527>328): tablas cortadas.
- Botones de 23–36 px en casi todas las pantallas (filtros, selectores del detalle de orden, «Agregar fotos»).
