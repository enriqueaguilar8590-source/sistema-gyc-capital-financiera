/* GYC Capital — motor contable de partida doble (etapa 1).
 * Funciones puras sobre el objeto `db` del sistema (mismo que usa sistema.html). No toca clientes, créditos ni cobros.
 * Claves nuevas del espacio de trabajo (todas por ID, solo administrador las escribe en servidor):
 *   ctaCat (catálogo) · asientos (diario) · periodos · cierres · auditoriaConta · cajas · bancoMov · activosFijos
 * Configuración en db.cfg.conta: {inicio, fechaApertura, aperturaAprobada, politicaIntereses}
 * Importes en córdobas. Los cálculos se hacen en centavos enteros.
 */
(function(root) {
    const cents = x => Math.round((Number(x) || 0) * 100);
    const money = c => c / 100;
    const isCents = x => Number.isFinite(Number(x)) && Math.abs(Number(x) * 100 - Math.round(Number(x) * 100)) < 1e-6;
    const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && new Date(d + 'T12:00:00').toISOString().slice(0, 10) === d;
    const periodOf = d => String(d || '').slice(0, 7);
    const conf = db => ((db && db.cfg && db.cfg.conta) || {});
    let uidSeq = 0;
    const uuid = ctx => (ctx && ctx.uuid) ? ctx.uuid() : (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + (++uidSeq));

    // ---------------------------------------------------------------- Permisos
    const PERMS = {
        consultar:  ['owner', 'admin', 'contador'],
        borrador:   ['owner', 'admin', 'contador'],
        contabilizar: ['owner', 'admin', 'contador'],
        aprobarAjuste: ['owner', 'admin'],
        reversar:   ['owner', 'admin'],
        periodos:   ['owner', 'admin'],
        catalogo:   ['owner', 'admin'],
        auditoria:  ['owner', 'admin', 'contador']
    };
    const can = (role, action) => (PERMS[action] || []).includes(({gestor: 'cobrador'})[role] || role);

    // ---------------------------------------------------------------- Catálogo (configurable; NO es un catálogo regulatorio oficial)
    const A = (code, nombre, padre, tipo, naturaleza, movimiento, extra) => Object.assign({
        id: code, code, nombre, padre: padre || null, grupo: tipo, tipo, naturaleza, movimiento: !!movimiento, activa: true, contra: false, restriccion: ''
    }, extra || {});
    const D = 'deudora', C = 'acreedora';
    const DEFAULT_ACCOUNTS = [
        A('1', 'ACTIVOS', null, 'activo', D, false),
        A('1.1', 'Efectivo y equivalentes', '1', 'activo', D, false),
        A('1.1.01', 'Caja general', '1.1', 'activo', D, true, {efectivo: true}),
        A('1.1.02', 'Cajas por responsable', '1.1', 'activo', D, false, {restriccion: 'Cree una cuenta hija por cobrador/responsable'}),
        A('1.1.03', 'Bancos', '1.1', 'activo', D, false),
        A('1.1.03.01', 'Banco - cuenta principal (renombrar)', '1.1.03', 'activo', D, true, {efectivo: true}),
        A('1.1.04', 'Otros medios de pago', '1.1', 'activo', D, true, {efectivo: true}),
        A('1.2', 'Cartera de créditos', '1', 'activo', D, false),
        A('1.2.01', 'Cartera de créditos - capital pendiente', '1.2', 'activo', D, true, {control: 'cartera_capital'}),
        A('1.2.02', 'Intereses por cobrar (contractuales)', '1.2', 'activo', D, true, {control: 'cartera_interes'}),
        A('1.2.03', 'Intereses contractuales no devengados', '1.2', 'activo', C, true, {contra: true, control: 'interes_no_devengado'}),
        A('1.2.04', 'Estimación por pérdidas crediticias', '1.2', 'activo', C, true, {contra: true}),
        A('1.2.99', 'Compensación por refinanciamiento (transitoria)', '1.2', 'activo', D, true, {restriccion: 'Debe quedar en cero'}),
        A('1.3', 'Anticipos y otros activos', '1', 'activo', D, false),
        A('1.3.01', 'Anticipos y otros activos', '1.3', 'activo', D, true),
        A('1.3.02', 'Cuentas por cobrar al propietario', '1.3', 'activo', D, true),
        A('1.4', 'Activos fijos', '1', 'activo', D, false),
        A('1.4.01', 'Mobiliario, equipo y otros activos fijos', '1.4', 'activo', D, true),
        A('1.4.02', 'Depreciación acumulada', '1.4', 'activo', C, true, {contra: true}),
        A('2', 'PASIVOS', null, 'pasivo', C, false),
        A('2.1', 'Pasivos', '2', 'pasivo', C, false),
        A('2.1.01', 'Préstamos recibidos', '2.1', 'pasivo', C, true),
        A('2.1.02', 'Deudas con terceros', '2.1', 'pasivo', C, true),
        A('2.1.03', 'Obligaciones por pagar a proveedores', '2.1', 'pasivo', C, true),
        A('2.1.04', 'Gastos acumulados pendientes de pago', '2.1', 'pasivo', C, true),
        A('2.1.05', 'Otras obligaciones', '2.1', 'pasivo', C, true),
        A('2.1.06', 'Préstamos del propietario a la financiera', '2.1', 'pasivo', C, true),
        A('2.1.07', 'Por pagar al propietario (reembolsos)', '2.1', 'pasivo', C, true),
        A('3', 'PATRIMONIO Y CUENTAS DEL PROPIETARIO', null, 'patrimonio', C, false),
        A('3.1', 'Capital', '3', 'patrimonio', C, false),
        A('3.1.01', 'Capital aportado', '3.1', 'patrimonio', C, true),
        A('3.1.02', 'Aportes adicionales', '3.1', 'patrimonio', C, true),
        A('3.2', 'Retiros', '3', 'patrimonio', D, false),
        A('3.2.01', 'Retiros del propietario', '3.2', 'patrimonio', D, true, {contra: true}),
        A('3.3', 'Resultados', '3', 'patrimonio', C, false),
        A('3.3.01', 'Resultados acumulados', '3.3', 'patrimonio', C, true),
        A('3.3.02', 'Resultado del ejercicio (solo cierre anual)', '3.3', 'patrimonio', C, true, {restriccion: 'Uso exclusivo del cierre anual'}),
        A('3.3.99', 'Diferencia de apertura bajo excepción autorizada', '3.3', 'patrimonio', C, true, {restriccion: 'Solo con excepción autorizada y sustentada'}),
        A('4', 'INGRESOS', null, 'ingreso', C, false),
        A('4.1', 'Ingresos', '4', 'ingreso', C, false),
        A('4.1.01', 'Ingresos financieros por intereses', '4.1', 'ingreso', C, true),
        A('4.1.02', 'Ingresos por mora reconocidos', '4.1', 'ingreso', C, true),
        A('4.1.03', 'Otros ingresos autorizados', '4.1', 'ingreso', C, true),
        A('4.1.04', 'Sobrantes de caja aprobados', '4.1', 'ingreso', C, true),
        A('5', 'GASTOS', null, 'gasto', D, false),
        A('5.1', 'Gastos', '5', 'gasto', D, false),
        A('5.1.01', 'Gastos administrativos', '5.1', 'gasto', D, true),
        A('5.1.02', 'Transporte y cobro', '5.1', 'gasto', D, true),
        A('5.1.03', 'Comisiones', '5.1', 'gasto', D, true),
        A('5.1.04', 'Gastos bancarios', '5.1', 'gasto', D, true),
        A('5.1.05', 'Alquiler', '5.1', 'gasto', D, true),
        A('5.1.06', 'Servicios', '5.1', 'gasto', D, true),
        A('5.1.07', 'Papelería y suministros', '5.1', 'gasto', D, true),
        A('5.1.08', 'Depreciación', '5.1', 'gasto', D, true),
        A('5.1.09', 'Gastos financieros (intereses de deudas)', '5.1', 'gasto', D, true),
        A('5.1.10', 'Pérdidas crediticias y provisiones', '5.1', 'gasto', D, true),
        A('5.1.11', 'Otros gastos autorizados', '5.1', 'gasto', D, true),
        A('5.1.12', 'Faltantes de caja aprobados', '5.1', 'gasto', D, true)
    ];
    const CASH = {caja: '1.1.01', banco: '1.1.03.01', otro: '1.1.04'};
    const catalog = db => (db.ctaCat && db.ctaCat.length ? db.ctaCat : DEFAULT_ACCOUNTS);
    const acct = (db, code) => catalog(db).find(a => a.code === code);
    const isCashAcct = (db, code) => { const a = acct(db, code); return !!(a && a.efectivo); };
    // Crea o completa el catálogo sin pisar cuentas que el usuario ya modificó.
    function ensureCatalog(db, ctx) {
        const have = new Set((db.ctaCat || []).map(a => a.code));
        const now = (ctx && ctx.ahora) || new Date().toISOString();
        db.ctaCat = [...(db.ctaCat || []), ...DEFAULT_ACCOUNTS.filter(a => !have.has(a.code)).map(a => ({...a, creada: now, modificada: now}))];
        return db.ctaCat;
    }
    function validateAccount(db, a) {
        if(!a || !/^\d+(\.\d+)*$/.test(a.code || '')) return 'Código de cuenta no válido (ej. 5.1.13).';
        if(!String(a.nombre || '').trim()) return 'La cuenta necesita un nombre.';
        if(!['deudora', 'acreedora'].includes(a.naturaleza)) return 'La naturaleza debe ser deudora o acreedora.';
        if(!['activo', 'pasivo', 'patrimonio', 'ingreso', 'gasto'].includes(a.tipo)) return 'Tipo de cuenta no válido.';
        if(a.padre && !acct(db, a.padre)) return 'La cuenta padre no existe.';
        if(a.padre && a.code.indexOf(a.padre + '.') !== 0) return 'El código debe comenzar con el de su cuenta padre.';
        if(a.padre && acct(db, a.padre).movimiento) return 'La cuenta padre es de movimiento: no puede tener hijas.';
        return '';
    }
    function addAccount(db, a, ctx) {
        if(!can(ctx && ctx.rol, 'catalogo')) return {ok: false, error: 'Sin permiso para administrar el catálogo.'};
        ensureCatalog(db, ctx);
        if(acct(db, a.code)) return {ok: false, error: 'Ya existe una cuenta con ese código.'};
        const err = validateAccount(db, a); if(err) return {ok: false, error: err};
        const now = (ctx && ctx.ahora) || new Date().toISOString();
        const parent = acct(db, a.padre) || {};
        const row = {id: a.code, code: a.code, nombre: a.nombre.trim(), padre: a.padre || null, grupo: a.grupo || a.tipo, tipo: a.tipo, naturaleza: a.naturaleza,
            movimiento: a.movimiento !== false, activa: true, contra: !!a.contra, efectivo: !!a.efectivo, restriccion: a.restriccion || '', creada: now, modificada: now};
        db.ctaCat.push(row); audit(db, ctx, 'catalogo.crear', a.code, row.nombre);
        return {ok: true, cuenta: row};
    }
    function setAccountActive(db, code, active, ctx) {
        if(!can(ctx && ctx.rol, 'catalogo')) return {ok: false, error: 'Sin permiso para administrar el catálogo.'};
        ensureCatalog(db, ctx);
        const a = db.ctaCat.find(x => x.code === code); if(!a) return {ok: false, error: 'Cuenta no encontrada.'};
        a.activa = !!active; a.modificada = (ctx && ctx.ahora) || new Date().toISOString();
        audit(db, ctx, active ? 'catalogo.activar' : 'catalogo.desactivar', code, a.nombre);
        return {ok: true};
    }

    // ---------------------------------------------------------------- Auditoría (solo se agrega)
    function audit(db, ctx, accion, ref, detalle) {
        db.auditoriaConta = db.auditoriaConta || [];
        db.auditoriaConta.push({id: uuid(ctx), fecha: (ctx && ctx.ahora) || new Date().toISOString(), usuario: (ctx && ctx.usuario) || '', accion, ref: ref || '', detalle: String(detalle || '').slice(0, 300)});
    }

    // ---------------------------------------------------------------- Períodos
    function periodState(db, fecha) {
        const p = (db.periodos || []).find(x => x.id === periodOf(fecha));
        return p ? p.estado : 'abierto';
    }
    function closePeriodDirect(db, id, ctx) {
        db.periodos = db.periodos || [];
        let p = db.periodos.find(x => x.id === id);
        if(!p) { p = {id, estado: 'abierto', reaperturas: []}; db.periodos.push(p); }
        p.estado = 'cerrado'; p.cerradoPor = (ctx && ctx.usuario) || ''; p.cerradoFecha = (ctx && ctx.ahora) || new Date().toISOString();
        return p;
    }
    function reopenPeriod(db, id, info, ctx) {
        if(!can(ctx && ctx.rol, 'periodos')) return {ok: false, error: 'Sin permiso para abrir o cerrar períodos.'};
        const p = (db.periodos || []).find(x => x.id === id);
        if(!p || p.estado !== 'cerrado') return {ok: false, error: 'El período no está cerrado.'};
        if(!info || String(info.motivo || '').trim().length < 10 || !String(info.autorizadoPor || '').trim()) return {ok: false, error: 'La reapertura exige un motivo (mínimo 10 letras) y quién la autoriza.'};
        p.reaperturas = [...(p.reaperturas || []), {fecha: (ctx && ctx.ahora) || new Date().toISOString(), usuario: ctx.usuario, motivo: info.motivo.trim(), autorizadoPor: info.autorizadoPor.trim()}];
        p.estado = 'abierto';
        audit(db, ctx, 'periodo.reabrir', id, info.motivo);
        return {ok: true};
    }

    // ---------------------------------------------------------------- Validación y contabilización
    function validateDraft(db, d, ctx) {
        const errs = [];
        const cfg = conf(db), isOpening = d.tipo === 'apertura';
        if(!isDate(d.fecha)) errs.push('La fecha contable no es válida.');
        else {
            if(ctx && ctx.hoy && d.fecha > ctx.hoy) errs.push('La fecha contable no puede ser futura.');
            if(!isOpening && cfg.inicio && d.fecha < cfg.inicio) errs.push('La fecha es anterior al inicio contable (' + cfg.inicio + '): esa operación ya está representada en los saldos de apertura.');
            if(periodState(db, d.fecha) === 'cerrado') errs.push('El período ' + periodOf(d.fecha) + ' está cerrado.');
        }
        if(!isOpening && !cfg.aperturaAprobada) errs.push('La apertura contable aún no está aprobada.');
        if(!String(d.descripcion || '').trim()) errs.push('Falta la descripción.');
        const lines = d.lineas || [];
        if(lines.length < 2) errs.push('Un asiento necesita al menos dos líneas.');
        let debe = 0, haber = 0;
        lines.forEach((l, i) => {
            const n = i + 1, a = acct(db, l.cuenta);
            if(!a) { errs.push('Línea ' + n + ': la cuenta ' + l.cuenta + ' no existe.'); return; }
            if(!a.activa) errs.push('Línea ' + n + ': la cuenta ' + a.code + ' está inactiva.');
            if(!a.movimiento) errs.push('Línea ' + n + ': ' + a.code + ' es una cuenta agrupadora; use una cuenta de movimiento.');
            const dv = Number(l.debe) || 0, hv = Number(l.haber) || 0;
            if(!isCents(dv) || !isCents(hv) || dv < 0 || hv < 0) errs.push('Línea ' + n + ': importe no válido.');
            else if((dv > 0) === (hv > 0)) errs.push('Línea ' + n + ': debe tener un importe en el debe o en el haber, no en ambos ni en ninguno.');
            debe += cents(dv); haber += cents(hv);
        });
        if(debe !== haber) errs.push('El asiento no cuadra: débitos ' + money(debe).toFixed(2) + ' ≠ créditos ' + money(haber).toFixed(2) + '.');
        if(debe === 0 && lines.length >= 2) errs.push('El asiento no tiene importe.');
        return errs;
    }
    const posted = db => (db.asientos || []).filter(a => a.estado === 'contabilizado');
    const nextNumber = db => Math.max(Number(((db.cfg || {}).secuencias || {}).asientoNext) || 1, posted(db).reduce((m, a) => Math.max(m, a.numero || 0), 0) + 1);
    // Contabiliza uno o varios asientos de forma atómica: o entran todos o no entra ninguno.
    function postMany(db, drafts, ctx) {
        if(!can(ctx && ctx.rol, 'contabilizar')) return {ok: false, error: 'Sin permiso para contabilizar.'};
        ensureCatalog(db, ctx);
        const seen = new Set(posted(db).map(a => a.claveOrigen).filter(Boolean)), batch = new Set(), out = [];
        for(const d of drafts) {
            if(d.claveOrigen && (seen.has(d.claveOrigen) || batch.has(d.claveOrigen))) {
                const ex = posted(db).find(a => a.claveOrigen === d.claveOrigen);
                return {ok: false, duplicado: true, existente: ex && ex.id, error: 'La operación ' + d.claveOrigen + ' ya está contabilizada.'};
            }
            const errs = validateDraft(db, d, ctx);
            if(errs.length) return {ok: false, errores: errs, error: errs[0]};
            if(d.claveOrigen) batch.add(d.claveOrigen);
            out.push(d);
        }
        db.cfg = db.cfg || {}; db.cfg.secuencias = db.cfg.secuencias || {};
        let n = nextNumber(db); const now = (ctx && ctx.ahora) || new Date().toISOString(), made = [];
        db.asientos = db.asientos || [];
        out.forEach(d => {
            const e = {id: d.id || (d.claveOrigen ? 'AS:' + d.claveOrigen : uuid(ctx)), numero: n++, fecha: d.fecha, fechaRegistro: now, descripcion: String(d.descripcion).trim(),
                tipo: d.tipo || 'manual', origen: d.origen || {modulo: 'manual', id: ''}, claveOrigen: d.claveOrigen || '', usuario: (ctx && ctx.usuario) || '', estado: 'contabilizado',
                periodo: periodOf(d.fecha), comprobantes: d.comprobantes || [], lineas: d.lineas.map(l => ({cuenta: l.cuenta, debe: Number(l.debe) || 0, haber: Number(l.haber) || 0, descripcion: l.descripcion || '', ref: l.ref || ''})),
                creado: (d.creado || now), contabilizado: now};
            if(d.reversaDe) { e.reversaDe = d.reversaDe; e.motivo = d.motivo; }
            if(d.aprobadoPor) e.aprobadoPor = d.aprobadoPor;
            db.asientos.push(e); made.push(e);
            audit(db, ctx, 'asiento.contabilizar', e.id, '#' + e.numero + ' ' + e.descripcion);
        });
        db.cfg.secuencias.asientoNext = n;
        return {ok: true, asientos: made, asiento: made[0]};
    }
    const post = (db, d, ctx) => postMany(db, [d], ctx);

    // Borradores: se pueden editar; los contabilizados no.
    function saveDraft(db, d, ctx) {
        if(!can(ctx && ctx.rol, 'borrador')) return {ok: false, error: 'Sin permiso para crear borradores.'};
        db.asientos = db.asientos || [];
        const old = d.id && db.asientos.find(a => a.id === d.id);
        if(old && old.estado !== 'borrador') return editEntry(db, d.id, d, ctx);
        const row = {id: d.id || uuid(ctx), estado: 'borrador', fecha: d.fecha, descripcion: d.descripcion, tipo: d.tipo || 'manual', origen: d.origen || {modulo: 'manual', id: ''}, claveOrigen: d.claveOrigen || '', lineas: d.lineas || [], usuario: (ctx && ctx.usuario) || '', creado: (ctx && ctx.ahora) || new Date().toISOString()};
        if(old) Object.assign(old, row); else db.asientos.push(row);
        audit(db, ctx, 'asiento.borrador', row.id, row.descripcion);
        return {ok: true, borrador: row};
    }
    function postDraft(db, id, ctx) {
        const i = (db.asientos || []).findIndex(a => a.id === id && a.estado === 'borrador');
        if(i < 0) return {ok: false, error: 'Borrador no encontrado.'};
        const d = db.asientos[i];
        const errs = validateDraft(db, d, ctx); if(errs.length) return {ok: false, errores: errs, error: errs[0]};
        db.asientos.splice(i, 1);
        const r = post(db, {...d, id: d.claveOrigen ? undefined : d.id}, ctx);
        if(!r.ok) db.asientos.splice(i, 0, d);
        return r;
    }
    // Un asiento contabilizado nunca se edita ni se elimina: la corrección es un reverso.
    function editEntry(db, id) {
        const e = (db.asientos || []).find(a => a.id === id);
        if(!e) return {ok: false, error: 'Asiento no encontrado.'};
        if(e.estado === 'contabilizado') return {ok: false, inmutable: true, error: 'Un asiento contabilizado no se edita. Use un reverso y registre uno nuevo.'};
        return {ok: false, error: 'Use saveDraft para editar borradores.'};
    }
    function deleteEntry(db, id) {
        const e = (db.asientos || []).find(a => a.id === id);
        if(!e) return {ok: false, error: 'Asiento no encontrado.'};
        if(e.estado === 'contabilizado') return {ok: false, inmutable: true, error: 'Un asiento contabilizado no se elimina. Use un reverso.'};
        db.asientos = db.asientos.filter(a => a.id !== id); return {ok: true};
    }
    function reverseEntry(db, id, info, ctx) {
        if(!can(ctx && ctx.rol, 'reversar')) return {ok: false, error: 'Sin permiso para anular mediante reverso.'};
        const e = posted(db).find(a => a.id === id); if(!e) return {ok: false, error: 'Asiento contabilizado no encontrado.'};
        if(e.reversaDe) return {ok: false, error: 'No se puede reversar un reverso; registre un asiento nuevo.'};
        if(posted(db).some(a => a.reversaDe === id)) return {ok: false, error: 'Ese asiento ya fue reversado.'};
        if(!info || String(info.motivo || '').trim().length < 5) return {ok: false, error: 'Escriba el motivo del reverso (mínimo 5 letras).'};
        const r = post(db, {fecha: (info.fecha || (ctx && ctx.hoy)), descripcion: 'REVERSO del asiento #' + e.numero + ': ' + info.motivo.trim(), tipo: 'reverso', origen: {modulo: 'contabilidad', id: e.id},
            claveOrigen: 'REV:' + e.id, reversaDe: e.id, motivo: info.motivo.trim(), lineas: e.lineas.map(l => ({cuenta: l.cuenta, debe: l.haber, haber: l.debe, descripcion: 'Reverso', ref: l.ref}))}, ctx);
        if(r.ok) audit(db, ctx, 'asiento.reversar', e.id, info.motivo);
        return r;
    }

    // ---------------------------------------------------------------- Integridad
    function integrityCheck(db) {
        const issues = [], list = posted(db), keys = new Map(), nums = new Map();
        list.forEach(a => {
            let d = 0, h = 0; (a.lineas || []).forEach(l => { d += cents(l.debe); h += cents(l.haber); });
            if(d !== h) issues.push({tipo: 'descuadrado', asiento: a.id, detalle: 'Débitos y créditos distintos en #' + a.numero});
            if(a.claveOrigen) { if(keys.has(a.claveOrigen)) issues.push({tipo: 'duplicado', asiento: a.id, detalle: 'Operación contabilizada dos veces: ' + a.claveOrigen}); keys.set(a.claveOrigen, a.id); }
            if(nums.has(a.numero)) issues.push({tipo: 'numero_repetido', asiento: a.id, detalle: 'Número de asiento repetido: ' + a.numero}); nums.set(a.numero, a.id);
            (a.lineas || []).forEach(l => { if(!acct(db, l.cuenta)) issues.push({tipo: 'cuenta_inexistente', asiento: a.id, detalle: l.cuenta}); });
        });
        return issues;
    }
    // Un dispositivo que sincroniza no puede quitar ni alterar asientos contabilizados ni la bitácora.
    function validateWorkspaceChange(oldDb, newDb) {
        const errs = [], nw = new Map((newDb.asientos || []).map(a => [a.id, a]));
        posted(oldDb).forEach(a => {
            const n = nw.get(a.id);
            if(!n) errs.push('Falta el asiento contabilizado #' + a.numero);
            else if(JSON.stringify(n) !== JSON.stringify(a)) errs.push('Se alteró el asiento contabilizado #' + a.numero);
        });
        const na = new Map((newDb.auditoriaConta || []).map(a => [a.id, a]));
        (oldDb.auditoriaConta || []).forEach(a => { if(!na.has(a.id) || JSON.stringify(na.get(a.id)) !== JSON.stringify(a)) errs.push('Se alteró la bitácora contable'); });
        return errs;
    }
    // Tras una sincronización, los asientos creados en este dispositivo que chocan en número con otros se renumeran (aún no estaban aceptados en la nube).
    function resolveNumberConflicts(db, localNewIds) {
        const local = new Set(localNewIds), taken = new Set(posted(db).filter(a => !local.has(a.id)).map(a => a.numero));
        let next = Math.max(0, ...posted(db).map(a => a.numero)) + 1, changed = [];
        posted(db).filter(a => local.has(a.id)).sort((a, b) => a.numero - b.numero).forEach(a => {
            if(taken.has(a.numero)) { a.numero = next++; changed.push(a.id); }
            taken.add(a.numero);
        });
        if(db.cfg && db.cfg.secuencias) db.cfg.secuencias.asientoNext = Math.max(next, Number(db.cfg.secuencias.asientoNext) || 1);
        return changed;
    }

    // ---------------------------------------------------------------- Saldos, mayor y balance de comprobación
    const sign = (db, code) => (acct(db, code) || {}).naturaleza === 'acreedora' ? -1 : 1;
    function balanceOf(db, code, to, from) {
        let c = 0; posted(db).forEach(a => { if((!to || a.fecha <= to) && (!from || a.fecha >= from)) a.lineas.forEach(l => { if(l.cuenta === code) c += cents(l.debe) - cents(l.haber); }); });
        return c * sign(db, code) / 100;
    }
    function balanceByRef(db, code, ref, to) {
        let c = 0; posted(db).forEach(a => { if(!to || a.fecha <= to) a.lineas.forEach(l => { if(l.cuenta === code && l.ref === ref) c += cents(l.debe) - cents(l.haber); }); });
        return c * sign(db, code) / 100;
    }
    function mayor(db, code, from, to) {
        const open = cents(balanceOf(db, code, addDay(from, -1))), s = sign(db, code); let run = open, deb = 0, cre = 0;
        const rows = [];
        posted(db).filter(a => a.fecha >= from && a.fecha <= to).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.numero - b.numero).forEach(a => a.lineas.forEach(l => {
            if(l.cuenta !== code) return;
            deb += cents(l.debe); cre += cents(l.haber); run += (cents(l.debe) - cents(l.haber)) * s;
            rows.push({fecha: a.fecha, numero: a.numero, asiento: a.id, descripcion: l.descripcion || a.descripcion, ref: l.ref, debe: l.debe, haber: l.haber, saldo: money(run)});
        }));
        return {cuenta: code, saldoInicial: money(open), debitos: money(deb), creditos: money(cre), saldoFinal: money(run), movimientos: rows};
    }
    function addDay(d, n) { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); }
    function trialBalance(db, to) {
        const totals = new Map();
        posted(db).filter(a => !to || a.fecha <= to).forEach(a => a.lineas.forEach(l => totals.set(l.cuenta, (totals.get(l.cuenta) || 0) + cents(l.debe) - cents(l.haber))));
        const rows = [...totals.entries()].filter(([, v]) => v !== 0).sort((a, b) => a[0].localeCompare(b[0], undefined, {numeric: true})).map(([code, v]) => ({cuenta: code, nombre: (acct(db, code) || {}).nombre || code, deudor: v > 0 ? money(v) : 0, acreedor: v < 0 ? money(-v) : 0}));
        const d = rows.reduce((s, r) => s + cents(r.deudor), 0), c = rows.reduce((s, r) => s + cents(r.acreedor), 0);
        return {filas: rows, deudor: money(d), acreedor: money(c), cuadra: d === c};
    }
    function incomeStatement(db, from, to) {
        const by = {ingreso: {}, gasto: {}};
        posted(db).filter(a => a.fecha >= from && a.fecha <= to).forEach(a => a.lineas.forEach(l => { const ac = acct(db, l.cuenta); if(ac && by[ac.tipo]) by[ac.tipo][l.cuenta] = (by[ac.tipo][l.cuenta] || 0) + (cents(l.debe) - cents(l.haber)) * sign(db, l.cuenta); }));
        const rows = t => Object.entries(by[t]).filter(([, v]) => v !== 0).sort().map(([code, v]) => ({cuenta: code, nombre: acct(db, code).nombre, importe: money(v)}));
        const ing = rows('ingreso'), gas = rows('gasto'), tot = r => r.reduce((s, x) => s + cents(x.importe), 0);
        const perdidas = gas.filter(g => g.cuenta === '5.1.10');
        return {ingresos: ing, gastos: gas.filter(g => g.cuenta !== '5.1.10'), perdidasCrediticias: perdidas, totalIngresos: money(tot(ing)), totalGastos: money(tot(gas)), resultado: money(tot(ing) - tot(gas))};
    }
    function balanceSheet(db, to) {
        // Cada sección se presenta con su propio signo: las cuentas que restan (no devengados, retiros, depreciación) salen en negativo.
        const net = code => { let c = 0; posted(db).forEach(a => { if(a.fecha <= to) a.lineas.forEach(l => { if(l.cuenta === code) c += cents(l.debe) - cents(l.haber); }); }); return c; };
        const group = t => catalog(db).filter(a => a.movimiento && a.tipo === t).map(a => ({cuenta: a.code, nombre: a.nombre, saldo: money(t === 'activo' ? net(a.code) : -net(a.code))})).filter(r => r.saldo !== 0);
        const act = group('activo'), pas = group('pasivo'), pat = group('patrimonio');
        const sumc = r => r.reduce((s, x) => s + cents(x.saldo), 0);
        const year = to.slice(0, 4), res = incomeStatement(db, year + '-01-01', to).resultado;
        const prev = incomeStatement(db, '0000-01-01', addDay(year + '-01-01', -1)).resultado;
        const A_ = sumc(act), P_ = sumc(pas), PT = sumc(pat) + cents(res) + cents(prev);
        const sin = catalog(db).some(a => a.code === '3.3.99') && Math.abs(balanceOf(db, '3.3.99', to)) > 0;
        return {activos: act, pasivos: pas, patrimonio: pat, resultadoEjercicio: res, resultadosAnterioresNoCerrados: prev, totalActivos: money(A_), totalPasivos: money(P_), totalPatrimonio: money(PT),
            cuadra: A_ === P_ + PT, advertencias: sin ? ['Hay una diferencia de apertura bajo excepción autorizada sin conciliar: el informe no es definitivo.'] : []};
    }
    function cashFlow(db, from, to) {
        const cls = {operativo: 0, inversion: 0, financiacion: 0}, det = {};
        posted(db).filter(a => a.fecha >= from && a.fecha <= to).forEach(a => {
            let cash = 0, others = [];
            a.lineas.forEach(l => { if(isCashAcct(db, l.cuenta)) cash += cents(l.debe) - cents(l.haber); else others.push(l.cuenta); });
            if(!cash || !others.length) return;
            const k = others.some(c => c === '1.4.01') ? 'inversion' : others.some(c => /^(2\.1\.0[1256]|3\.1|3\.2)/.test(c)) ? 'financiacion' : 'operativo';
            cls[k] += cash; const key = k + '|' + a.tipo; det[key] = (det[key] || 0) + cash;
        });
        const open = cashBalance(db, addDay(from, -1)), close = cashBalance(db, to), net = cls.operativo + cls.inversion + cls.financiacion;
        return {operativo: money(cls.operativo), inversion: money(cls.inversion), financiacion: money(cls.financiacion), variacion: money(net), efectivoInicial: open, efectivoFinal: close,
            cuadra: cents(open) + net === cents(close), detalle: Object.entries(det).map(([k, v]) => ({clase: k.split('|')[0], concepto: k.split('|')[1], importe: money(v)}))};
    }
    const cashBalance = (db, to) => money(catalog(db).filter(a => a.efectivo).reduce((s, a) => s + cents(balanceOf(db, a.code, to)), 0));
    const journal = (db, from, to) => posted(db).filter(a => a.fecha >= from && a.fecha <= to).sort((a, b) => a.numero - b.numero);

    // ---------------------------------------------------------------- Reglas de contabilización (borradores listos para postMany)
    const accountOf = (m, db) => { const code = typeof m === 'string' && /^\d/.test(m) ? m : CASH[m]; if(!code) return null; return code; };
    const need = (cond, msg) => { if(!cond) throw new Error(msg); };
    const wrap = fn => (...a) => { try { return {ok: true, draft: fn(...a)}; } catch(e) { return {ok: false, error: e.message}; } };
    const L = (cuenta, debe, haber, descripcion, ref) => ({cuenta, debe: debe || 0, haber: haber || 0, descripcion: descripcion || '', ref: ref || ''});
    const polOf = db => conf(db).politicaIntereses || null;
    function interestPlan(cre) {
        const n = (cre.schedule || []).length || Number(cre.plz) || 1, total = cents(cre.total) - cents(cre.cap), base = Math.floor(total / n), plan = [];
        for(let i = 1; i <= n; i++) plan.push({n: i, fecha: (cre.schedule && cre.schedule[i - 1] && cre.schedule[i - 1].dateKey) || '', centavos: i === n ? total - base * (n - 1) : base});
        return plan;
    }
    // Desembolso confirmado: sale efectivo, nace la cartera y (según política) los intereses contractuales.
    const desembolso = wrap((db, cre, o) => {
        need(cre && !cre.esPrueba, 'Los créditos de prueba no se contabilizan.');
        need(o && o.confirmado === true, 'El desembolso aún no está confirmado.');
        need(o.fecha, 'Falta la fecha del desembolso.');
        const pol = polOf(db); need(pol, 'Falta definir la política de reconocimiento de intereses (cfg.conta.politicaIntereses).');
        const medio = accountOf(o.medio || 'caja', db); need(medio && isCashAcct(db, medio), 'El medio de pago debe ser una cuenta de efectivo o banco.');
        const cap = Number(cre.cap), desc = Number(cre.descuento) || 0, neto = cents(cap) - cents(desc), interes = cents(cre.total) - cents(cap);
        const lines = [L('1.2.01', cap, 0, 'Principal del crédito ' + cre.id, cre.id)];
        if(pol === 'devengo_cuota' && interes > 0) lines.push(L('1.2.02', money(interes), 0, 'Intereses contractuales', cre.id), L('1.2.03', 0, money(interes), 'Intereses no devengados', cre.id));
        lines.push(L(medio, 0, money(neto), 'Salida de efectivo (neto entregado)', cre.id));
        if(desc > 0) lines.push(L('1.2.99', 0, desc, 'Saldo del crédito anterior compensado', cre.id));
        return {fecha: o.fecha, descripcion: 'Desembolso del crédito ' + cre.id + (o.cliente ? ' - ' + o.cliente : ''), tipo: 'desembolso', origen: {modulo: 'creditos', id: cre.id}, claveOrigen: 'desembolso:' + cre.id, comprobantes: [cre.contrato || cre.id], lineas: lines};
    });
    // Devengo de un tramo de intereses (política devengo_cuota). Idempotente por crédito y cuota.
    const devengo = wrap((db, cre, n, fecha) => {
        need(polOf(db) === 'devengo_cuota', 'La política vigente no devenga intereses por cuota.');
        const item = interestPlan(cre).find(x => x.n === n); need(item, 'La cuota no existe.');
        const imp = Math.min(item.centavos, cents(balanceByRef(db, '1.2.03', cre.id))); need(imp > 0, 'No quedan intereses por devengar en ' + cre.id + '.');
        return {fecha, descripcion: 'Devengo de intereses cuota ' + n + ' del crédito ' + cre.id, tipo: 'devengo', origen: {modulo: 'creditos', id: cre.id}, claveOrigen: 'devengo:' + cre.id + ':' + n,
            lineas: [L('1.2.03', money(imp), 0, 'Intereses devengados', cre.id), L('4.1.01', 0, money(imp), 'Ingreso por intereses', cre.id)]};
    });
    // Cobro confirmado: separa capital, intereses y mora. Mora dispensada o no cobrada no genera efectivo ni ingreso.
    const cobro = wrap((db, pag, cre, o) => {
        need(pag && cre && !cre.esPrueba, 'Los créditos de prueba no se contabilizan.');
        const pri = cents(pag.pri), int = cents(pag.int), m = cents(pag.m), t = cents(pag.t);
        need(pri >= 0 && int >= 0 && m >= 0, 'El cobro tiene importes negativos.');
        need(Math.abs(pri + int + m - t) <= 1, 'El cobro no cuadra: capital + intereses + mora ≠ total recibido.');
        if(t === 0) return null;   // Solo dispensa de mora: no entra efectivo ni se reconoce ingreso.
        const pol = polOf(db); need(pol, 'Falta definir la política de reconocimiento de intereses (cfg.conta.politicaIntereses).');
        const refi = pag.tipo === 'refinanciamiento';
        const medio = refi ? '1.2.99' : accountOf((o && o.medio) || 'caja', db);
        need(medio && (refi || isCashAcct(db, medio)), 'El medio de cobro debe ser una cuenta de efectivo o banco.');
        const fecha = pag.fechaISO || (o && o.fecha); need(fecha, 'Falta la fecha del cobro.');
        const lines = [L(medio, money(t), 0, refi ? 'Compensación sin efectivo' : 'Efectivo recibido', cre.id)];
        if(pri) lines.push(L('1.2.01', 0, money(pri), 'Recuperación de capital', cre.id));
        if(int) {
            if(pol === 'devengo_cuota') {
                const unaccrued = cents(balanceByRef(db, '1.2.03', cre.id)), accruedUnpaid = cents(balanceByRef(db, '1.2.02', cre.id)) - unaccrued;
                const extra = Math.max(0, int - Math.max(0, accruedUnpaid));
                need(extra <= unaccrued, 'Los intereses cobrados exceden los intereses contractuales registrados para ' + cre.id + ' (revise la apertura o el desembolso).');
                if(extra) lines.push(L('1.2.03', money(extra), 0, 'Devengo anticipado por cobro', cre.id), L('4.1.01', 0, money(extra), 'Ingreso por intereses', cre.id));
                lines.push(L('1.2.02', 0, money(int), 'Cobro de intereses contractuales', cre.id));
            } else lines.push(L('4.1.01', 0, money(int), 'Ingreso por intereses cobrados', cre.id));
        }
        if(m) lines.push(L('4.1.02', 0, money(m), 'Mora cobrada', cre.id));
        return {fecha, descripcion: (refi ? 'Compensación por refinanciamiento ' : 'Cobro ') + pag.id + ' del crédito ' + cre.id, tipo: refi ? 'refinanciamiento' : 'cobro', origen: {modulo: 'cobros', id: pag.id}, claveOrigen: 'cobro:' + pag.id, comprobantes: [pag.id], lineas: lines};
    });
    const gasto = wrap((db, g) => {
        need(g.fecha && g.monto > 0 && g.cuenta, 'Faltan fecha, monto o cuenta del gasto.');
        const ac = acct(db, g.cuenta); need(ac && (ac.tipo === 'gasto' || g.esActivo), 'La cuenta del gasto no es de gastos.');
        need(['caja', 'banco', 'otro', 'pendiente', 'propietario'].includes(g.pago) || /^\d/.test(g.pago || ''), 'Indique cómo se pagó: caja, banco, pendiente o propietario.');
        let cr;
        if(g.pago === 'pendiente') cr = L(g.cuentaPorPagar || '2.1.03', 0, g.monto, 'Pendiente de pago' + (g.proveedor ? ' - ' + g.proveedor : ''));
        else if(g.pago === 'propietario') { need(['por_pagar_propietario', 'aporte'].includes(g.tratamiento), 'Indique si se reembolsará al propietario o se trata como aporte.'); cr = L(g.tratamiento === 'aporte' ? '3.1.02' : '2.1.07', 0, g.monto, 'Pagado con fondos personales'); }
        else { const m = accountOf(g.pago, db); need(isCashAcct(db, m), 'El medio de pago no es efectivo ni banco.'); cr = L(m, 0, g.monto, 'Pago del gasto'); }
        return {fecha: g.fecha, descripcion: (g.descripcion || ac.nombre) + (g.proveedor ? ' - ' + g.proveedor : ''), tipo: g.esActivo ? 'adquisicion_activo' : 'gasto', origen: {modulo: 'gastos', id: g.id || ''}, claveOrigen: g.id ? 'gasto:' + g.id : '', comprobantes: g.comprobante ? [g.comprobante] : [], lineas: [L(g.cuenta, g.monto, 0, g.descripcion || ''), cr]};
    });
    const pagoGastoPendiente = wrap((db, p) => { const m = accountOf(p.medio || 'caja', db); need(isCashAcct(db, m) && p.monto > 0, 'Datos del pago no válidos.'); return {fecha: p.fecha, descripcion: 'Pago de obligación ' + (p.descripcion || ''), tipo: 'pago_obligacion', origen: {modulo: 'gastos', id: p.id || ''}, claveOrigen: p.id ? 'pagoobl:' + p.id : '', lineas: [L(p.cuenta || '2.1.03', p.monto, 0), L(m, 0, p.monto)]}; });
    const propietario = wrap((db, o) => {
        need(o.fecha && o.monto > 0, 'Faltan fecha o monto.');
        const m = accountOf(o.medio || 'caja', db); need(isCashAcct(db, m), 'El medio no es efectivo ni banco.');
        const map = {
            aporte: [L(m, o.monto, 0, 'Aporte del propietario'), L(o.adicional ? '3.1.02' : '3.1.01', 0, o.monto)],
            retiro: [L('3.2.01', o.monto, 0, 'Retiro personal'), L(m, 0, o.monto)],
            prestamo: [L(m, o.monto, 0, 'Préstamo del propietario'), L('2.1.06', 0, o.monto)],
            reembolso: [L(o.contra === '2.1.06' ? '2.1.06' : '2.1.07', o.monto, 0, 'Reembolso al propietario'), L(m, 0, o.monto)],
            gasto_personal: null
        };
        if(o.tipo === 'gasto_personal') {
            need(['retiro', 'por_cobrar'].includes(o.tratamiento), 'Indique si el gasto personal se trata como retiro o como cuenta por cobrar al propietario.');
            return {fecha: o.fecha, descripcion: 'Gasto personal pagado con fondos de la financiera', tipo: 'gasto_personal', origen: {modulo: 'propietario', id: o.id || ''}, claveOrigen: o.id ? 'prop:' + o.id : '', lineas: [L(o.tratamiento === 'retiro' ? '3.2.01' : '1.3.02', o.monto, 0), L(m, 0, o.monto)]};
        }
        need(map[o.tipo], 'Tipo de operación del propietario no válido.');
        return {fecha: o.fecha, descripcion: o.descripcion || 'Operación del propietario: ' + o.tipo, tipo: 'propietario_' + o.tipo, origen: {modulo: 'propietario', id: o.id || ''}, claveOrigen: o.id ? 'prop:' + o.id : '', lineas: map[o.tipo]};
    });
    const deuda = wrap((db, o) => {
        need(o.fecha && o.monto > 0, 'Faltan fecha o monto.');
        const m = accountOf(o.medio || 'caja', db); need(isCashAcct(db, m), 'El medio no es efectivo ni banco.');
        const pas = o.cuenta || '2.1.01', t = {
            recibido: [L(m, o.monto, 0, 'Préstamo recibido de ' + (o.acreedor || '')), L(pas, 0, o.monto)],
            principal: [L(pas, o.monto, 0, 'Pago de principal'), L(m, 0, o.monto)],
            interes: [L('5.1.09', o.monto, 0, 'Intereses de deuda'), L(m, 0, o.monto)]
        }[o.tipo];
        need(t, 'Tipo de operación de deuda no válido.');
        return {fecha: o.fecha, descripcion: 'Deuda ' + o.tipo + (o.acreedor ? ' - ' + o.acreedor : ''), tipo: 'deuda_' + o.tipo, origen: {modulo: 'deudas', id: o.id || ''}, claveOrigen: o.id ? 'deuda:' + o.id : '', lineas: t};
    });
    const transferencia = wrap((db, o) => {
        const a = accountOf(o.desde, db), b = accountOf(o.hacia, db);
        need(a && b && a !== b, 'Origen y destino deben ser dos cuentas distintas.');
        need(isCashAcct(db, a) && isCashAcct(db, b), 'Solo se transfiere entre cajas y bancos propios.');
        need(o.monto > 0 && o.fecha, 'Faltan fecha o monto.');
        return {fecha: o.fecha, descripcion: o.descripcion || 'Transferencia entre cuentas propias', tipo: 'transferencia', origen: {modulo: 'tesoreria', id: o.id || ''}, claveOrigen: o.id ? 'transf:' + o.id : '', lineas: [L(b, o.monto, 0, 'Entrada'), L(a, 0, o.monto, 'Salida')]};
    });
    const diferenciaCaja = wrap((db, o) => {
        need(o.aprobadoPor && String(o.motivo || '').trim().length >= 10, 'El ajuste exige quién lo aprueba y el resultado de la investigación (mínimo 10 letras).');
        const dif = cents(o.fisico) - cents(o.teorico); need(dif !== 0, 'No hay diferencia que ajustar.');
        const m = accountOf(o.cuenta || 'caja', db);
        return {fecha: o.fecha, descripcion: 'Ajuste de diferencia de caja aprobado: ' + o.motivo.trim(), tipo: 'ajuste_caja', aprobadoPor: o.aprobadoPor, origen: {modulo: 'tesoreria', id: o.id || ''}, claveOrigen: o.id ? 'difcaja:' + o.id : '',
            lineas: dif < 0 ? [L('5.1.12', money(-dif)), L(m, 0, money(-dif))] : [L(m, money(dif)), L('4.1.04', 0, money(dif))]};
    });
    const depreciacion = wrap((db, act, periodo) => {
        need(act && act.estado !== 'baja', 'El activo no está vigente.');
        const mes = Math.round((cents(act.costo) - cents(act.residual || 0)) / act.vidaMeses);
        const restante = cents(act.costo) - cents(act.residual || 0) - cents(act.depAcum || 0); need(restante > 0, 'El activo ya está totalmente depreciado.');
        const imp = Math.min(mes, restante);
        return {fecha: lastDay(periodo), descripcion: 'Depreciación ' + periodo + ' - ' + act.descripcion, tipo: 'depreciacion', origen: {modulo: 'activos', id: act.id}, claveOrigen: 'dep:' + act.id + ':' + periodo, lineas: [L('5.1.08', money(imp)), L('1.4.02', 0, money(imp))]};
    });
    const lastDay = p => { const [y, m] = p.split('-').map(Number); return p + '-' + String(new Date(y, m, 0).getDate()).padStart(2, '0'); };

    // ---------------------------------------------------------------- Apertura (31/10/2026) sin cuentas de ajuste inventadas
    function validateOpening(db, lines) {
        const errs = [], detail = [];
        let d = 0, h = 0;
        (lines || []).forEach((l, i) => {
            const a = acct(db, l.cuenta);
            if(!a || !a.movimiento) errs.push('Línea ' + (i + 1) + ': cuenta no válida.');
            if(!String(l.fuente || '').trim()) errs.push('Línea ' + (i + 1) + ': falta la fuente que sustenta el saldo.');
            d += cents(l.debe); h += cents(l.haber);
        });
        const dif = d - h;
        return {listo: !errs.length && dif === 0 && (lines || []).length >= 2, diferencia: money(dif), errores: errs, bloqueado: dif !== 0, detalle: detail};
    }
    function approveOpening(db, lines, info, ctx) {
        if(!can(ctx && ctx.rol, 'aprobarAjuste')) return {ok: false, error: 'Sin permiso para aprobar la apertura.'};
        const cfg = conf(db); if(cfg.aperturaAprobada) return {ok: false, error: 'La apertura ya fue aprobada.'};
        const fecha = cfg.fechaApertura || '2026-10-31'; db.cfg = db.cfg || {}; db.cfg.conta = db.cfg.conta || {};
        const v = validateOpening(db, lines), all = [...lines];
        if(v.errores.length) return {ok: false, error: v.errores[0], errores: v.errores};
        if(v.diferencia !== 0) {
            const ex = info && info.excepcion;
            if(!ex || !String(ex.autorizadoPor || '').trim() || String(ex.sustento || '').trim().length < 30) return {ok: false, bloqueado: true, diferencia: v.diferencia, error: 'El balance de apertura no cuadra (diferencia ' + v.diferencia.toFixed(2) + '). Resuélvala o registre una excepción autorizada y sustentada (mínimo 30 letras).'};
            const dif = cents(v.diferencia); all.push(dif > 0 ? L('3.3.99', 0, v.diferencia, 'Excepción: ' + ex.sustento, '') : L('3.3.99', -v.diferencia, 0, 'Excepción: ' + ex.sustento, ''));
            audit(db, ctx, 'apertura.excepcion', fecha, ex.autorizadoPor + ': ' + ex.sustento);
        }
        const prev = db.cfg.conta.aperturaAprobada; db.cfg.conta.aperturaAprobada = true;
        const r = post(db, {fecha, descripcion: 'Asiento de apertura contable', tipo: 'apertura', origen: {modulo: 'apertura', id: fecha}, claveOrigen: 'apertura:' + fecha, lineas: all.map(l => ({cuenta: l.cuenta, debe: l.debe, haber: l.haber, descripcion: l.fuente || l.descripcion, ref: l.ref}))}, {...ctx, hoy: ctx && ctx.hoy ? (ctx.hoy < fecha ? fecha : ctx.hoy) : fecha});
        if(!r.ok) { db.cfg.conta.aperturaAprobada = prev; return r; }
        audit(db, ctx, 'apertura.aprobar', fecha, (info && info.observaciones) || '');
        return r;
    }

    // ---------------------------------------------------------------- Conciliación de cartera con los auxiliares operativos (clientes/créditos/cobros)
    function auxiliarCartera(db, hasta) {
        const rows = (db.cre || []).filter(c => !c.esPrueba && Number(c.saldo) > 0.005 && Number(c.total) > 0).map(c => {
            const cap = cents(c.saldo) * Number(c.cap) / Number(c.total), capR = Math.round(cap);
            return {credito: c.id, cliente: c.cliId, saldo: Number(c.saldo), capital: money(capR), interes: money(cents(c.saldo) - capR)};
        });
        return {filas: rows, capital: money(rows.reduce((s, r) => s + cents(r.capital), 0)), interes: money(rows.reduce((s, r) => s + cents(r.interes), 0)), hasta};
    }
    function reconcilePortfolio(db, hasta) {
        const aux = auxiliarCartera(db, hasta), pol = polOf(db), diffs = [];
        const ledgerCap = balanceOf(db, '1.2.01', hasta), ledgerInt = pol === 'devengo_cuota' ? balanceOf(db, '1.2.02', hasta) : null;
        const byRef = new Map(aux.filas.map(r => [r.credito, r]));
        const refs = new Set([...aux.filas.map(r => r.credito), ...posted(db).flatMap(a => a.lineas.filter(l => l.cuenta === '1.2.01' && l.ref).map(l => l.ref))]);
        refs.forEach(ref => {
            const a = byRef.get(ref) || {capital: 0, interes: 0}, lc = balanceByRef(db, '1.2.01', ref, hasta), li = pol === 'devengo_cuota' ? balanceByRef(db, '1.2.02', ref, hasta) : a.interes;
            if(Math.abs(cents(lc) - cents(a.capital)) > 1 || Math.abs(cents(li) - cents(a.interes)) > 1) diffs.push({credito: ref, capitalMayor: lc, capitalAuxiliar: a.capital, interesMayor: li, interesAuxiliar: a.interes});
        });
        return {capitalMayor: ledgerCap, capitalAuxiliar: aux.capital, interesMayor: ledgerInt, interesAuxiliar: aux.interes, cuadra: Math.abs(cents(ledgerCap) - cents(aux.capital)) <= 1 && (ledgerInt === null || Math.abs(cents(ledgerInt) - cents(aux.interes)) <= 1) && !diffs.length, diferencias: diffs,
            compensacionTransitoria: balanceOf(db, '1.2.99', hasta)};
    }

    // ---------------------------------------------------------------- Caja y bancos
    function cashClose(db, o, ctx) {
        db.cajas = db.cajas || [];
        const teorico = balanceOf(db, o.cuenta, o.fecha), dif = cents(o.fisico) - cents(teorico);
        const row = {id: 'caja:' + o.cuenta + ':' + o.fecha, fecha: o.fecha, cuenta: o.cuenta, teorico, fisico: Number(o.fisico), diferencia: money(dif), estado: dif === 0 ? 'cuadrada' : 'pendiente_investigacion', usuario: (ctx && ctx.usuario) || ''};
        if(db.cajas.some(c => c.id === row.id)) return {ok: false, error: 'La caja de esa fecha ya está cerrada.'};
        db.cajas.push(row); audit(db, ctx, 'caja.cierre', row.id, 'Diferencia ' + row.diferencia.toFixed(2));
        return {ok: true, cierre: row};   // Nunca se ajusta el saldo contable por sí solo.
    }
    function bankMovement(db, m, ctx) {
        db.bancoMov = db.bancoMov || [];
        if(!m.id || db.bancoMov.some(x => x.id === m.id)) return {ok: false, error: 'Movimiento sin identificador o repetido.'};
        db.bancoMov.push({id: m.id, fecha: m.fecha, descripcion: m.descripcion || '', monto: Number(m.monto), cuenta: m.cuenta || CASH.banco, estado: 'pendiente', asientoId: ''});
        return {ok: true};
    }
    function reconcileBank(db, movId, asientoId, ctx) {
        const mv = (db.bancoMov || []).find(x => x.id === movId), a = posted(db).find(x => x.id === asientoId);
        if(!mv || !a) return {ok: false, error: 'Movimiento o asiento no encontrado.'};
        const net = a.lineas.filter(l => l.cuenta === mv.cuenta).reduce((s, l) => s + cents(l.debe) - cents(l.haber), 0);
        if(net !== cents(mv.monto)) return {ok: false, error: 'El importe del banco (' + mv.monto + ') no coincide con el del asiento (' + money(net) + ').'};
        if((db.bancoMov || []).some(x => x.asientoId === asientoId)) return {ok: false, error: 'Ese asiento ya está conciliado con otro movimiento.'};
        mv.estado = 'conciliado'; mv.asientoId = asientoId; audit(db, ctx, 'banco.conciliar', movId, asientoId);
        return {ok: true};
    }
    const bankReport = db => ({pendientes: (db.bancoMov || []).filter(m => m.estado !== 'conciliado'), conciliados: (db.bancoMov || []).filter(m => m.estado === 'conciliado')});

    // ---------------------------------------------------------------- Cierre mensual
    const CLOSE_TASKS = ['Conciliación de caja y bancos', 'Conciliación de cartera con auxiliares', 'Revisión de intereses (devengados y no devengados)', 'Revisión de deudas y cuentas por pagar', 'Revisión de aportes y retiros',
        'Gastos pendientes y ajustes', 'Depreciaciones y estimaciones', 'Balance de comprobación', 'Revisión de asientos descuadrados o duplicados', 'Generación de estados financieros', 'Aprobación del cierre'];
    function startClose(db, periodo) {
        db.cierres = db.cierres || [];
        if(!db.cierres.some(c => c.id === periodo)) db.cierres.push({id: periodo, tareas: CLOSE_TASKS.map((n, i) => ({id: i + 1, nombre: n, estado: 'pendiente', nota: ''}))});
        return db.cierres.find(c => c.id === periodo);
    }
    function setCloseTask(db, periodo, id, estado, nota, ctx) {
        if(!can(ctx && ctx.rol, 'periodos')) return {ok: false, error: 'Sin permiso.'};
        const c = startClose(db, periodo), t = c.tareas.find(x => x.id === id);
        if(!t || !['pendiente', 'en_proceso', 'observado', 'aprobado'].includes(estado)) return {ok: false, error: 'Tarea o estado no válido.'};
        t.estado = estado; t.nota = nota || ''; t.usuario = (ctx && ctx.usuario) || ''; audit(db, ctx, 'cierre.tarea', periodo + '#' + id, estado);
        return {ok: true};
    }
    function closePeriod(db, periodo, ctx) {
        if(!can(ctx && ctx.rol, 'periodos')) return {ok: false, error: 'Sin permiso para cerrar períodos.'};
        const c = startClose(db, periodo), pend = c.tareas.filter(t => t.estado !== 'aprobado'), bloqueos = [];
        if(pend.length) bloqueos.push('Tareas sin aprobar: ' + pend.map(t => t.nombre).join('; '));
        const iss = integrityCheck(db); if(iss.length) bloqueos.push('Hay problemas de integridad (' + iss.length + ').');
        const to = lastDay(periodo); const tb = trialBalance(db, to); if(!tb.cuadra) bloqueos.push('El balance de comprobación no cuadra.');
        if(Math.abs(balanceOf(db, '1.2.99', to)) > 0) bloqueos.push('La compensación por refinanciamiento no está en cero.');
        if(bloqueos.length) return {ok: false, bloqueos, error: bloqueos[0]};
        closePeriodDirect(db, periodo, ctx); audit(db, ctx, 'periodo.cerrar', periodo, '');
        return {ok: true};
    }

    // ---------------------------------------------------------------- Tablero
    function dashboard(db, hoy) {
        const mes = hoy.slice(0, 7), from = mes + '-01', res = incomeStatement(db, from, hoy), pol = polOf(db);
        const src = 'Libro mayor (asientos contabilizados)';
        const bank = catalog(db).filter(a => a.efectivo).reduce((s, a) => s + cents(balanceOf(db, a.code, hoy)), 0);
        const mk = (valor, extra) => Object.assign({valor, periodo: extra && extra.periodo || 'al ' + hoy, actualizado: hoy, origen: src}, extra || {});
        return {
            efectivo: mk(money(bank)), carteraCapital: mk(balanceOf(db, '1.2.01', hoy)),
            interesesNoDevengados: mk(balanceOf(db, '1.2.03', hoy)), interesesPorCobrar: mk(money(cents(balanceOf(db, '1.2.02', hoy)) - cents(balanceOf(db, '1.2.03', hoy)))),
            pasivos: mk(money(catalog(db).filter(a => a.tipo === 'pasivo' && a.movimiento).reduce((s, a) => s + cents(balanceOf(db, a.code, hoy)), 0))),
            ingresosMes: mk(res.totalIngresos, {periodo: mes}), gastosMes: mk(res.totalGastos, {periodo: mes}), resultadoMes: mk(res.resultado, {periodo: mes}),
            diferenciasCaja: mk(money((db.cajas || []).filter(c => c.estado === 'pendiente_investigacion').reduce((s, c) => s + cents(c.diferencia), 0))),
            estadoCierre: {valor: periodState(db, hoy) === 'cerrado' ? 'cerrado' : 'abierto', periodo: mes, actualizado: hoy, origen: 'Períodos contables'},
            politicaIntereses: pol, aperturaAprobada: !!conf(db).aperturaAprobada
        };
    }

    // ---------------------------------------------------------------- Activos fijos
    function registerAsset(db, a, ctx) {
        if(!can(ctx && ctx.rol, 'contabilizar')) return {ok: false, error: 'Sin permiso.'};
        const umbral = conf(db).umbralActivoFijo;
        if(umbral == null && a.reconocerComoActivo !== true) return {ok: false, error: 'Falta definir el umbral de materialidad para activos fijos; o confirme expresamente que este bien se reconoce como activo.'};
        if(umbral != null && cents(a.costo) < cents(umbral) && a.reconocerComoActivo !== true) return {ok: false, error: 'El costo está por debajo del umbral de activo fijo: se registra como gasto.'};
        if(!(a.vidaMeses > 0) || !(cents(a.costo) > 0) || cents(a.residual || 0) >= cents(a.costo)) return {ok: false, error: 'Costo, vida útil y valor residual no son válidos.'};
        db.activosFijos = db.activosFijos || [];
        const row = {id: a.id || uuid(ctx), descripcion: a.descripcion, fechaAdq: a.fechaAdq, costo: Number(a.costo), cuenta: a.cuenta || '1.4.01', vidaMeses: a.vidaMeses, residual: Number(a.residual || 0), metodo: 'linea_recta', depAcum: 0, estado: 'vigente', fechaBaja: ''};
        db.activosFijos.push(row); audit(db, ctx, 'activo.registrar', row.id, row.descripcion);
        return {ok: true, activo: row};
    }

    root.GycLedger = {DEFAULT_ACCOUNTS, CASH, PERMS, can, ensureCatalog, addAccount, setAccountActive, validateAccount, acct,
        validateDraft, post, postMany, saveDraft, postDraft, editEntry, deleteEntry, reverseEntry, integrityCheck, validateWorkspaceChange, resolveNumberConflicts,
        periodState, reopenPeriod, closePeriod, startClose, setCloseTask, CLOSE_TASKS, audit,
        balanceOf, balanceByRef, mayor, trialBalance, incomeStatement, balanceSheet, cashFlow, cashBalance, journal,
        rules: {desembolso, devengo, cobro, gasto, pagoGastoPendiente, propietario, deuda, transferencia, diferenciaCaja, depreciacion}, interestPlan,
        validateOpening, approveOpening, auxiliarCartera, reconcilePortfolio, cashClose, bankMovement, reconcileBank, bankReport, dashboard, registerAsset, nextNumber, lastDay};
})(globalThis);
