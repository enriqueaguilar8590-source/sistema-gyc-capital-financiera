# Contabilidad integral de GYC Capital — diagnóstico y estado (etapa 1)

Fecha: 26/10/2026. Inicio contable previsto: 01/11/2026. Apertura: 31/10/2026.

## 1. Cómo está hecho el sistema hoy (verificado en el código)

- Una sola aplicación: `public/sistema.html` (lógica y pantallas) + `public/gyc-rules.js` (reglas puras, con pruebas).
- Todos los datos viven en **un único objeto JSON** (`db`): clientes `cli`, créditos `cre`, cobros `pag`, configuración `cfg`, `conta`, `socios`, `aportes`, `hist`, `trash`. Se guarda en la nube en la tabla `workspace` (una fila, columna `data jsonb`, con número de versión) y se fusiona entre dispositivos con `src/lib/merge.ts` (por `id`).
- Permisos en servidor: la función `save_workspace` (drizzle/migrations/0002) deja a cobradores y desembolsadores escribir solo `cli`, `cre`, `pag`, `cfg`, `hist`. **Toda clave nueva (por ejemplo `asientos`) queda automáticamente solo para administrador.**
- Intereses: se pactan como un total fijo (`total = cap + cap × %`). Cada cobro (`pag`) guarda `pri` (capital), `int` (interés), `m` (mora), `t` (total), `dis` (mora dispensada) y, si es el caso, `tipo: 'refinanciamiento'` (compensación sin efectivo).
- Los créditos de prueba (`esPrueba`) se excluyen de los informes.

## 2. Qué contabilidad existe y qué le falta

| Existe (`db.conta`) | Problema |
| --- | --- |
| Movimientos sueltos: gasto, ingreso, retiro, activo, pasivo, pago de pasivo, capital | No es partida doble: cada movimiento tiene un solo lado. |
| Utilidad = intereses y mora cobrados + otros ingresos − gastos | Base de caja; no distingue intereses devengados ni no devengados. |
| Balance con "caja estimada" | **La caja se calcula y el patrimonio sale como activos − pasivos**: el balance cuadra por construcción, no por contabilidad. |
| Anulación con marca `anulado` | El registro sigue editable (`applyEntryEdit`); no hay reverso ni asiento inmutable. |
| Sin catálogo, diario, mayor, períodos, cierre, conciliación, activos fijos con depreciación, deudas con detalle | Faltaban por completo. |

**El módulo actual se conserva sin cambios** hasta que se apruebe la apertura; no se borra ni se migra automáticamente.

## 3. Riesgos detectados

1. Duplicar operaciones: el mismo cobro o desembolso contabilizado dos veces (dos dispositivos, doble clic). Mitigación: cada asiento de origen lleva una clave única (`cobro:RC0001`, `desembolso:CRE0001`) y el id del asiento se deriva de ella.
2. Numeración de asientos repetida al sincronizar dos dispositivos. Mitigación: renumeración solo de asientos aún no aceptados en la nube + disparador en el servidor que rechaza números repetidos.
3. Mezcla de fondos personales y de la financiera: por eso el motor **exige** decidir el tratamiento (aporte, por pagar al propietario, retiro o cuenta por cobrar) y nunca lo asume.
4. La mora ya cobrada no se debe reconocer dos veces; la mora dispensada no genera asiento.
5. Reconocimiento de intereses fijos: no se reconocen como utilidad al desembolsar.

## 4. Qué se entregó en esta etapa (probado)

| Pieza | Archivo | Estado |
| --- | --- | --- |
| Motor de partida doble, catálogo ampliable, períodos, reversos, bitácora, mayor, balance de comprobación, balance general, estado de resultados, flujo de efectivo, apertura, conciliación de cartera, caja y bancos, cierre mensual, activos fijos, tablero | `public/gyc-ledger.js` | Hecho y probado |
| 33 pruebas (las 20 obligatorias + 13 adicionales) | `src/test/gyc-ledger.test.ts` | 33 de 33 correctas ejecutadas con Node; la suite Vitest no se pudo correr en este entorno (no instala dependencias) |
| Protección en la base de datos del libro diario (inmutabilidad, bitácora, números y operaciones únicas, asientos cuadrados, períodos cerrados) | `docs/contabilidad/0003_integridad_libro_diario.sql` | Probada en un PostgreSQL 16 temporal con 9 casos; **no aplicada** a la base real |

### Reglas de contabilización implementadas

- **Desembolso confirmado:** Dr Cartera capital; Cr Caja/Banco por el neto entregado. Con política `devengo_cuota` además Dr Intereses por cobrar y Cr Intereses no devengados por el total contractual. Con descuento por refinanciamiento: Cr Compensación transitoria (queda en cero al contabilizar el cobro tipo refinanciamiento).
- **Devengo por cuota:** Dr Intereses no devengados; Cr Ingresos por intereses (una vez por crédito y cuota).
- **Cobro:** Dr Caja/Banco; Cr Capital; Cr Intereses por cobrar (o ingreso si la política es "al cobro"); Cr Mora. Si se cobra interés antes de devengarlo, se devenga en el mismo asiento. Solo-dispensa de mora: sin asiento.
- **Gastos:** pagado, pendiente (cuenta por pagar), pagado por el propietario (por pagar o aporte, a elegir) y adquisición de activo.
- **Propietario:** aporte, retiro, préstamo, reembolso y gasto personal (retiro o cuenta por cobrar, a elegir).
- **Deudas:** recibido, pago de principal, pago de intereses (gasto financiero).
- **Transferencias** entre cajas/bancos propios: sin ingreso ni gasto.
- **Diferencia de caja:** nunca automática; exige aprobador y resultado de la investigación.

## 5. Lo que NO está hecho todavía (no se afirma como terminado)

1. **Pantallas** de contabilidad nueva (catálogo, diario, mayor, apertura, cierre, conciliaciones, estados): no existen; el motor aún no está cargado en `sistema.html`.
2. **Conexión automática** con `saveCre` y `confirmPay` (contabilizar al desembolsar y al cobrar). Hoy el motor solo genera los asientos cuando se le invoca.
3. **Contabilización pendiente de cobradores:** los cobros de cobradores los contabilizará el administrador (proceso idempotente por clave de origen), porque el servidor solo le permite a él escribir `asientos`.
4. Rol nuevo `contador`: el motor lo reconoce, pero la tabla de miembros del servidor no lo admite todavía.
5. Importación de auxiliares para la apertura (el motor valida y concilia; falta la carga desde archivo).
6. Devengo automático mensual y estimación de pérdidas crediticias.
7. Aplicar `0003_integridad_libro_diario.sql` en la base real.

## 6. Datos que deben conciliarse manualmente antes del 01/11/2026

- Efectivo real de cada caja y saldo de cada cuenta bancaria al 31/10 (arqueo y extracto).
- Cartera: por cada crédito activo, capital pendiente e intereses pendientes (el motor propone `saldo × cap/total`; confirmar contra el sistema).
- Intereses ya devengados frente a no devengados de cada crédito al 31/10.
- Préstamos recibidos y otras deudas, con acreedor, saldo y condiciones.
- Aportes y retiros del propietario sustentados; separación de fondos personales.
- Activos fijos con costo y fecha de compra.

## 7. Decisiones que debe validar un contador local

1. **Reconocimiento de los intereses fijos:** `devengo_cuota` (lineal por cuota) o `al_cobro`. Está parametrizado en `cfg.conta.politicaIntereses` y **sin valor por defecto**: mientras no se defina, el motor no contabiliza desembolsos ni cobros.
2. Si los intereses cobrados por adelantado se devengan al cobrarse (como hoy) o se difieren.
3. Reconocer la mora al cobrarse (así está) o devengarla.
4. Marco contable aplicable y catálogo definitivo (el actual es una base ampliable, **no** un catálogo oficial).
5. Umbral de materialidad para activos fijos (`cfg.conta.umbralActivoFijo`; sin él, cada bien se confirma a mano).
6. Estimación por pérdidas crediticias y criterios de castigo.
7. Tratamiento tributario de intereses, mora y retiros.

## 8. Respaldo y recuperación

- Antes de activar nada, descargar un respaldo con "💾 RESPALDAR" en Ajustes → Sistema (el sistema también hace uno cada viernes).
- Esta etapa no modifica datos existentes: añade un archivo y documentos. Para revertirla basta volver al commit anterior (`138e426`).
- El disparador de la base se quita con `DROP TRIGGER guard_ledger ON public.workspace; DROP FUNCTION public.guard_ledger();`.

## 9. Cómo usarlo cuando se conecte a las pantallas

```js
// sistema.html (etapa 2): <script src="/gyc-ledger.js"></script>
GycLedger.ensureCatalog(db, ctx);
GycLedger.post(db, GycLedger.rules.cobro(db, pag, cre, {medio: 'caja'}).draft, ctx);
```
`ctx = {usuario, rol, hoy, ahora}`.
