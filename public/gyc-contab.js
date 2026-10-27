/* GYC Capital — motor contable de partida doble.
 * Reglas puras (sin DOM) para poder probarlas. Todo vive en db.pd (una sola llave nueva del workspace,
 * solo administrador en el servidor). Los asientos contabilizados nunca se editan ni se borran: se reversan.
 * Los importes se manejan en centavos enteros para que los débitos y créditos cuadren exactamente.
 */
(function(root) {
    'use strict';
    const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
    const ct = n => Math.round((Number(n) || 0) * 100);
    const fromCt = c => c / 100;
    const ISO = /^\d{4}-\d{2}-\d{2}$/;
    const validISO = d => { if (!ISO.test(d || '')) return false; const t = new Date(d + 'T12:00:00Z'); return !isNaN(t) && t.toISOString().slice(0, 10) === d; };
    const monthEnd = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
    const addDaysISO = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
    const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
    const normRole = r => ({ owner: 'admin', gestor: 'cobrador' })[r] || r;
    let seq = 0;
    const newId = p => { try { if (root.crypto && root.crypto.randomUUID) return p + '_' + root.crypto.randomUUID(); } catch (e) {} seq++; return p + '_' + Date.now().toString(36) + seq.toString(36) + Math.random().toString(36).slice(2, 8); };
    // Convierte fechas del sistema (ISO o d/m/aaaa) a AAAA-MM-DD usando la misma lógica de GycRules si está cargada.
    const defaultToKey = v => { if (ISO.test(v || '')) return v; if (root.GycRules && root.GycRules.dateKey) return root.GycRules.dateKey(v); return ''; };

    // ---------------------------------------------------------------- PERMISOS
    const ACC_PERMS = { ver: 'Consultar', borrador: 'Crear borradores', contabilizar: 'Contabilizar', aprobar: 'Aprobar ajustes', reversar: 'Anular mediante reverso', periodos: 'Abrir o cerrar períodos', catalogo: 'Administrar el catálogo', auditoria: 'Consultar auditoría' };
    // Solo el administrador de la nube puede tocar lo contable (el servidor lo exige). El usuario interno puede restringirse con user.cp.
    function canAcc(cloudRole, user, perm) {
        if (!user || !ACC_PERMS[perm]) return false;
        if (normRole(cloudRole) !== 'admin' || normRole(user.r) !== 'admin') return false;
        return !Array.isArray(user.cp) || user.cp.includes(perm);
    }

    // ---------------------------------------------------------------- CATÁLOGO BASE (configurable; no es un catálogo regulatorio oficial)
    // [cod, nombre, padre, grupo, naturaleza, tipo, movimiento, restricción]
    const CUENTAS_BASE = [
        ['1', 'ACTIVOS', null, 'Activo', 'D', 'grupo', false],
        ['1.1', 'Efectivo y equivalentes', '1', 'Activo', 'D', 'grupo', false],
        ['1.1.01', 'Caja general', '1.1', 'Activo', 'D', 'efectivo', true],
        ['1.1.02', 'Cajas por responsable', '1.1', 'Activo', 'D', 'grupo', false],
        ['1.1.03', 'Bancos', '1.1', 'Activo', 'D', 'grupo', false],
        ['1.1.04', 'Otros medios de pago', '1.1', 'Activo', 'D', 'efectivo', true],
        ['1.2', 'Cartera de créditos', '1', 'Activo', 'D', 'grupo', false],
        ['1.2.01', 'Cartera de créditos: capital pendiente', '1.2', 'Activo', 'D', 'cartera', true, 'sistema'],
        ['1.2.02', 'Intereses contractuales por cobrar', '1.2', 'Activo', 'D', 'cartera', true, 'sistema'],
        ['1.2.03', 'Intereses contractuales no devengados', '1.2', 'Activo', 'A', 'cartera', true, 'sistema'],
        ['1.2.04', 'Estimación por pérdidas crediticias', '1.2', 'Activo', 'A', 'estimacion', true],
        ['1.2.99', 'Refinanciamientos por compensar (transitoria)', '1.2', 'Activo', 'D', 'transitoria', true],
        ['1.3', 'Otros activos', '1', 'Activo', 'D', 'grupo', false],
        ['1.3.01', 'Anticipos y otros activos', '1.3', 'Activo', 'D', 'otro', true],
        ['1.3.02', 'Cuentas por cobrar al propietario', '1.3', 'Activo', 'D', 'otro', true],
        ['1.4', 'Propiedad, mobiliario y equipo', '1', 'Activo', 'D', 'grupo', false],
        ['1.4.01', 'Mobiliario y equipo', '1.4', 'Activo', 'D', 'activo_fijo', true],
        ['1.4.02', 'Equipo de cómputo y comunicación', '1.4', 'Activo', 'D', 'activo_fijo', true],
        ['1.4.99', 'Depreciación acumulada', '1.4', 'Activo', 'A', 'depreciacion', true, 'sistema'],
        ['2', 'PASIVOS', null, 'Pasivo', 'A', 'grupo', false],
        ['2.1', 'Obligaciones', '2', 'Pasivo', 'A', 'grupo', false],
        ['2.1.01', 'Préstamos recibidos', '2.1', 'Pasivo', 'A', 'deuda', true],
        ['2.1.02', 'Préstamos del propietario', '2.1', 'Pasivo', 'A', 'deuda', true],
        ['2.1.03', 'Deudas con terceros', '2.1', 'Pasivo', 'A', 'deuda', true],
        ['2.1.04', 'Obligaciones por pagar a proveedores', '2.1', 'Pasivo', 'A', 'por_pagar', true],
        ['2.1.05', 'Gastos acumulados pendientes de pago', '2.1', 'Pasivo', 'A', 'por_pagar', true],
        ['2.1.06', 'Intereses por pagar', '2.1', 'Pasivo', 'A', 'por_pagar', true],
        ['2.1.09', 'Otras obligaciones', '2.1', 'Pasivo', 'A', 'otro', true],
        ['3', 'PATRIMONIO', null, 'Patrimonio', 'A', 'grupo', false],
        ['3.1', 'Capital aportado', '3', 'Patrimonio', 'A', 'capital', true],
        ['3.2', 'Aportes adicionales', '3', 'Patrimonio', 'A', 'capital', true],
        ['3.3', 'Retiros del propietario', '3', 'Patrimonio', 'D', 'retiros', true],
        ['3.4', 'Resultados acumulados', '3', 'Patrimonio', 'A', 'resultados', true],
        ['3.5', 'Resultado del ejercicio', '3', 'Patrimonio', 'A', 'resultados', true, 'sistema'],
        ['3.6', 'Diferencia de apertura pendiente de conciliar (excepción)', '3', 'Patrimonio', 'A', 'excepcion', true, 'sistema'],
        ['4', 'INGRESOS', null, 'Ingreso', 'A', 'grupo', false],
        ['4.1', 'Ingresos', '4', 'Ingreso', 'A', 'grupo', false],
        ['4.1.01', 'Ingresos financieros por intereses', '4.1', 'Ingreso', 'A', 'ingreso', true, 'sistema'],
        ['4.1.02', 'Ingresos por mora reconocidos', '4.1', 'Ingreso', 'A', 'ingreso', true, 'sistema'],
        ['4.1.03', 'Otros ingresos autorizados', '4.1', 'Ingreso', 'A', 'ingreso', true],
        ['4.1.05', 'Sobrantes de caja', '4.1', 'Ingreso', 'A', 'ingreso', true, 'sistema'],
        ['5', 'GASTOS', null, 'Gasto', 'D', 'grupo', false],
        ['5.1', 'Gastos', '5', 'Gasto', 'D', 'grupo', false],
        ['5.1.01', 'Gastos administrativos', '5.1', 'Gasto', 'D', 'gasto', true],
        ['5.1.02', 'Transporte y cobro', '5.1', 'Gasto', 'D', 'gasto', true],
        ['5.1.03', 'Comisiones', '5.1', 'Gasto', 'D', 'gasto', true],
        ['5.1.04', 'Gastos bancarios', '5.1', 'Gasto', 'D', 'gasto', true],
        ['5.1.05', 'Alquiler y servicios', '5.1', 'Gasto', 'D', 'gasto', true],
        ['5.1.06', 'Papelería y suministros', '5.1', 'Gasto', 'D', 'gasto', true],
        ['5.1.07', 'Depreciación', '5.1', 'Gasto', 'D', 'gasto', true, 'sistema'],
        ['5.1.08', 'Gastos financieros', '5.1', 'Gasto', 'D', 'gasto', true],
        ['5.1.09', 'Pérdidas crediticias y provisiones', '5.1', 'Gasto', 'D', 'gasto', true],
        ['5.1.10', 'Faltantes de caja', '5.1', 'Gasto', 'D', 'gasto', true, 'sistema'],
        ['5.1.99', 'Otros gastos autorizados', '5.1', 'Gasto', 'D', 'gasto', true]
    ];
    const C = { CAJA: '1.1.01', CAPITAL_PEND: '1.2.01', INT_COBRAR: '1.2.02', INT_NO_DEV: '1.2.03', ESTIMACION: '1.2.04', REFI: '1.2.99', CXC_PROP: '1.3.02', DEP_ACUM: '1.4.99', PREST_TERC: '2.1.01', PREST_PROP: '2.1.02', DEUDAS_TERC: '2.1.03', CXP_PROV: '2.1.04', GASTO_ACUM: '2.1.05', CAPITAL: '3.1', APORTES: '3.2', RETIROS: '3.3', RES_ACUM: '3.4', RES_EJER: '3.5', DIF_APERTURA: '3.6', ING_INT: '4.1.01', ING_MORA: '4.1.02', ING_OTROS: '4.1.03', SOBRANTE: '4.1.05', GASTO_ADM: '5.1.01', GASTO_DEP: '5.1.07', GASTO_FIN: '5.1.08', GASTO_PERD: '5.1.09', FALTANTE: '5.1.10' };
    // Tipos de asiento que pueden usar cuentas restringidas (cartera, ingresos del sistema…). Un asiento manual no puede.
    const TIPOS_SISTEMA = ['desembolso', 'cobro', 'devengo', 'apertura', 'reverso', 'ajuste', 'depreciacion', 'ajuste_caja'];
    const TIPOS = ['desembolso', 'cobro', 'devengo', 'apertura', 'reverso', 'ajuste', 'depreciacion', 'ajuste_caja', 'gasto', 'pago_gasto', 'activo', 'aporte', 'retiro', 'prestamo_recibido', 'pago_deuda', 'transferencia', 'propietario', 'manual'];
    const POLITICAS_INTERES = { porVencimiento: 'Se reconoce el interés de cada cuota en su fecha de vencimiento', diario: 'Se reconoce en línea recta por días entre el desembolso y la última cuota', alCobro: 'Se reconoce solo cuando se cobra (base de efectivo)' };

    function cuentaDe(base, ts) { return { cod: base[0], nombre: base[1], padre: base[2], grupo: base[3], naturaleza: base[4], tipo: base[5], movimiento: !!base[6], restriccion: base[7] || '', activa: true, base: true, creada: ts, modificada: ts }; }

    function nuevoPd(usuario, ts) {
        return {
            version: 1,
            cfg: { inicio: '2026-11-01', fechaApertura: '2026-10-31', moneda: 'NIO', politicaInteres: 'alCobro', politicaConfirmada: false, cajaDefault: C.CAJA, cajaPorUsuario: {}, umbralActivoFijo: null, depInicio: 'mesSiguiente', creado: ts, creadoPor: usuario },
            cuentas: CUENTAS_BASE.map(b => cuentaDe(b, ts)),
            asientos: [], periodos: [], apertura: { fecha: '2026-10-31', estado: 'borrador', lineas: [], aux: [], observaciones: '' },
            gastos: [], activos: [], deudas: [], cierresCaja: [], bancoMovs: [], conciliaciones: [], auditoria: []
        };
    }

    // ---------------------------------------------------------------- CATÁLOGO
    const cuenta = (pd, cod) => (pd.cuentas || []).find(c => c.cod === cod) || null;
    const hijos = (pd, cod) => (pd.cuentas || []).filter(c => c.padre === cod);
    const esEfectivo = c => !!c && c.movimiento && (c.tipo === 'efectivo' || c.tipo === 'banco');
    const cuentasEfectivo = pd => (pd.cuentas || []).filter(c => esEfectivo(c) && c.activa);
    function validarCuentaNueva(pd, c) {
        const e = [];
        if (!/^\d+(\.\d+)*$/.test(c.cod || '')) e.push('El código debe ser numérico con puntos (ej. 1.1.03.01).');
        if (cuenta(pd, c.cod)) e.push('Ya existe una cuenta con ese código.');
        if (!String(c.nombre || '').trim()) e.push('Escribe el nombre de la cuenta.');
        const p = cuenta(pd, c.padre);
        if (!p) e.push('Selecciona la cuenta padre.');
        else { if (p.movimiento) e.push('La cuenta padre es de movimiento: debe ser una cuenta agrupadora.'); if (c.cod.indexOf(p.cod + '.') !== 0) e.push('El código debe empezar con el código del padre (' + p.cod + '.).'); }
        return e;
    }
    function agregarCuenta(pd, c, ctx) {
        const e = validarCuentaNueva(pd, c);
        if (e.length) return { ok: false, errores: e };
        const p = cuenta(pd, c.padre);
        const TIPOS_CUENTA = ['efectivo', 'banco', 'cartera', 'estimacion', 'activo_fijo', 'depreciacion', 'deuda', 'por_pagar', 'capital', 'retiros', 'resultados', 'ingreso', 'gasto', 'otro'];
        const porPadre = p.cod === '1.1.03' ? 'banco' : p.cod === '1.1.02' ? 'efectivo' : p.cod === '1.4' ? 'activo_fijo' : p.grupo === 'Gasto' ? 'gasto' : p.grupo === 'Ingreso' ? 'ingreso' : 'otro';
        const nueva = { cod: c.cod, nombre: String(c.nombre).trim(), padre: p.cod, grupo: p.grupo, naturaleza: c.naturaleza === 'D' || c.naturaleza === 'A' ? c.naturaleza : p.naturaleza, tipo: c.movimiento ? (TIPOS_CUENTA.includes(c.tipo) && !['cartera', 'estimacion', 'depreciacion', 'resultados'].includes(c.tipo) ? c.tipo : porPadre) : 'grupo', movimiento: !!c.movimiento, restriccion: '', activa: true, base: false, creada: ctx.ts, modificada: ctx.ts };
        if (p.cod === '1.1.03' && nueva.movimiento) nueva.tipo = 'banco';
        if (p.cod === '1.1.02' && nueva.movimiento) nueva.tipo = 'efectivo';
        pd.cuentas.push(nueva);
        auditar(pd, ctx, 'catalogo.crear', 'Cuenta ' + nueva.cod + ' ' + nueva.nombre, nueva.cod);
        return { ok: true, cuenta: nueva };
    }
    function cuentaUsada(pd, cod) { return pd.asientos.some(a => a.lineas.some(l => l.cuenta === cod)); }
    // Solo se puede renombrar o activar/desactivar. Código, naturaleza y tipo no cambian si la cuenta ya tiene movimientos.
    function editarCuenta(pd, cod, cambios, ctx) {
        const c = cuenta(pd, cod); if (!c) return { ok: false, errores: ['La cuenta no existe.'] };
        const e = [];
        if (cambios.nombre != null) { if (!String(cambios.nombre).trim()) e.push('El nombre no puede quedar vacío.'); else c.nombre = String(cambios.nombre).trim(); }
        if (cambios.activa != null) {
            if (!cambios.activa && c.restriccion === 'sistema') e.push('Las cuentas que usa el sistema no se pueden desactivar.');
            else if (!cambios.activa && Math.abs(saldoCuenta(pd, cod)) > 0.005) e.push('La cuenta tiene saldo: no se puede desactivar.');
            else c.activa = !!cambios.activa;
        }
        if (e.length) return { ok: false, errores: e };
        c.modificada = ctx.ts;
        auditar(pd, ctx, 'catalogo.editar', 'Cuenta ' + cod + ' ' + JSON.stringify(cambios), cod);
        return { ok: true, cuenta: c };
    }

    // ---------------------------------------------------------------- AUDITORÍA
    function auditar(pd, ctx, accion, detalle, ref) {
        if (!pd.auditoria) pd.auditoria = [];
        pd.auditoria.push({ id: newId('au'), ts: ctx.ts, usuario: ctx.usuario || '', accion, detalle: String(detalle || '').slice(0, 400), ref: ref || '' });
    }

    // ---------------------------------------------------------------- PERÍODOS
    const periodoDe = f => String(f || '').slice(0, 7);
    const buscarPeriodo = (pd, ym) => (pd.periodos || []).find(p => p.id === ym) || null;
    const periodoCerrado = (pd, ym) => { const p = buscarPeriodo(pd, ym); return !!p && p.estado === 'cerrado'; };

    // ---------------------------------------------------------------- ASIENTOS
    function sello(a) {
        const s = JSON.stringify([a.num, a.fecha, a.desc, a.tipo, a.origen, a.origenId, a.clave, a.reversaDe, a.lineas.map(l => [l.cuenta, ct(l.debe), ct(l.haber), l.ref || ''])]);
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }
    const postedList = pd => (pd.asientos || []).filter(a => a.estado === 'contabilizado');
    const reversadoPor = (pd, id) => (pd.asientos || []).find(a => a.estado === 'contabilizado' && a.reversaDe === id) || null;
    const claveUsada = (pd, clave, exceptId) => !!clave && (pd.asientos || []).some(a => a.clave === clave && a.id !== exceptId);

    function normLineas(ls) { return (ls || []).map(l => ({ cuenta: String(l.cuenta || ''), debe: r2(l.debe), haber: r2(l.haber), desc: String(l.desc || '').slice(0, 200), ref: l.ref ? String(l.ref) : '' })); }

    // Valida un asiento (candidato) antes de contabilizar. Devuelve la lista de errores en español.
    function validarAsiento(pd, a, ctx) {
        const e = [];
        ctx = ctx || {};
        const cfg = pd.cfg || {};
        if (!validISO(a.fecha)) e.push('La fecha contable no es válida.');
        else {
            if (ctx.hoy && a.fecha > ctx.hoy) e.push('La fecha contable no puede ser futura.');
            if (a.tipo === 'apertura') { if (a.fecha !== cfg.fechaApertura) e.push('El asiento de apertura debe tener fecha ' + cfg.fechaApertura + '.'); }
            else {
                if (a.fecha < cfg.inicio) e.push('Las operaciones anteriores a ' + cfg.inicio + ' están representadas en los saldos de apertura y no se vuelven a contabilizar.');
                if (periodoCerrado(pd, periodoDe(a.fecha))) e.push('El período ' + periodoDe(a.fecha) + ' está cerrado. Registra la operación en un período abierto o reabre el período con autorización.');
            }
        }
        if (!TIPOS.includes(a.tipo)) e.push('Tipo de operación no válido.');
        if (String(a.desc || '').trim().length < 3) e.push('Escribe una descripción del asiento.');
        const ls = a.lineas || [];
        if (ls.length < 2) e.push('Un asiento necesita al menos dos líneas.');
        let d = 0, h = 0;
        ls.forEach((l, i) => {
            const c = cuenta(pd, l.cuenta);
            const n = i + 1;
            if (!c) { e.push('Línea ' + n + ': la cuenta ' + l.cuenta + ' no existe.'); return; }
            if (!c.movimiento) e.push('Línea ' + n + ': ' + c.cod + ' es una cuenta agrupadora; usa una cuenta de movimiento.');
            if (!c.activa) e.push('Línea ' + n + ': la cuenta ' + c.cod + ' está inactiva.');
            if (c.restriccion === 'sistema' && !TIPOS_SISTEMA.includes(a.tipo)) e.push('Línea ' + n + ': la cuenta ' + c.cod + ' solo la mueve el sistema (desembolsos, cobros, devengo…).');
            if (a.tipo === 'ajuste' && c.restriccion === 'sistema' && c.tipo === 'cartera' && !l.ref) e.push('Línea ' + n + ': un ajuste sobre cartera debe indicar el crédito (referencia).');
            const dv = Number(l.debe), hv = Number(l.haber);
            if (!Number.isFinite(dv) || !Number.isFinite(hv) || dv < 0 || hv < 0) { e.push('Línea ' + n + ': importe no válido.'); return; }
            if ((ct(dv) > 0) === (ct(hv) > 0)) e.push('Línea ' + n + ': cada línea debe tener importe en el debe o en el haber, no en ambos ni en ninguno.');
            d += ct(dv); h += ct(hv);
        });
        if (d !== h) e.push('El asiento está descuadrado: débitos ' + fromCt(d).toFixed(2) + ' ≠ créditos ' + fromCt(h).toFixed(2) + '.');
        if (d <= 0) e.push('El asiento no tiene importe.');
        if (a.clave && claveUsada(pd, a.clave, a.id)) e.push('Esta operación ya fue contabilizada (clave ' + a.clave + ').');
        if (a.reversaDe) {
            const o = (pd.asientos || []).find(x => x.id === a.reversaDe);
            if (!o || o.estado !== 'contabilizado') e.push('El asiento que se quiere reversar no existe o no está contabilizado.');
            else if (reversadoPor(pd, o.id) && reversadoPor(pd, o.id).id !== a.id) e.push('Ese asiento ya fue reversado.');
        }
        return e;
    }

    function armarAsiento(d, ctx) {
        return { id: d.id || newId('as'), num: null, fecha: d.fecha, fechaReg: ctx.ts, desc: String(d.desc || '').trim(), tipo: d.tipo || 'manual', origen: d.origen || 'manual', origenId: d.origenId || '', clave: d.clave || null, usuario: ctx.usuario || '', estado: 'borrador', periodo: periodoDe(d.fecha), lineas: normLineas(d.lineas), refs: d.refs || {}, comprobante: d.comprobante || '', reversaDe: d.reversaDe || null, motivo: d.motivo || '', creado: ctx.ts, contabilizado: null };
    }
    const siguienteNum = pd => postedList(pd).reduce((m, a) => Math.max(m, a.num || 0), 0) + 1;

    // Contabiliza de una vez (crea y postea). Si algo falla no deja nada a medias.
    function postear(pd, datos, ctx) {
        const a = armarAsiento(datos, ctx);
        const errores = validarAsiento(pd, a, ctx);
        if (errores.length) return { ok: false, errores, duplicado: errores.some(x => x.indexOf('ya fue contabilizada') >= 0) };
        a.estado = 'contabilizado'; a.num = siguienteNum(pd); a.contabilizado = ctx.ts; a.sello = sello(a);
        pd.asientos.push(a);
        auditar(pd, ctx, 'asiento.contabilizar', '#' + a.num + ' ' + a.tipo + ' ' + a.desc, a.id);
        return { ok: true, asiento: a };
    }
    function guardarBorrador(pd, datos, ctx) {
        const a = armarAsiento(datos, ctx);
        const e = [];
        if (!validISO(a.fecha)) e.push('La fecha no es válida.');
        if (String(a.desc).length < 3) e.push('Escribe una descripción.');
        if (a.clave && claveUsada(pd, a.clave, a.id)) e.push('Ya existe un asiento para esa operación.');
        if (e.length) return { ok: false, errores: e };
        const prev = (pd.asientos || []).findIndex(x => x.id === a.id);
        if (prev >= 0) { if (pd.asientos[prev].estado !== 'borrador') return { ok: false, errores: ['Un asiento contabilizado no se puede editar. Usa un reverso.'] }; pd.asientos[prev] = a; }
        else pd.asientos.push(a);
        auditar(pd, ctx, 'asiento.borrador', a.desc, a.id);
        return { ok: true, asiento: a };
    }
    function contabilizarBorrador(pd, id, ctx) {
        const a = pd.asientos.find(x => x.id === id);
        if (!a) return { ok: false, errores: ['El borrador no existe.'] };
        if (a.estado !== 'borrador') return { ok: false, errores: ['El asiento ya está contabilizado.'] };
        const errores = validarAsiento(pd, a, ctx);
        if (errores.length) return { ok: false, errores };
        a.estado = 'contabilizado'; a.num = siguienteNum(pd); a.contabilizado = ctx.ts; a.periodo = periodoDe(a.fecha); a.sello = sello(a);
        auditar(pd, ctx, 'asiento.contabilizar', '#' + a.num + ' ' + a.tipo + ' ' + a.desc, a.id);
        return { ok: true, asiento: a };
    }
    function eliminarBorrador(pd, id, ctx) {
        const i = pd.asientos.findIndex(x => x.id === id);
        if (i < 0) return { ok: false, errores: ['No existe.'] };
        if (pd.asientos[i].estado !== 'borrador') return { ok: false, errores: ['Un asiento contabilizado no se elimina: se reversa.'] };
        const [a] = pd.asientos.splice(i, 1);
        auditar(pd, ctx, 'asiento.borrador_eliminado', a.desc, a.id);
        return { ok: true };
    }
    // Un asiento contabilizado jamás se modifica: se crea otro con las líneas invertidas y el motivo documentado.
    function reversar(pd, id, motivo, ctx) {
        const o = pd.asientos.find(x => x.id === id);
        if (!o || o.estado !== 'contabilizado') return { ok: false, errores: ['El asiento no existe o no está contabilizado.'] };
        if (String(motivo || '').trim().length < 10) return { ok: false, errores: ['Escribe el motivo del reverso (mínimo 10 caracteres).'] };
        if (o.tipo === 'reverso') return { ok: false, errores: ['Un reverso no se reversa: registra un asiento nuevo documentado.'] };
        if (o.tipo === 'apertura') return { ok: false, errores: ['La apertura no se reversa desde aquí.'] };
        if (reversadoPor(pd, id)) return { ok: false, errores: ['Ese asiento ya fue reversado.'] };
        let fecha = ctx.fechaReverso || o.fecha;
        if (periodoCerrado(pd, periodoDe(fecha))) fecha = ctx.hoy;
        const r = postear(pd, { fecha, desc: 'REVERSO #' + o.num + ' — ' + o.desc, tipo: 'reverso', origen: 'reverso', origenId: o.id, clave: 'reverso:' + o.id, reversaDe: o.id, motivo: String(motivo).trim(), comprobante: o.comprobante, refs: o.refs, lineas: o.lineas.map(l => ({ cuenta: l.cuenta, debe: l.haber, haber: l.debe, desc: 'Reverso: ' + (l.desc || ''), ref: l.ref })) }, ctx);
        if (r.ok) auditar(pd, ctx, 'asiento.reverso', '#' + o.num + ' → #' + r.asiento.num + ': ' + motivo, o.id);
        return r;
    }
    // Ejecuta varias operaciones como una sola: si algo lanza una excepción, todo vuelve a como estaba.
    function transaccion(pd, fn) {
        const largos = {}, objetos = {};
        Object.keys(pd).forEach(k => { if (Array.isArray(pd[k])) largos[k] = pd[k].length; else if (pd[k] && typeof pd[k] === 'object') objetos[k] = JSON.stringify(pd[k]); });
        try { return fn(); } catch (e) {
            Object.keys(largos).forEach(k => { pd[k].length = largos[k]; });
            Object.keys(objetos).forEach(k => { pd[k] = JSON.parse(objetos[k]); });
            throw e;
        }
    }

    // ---------------------------------------------------------------- SALDOS, DIARIO, MAYOR, BALANCES
    // Todo sale de los asientos contabilizados. Nunca de valores guardados aparte.
    function acumular(pd, desde, hasta, filtro) {
        const m = new Map();
        for (const a of pd.asientos || []) {
            if (a.estado !== 'contabilizado') continue;
            if (desde && a.fecha < desde) continue;
            if (hasta && a.fecha > hasta) continue;
            if (filtro && !filtro(a)) continue;
            for (const l of a.lineas) { const x = m.get(l.cuenta) || { debe: 0, haber: 0 }; x.debe += ct(l.debe); x.haber += ct(l.haber); m.set(l.cuenta, x); }
        }
        return m;
    }
    const natCt = (c, x) => !x ? 0 : (c.naturaleza === 'D' ? x.debe - x.haber : x.haber - x.debe);
    function saldoCuenta(pd, cod, hasta, desde) {
        const c = cuenta(pd, cod); if (!c) return 0;
        const m = acumular(pd, desde || null, hasta || null);
        const cods = c.movimiento ? [cod] : descendientesMov(pd, cod);
        return fromCt(cods.reduce((s, k) => { const cc = cuenta(pd, k); return s + natCt(cc, m.get(k)) * (cc.naturaleza === c.naturaleza ? 1 : -1); }, 0));
    }
    function descendientesMov(pd, cod) {
        const out = [];
        const rec = k => hijos(pd, k).forEach(h => { if (h.movimiento) out.push(h.cod); rec(h.cod); });
        const c = cuenta(pd, cod); if (c && c.movimiento) return [cod];
        rec(cod); return out;
    }
    function libroDiario(pd, desde, hasta) {
        const filas = postedList(pd).filter(a => (!desde || a.fecha >= desde) && (!hasta || a.fecha <= hasta)).sort((a, b) => a.num - b.num);
        return { titulo: 'Libro diario', desde, hasta, asientos: filas.map(a => ({ num: a.num, fecha: a.fecha, desc: a.desc, tipo: a.tipo, usuario: a.usuario, comprobante: a.comprobante, reversaDe: a.reversaDe, reversado: !!reversadoPor(pd, a.id), lineas: a.lineas.map(l => Object.assign({ nombre: (cuenta(pd, l.cuenta) || {}).nombre || '' }, l)) })) };
    }
    function mayor(pd, cod, desde, hasta) {
        const c = cuenta(pd, cod); if (!c) return null;
        const cods = new Set(c.movimiento ? [cod] : descendientesMov(pd, cod));
        const signo = k => (cuenta(pd, k).naturaleza === c.naturaleza ? 1 : -1);
        let ini = 0;
        const movs = [];
        for (const a of postedList(pd).sort((x, y) => x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : x.num - y.num)) {
            a.lineas.forEach((l, i) => {
                if (!cods.has(l.cuenta)) return;
                const dv = ct(l.debe), hv = ct(l.haber);
                const nat = cuenta(pd, l.cuenta).naturaleza;
                const ef = (nat === 'D' ? dv - hv : hv - dv) * signo(l.cuenta);
                if (desde && a.fecha < desde) { ini += ef; return; }
                if (hasta && a.fecha > hasta) return;
                movs.push({ fecha: a.fecha, num: a.num, asientoId: a.id, linea: i, cuenta: l.cuenta, desc: l.desc || a.desc, ref: l.ref, debe: fromCt(dv), haber: fromCt(hv), ef });
            });
        }
        let run = ini, deb = 0, cre = 0;
        movs.forEach(m => { run += m.ef; m.saldo = fromCt(run); deb += ct(m.debe); cre += ct(m.haber); });
        return { cuenta: c, desde, hasta, saldoInicial: fromCt(ini), debitos: fromCt(deb), creditos: fromCt(cre), saldoFinal: fromCt(run), movimientos: movs };
    }
    function balanceComprobacion(pd, hasta, desde) {
        const acum = acumular(pd, null, hasta);
        const per = desde ? acumular(pd, desde, hasta) : null;
        const filas = []; let td = 0, th = 0, sd = 0, sa = 0;
        for (const c of pd.cuentas) {
            if (!c.movimiento) continue;
            const x = acum.get(c.cod); if (!x) continue;
            const neto = x.debe - x.haber;
            const f = { cod: c.cod, nombre: c.nombre, debe: fromCt(x.debe), haber: fromCt(x.haber), deudor: neto > 0 ? fromCt(neto) : 0, acreedor: neto < 0 ? fromCt(-neto) : 0 };
            if (per && per.get(c.cod)) { f.debePeriodo = fromCt(per.get(c.cod).debe); f.haberPeriodo = fromCt(per.get(c.cod).haber); }
            filas.push(f); td += x.debe; th += x.haber; sd += neto > 0 ? neto : 0; sa += neto < 0 ? -neto : 0;
        }
        filas.sort((a, b) => a.cod.localeCompare(b.cod, undefined, { numeric: true }));
        return { titulo: 'Balance de comprobación', hasta, filas, totales: { debe: fromCt(td), haber: fromCt(th), deudor: fromCt(sd), acreedor: fromCt(sa) }, cuadra: td === th && sd === sa };
    }
    const GRUPO_NATURAL = { Activo: 'D', Pasivo: 'A', Patrimonio: 'A', Ingreso: 'A', Gasto: 'D' };
    // Valor presentado de una cuenta dentro de su grupo (las cuentas "contra" restan).
    function valorGrupo(pd, acum, c) { const x = acum.get(c.cod); const nat = natCt(c, x); return c.naturaleza === GRUPO_NATURAL[c.grupo] ? nat : -nat; }
    function resultadoEntre(pd, desde, hasta) {
        const acum = acumular(pd, desde, hasta); let ing = 0, gas = 0;
        for (const c of pd.cuentas) { if (!c.movimiento) continue; if (c.grupo === 'Ingreso') ing += valorGrupo(pd, acum, c); if (c.grupo === 'Gasto') gas += valorGrupo(pd, acum, c); }
        return { ingresos: fromCt(ing), gastos: fromCt(gas), neto: fromCt(ing - gas) };
    }
    function listaGrupo(pd, acum, grupo) {
        const filas = [];
        for (const c of pd.cuentas) { if (!c.movimiento || c.grupo !== grupo) continue; const v = valorGrupo(pd, acum, c); if (v !== 0) filas.push({ cod: c.cod, nombre: c.nombre, saldo: fromCt(v), contra: c.naturaleza !== GRUPO_NATURAL[grupo] }); }
        filas.sort((a, b) => a.cod.localeCompare(b.cod, undefined, { numeric: true }));
        return filas;
    }
    function balanceGeneral(pd, hasta, extra) {
        const acum = acumular(pd, null, hasta);
        const activos = listaGrupo(pd, acum, 'Activo'), pasivos = listaGrupo(pd, acum, 'Pasivo'), patr = listaGrupo(pd, acum, 'Patrimonio');
        const sum = a => a.reduce((s, f) => s + ct(f.saldo), 0);
        const anio = hasta.slice(0, 4);
        const total = resultadoEntre(pd, null, hasta), ejer = resultadoEntre(pd, anio + '-01-01', hasta);
        const resEjer = ct(ejer.neto), resAnt = ct(total.neto) - resEjer;
        if (resAnt !== 0) patr.push({ cod: '', nombre: 'Resultados de ejercicios anteriores (sin cerrar)', saldo: fromCt(resAnt), contra: false });
        patr.push({ cod: '3.5', nombre: 'Resultado del ejercicio ' + anio, saldo: fromCt(resEjer), contra: false, calculado: true });
        const tA = sum(activos), tP = sum(pasivos), tPat = sum(patr);
        const advertencias = advertenciasGenerales(pd, hasta, extra);
        return { titulo: 'Balance general', hasta, activos, pasivos, patrimonio: patr, totalActivos: fromCt(tA), totalPasivos: fromCt(tP), totalPatrimonio: fromCt(tPat), diferencia: fromCt(tA - tP - tPat), cuadra: tA === tP + tPat, advertencias, definitivo: advertencias.length === 0 };
    }
    function estadoResultados(pd, desde, hasta, extra) {
        const acum = acumular(pd, desde, hasta);
        const ing = listaGrupo(pd, acum, 'Ingreso'), gas = listaGrupo(pd, acum, 'Gasto');
        const perd = gas.filter(f => f.cod === C.GASTO_PERD);
        const tI = ing.reduce((s, f) => s + ct(f.saldo), 0), tG = gas.reduce((s, f) => s + ct(f.saldo), 0);
        const advertencias = advertenciasGenerales(pd, hasta, extra);
        return { titulo: 'Estado de resultados', desde, hasta, ingresos: ing, gastos: gas, perdidasCrediticias: perd, totalIngresos: fromCt(tI), totalGastos: fromCt(tG), resultadoNeto: fromCt(tI - tG), advertencias, definitivo: advertencias.length === 0 };
    }
    // Flujo de efectivo (método directo). Cada entrada de efectivo se clasifica según las cuentas de contrapartida.
    function claseFlujo(c) {
        if (!c) return 'operacion';
        if (c.tipo === 'activo_fijo' || c.tipo === 'depreciacion') return 'inversion';
        if (c.tipo === 'deuda' || c.tipo === 'capital' || c.tipo === 'retiros' || c.tipo === 'excepcion') return 'financiacion';
        return 'operacion';
    }
    function flujoEfectivo(pd, desde, hasta, extra) {
        const efectivo = new Set((pd.cuentas || []).filter(esEfectivo).map(c => c.cod));
        const ini = (() => { const m = acumular(pd, null, addDaysISO(desde, -1)); let s = 0; efectivo.forEach(k => { const x = m.get(k); if (x) s += x.debe - x.haber; }); return s; })();
        const det = { operacion: new Map(), inversion: new Map(), financiacion: new Map() };
        let net = 0;
        for (const a of postedList(pd)) {
            if (a.fecha < desde || a.fecha > hasta) continue;
            const noEf = a.lineas.filter(l => !efectivo.has(l.cuenta));
            const efLin = a.lineas.filter(l => efectivo.has(l.cuenta));
            const delta = efLin.reduce((s, l) => s + ct(l.debe) - ct(l.haber), 0);
            if (delta === 0) continue;
            net += delta;
            // El efectivo que entra equivale al crédito neto de las líneas que no son efectivo.
            noEf.forEach(l => {
                const c = cuenta(pd, l.cuenta); const clase = claseFlujo(c);
                const aporte = ct(l.haber) - ct(l.debe);
                const k = c ? c.cod + ' ' + c.nombre : l.cuenta;
                det[clase].set(k, (det[clase].get(k) || 0) + aporte);
            });
        }
        const clases = ['operacion', 'inversion', 'financiacion'].map(k => { const filas = [...det[k].entries()].filter(([, v]) => v !== 0).map(([n, v]) => ({ concepto: n, importe: fromCt(v) })); return { clase: k, filas, total: fromCt([...det[k].values()].reduce((s, v) => s + v, 0)) }; });
        const fin = ini + net;
        const advertencias = advertenciasGenerales(pd, hasta, extra);
        const sumaClases = clases.reduce((s, c) => s + ct(c.total), 0);
        return { titulo: 'Estado de flujos de efectivo', desde, hasta, clases, efectivoInicial: fromCt(ini), variacion: fromCt(net), efectivoFinal: fromCt(fin), cuadra: sumaClases === net, advertencias, definitivo: advertencias.length === 0 };
    }

    // ---------------------------------------------------------------- INTEGRIDAD
    function verificarIntegridad(pd) {
        const p = [];
        const nums = new Map(), claves = new Map();
        postedList(pd).forEach(a => {
            let d = 0, h = 0; a.lineas.forEach(l => { d += ct(l.debe); h += ct(l.haber); });
            if (d !== h) p.push('Asiento #' + a.num + ' descuadrado.');
            if (a.sello && a.sello !== sello(a)) p.push('Asiento #' + a.num + ' fue modificado después de contabilizarse.');
            nums.set(a.num, (nums.get(a.num) || 0) + 1);
            a.lineas.forEach(l => { if (!cuenta(pd, l.cuenta)) p.push('Asiento #' + a.num + ' usa una cuenta inexistente: ' + l.cuenta); });
        });
        (pd.asientos || []).forEach(a => { if (a.clave) claves.set(a.clave, (claves.get(a.clave) || 0) + 1); });
        nums.forEach((v, k) => { if (v > 1) p.push('Número de asiento duplicado: ' + k); });
        claves.forEach((v, k) => { if (v > 1) p.push('Operación contabilizada dos veces: ' + k); });
        const max = [...nums.keys()].reduce((m, k) => Math.max(m, k), 0);
        for (let i = 1; i <= max; i++) if (!nums.has(i)) { p.push('Falta el asiento número ' + i + ' (secuencia con saltos).'); break; }
        return p;
    }

    // ---------------------------------------------------------------- OPERACIONES DEL SISTEMA → ASIENTOS
    const creEsReal = c => !!c && !c.esPrueba;
    const fechaDesembolso = (c, toKey) => (toKey || defaultToKey)(c.fecDes || c.date) || '';
    const refCre = id => 'cre:' + id;
    const cajaPara = (pd, usuario) => (pd.cfg.cajaPorUsuario && pd.cfg.cajaPorUsuario[usuario]) || pd.cfg.cajaDefault || C.CAJA;
    const enApertura = (pd, creId) => (pd.apertura && pd.apertura.estado === 'aprobada' && (pd.apertura.aux || []).find(x => x.creId === creId)) || null;
    const aperturaAprobada = pd => !!pd.apertura && pd.apertura.estado === 'aprobada';

    function asientoDesembolso(pd, c, cli, opts) {
        opts = opts || {};
        const cap = r2(c.cap), total = r2(c.total), interes = r2(total - cap);
        const caja = opts.cuentaPago || cajaPara(pd, opts.usuarioCaja);
        const nombre = cli ? cli.nom : (c.cliId || '');
        const lineas = [{ cuenta: C.CAPITAL_PEND, debe: cap, haber: 0, desc: 'Capital desembolsado ' + c.id, ref: refCre(c.id) }];
        if (interes > 0) { lineas.push({ cuenta: C.INT_COBRAR, debe: interes, haber: 0, desc: 'Intereses contractuales ' + c.id, ref: refCre(c.id) }); lineas.push({ cuenta: C.INT_NO_DEV, debe: 0, haber: interes, desc: 'Intereses no devengados ' + c.id, ref: refCre(c.id) }); }
        const desc = c.refiDe ? Math.min(cap, Math.max(0, r2(c.descuento || 0))) : 0;
        if (desc > 0) lineas.push({ cuenta: C.REFI, debe: 0, haber: desc, desc: 'Saldo cancelado por refinanciamiento (sin efectivo) ' + c.id, ref: refCre(c.id) });
        lineas.push({ cuenta: caja, debe: 0, haber: r2(cap - desc), desc: 'Salida de efectivo por desembolso ' + c.id, ref: refCre(c.id) });
        return { fecha: fechaDesembolso(c, opts.toKey), desc: 'Desembolso crédito ' + c.id + (c.contrato ? ' / contrato ' + c.contrato : '') + ' — ' + nombre, tipo: 'desembolso', origen: 'cre', origenId: c.id, clave: 'desembolso:' + c.id, refs: { creId: c.id, cliId: c.cliId, contrato: c.contrato || '' }, comprobante: c.contrato || c.id, lineas };
    }
    function asientoCobro(pd, p, c, opts) {
        opts = opts || {};
        const t = r2(p.t), m = r2(p.m), pri = r2(p.pri);
        const int = r2(t - m - pri);
        const errores = [];
        if (Math.abs(int - r2(p.int)) > 0.02) errores.push('El recibo ' + p.id + ' no cuadra: capital + interés + mora ≠ total recibido.');
        if (pri < 0 || int < 0 || m < 0) errores.push('El recibo ' + p.id + ' tiene importes negativos.');
        if (errores.length) return { errores };
        const caja = opts.cuentaCaja || cajaPara(pd, p.cobradorUsuario || p.g);
        const ref = refCre(p.creId);
        const lineas = [{ cuenta: p.tipo === 'refinanciamiento' ? C.REFI : caja, debe: t, haber: 0, desc: (p.tipo === 'refinanciamiento' ? 'Cancelación sin efectivo ' : 'Cobro ') + p.id, ref: 'pag:' + p.id }];
        if (pri > 0) lineas.push({ cuenta: C.CAPITAL_PEND, debe: 0, haber: pri, desc: 'Recuperación de capital ' + p.id, ref });
        if (int > 0) lineas.push({ cuenta: C.INT_COBRAR, debe: 0, haber: int, desc: 'Interés cobrado ' + p.id, ref });
        if (m > 0) lineas.push({ cuenta: C.ING_MORA, debe: 0, haber: m, desc: 'Mora cobrada ' + p.id, ref });
        if (int > 0 && pd.cfg.politicaInteres === 'alCobro') { lineas.push({ cuenta: C.INT_NO_DEV, debe: int, haber: 0, desc: 'Devengo al cobro ' + p.id, ref }); lineas.push({ cuenta: C.ING_INT, debe: 0, haber: int, desc: 'Ingreso por interés ' + p.id, ref }); }
        const refi = p.tipo === 'refinanciamiento';
        return { fecha: (opts.toKey || defaultToKey)(p.fechaISO || p.f), desc: (refi ? 'Cancelación por refinanciamiento ' : 'Cobro ') + p.id + ' crédito ' + p.creId + ' — ' + (p.nom || ''), tipo: 'cobro', origen: 'pag', origenId: p.id, clave: 'cobro:' + p.id, refs: { creId: p.creId, cliId: p.cid, recibo: p.id }, comprobante: p.id, lineas };
    }
    // Asientos de una operación: la clave base y sus re-contabilizaciones (clave#2, clave#3…).
    const entradasDeClave = (pd, base) => (pd.asientos || []).filter(a => a.clave === base || (a.clave && a.clave.indexOf(base + '#') === 0));
    // 'vigente' = hay un asiento activo; 'reversada' = solo hay asientos reversados; 'ninguna' = falta contabilizar.
    function estadoOperacion(pd, base) {
        const l = entradasDeClave(pd, base);
        if (!l.length) return 'ninguna';
        if (l.some(a => a.estado === 'borrador' || (a.estado === 'contabilizado' && !reversadoPor(pd, a.id)))) return 'vigente';
        return 'reversada';
    }
    // Qué operaciones del sistema aún no están en la contabilidad.
    function pendientes(db, pd, opts) {
        opts = opts || {};
        const toKey = opts.toKey || defaultToKey;
        const out = { desembolsos: [], cobros: [], omitidos: [], sinEfecto: [], reversadas: [], advertencia: '' };
        if (!pd) return out;
        if (!aperturaAprobada(pd)) { out.advertencia = 'La apertura contable aún no está aprobada: no se contabilizan operaciones.'; return out; }
        const inicio = pd.cfg.inicio;
        const creMap = new Map((db.cre || []).map(c => [c.id, c]));
        (db.cre || []).forEach(c => {
            if (!creEsReal(c)) return;
            const f = fechaDesembolso(c, toKey);
            if (enApertura(pd, c.id)) return;
            const est = estadoOperacion(pd, 'desembolso:' + c.id);
            if (est !== 'ninguna') { if (est === 'reversada') out.reversadas.push({ tipo: 'desembolso', id: c.id }); return; }
            if (!f || f < inicio) { out.omitidos.push({ tipo: 'desembolso', id: c.id, motivo: 'Crédito con fecha anterior al ' + inicio + ' que no está en la apertura: confirma si debe incluirse en la apertura.' }); return; }
            out.desembolsos.push(c);
        });
        (db.pag || []).forEach(p => {
            const c = creMap.get(p.creId);
            if (!c || !creEsReal(c)) return;
            if (Number(p.t) <= 0.005) { out.sinEfecto.push(p.id); return; }
            const est = estadoOperacion(pd, 'cobro:' + p.id);
            if (est !== 'ninguna') { if (est === 'reversada') out.reversadas.push({ tipo: 'cobro', id: p.id }); return; }
            const f = toKey(p.fechaISO || p.f);
            if (!f || f < inicio) {
                // Cobro anterior al inicio: si el crédito está en la apertura, ya está dentro de sus saldos (solo si se registró antes de aprobar).
                if (enApertura(pd, p.creId) && (pd.apertura.pagosIncluidos || []).includes(p.id)) return;
                out.omitidos.push({ tipo: 'cobro', id: p.id, motivo: 'Cobro con fecha anterior al ' + inicio + ' que no estaba en la apertura: requiere decisión del contador.' });
                return;
            }
            out.cobros.push(p);
        });
        return out;
    }
    function contabilizarPendientes(db, pd, ctx, opts) {
        const pend = pendientes(db, pd, opts);
        const res = { desembolsos: 0, cobros: 0, errores: [], omitidos: pend.omitidos, advertencia: pend.advertencia };
        const cliDe = id => (db.cli || []).find(x => x.id === id);
        pend.desembolsos.sort((a, b) => fechaDesembolso(a, opts && opts.toKey).localeCompare(fechaDesembolso(b, opts && opts.toKey))).forEach(c => {
            const r = transaccion(pd, () => postear(pd, asientoDesembolso(pd, c, cliDe(c.cliId), opts), ctx));
            if (r.ok) res.desembolsos++; else if (!r.duplicado) res.errores.push('Desembolso ' + c.id + ': ' + r.errores.join(' '));
        });
        const toKey = (opts && opts.toKey) || defaultToKey;
        pend.cobros.sort((a, b) => toKey(a.fechaISO || a.f).localeCompare(toKey(b.fechaISO || b.f))).forEach(p => {
            const c = (db.cre || []).find(x => x.id === p.creId);
            const d = asientoCobro(pd, p, c, opts);
            if (d.errores) { res.errores.push(d.errores.join(' ')); return; }
            const r = transaccion(pd, () => postear(pd, d, ctx));
            if (r.ok) res.cobros++; else if (!r.duplicado) res.errores.push('Cobro ' + p.id + ': ' + r.errores.join(' '));
        });
        return res;
    }

    // Después de un reverso, vuelve a contabilizar la operación (p. ej. con otra caja). Queda ligada a la original por la clave "#n".
    function repostear(db, pd, tipo, id, ctx, opts) {
        const base = tipo + ':' + id;
        if (estadoOperacion(pd, base) !== 'reversada') return { ok: false, errores: ['Solo se puede volver a contabilizar una operación cuyo asiento fue reversado.'] };
        const n = entradasDeClave(pd, base).length + 1;
        let d;
        if (tipo === 'desembolso') { const c = (db.cre || []).find(x => x.id === id); if (!c) return { ok: false, errores: ['El crédito ya no existe.'] }; d = asientoDesembolso(pd, c, (db.cli || []).find(x => x.id === c.cliId), opts); }
        else if (tipo === 'cobro') { const p = (db.pag || []).find(x => x.id === id); if (!p) return { ok: false, errores: ['El cobro ya no existe.'] }; d = asientoCobro(pd, p, (db.cre || []).find(x => x.id === p.creId), opts); if (d.errores) return { ok: false, errores: d.errores }; }
        else return { ok: false, errores: ['Tipo no soportado.'] };
        d.clave = base + '#' + n;
        return transaccion(pd, () => postear(pd, d, ctx));
    }

    // ---------------------------------------------------------------- INTERESES: DEVENGO
    // Tipo "de fondo" de un asiento: un reverso cuenta como el tipo del asiento que anula.
    function tipoEfectivo(pd, a) { if (a.tipo !== 'reverso') return a.tipo; const o = (pd.asientos || []).find(x => x.id === a.reversaDe); return o ? o.tipo : a.tipo; }
    function sumaRef(pd, cod, ref, hasta, signo, tipos) {
        let s = 0;
        for (const a of postedList(pd)) {
            if (hasta && a.fecha > hasta) continue;
            if (tipos && !tipos.includes(tipoEfectivo(pd, a))) continue;
            for (const l of a.lineas) if (l.cuenta === cod && l.ref === ref) s += signo === 'D' ? ct(l.debe) - ct(l.haber) : ct(l.haber) - ct(l.debe);
        }
        return fromCt(s);
    }
    function objetivoDevengo(c, hasta, politica, toKey) {
        const I = r2(c.total - c.cap); if (I <= 0 || politica === 'alCobro') return 0;
        toKey = toKey || defaultToKey;
        const dues = (c.schedule || []).map(s => toKey(s.date)).filter(Boolean).sort();
        const n = (c.schedule || []).length || c.plz || 0; if (!n || !dues.length) return 0;
        if (politica === 'diario') {
            const ini = toKey(c.fecDes || c.date), fin = dues[dues.length - 1];
            if (!ini || hasta >= fin) return I; if (hasta <= ini) return 0;
            return Math.min(I, r2(I * daysBetween(ini, hasta) / daysBetween(ini, fin)));
        }
        const k = dues.filter(d => d <= hasta).length;
        return k >= n ? I : r2(I * k / n);
    }
    function infoDevengo(pd, c, hasta, opts) {
        const aux = (pd.apertura && pd.apertura.estado === 'aprobada' && (pd.apertura.aux || []).find(x => x.creId === c.id)) || null;
        const ref = refCre(c.id);
        const base = aux ? aux.devengadoAcum : 0, cobrBase = aux ? aux.paidInt : 0;
        const postDev = sumaRef(pd, C.ING_INT, ref, hasta, 'A');
        const cobrPost = sumaRef(pd, C.INT_COBRAR, ref, hasta, 'A', ['cobro']);
        const I = r2(c.total - c.cap);
        const devengado = r2(base + postDev), cobrado = r2(cobrBase + cobrPost);
        const objetivo = Math.min(I, Math.max(objetivoDevengo(c, hasta, pd.cfg.politicaInteres, opts && opts.toKey), cobrado));
        return { I, devengado, cobrado, objetivo: r2(objetivo), delta: r2(objetivo - devengado) };
    }
    function asientoDevengo(db, pd, mes, opts) {
        const hasta = monthEnd(mes);
        const lineas = [];
        const ids = new Set(postedList(pd).filter(a => a.tipo === 'desembolso' && !reversadoPor(pd, a.id)).map(a => a.origenId));
        (pd.apertura && pd.apertura.estado === 'aprobada' ? pd.apertura.aux : []).forEach(x => ids.add(x.creId));
        (db.cre || []).filter(c => creEsReal(c) && ids.has(c.id)).forEach(c => {
            if (pd.cfg.politicaInteres === 'alCobro') return;
            const i = infoDevengo(pd, c, hasta, opts);
            if (i.delta > 0.004) { lineas.push({ cuenta: C.INT_NO_DEV, debe: i.delta, haber: 0, desc: 'Devengo ' + mes + ' ' + c.id, ref: refCre(c.id) }); lineas.push({ cuenta: C.ING_INT, debe: 0, haber: i.delta, desc: 'Ingreso por interés ' + mes + ' ' + c.id, ref: refCre(c.id) }); }
        });
        return { fecha: hasta, desc: 'Devengo de intereses contractuales ' + mes + ' (política: ' + pd.cfg.politicaInteres + ')', tipo: 'devengo', origen: 'devengo', origenId: mes, clave: 'devengo:' + mes, lineas };
    }
    function registrarDevengo(db, pd, mes, ctx, opts) {
        if (monthEnd(mes) > ctx.hoy) return { ok: false, errores: ['El devengo mensual se registra al terminar el mes.'] };
        const d = asientoDevengo(db, pd, mes, opts);
        if (!d.lineas.length) return { ok: true, vacio: true, mensaje: 'No hay intereses por devengar en ' + mes + '.' };
        return transaccion(pd, () => postear(pd, d, ctx));
    }

    // ---------------------------------------------------------------- GASTOS, PROPIETARIO, DEUDAS, TRANSFERENCIAS
    const cuentaMedio = (pd, cod) => { const c = cuenta(pd, cod); return esEfectivo(c) && c.activa ? c : null; };
    function registrarGasto(pd, g, ctx) {
        const e = [];
        const monto = r2(g.monto);
        if (!(monto > 0)) e.push('El importe debe ser mayor que cero.');
        const cg = cuenta(pd, g.cuentaGasto);
        if (!cg || !cg.movimiento || !cg.activa || (g.esActivo ? cg.tipo !== 'activo_fijo' : cg.grupo !== 'Gasto')) e.push(g.esActivo ? 'Elige una cuenta de activo fijo.' : 'Elige una cuenta de gasto.');
        if (String(g.descripcion || '').trim().length < 3) e.push('Escribe la descripción.');
        const pendiente = g.estadoPago === 'pendiente';
        if (!pendiente && !cuentaMedio(pd, g.medio)) e.push('Elige la caja o banco con que se pagó.');
        if (pendiente && !String(g.proveedor || '').trim()) e.push('Indica el proveedor al que se le debe.');
        if (g.esActivo) {
            if (pd.cfg.umbralActivoFijo != null && monto < Number(pd.cfg.umbralActivoFijo) && !g.confirmaMaterialidad) e.push('El importe está por debajo del umbral de activo fijo (' + pd.cfg.umbralActivoFijo + '). Confirma que quieres reconocerlo como activo.');
            if (!(Number(g.vidaMeses) >= 1)) e.push('Indica la vida útil estimada en meses.');
        }
        if (e.length) return { ok: false, errores: e };
        const id = newId('gt');
        const credit = pendiente ? (g.cuentaPasivo || (g.esActivo ? C.CXP_PROV : C.GASTO_ACUM)) : g.medio;
        const lineas = [{ cuenta: g.cuentaGasto, debe: monto, haber: 0, desc: g.descripcion, ref: g.esActivo ? 'activo:' + id : 'gasto:' + id }, { cuenta: credit, debe: 0, haber: monto, desc: pendiente ? 'Pendiente de pago a ' + g.proveedor : g.descripcion, ref: pendiente ? 'cxp:' + id : 'gasto:' + id }];
        const out = transaccion(pd, () => {
            const r = postear(pd, { fecha: g.fecha, desc: (g.esActivo ? 'Adquisición de activo: ' : 'Gasto: ') + g.descripcion + (g.proveedor ? ' (' + g.proveedor + ')' : ''), tipo: g.esActivo ? 'activo' : 'gasto', origen: 'gasto', origenId: id, clave: 'gasto:' + id, comprobante: g.comprobante || '', lineas }, ctx);
            if (!r.ok) return r;
            if (g.esActivo) {
                const ra = registrarActivo(pd, { id, descripcion: g.descripcion, fechaAdq: g.fecha, costo: monto, cuenta: g.cuentaGasto, vidaMeses: g.vidaMeses, residual: g.residual || 0, gastoId: id }, ctx);
                if (!ra.ok) throw new Error(ra.errores.join(' '));
            }
            pd.gastos.push({ id, fecha: g.fecha, cuentaGasto: g.cuentaGasto, descripcion: g.descripcion, monto, medio: pendiente ? '' : g.medio, proveedor: g.proveedor || '', comprobante: g.comprobante || '', usuario: ctx.usuario, estadoPago: pendiente ? 'pendiente' : 'pagado', cuentaPasivo: pendiente ? credit : '', esActivo: !!g.esActivo, asientoId: r.asiento.id, pagos: [] });
            return { ok: true, asiento: r.asiento, gasto: pd.gastos[pd.gastos.length - 1] };
        });
        return out;
    }
    function saldoPagable(pd, gasto) { return sumaRef(pd, gasto.cuentaPasivo, 'cxp:' + gasto.id, null, 'A'); }
    function pagarGasto(pd, gastoId, datos, ctx) {
        const g = pd.gastos.find(x => x.id === gastoId);
        if (!g || g.estadoPago !== 'pendiente') return { ok: false, errores: ['El gasto no existe o ya fue pagado.'] };
        const monto = r2(datos.monto), saldo = saldoPagable(pd, g);
        const e = [];
        if (!(monto > 0)) e.push('El importe debe ser mayor que cero.');
        if (monto > saldo + 0.004) e.push('El pago supera lo que se debe (' + saldo.toFixed(2) + ').');
        if (!cuentaMedio(pd, datos.medio)) e.push('Elige la caja o banco con que se paga.');
        if (e.length) return { ok: false, errores: e };
        const idp = newId('pg');
        const r = transaccion(pd, () => postear(pd, { fecha: datos.fecha, desc: 'Pago de gasto pendiente: ' + g.descripcion + ' (' + g.proveedor + ')', tipo: 'pago_gasto', origen: 'gasto', origenId: g.id, clave: 'pago_gasto:' + idp, comprobante: datos.comprobante || '', lineas: [{ cuenta: g.cuentaPasivo, debe: monto, haber: 0, desc: 'Pago a ' + g.proveedor, ref: 'cxp:' + g.id }, { cuenta: datos.medio, debe: 0, haber: monto, desc: 'Pago a ' + g.proveedor, ref: 'cxp:' + g.id }] }, ctx));
        if (!r.ok) return r;
        g.pagos.push({ id: idp, fecha: datos.fecha, monto, asientoId: r.asiento.id });
        if (saldoPagable(pd, g) <= 0.004) g.estadoPago = 'pagado';
        return { ok: true, asiento: r.asiento };
    }
    // Operaciones del propietario: la contrapartida depende de la naturaleza real de cada operación.
    const OPS_PROPIETARIO = {
        aporte: 'Aporte del propietario (capital)',
        aporte_adicional: 'Aporte adicional del propietario',
        retiro: 'Retiro personal del propietario',
        prestamo_propietario: 'Préstamo del propietario a la financiera',
        reembolso_propietario: 'Reembolso al propietario (devolución de préstamo)',
        gasto_con_fondos_personales_aporte: 'Gasto de la financiera pagado con dinero personal (se trata como aporte)',
        gasto_con_fondos_personales_prestamo: 'Gasto de la financiera pagado con dinero personal (se debe al propietario)',
        gasto_personal_retiro: 'Gasto personal pagado con fondos de la financiera (retiro)',
        gasto_personal_por_cobrar: 'Gasto personal pagado con fondos de la financiera (por cobrar al propietario)'
    };
    function operacionPropietario(pd, o, ctx) {
        const e = [], monto = r2(o.monto);
        if (!(monto > 0)) e.push('El importe debe ser mayor que cero.');
        if (!OPS_PROPIETARIO[o.tipo]) e.push('Tipo de operación no válido.');
        if (String(o.descripcion || '').trim().length < 3) e.push('Escribe la descripción.');
        const usaMedio = o.tipo !== 'gasto_con_fondos_personales_aporte' && o.tipo !== 'gasto_con_fondos_personales_prestamo';
        if (usaMedio && !cuentaMedio(pd, o.medio)) e.push('Elige la caja o banco.');
        const gastoCta = cuenta(pd, o.cuentaGasto);
        if (!usaMedio && (!gastoCta || gastoCta.grupo !== 'Gasto' || !gastoCta.movimiento)) e.push('Elige la cuenta del gasto que se pagó.');
        if (e.length) return { ok: false, errores: e };
        const d = o.descripcion, ref = o.socioId ? 'socio:' + o.socioId : 'prop';
        const L = (cuenta, debe, haber) => ({ cuenta, debe, haber, desc: d, ref });
        const mapa = {
            aporte: [L(o.medio, monto, 0), L(C.CAPITAL, 0, monto)],
            aporte_adicional: [L(o.medio, monto, 0), L(C.APORTES, 0, monto)],
            retiro: [L(C.RETIROS, monto, 0), L(o.medio, 0, monto)],
            prestamo_propietario: [L(o.medio, monto, 0), L(C.PREST_PROP, 0, monto)],
            reembolso_propietario: [L(C.PREST_PROP, monto, 0), L(o.medio, 0, monto)],
            gasto_con_fondos_personales_aporte: [L(o.cuentaGasto, monto, 0), L(C.APORTES, 0, monto)],
            gasto_con_fondos_personales_prestamo: [L(o.cuentaGasto, monto, 0), L(C.PREST_PROP, 0, monto)],
            gasto_personal_retiro: [L(C.RETIROS, monto, 0), L(o.medio, 0, monto)],
            gasto_personal_por_cobrar: [L(C.CXC_PROP, monto, 0), L(o.medio, 0, monto)]
        };
        const id = newId('pr');
        return transaccion(pd, () => postear(pd, { fecha: o.fecha, desc: OPS_PROPIETARIO[o.tipo] + ': ' + d, tipo: o.tipo === 'aporte' || o.tipo === 'aporte_adicional' ? 'aporte' : o.tipo === 'retiro' ? 'retiro' : 'propietario', origen: 'propietario', origenId: id, clave: 'prop:' + id, comprobante: o.comprobante || '', lineas: mapa[o.tipo] }, ctx));
    }
    function registrarDeuda(pd, d, ctx) {
        const e = [], monto = r2(d.monto);
        if (!String(d.acreedor || '').trim()) e.push('Indica el acreedor.');
        if (!(monto > 0)) e.push('El importe debe ser mayor que cero.');
        if (!cuentaMedio(pd, d.medio)) e.push('Elige la caja o banco donde entra el dinero.');
        const cp = cuenta(pd, d.cuentaPasivo || C.PREST_TERC);
        if (!cp || cp.tipo !== 'deuda') e.push('Elige una cuenta de deuda.');
        if (d.vencimiento && (!validISO(d.vencimiento) || d.vencimiento < d.fecha)) e.push('El vencimiento no es válido.');
        if (e.length) return { ok: false, errores: e };
        const id = newId('dd');
        const r = transaccion(pd, () => postear(pd, { fecha: d.fecha, desc: 'Préstamo recibido de ' + d.acreedor, tipo: 'prestamo_recibido', origen: 'deuda', origenId: id, clave: 'deuda:' + id, comprobante: d.comprobante || '', lineas: [{ cuenta: d.medio, debe: monto, haber: 0, desc: 'Recibido de ' + d.acreedor, ref: 'deuda:' + id }, { cuenta: cp.cod, debe: 0, haber: monto, desc: 'Obligación con ' + d.acreedor, ref: 'deuda:' + id }] }, ctx));
        if (!r.ok) return r;
        pd.deudas.push({ id, acreedor: d.acreedor.trim(), fecha: d.fecha, monto, cuentaPasivo: cp.cod, condiciones: d.condiciones || '', tasa: d.tasa || '', vencimiento: d.vencimiento || '', comprobante: d.comprobante || '', estado: 'vigente', asientoId: r.asiento.id });
        return { ok: true, asiento: r.asiento, deuda: pd.deudas[pd.deudas.length - 1] };
    }
    const saldoDeuda = (pd, deuda) => sumaRef(pd, deuda.cuentaPasivo, 'deuda:' + deuda.id, null, 'A');
    // Pago de deuda: el principal reduce efectivo y pasivo; los intereses van aparte, al gasto financiero.
    function pagarDeuda(pd, deudaId, p, ctx) {
        const dd = pd.deudas.find(x => x.id === deudaId); if (!dd) return { ok: false, errores: ['La deuda no existe.'] };
        const principal = r2(p.principal), interes = r2(p.interes), e = [];
        if (principal < 0 || interes < 0 || principal + interes <= 0) e.push('Indica el principal y/o los intereses pagados.');
        if (principal > saldoDeuda(pd, dd) + 0.004) e.push('El principal supera el saldo de la deuda (' + saldoDeuda(pd, dd).toFixed(2) + ').');
        if (!cuentaMedio(pd, p.medio)) e.push('Elige la caja o banco con que se paga.');
        if (e.length) return { ok: false, errores: e };
        const ref = 'deuda:' + dd.id, lineas = [];
        if (principal > 0) lineas.push({ cuenta: dd.cuentaPasivo, debe: principal, haber: 0, desc: 'Pago de principal a ' + dd.acreedor, ref });
        if (interes > 0) lineas.push({ cuenta: C.GASTO_FIN, debe: interes, haber: 0, desc: 'Intereses pagados a ' + dd.acreedor, ref });
        lineas.push({ cuenta: p.medio, debe: 0, haber: principal + interes, desc: 'Pago a ' + dd.acreedor, ref });
        const r = transaccion(pd, () => postear(pd, { fecha: p.fecha, desc: 'Pago de deuda a ' + dd.acreedor, tipo: 'pago_deuda', origen: 'deuda', origenId: dd.id, clave: 'pago_deuda:' + newId('x'), comprobante: p.comprobante || '', lineas }, ctx));
        if (r.ok && saldoDeuda(pd, dd) <= 0.004) dd.estado = 'pagada';
        return r;
    }
    // Una transferencia entre cuentas propias no genera ingreso ni gasto.
    function transferir(pd, t, ctx) {
        const monto = r2(t.monto), e = [];
        if (!(monto > 0)) e.push('El importe debe ser mayor que cero.');
        if (!cuentaMedio(pd, t.origen) || !cuentaMedio(pd, t.destino)) e.push('Elige cajas o bancos propios válidos.');
        if (t.origen === t.destino) e.push('El origen y el destino deben ser distintos.');
        if (e.length) return { ok: false, errores: e };
        const id = newId('tr');
        return transaccion(pd, () => postear(pd, { fecha: t.fecha, desc: 'Transferencia ' + t.origen + ' → ' + t.destino + (t.nota ? ': ' + t.nota : ''), tipo: 'transferencia', origen: 'transferencia', origenId: id, clave: 'transf:' + id, comprobante: t.comprobante || '', lineas: [{ cuenta: t.destino, debe: monto, haber: 0, desc: 'Entrada por transferencia', ref: 'transf:' + id }, { cuenta: t.origen, debe: 0, haber: monto, desc: 'Salida por transferencia', ref: 'transf:' + id }] }, ctx));
    }
    // Asiento manual: queda como borrador hasta que alguien con permiso lo contabilice.
    function asientoManual(pd, d, ctx, contabilizar) {
        const datos = { fecha: d.fecha, desc: d.desc, tipo: d.tipo === 'ajuste' ? 'ajuste' : 'manual', origen: 'manual', origenId: '', comprobante: d.comprobante || '', lineas: d.lineas, motivo: d.motivo || '' };
        if (!contabilizar) return guardarBorrador(pd, datos, ctx);
        return transaccion(pd, () => postear(pd, datos, ctx));
    }

    // ---------------------------------------------------------------- ACTIVOS FIJOS Y DEPRECIACIÓN
    function registrarActivo(pd, a, ctx) {
        const e = [], costo = r2(a.costo), residual = r2(a.residual || 0), vida = Number(a.vidaMeses);
        if (String(a.descripcion || '').trim().length < 3) e.push('Escribe la descripción del activo.');
        if (!(costo > 0)) e.push('El costo debe ser mayor que cero.');
        if (!(vida >= 1) || !Number.isInteger(vida)) e.push('La vida útil debe ser un número entero de meses (mínimo 1).');
        if (residual < 0 || residual >= costo) e.push('El valor residual debe ser menor que el costo.');
        const cc = cuenta(pd, a.cuenta);
        if (!cc || cc.tipo !== 'activo_fijo') e.push('Elige una cuenta de activo fijo.');
        if (e.length) return { ok: false, errores: e };
        const id = a.id || newId('af');
        const act = { id, descripcion: a.descripcion.trim(), fechaAdq: a.fechaAdq, costo, cuenta: a.cuenta, vidaMeses: vida, residual, metodo: 'linea_recta', estado: 'activo', fechaBaja: '', gastoId: a.gastoId || '' };
        pd.activos.push(act);
        auditar(pd, ctx, 'activo.registrar', act.descripcion + ' C$' + costo, id);
        return { ok: true, activo: act };
    }
    function depAcumuladaActivo(pd, act, hasta) { return sumaRef(pd, C.DEP_ACUM, 'activo:' + act.id, hasta, 'A'); }
    function depreciacionMes(pd, mes) {
        const fin = monthEnd(mes), filas = [];
        const mesAdq = a => periodoDe(a.fechaAdq);
        pd.activos.forEach(a => {
            if (a.estado !== 'activo') return;
            const primerMes = pd.cfg.depInicio === 'mismoMes' ? mesAdq(a) : (() => { const [y, m] = mesAdq(a).split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); })();
            if (mes < primerMes) return;
            const depreciable = r2(a.costo - a.residual), cuota = r2(depreciable / a.vidaMeses);
            const acumulada = depAcumuladaActivo(pd, a, addDaysISO(mes + '-01', -1));
            const restante = r2(depreciable - acumulada);
            const monto = Math.max(0, Math.min(cuota, restante));
            if (monto > 0.004) filas.push({ activo: a, monto: r2(monto) });
        });
        return filas;
    }
    function registrarDepreciacion(pd, mes, ctx) {
        if (monthEnd(mes) > ctx.hoy) return { ok: false, errores: ['La depreciación se registra al terminar el mes.'] };
        const filas = depreciacionMes(pd, mes);
        if (!filas.length) return { ok: true, vacio: true, mensaje: 'No hay depreciación por registrar en ' + mes + '.' };
        const total = filas.reduce((s, f) => s + ct(f.monto), 0);
        const lineas = [{ cuenta: C.GASTO_DEP, debe: fromCt(total), haber: 0, desc: 'Depreciación ' + mes }];
        filas.forEach(f => lineas.push({ cuenta: C.DEP_ACUM, debe: 0, haber: f.monto, desc: 'Depreciación ' + f.activo.descripcion, ref: 'activo:' + f.activo.id }));
        return transaccion(pd, () => postear(pd, { fecha: monthEnd(mes), desc: 'Depreciación mensual ' + mes, tipo: 'depreciacion', origen: 'depreciacion', origenId: mes, clave: 'deprec:' + mes, lineas }, ctx));
    }
    // Baja de un activo: se retira el costo y la depreciación acumulada; la diferencia va a gasto (o ingreso si hay utilidad). No inventa valor de venta.
    function bajaActivo(pd, id, datos, ctx) {
        const a = pd.activos.find(x => x.id === id); if (!a || a.estado !== 'activo') return { ok: false, errores: ['El activo no existe o ya fue dado de baja.'] };
        if (!validISO(datos.fecha)) return { ok: false, errores: ['La fecha de baja no es válida.'] };
        const dep = depAcumuladaActivo(pd, a, datos.fecha), neto = r2(a.costo - dep), cobro = r2(datos.valorCobrado || 0);
        if (cobro > 0 && !cuentaMedio(pd, datos.medio)) return { ok: false, errores: ['Elige la caja o banco donde se recibe el cobro.'] };
        const ref = 'activo:' + a.id, lineas = [];
        if (dep > 0) lineas.push({ cuenta: C.DEP_ACUM, debe: dep, haber: 0, desc: 'Baja ' + a.descripcion, ref });
        if (cobro > 0) lineas.push({ cuenta: datos.medio, debe: cobro, haber: 0, desc: 'Cobro por baja ' + a.descripcion, ref });
        const dif = r2(neto - cobro);
        if (dif > 0) lineas.push({ cuenta: '5.1.99', debe: dif, haber: 0, desc: 'Pérdida por baja ' + a.descripcion, ref });
        lineas.push({ cuenta: a.cuenta, debe: 0, haber: a.costo, desc: 'Baja ' + a.descripcion, ref });
        if (dif < 0) lineas.push({ cuenta: C.ING_OTROS, debe: 0, haber: -dif, desc: 'Utilidad por baja ' + a.descripcion, ref });
        const r = transaccion(pd, () => postear(pd, { fecha: datos.fecha, desc: 'Baja de activo: ' + a.descripcion, tipo: 'ajuste', origen: 'activo', origenId: a.id, clave: 'baja:' + a.id, motivo: datos.motivo || '', lineas }, ctx));
        if (r.ok) { a.estado = 'baja'; a.fechaBaja = datos.fecha; }
        return r;
    }

    // ---------------------------------------------------------------- CAJA Y BANCOS
    function registrarCierreCaja(pd, d, ctx) {
        const c = cuentaMedio(pd, d.cuenta); const e = [];
        if (!c) e.push('Elige una caja o banco.');
        if (!validISO(d.fecha) || d.fecha > ctx.hoy) e.push('La fecha no es válida.');
        const fisico = Number(d.fisico);
        if (!Number.isFinite(fisico) || fisico < 0) e.push('Escribe el efectivo contado.');
        if (e.length) return { ok: false, errores: e };
        const teorico = saldoCuenta(pd, d.cuenta, d.fecha);
        const dif = r2(fisico - teorico);
        const reg = { id: newId('cc'), tipo: d.tipo === 'apertura' ? 'apertura' : 'cierre', cuenta: d.cuenta, fecha: d.fecha, teorico: r2(teorico), fisico: r2(fisico), diferencia: dif, estado: Math.abs(dif) < 0.005 ? 'sin_diferencia' : 'por_aprobar', nota: d.nota || '', usuario: ctx.usuario, ts: ctx.ts };
        pd.cierresCaja.push(reg);
        auditar(pd, ctx, 'caja.' + reg.tipo, d.cuenta + ' ' + d.fecha + ' teórico ' + reg.teorico + ' físico ' + reg.fisico + ' dif ' + dif, reg.id);
        return { ok: true, registro: reg };
    }
    // Nunca se ajusta el saldo automáticamente: la diferencia se documenta y alguien con permiso la aprueba.
    function aprobarAjusteCaja(pd, id, nota, ctx) {
        const r = pd.cierresCaja.find(x => x.id === id);
        if (!r || r.estado !== 'por_aprobar') return { ok: false, errores: ['No hay una diferencia pendiente de aprobar.'] };
        if (String(nota || '').trim().length < 15) return { ok: false, errores: ['Documenta la causa de la diferencia (mínimo 15 caracteres).'] };
        const falt = r.diferencia < 0, monto = Math.abs(r.diferencia);
        const res = transaccion(pd, () => postear(pd, { fecha: r.fecha, desc: (falt ? 'Faltante' : 'Sobrante') + ' de caja ' + r.cuenta + ' al ' + r.fecha + ': ' + nota, tipo: 'ajuste_caja', origen: 'caja', origenId: r.id, clave: 'ajuste_caja:' + r.id, motivo: nota, lineas: falt ? [{ cuenta: C.FALTANTE, debe: monto, haber: 0, desc: nota }, { cuenta: r.cuenta, debe: 0, haber: monto, desc: nota }] : [{ cuenta: r.cuenta, debe: monto, haber: 0, desc: nota }, { cuenta: C.SOBRANTE, debe: 0, haber: monto, desc: nota }] }, ctx));
        if (res.ok) { r.estado = 'ajustada'; r.asientoId = res.asiento.id; r.nota = (r.nota ? r.nota + ' | ' : '') + nota; r.aprobadoPor = ctx.usuario; }
        return res;
    }
    function registrarMovBanco(pd, m, ctx) {
        const e = [];
        const c = cuenta(pd, m.cuenta); if (!c || c.tipo !== 'banco') e.push('Elige una cuenta bancaria.');
        if (!validISO(m.fecha)) e.push('La fecha no es válida.');
        const monto = r2(m.monto); if (!monto) e.push('El importe no puede ser cero (entrada +, salida −).');
        if (e.length) return { ok: false, errores: e };
        const mv = { id: newId('bm'), cuenta: m.cuenta, fecha: m.fecha, desc: String(m.desc || '').trim(), monto, ref: m.ref || '', estado: 'pendiente', asientoId: '', linea: -1, nota: '' };
        pd.bancoMovs.push(mv); return { ok: true, mov: mv };
    }
    function conciliarMov(pd, movId, asientoId, linea, ctx) {
        const mv = pd.bancoMovs.find(x => x.id === movId), a = pd.asientos.find(x => x.id === asientoId);
        if (!mv || !a || a.estado !== 'contabilizado') return { ok: false, errores: ['Movimiento o asiento no válido.'] };
        const l = a.lineas[linea];
        if (!l || l.cuenta !== mv.cuenta) return { ok: false, errores: ['Esa línea no es de la cuenta bancaria.'] };
        if (ct(l.debe) - ct(l.haber) !== ct(mv.monto)) return { ok: false, errores: ['El importe del asiento (' + (l.debe - l.haber).toFixed(2) + ') no coincide con el del banco (' + mv.monto.toFixed(2) + ').'] };
        const yaUsada = pd.bancoMovs.some(x => x.id !== movId && x.asientoId === asientoId && x.linea === linea);
        if (yaUsada) return { ok: false, errores: ['Esa línea ya fue conciliada con otro movimiento.'] };
        mv.estado = 'conciliado'; mv.asientoId = asientoId; mv.linea = linea;
        auditar(pd, ctx, 'banco.conciliar', mv.cuenta + ' ' + mv.monto + ' ↔ #' + a.num, mv.id);
        return { ok: true };
    }
    function marcarNoIdentificado(pd, movId, nota, ctx) {
        const mv = pd.bancoMovs.find(x => x.id === movId); if (!mv || mv.estado === 'conciliado') return { ok: false, errores: ['No se puede marcar.'] };
        if (String(nota || '').trim().length < 5) return { ok: false, errores: ['Escribe una nota.'] };
        mv.estado = 'no_identificado'; mv.nota = nota; auditar(pd, ctx, 'banco.no_identificado', mv.cuenta + ' ' + mv.monto, mv.id); return { ok: true };
    }
    function conciliacionBanco(pd, cuentaCod, hasta, saldoExtracto) {
        const libros = saldoCuenta(pd, cuentaCod, hasta);
        const usadas = new Set(pd.bancoMovs.filter(m => m.estado === 'conciliado' && m.cuenta === cuentaCod).map(m => m.asientoId + '#' + m.linea));
        const librosSinBanco = []; let sl = 0;
        postedList(pd).forEach(a => { if (a.fecha > hasta) return; a.lineas.forEach((l, i) => { if (l.cuenta !== cuentaCod || usadas.has(a.id + '#' + i)) return; const v = ct(l.debe) - ct(l.haber); librosSinBanco.push({ fecha: a.fecha, num: a.num, desc: l.desc || a.desc, importe: fromCt(v), asientoId: a.id, linea: i }); sl += v; }); });
        const bancoSinLibros = pd.bancoMovs.filter(m => m.cuenta === cuentaCod && m.fecha <= hasta && m.estado !== 'conciliado');
        const sb = bancoSinLibros.reduce((s, m) => s + ct(m.monto), 0);
        const ext = ct(saldoExtracto);
        const noExplicada = (ext - ct(libros)) - (sb - sl);
        return { cuenta: cuentaCod, hasta, saldoLibros: libros, saldoExtracto: r2(saldoExtracto), librosSinBanco, bancoSinLibros, diferenciaNoExplicada: fromCt(noExplicada), conciliada: noExplicada === 0 && bancoSinLibros.length === 0 };
    }

    // ---------------------------------------------------------------- AUXILIARES Y CONCILIACIÓN DE CARTERA
    function cobradoHasta(db, c, hasta, toKey) { toKey = toKey || defaultToKey; return (db.pag || []).filter(p => p.creId === c.id && (toKey(p.fechaISO || p.f) || '9999') <= hasta).reduce((s, p) => ({ pri: s.pri + (Number(p.pri) || 0), int: s.int + (Number(p.int) || 0), mora: s.mora + (Number(p.m) || 0) }), { pri: 0, int: 0, mora: 0 }); }
    function auxCartera(db, pd, hasta, opts) {
        const refs = new Set();
        postedList(pd).forEach(a => a.lineas.forEach(l => { if (l.ref && l.ref.indexOf('cre:') === 0 && [C.CAPITAL_PEND, C.INT_COBRAR, C.INT_NO_DEV].includes(l.cuenta)) refs.add(l.ref); }));
        const filas = [];
        let dc = 0, di = 0, dn = 0;
        refs.forEach(ref => {
            const id = ref.slice(4), c = (db.cre || []).find(x => x.id === id);
            const cap = sumaRef(pd, C.CAPITAL_PEND, ref, hasta, 'D'), ic = sumaRef(pd, C.INT_COBRAR, ref, hasta, 'D'), nd = sumaRef(pd, C.INT_NO_DEV, ref, hasta, 'A');
            let sistemaCap = null, dif = null;
            if (c && c.total > 0) { const cob = cobradoHasta(db, c, hasta, opts && opts.toKey); sistemaCap = r2(c.cap - cob.pri); dif = r2(cap - sistemaCap); }
            filas.push({ creId: id, cliente: c ? ((db.cli || []).find(x => x.id === c.cliId) || {}).nom || '' : '(crédito eliminado)', capital: cap, interesPorCobrar: ic, noDevengado: nd, interesDevengadoPorCobrar: r2(ic - nd), sistemaCapital: sistemaCap, diferencia: dif });
            dc += ct(cap); di += ct(ic); dn += ct(nd);
        });
        filas.sort((a, b) => a.creId.localeCompare(b.creId, undefined, { numeric: true }));
        const control = { capital: saldoCuenta(pd, C.CAPITAL_PEND, hasta), interesPorCobrar: saldoCuenta(pd, C.INT_COBRAR, hasta), noDevengado: saldoCuenta(pd, C.INT_NO_DEV, hasta) };
        const totales = { capital: fromCt(dc), interesPorCobrar: fromCt(di), noDevengado: fromCt(dn) };
        const concilia = ct(control.capital) === dc && ct(control.interesPorCobrar) === di && ct(control.noDevengado) === dn;
        return { titulo: 'Auxiliar de cartera', hasta, filas, totales, control, concilia, conDiferencias: filas.filter(f => f.diferencia != null && Math.abs(f.diferencia) > 0.01) };
    }
    function auxIntereses(db, pd, hasta, opts) {
        const filas = [];
        const ids = new Set(postedList(pd).filter(a => a.tipo === 'desembolso').map(a => a.origenId));
        ((pd.apertura && pd.apertura.estado === 'aprobada') ? pd.apertura.aux : []).forEach(x => ids.add(x.creId));
        ids.forEach(id => {
            const c = (db.cre || []).find(x => x.id === id); if (!c) return;
            const i = infoDevengo(pd, c, hasta, opts);
            const noDev = sumaRef(pd, C.INT_NO_DEV, refCre(id), hasta, 'A');
            filas.push({ creId: id, contractual: i.I, devengado: i.devengado, noDevengado: noDev, cobrado: i.cobrado, pendienteCobro: r2(i.devengado - i.cobrado), porDevengarAlCorte: i.delta });
        });
        filas.sort((a, b) => a.creId.localeCompare(b.creId, undefined, { numeric: true }));
        return { titulo: 'Intereses devengados y no devengados', hasta, politica: pd.cfg.politicaInteres, filas };
    }
    function conciliarOperaciones(db, pd, desde, hasta, opts) {
        const toKey = (opts && opts.toKey) || defaultToKey;
        const reales = new Set((db.cre || []).filter(creEsReal).map(c => c.id));
        const cobrosSis = (db.pag || []).filter(p => reales.has(p.creId) && Number(p.t) > 0 && (toKey(p.fechaISO || p.f) || '') >= desde && (toKey(p.fechaISO || p.f) || '') <= hasta && toKey(p.fechaISO || p.f) >= pd.cfg.inicio);
        const totSis = cobrosSis.reduce((s, p) => s + ct(p.t), 0);
        let totCont = 0; postedList(pd).filter(a => a.tipo === 'cobro' && a.fecha >= desde && a.fecha <= hasta && !reversadoPor(pd, a.id)).forEach(a => { totCont += a.lineas[0] ? ct(a.lineas[0].debe) : 0; });
        const desSis = (db.cre || []).filter(c => creEsReal(c) && !enApertura(pd, c.id) && (fechaDesembolso(c, toKey) || '') >= (desde > pd.cfg.inicio ? desde : pd.cfg.inicio) && fechaDesembolso(c, toKey) <= hasta).reduce((s, c) => s + ct(c.cap), 0);
        let desCont = 0; postedList(pd).filter(a => a.tipo === 'desembolso' && a.fecha >= desde && a.fecha <= hasta && !reversadoPor(pd, a.id)).forEach(a => { desCont += ct(a.lineas.find(l => l.cuenta === C.CAPITAL_PEND).debe); });
        return { desde, hasta, cobros: { sistema: fromCt(totSis), contabilidad: fromCt(totCont), diferencia: fromCt(totSis - totCont) }, desembolsos: { sistema: fromCt(desSis), contabilidad: fromCt(desCont), diferencia: fromCt(desSis - desCont) } };
    }
    function auxDeudas(pd, hasta) {
        return { titulo: 'Auxiliar de préstamos y deudas', filas: pd.deudas.map(d => { const ref = 'deuda:' + d.id; return { id: d.id, acreedor: d.acreedor, fecha: d.fecha, recibido: d.monto, pagosPrincipal: r2(sumaRef(pd, d.cuentaPasivo, ref, hasta, 'D')), interesesPagados: sumaRef(pd, C.GASTO_FIN, ref, hasta, 'D'), saldo: sumaRef(pd, d.cuentaPasivo, ref, hasta, 'A'), vencimiento: d.vencimiento, estado: d.estado }; }) };
    }
    function comparativoMensual(pd, desde, hasta) {
        const filas = []; let m = desde.slice(0, 7); const fin = hasta.slice(0, 7);
        while (m <= fin) { const r = resultadoEntre(pd, m + '-01', monthEnd(m)); filas.push({ mes: m, ingresos: r.ingresos, gastos: r.gastos, resultado: r.neto }); const [y, mm] = m.split('-').map(Number); m = new Date(Date.UTC(y, mm, 1)).toISOString().slice(0, 7); }
        return { titulo: 'Comparativo mensual', filas };
    }

    // ---------------------------------------------------------------- APERTURA (31/10/2026)
    function sugerirAperturaCartera(db, pd, fecha, opts) {
        const toKey = (opts && opts.toKey) || defaultToKey;
        const aux = [];
        (db.cre || []).filter(creEsReal).forEach(c => {
            const f = fechaDesembolso(c, toKey); if (!f || f > fecha) return;
            const cob = cobradoHasta(db, c, fecha, toKey);
            const I = r2(c.total - c.cap);
            const cap = Math.max(0, r2(c.cap - cob.pri)), ic = Math.max(0, r2(I - cob.int));
            if (cap <= 0.004 && ic <= 0.004) return;
            const objetivo = Math.min(I, Math.max(objetivoDevengo(c, fecha, pd.cfg.politicaInteres, toKey), cob.int));
            const devengadoAcum = r2(objetivo), noDev = r2(Math.max(0, I - devengadoAcum));
            aux.push({ creId: c.id, capPend: cap, intPend: ic, noDev, devengadoAcum, paidInt: r2(cob.int) });
        });
        return aux;
    }
    // Cobros anteriores al corte que ya están dentro de los saldos del auxiliar (para no volver a contabilizarlos).
    function pagosDeApertura(db, aux, fecha, opts) {
        const toKey = (opts && opts.toKey) || defaultToKey, ids = new Set(aux.map(x => x.creId));
        return (db.pag || []).filter(p => ids.has(p.creId) && (toKey(p.fechaISO || p.f) || '9999') <= fecha).map(p => p.id);
    }
    // Líneas de apertura = lo que captura el administrador + el auxiliar de cartera. No se inventa ningún saldo.
    function lineasAperturaCartera(aux) {
        const s = k => aux.reduce((t, x) => t + ct(x[k]), 0);
        const out = [];
        if (s('capPend') > 0) out.push({ cuenta: C.CAPITAL_PEND, debe: fromCt(s('capPend')), haber: 0, fuente: 'Auxiliar de cartera (calculado con cobros hasta la fecha)' });
        if (s('intPend') > 0) out.push({ cuenta: C.INT_COBRAR, debe: fromCt(s('intPend')), haber: 0, fuente: 'Auxiliar de cartera' });
        if (s('noDev') > 0) out.push({ cuenta: C.INT_NO_DEV, debe: 0, haber: fromCt(s('noDev')), fuente: 'Auxiliar de cartera (política ' + 'de intereses vigente)' });
        return out;
    }
    function validarApertura(pd, ap) {
        ap = ap || pd.apertura;
        const e = [], avisos = [];
        let d = 0, h = 0;
        (ap.lineas || []).forEach((l, i) => {
            const c = cuenta(pd, l.cuenta);
            if (!c || !c.movimiento || !c.activa) { e.push('Línea ' + (i + 1) + ': cuenta no válida (' + l.cuenta + ').'); return; }
            const dv = ct(l.debe), hv = ct(l.haber);
            if ((dv > 0) === (hv > 0) || dv < 0 || hv < 0) e.push('Línea ' + (i + 1) + ': importe no válido.');
            if (c.cod === C.DIF_APERTURA) e.push('La cuenta de diferencia no se captura: la genera la excepción autorizada.');
            if (!String(l.fuente || '').trim()) avisos.push('Línea ' + (i + 1) + ' (' + l.cuenta + '): falta indicar la fuente que respalda el saldo.');
            d += dv; h += hv;
        });
        const diferencia = d - h;
        if (!(ap.lineas || []).length) e.push('No hay saldos de apertura capturados.');
        // La cartera del auxiliar debe coincidir con las cuentas de control.
        [[C.CAPITAL_PEND, 'capPend', 'D', 'capital pendiente'], [C.INT_COBRAR, 'intPend', 'D', 'intereses por cobrar'], [C.INT_NO_DEV, 'noDev', 'A', 'intereses no devengados']].forEach(([cod, k, lado, nom]) => {
            const auxV = (ap.aux || []).reduce((s, x) => s + ct(x[k]), 0);
            const ctrl = (ap.lineas || []).filter(l => l.cuenta === cod).reduce((s, l) => s + (lado === 'D' ? ct(l.debe) - ct(l.haber) : ct(l.haber) - ct(l.debe)), 0);
            if (auxV !== ctrl) e.push('El auxiliar de cartera (' + fromCt(auxV).toFixed(2) + ') no coincide con la cuenta de ' + nom + ' (' + fromCt(ctrl).toFixed(2) + ').');
        });
        const ex = ap.excepcion;
        const excepcionValida = !!ex && ex.autorizada === true && String(ex.motivo || '').trim().length >= 30 && String(ex.documento || '').trim().length >= 3;
        if (diferencia !== 0 && !excepcionValida) e.push('El balance de apertura no cuadra (diferencia ' + fromCt(diferencia).toFixed(2) + '). Resuelve la diferencia o registra una excepción autorizada con motivo (mínimo 30 caracteres) y documento de soporte.');
        return { ok: e.length === 0, errores: e, avisos, debe: fromCt(d), haber: fromCt(h), diferencia: fromCt(diferencia), usaExcepcion: diferencia !== 0 && excepcionValida };
    }
    function aprobarApertura(pd, ctx) {
        const ap = pd.apertura;
        if (ap.estado === 'aprobada') return { ok: false, errores: ['La apertura ya fue aprobada y no se modifica.'] };
        const v = validarApertura(pd, ap);
        if (!v.ok) return { ok: false, errores: v.errores };
        const lineas = ap.lineas.map(l => ({ cuenta: l.cuenta, debe: r2(l.debe), haber: r2(l.haber), desc: 'Apertura: ' + (l.fuente || ''), ref: l.ref || '' }));
        // Referencias por crédito para que los auxiliares de cartera cuadren desde el primer día.
        const conRef = [];
        lineas.forEach(l => { if ([C.CAPITAL_PEND, C.INT_COBRAR, C.INT_NO_DEV].includes(l.cuenta) && (ap.aux || []).length) return; conRef.push(l); });
        (ap.aux || []).forEach(x => {
            const ref = refCre(x.creId);
            if (x.capPend > 0) conRef.push({ cuenta: C.CAPITAL_PEND, debe: r2(x.capPend), haber: 0, desc: 'Apertura cartera ' + x.creId, ref });
            if (x.intPend > 0) conRef.push({ cuenta: C.INT_COBRAR, debe: r2(x.intPend), haber: 0, desc: 'Apertura intereses ' + x.creId, ref });
            if (x.noDev > 0) conRef.push({ cuenta: C.INT_NO_DEV, debe: 0, haber: r2(x.noDev), desc: 'Apertura no devengados ' + x.creId, ref });
        });
        if (v.usaExcepcion) { const dif = ct(v.debe) - ct(v.haber); conRef.push(dif > 0 ? { cuenta: C.DIF_APERTURA, debe: 0, haber: fromCt(dif), desc: 'Excepción autorizada: ' + ap.excepcion.documento } : { cuenta: C.DIF_APERTURA, debe: fromCt(-dif), haber: 0, desc: 'Excepción autorizada: ' + ap.excepcion.documento }); }
        const r = transaccion(pd, () => postear(pd, { fecha: ap.fecha, desc: 'Asiento de apertura al ' + ap.fecha, tipo: 'apertura', origen: 'apertura', origenId: ap.fecha, clave: 'apertura:' + ap.fecha, motivo: ap.observaciones || '', lineas: conRef }, ctx));
        if (!r.ok) return r;
        ap.estado = 'aprobada'; ap.aprobadoPor = ctx.usuario; ap.fechaAprobacion = ctx.ts; ap.asientoId = r.asiento.id;
        auditar(pd, ctx, 'apertura.aprobar', 'Apertura al ' + ap.fecha + (v.usaExcepcion ? ' con excepción' : ''), r.asiento.id);
        return r;
    }

    // ---------------------------------------------------------------- CIERRE MENSUAL
    const TAREAS_CIERRE = [
        { k: 'pendientes', t: 'Contabilizar desembolsos y cobros del mes', auto: true },
        { k: 'devengo', t: 'Registrar el devengo de intereses del mes', auto: true },
        { k: 'depreciacion', t: 'Registrar la depreciación y estimaciones aplicables', auto: true },
        { k: 'caja', t: 'Conciliar caja (cierre y arqueo)', auto: false },
        { k: 'bancos', t: 'Conciliar bancos', auto: false },
        { k: 'cartera', t: 'Conciliar cartera con los auxiliares', auto: true },
        { k: 'intereses', t: 'Revisar intereses devengados y no devengados', auto: false },
        { k: 'deudas', t: 'Revisar deudas y cuentas por pagar', auto: false },
        { k: 'propietario', t: 'Revisar aportes y retiros del propietario', auto: false },
        { k: 'gastos', t: 'Registrar gastos pendientes y ajustes', auto: false },
        { k: 'integridad', t: 'Balance de comprobación sin asientos descuadrados ni duplicados', auto: true },
        { k: 'estados', t: 'Generar y revisar los estados financieros', auto: false }
    ];
    const ESTADOS_TAREA = ['pendiente', 'en_proceso', 'observado', 'aprobado'];
    function tareaAuto(db, pd, mes, k, opts) {
        const fin = monthEnd(mes);
        if (k === 'pendientes') { const p = pendientes(db, pd, opts); const n = p.desembolsos.concat(p.cobros).filter(x => { const f = x.fechaISO ? ((opts && opts.toKey) || defaultToKey)(x.fechaISO) : fechaDesembolso(x, opts && opts.toKey); return f && f <= fin; }).length; return { ok: n === 0 && !p.advertencia && p.omitidos.length === 0, detalle: n ? n + ' operaciones sin contabilizar' : p.omitidos.length ? p.omitidos.length + ' operaciones omitidas por decidir' : p.advertencia || 'Al día' }; }
        if (k === 'devengo') { if (pd.cfg.politicaInteres === 'alCobro') return { ok: true, detalle: 'Política al cobro: el devengo se registra con cada cobro' }; const hay = pd.asientos.some(a => a.clave === 'devengo:' + mes && a.estado === 'contabilizado'); const d = hay ? { lineas: [] } : asientoDevengo(db, pd, mes, opts); return { ok: hay || d.lineas.length === 0, detalle: hay ? 'Registrado' : d.lineas.length ? 'Falta registrar el devengo' : 'Sin intereses por devengar' }; }
        if (k === 'depreciacion') { const hay = pd.asientos.some(a => a.clave === 'deprec:' + mes && a.estado === 'contabilizado'); const n = hay ? 0 : depreciacionMes(pd, mes).length; return { ok: hay || n === 0, detalle: hay ? 'Registrada' : n ? 'Falta registrar la depreciación' : 'Sin depreciación' }; }
        if (k === 'cartera') { const a = auxCartera(db, pd, fin, opts); return { ok: a.concilia && a.conDiferencias.length === 0, detalle: !a.concilia ? 'El auxiliar no coincide con la cuenta de control' : a.conDiferencias.length ? a.conDiferencias.length + ' créditos con diferencia frente al sistema' : 'Concilia' }; }
        if (k === 'integridad') { const p = verificarIntegridad(pd); const b = balanceComprobacion(pd, fin); return { ok: p.length === 0 && b.cuadra, detalle: p.length ? p[0] : b.cuadra ? 'Cuadra' : 'El balance de comprobación no cuadra' }; }
        return { ok: true, detalle: '' };
    }
    function estadoCierre(db, pd, mes, opts) {
        const per = buscarPeriodo(pd, mes) || { id: mes, estado: 'abierto', tareas: {}, historial: [] };
        const tareas = TAREAS_CIERRE.map(t => { const reg = (per.tareas || {})[t.k] || { estado: 'pendiente', nota: '' }; const auto = t.auto ? tareaAuto(db, pd, mes, t.k, opts) : null; return { k: t.k, titulo: t.t, auto: t.auto, estado: reg.estado, nota: reg.nota || '', por: reg.por || '', autoOk: auto ? auto.ok : null, detalle: auto ? auto.detalle : '' }; });
        const bloqueos = [];
        tareas.forEach(t => { if (t.estado !== 'aprobado') bloqueos.push('Falta aprobar: ' + t.titulo); if (t.auto && !t.autoOk) bloqueos.push(t.titulo + ' — ' + t.detalle); });
        if (!aperturaAprobada(pd)) bloqueos.push('La apertura contable no está aprobada.');
        return { periodo: mes, estado: per.estado, tareas, bloqueos: [...new Set(bloqueos)], puedeCerrar: per.estado !== 'cerrado' && bloqueos.length === 0, historial: per.historial || [] };
    }
    function marcarTarea(pd, mes, k, estado, nota, ctx) {
        if (!ESTADOS_TAREA.includes(estado) || !TAREAS_CIERRE.some(t => t.k === k)) return { ok: false, errores: ['Tarea o estado no válido.'] };
        if (estado === 'observado' && String(nota || '').trim().length < 5) return { ok: false, errores: ['Escribe la observación.'] };
        let per = buscarPeriodo(pd, mes);
        if (!per) { per = { id: mes, estado: 'abierto', tareas: {}, historial: [] }; pd.periodos.push(per); }
        if (per.estado === 'cerrado') return { ok: false, errores: ['El período está cerrado.'] };
        per.tareas[k] = { estado, nota: nota || '', por: ctx.usuario, ts: ctx.ts };
        auditar(pd, ctx, 'cierre.tarea', mes + ' ' + k + ' → ' + estado, mes);
        return { ok: true };
    }
    function cerrarPeriodo(db, pd, mes, ctx, opts) {
        const est = estadoCierre(db, pd, mes, opts);
        if (!est.puedeCerrar) return { ok: false, errores: est.bloqueos.length ? est.bloqueos : ['El período ya está cerrado.'] };
        let per = buscarPeriodo(pd, mes);
        per.estado = 'cerrado'; per.cerradoPor = ctx.usuario; per.fechaCierre = ctx.ts;
        per.historial = (per.historial || []).concat([{ accion: 'cierre', usuario: ctx.usuario, ts: ctx.ts, motivo: '' }]);
        auditar(pd, ctx, 'periodo.cerrar', mes, mes);
        return { ok: true };
    }
    function reabrirPeriodo(pd, mes, motivo, ctx) {
        const per = buscarPeriodo(pd, mes);
        if (!per || per.estado !== 'cerrado') return { ok: false, errores: ['El período no está cerrado.'] };
        if (String(motivo || '').trim().length < 15) return { ok: false, errores: ['Documenta el motivo de la reapertura (mínimo 15 caracteres).'] };
        per.estado = 'abierto'; per.reabiertoPor = ctx.usuario; per.tareas = {};
        per.historial = (per.historial || []).concat([{ accion: 'reapertura', usuario: ctx.usuario, ts: ctx.ts, motivo: String(motivo).trim() }]);
        auditar(pd, ctx, 'periodo.reabrir', mes + ': ' + motivo, mes);
        return { ok: true };
    }

    // ---------------------------------------------------------------- ADVERTENCIAS (un informe no es definitivo si hay saldos sin conciliar)
    function advertenciasGenerales(pd, hasta, extra) {
        const w = [];
        if (!aperturaAprobada(pd)) w.push('La apertura contable aún no está aprobada.');
        else if (pd.asientos.some(a => a.estado === 'contabilizado' && a.lineas.some(l => l.cuenta === C.DIF_APERTURA))) w.push('La apertura se aprobó con una diferencia por conciliar (excepción autorizada).');
        if (!pd.cfg.politicaConfirmada) w.push('La política de reconocimiento de intereses está pendiente de validación por un contador.');
        const ing = verificarIntegridad(pd); if (ing.length) w.push('Hay problemas de integridad: ' + ing[0]);
        if (hasta && !periodoCerrado(pd, periodoDe(hasta))) w.push('El período ' + periodoDe(hasta) + ' no está cerrado: cifras preliminares.');
        if (extra && extra.pendientes) { const n = extra.pendientes.desembolsos.length + extra.pendientes.cobros.length; if (n) w.push('Hay ' + n + ' operaciones del sistema sin contabilizar.'); if (extra.pendientes.omitidos.length) w.push('Hay ' + extra.pendientes.omitidos.length + ' operaciones omitidas por decidir.'); }
        if (extra && extra.cartera && (!extra.cartera.concilia || extra.cartera.conDiferencias.length)) w.push('La cartera contable no concilia con el sistema.');
        if ((pd.bancoMovs || []).some(m => m.estado !== 'conciliado')) w.push('Hay movimientos bancarios sin conciliar.');
        if ((pd.cierresCaja || []).some(c => c.estado === 'por_aprobar')) w.push('Hay diferencias de caja sin resolver.');
        return w;
    }

    // ---------------------------------------------------------------- TABLERO
    function tablero(db, pd, hoy, opts) {
        const mes = hoy.slice(0, 7), ini = mes + '-01', fin = monthEnd(mes);
        const efectivo = cuentasEfectivo(pd).reduce((s, c) => s + ct(saldoCuenta(pd, c.cod, hoy)), 0);
        const res = resultadoEntre(pd, ini, hoy < fin ? hoy : fin);
        const pend = pendientes(db, pd, opts);
        const cart = auxCartera(db, pd, hoy, opts);
        const pas = saldoCuenta(pd, '2.1', hoy);
        const difs = (pd.cierresCaja || []).filter(c => c.estado === 'por_aprobar').length + (pd.bancoMovs || []).filter(m => m.estado !== 'conciliado').length;
        const ultimaAsiento = postedList(pd).reduce((m, a) => a.contabilizado > m ? a.contabilizado : m, '');
        return { periodo: mes, corte: hoy, actualizado: ultimaAsiento, efectivo: fromCt(efectivo), capitalPendiente: saldoCuenta(pd, C.CAPITAL_PEND, hoy), interesNoDevengado: saldoCuenta(pd, C.INT_NO_DEV, hoy), interesDevengadoPorCobrar: r2(saldoCuenta(pd, C.INT_COBRAR, hoy) - saldoCuenta(pd, C.INT_NO_DEV, hoy)), pasivos: pas, ingresosMes: res.ingresos, gastosMes: res.gastos, resultadoMes: res.neto, diferenciasConciliacion: difs, pendientes: pend.desembolsos.length + pend.cobros.length, omitidos: pend.omitidos.length, carteraConcilia: cart.concilia && cart.conDiferencias.length === 0, estadoCierre: (buscarPeriodo(pd, mes) || { estado: 'abierto' }).estado, asientos: postedList(pd).length };
    }

    // ---------------------------------------------------------------- PROTECCIÓN DE OPERACIONES YA CONTABILIZADAS
    // Editar o borrar un crédito/cobro ya contabilizado dejaría la contabilidad desfasada: se exige reversar primero.
    function operacionBloqueada(pd, tipo, id) {
        if (!pd || !pd.asientos) return false;
        const base = tipo === 'cre' ? 'desembolso:' + id : tipo === 'pag' ? 'cobro:' + id : '';
        if (base) { const a = entradasDeClave(pd, base).find(x => x.estado === 'contabilizado' && !reversadoPor(pd, x.id)); if (a) return a; }
        if (tipo === 'cre') {
            const ap = pd.apertura && pd.apertura.estado === 'aprobada' && (pd.apertura.aux || []).find(x => x.creId === id); if (ap) return { num: 'apertura' };
            const cobro = pd.asientos.find(x => x.estado === 'contabilizado' && x.tipo === 'cobro' && x.refs && x.refs.creId === id && !reversadoPor(pd, x.id)); if (cobro) return cobro;
        }
        return false;
    }

    root.GycContab = { ACC_PERMS, canAcc, CUENTAS_BASE, C, TIPOS, TIPOS_SISTEMA, POLITICAS_INTERES, OPS_PROPIETARIO, TAREAS_CIERRE, ESTADOS_TAREA,
        r2, validISO, monthEnd, nuevoPd, cuenta, hijos, cuentasEfectivo, esEfectivo, agregarCuenta, editarCuenta, validarCuentaNueva, cuentaUsada, auditar,
        periodoCerrado, buscarPeriodo, sello, reversadoPor, validarAsiento, postear, guardarBorrador, contabilizarBorrador, eliminarBorrador, reversar, transaccion,
        acumular, saldoCuenta, libroDiario, mayor, balanceComprobacion, balanceGeneral, estadoResultados, flujoEfectivo, resultadoEntre, verificarIntegridad,
        asientoDesembolso, asientoCobro, pendientes, contabilizarPendientes, objetivoDevengo, infoDevengo, asientoDevengo, registrarDevengo,
        registrarGasto, pagarGasto, saldoPagable, operacionPropietario, registrarDeuda, pagarDeuda, saldoDeuda, transferir, asientoManual,
        registrarActivo, depreciacionMes, registrarDepreciacion, bajaActivo, depAcumuladaActivo, registrarCierreCaja, aprobarAjusteCaja, pagosDeApertura, repostear, registrarMovBanco, conciliarMov, marcarNoIdentificado, conciliacionBanco,
        auxCartera, auxIntereses, conciliarOperaciones, auxDeudas, comparativoMensual, sumaRef, estadoOperacion, tipoEfectivo,
        sugerirAperturaCartera, lineasAperturaCartera, validarApertura, aprobarApertura, estadoCierre, marcarTarea, cerrarPeriodo, reabrirPeriodo, advertenciasGenerales, tablero, operacionBloqueada };
})(globalThis);
