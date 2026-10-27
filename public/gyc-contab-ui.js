/* Pantalla de Contabilidad de partida doble (solo administrador). Usa GycContab y los datos en db.pd.
   Se carga después del script principal de sistema.html y usa sus globales: db, session, save, log, allowed,
   agendaFmt, escapeText, toDateKey, getTodayCalendar. No crea db.pd hasta que el administrador pulsa "Activar". */
(function () {
    const K = window.GycContab; if (!K) return;
    let vista = 'tablero';
    const $ = id => document.getElementById(id);
    const esc = v => escapeText(v);
    const hoy = () => toDateKey(getTodayCalendar());
    const ctx = () => ({ usuario: (session && (session.n || session.u)) || 'admin', ts: new Date().toISOString(), hoy: hoy() });
    const money = n => agendaFmt(Number(n) || 0);
    const pd = () => db.pd || null;
    const persist = acc => { if (acc) log(acc); else save(); };
    const msg = (r, ok) => alert(r.ok === false || (r.errores && r.errores.length) ? ('No se pudo:\n- ' + (r.errores || ['error']).join('\n- ')) : (ok || 'Listo'));
    const VISTAS = [['tablero', 'Tablero'], ['apertura', 'Apertura'], ['pendientes', 'Pendientes'], ['diario', 'Diario'], ['informes', 'Informes'], ['gastos', 'Gastos'], ['cierre', 'Cierre']];

    function table(head, rows) { return '<div class="table-wrapper"><table><thead><tr>' + head.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + (rows.length ? rows.join('') : '<tr><td colspan="' + head.length + '" style="text-align:center;color:var(--text-muted)">Sin datos</td></tr>') + '</tbody></table></div>'; }
    const tr = cells => '<tr>' + cells.map(c => '<td>' + c + '</td>').join('') + '</tr>';
    const warns = a => (a || []).map(w => '<div style="background:#fff7e0;border:1px solid #f0d58a;border-radius:8px;padding:8px 10px;margin:6px 0;font-size:.85rem">⚠ ' + esc(w) + '</div>').join('');

    window.pdVista = function (v) { vista = v; renderPd(); };
    window.renderPd = function () {
        const root = $('sect-pd'); if (!root) return;
        const p = pd();
        const nav = '<div class="tab-group">' + VISTAS.map(([k, t]) => '<div class="tab-item' + (k === vista ? ' active' : '') + '" onclick="pdVista(\'' + k + '\')">' + t.toUpperCase() + '</div>').join('') + '</div>';
        let body;
        if (!p) body = '<div class="card" style="padding:16px"><h3>Contabilidad de partida doble</h3><p>Aún no está activada. Se activa sin tocar tus créditos, cobros ni la contabilidad anterior. Empieza el 1/11/2026 con una apertura validada al 31/10/2026.</p><button class="btn" onclick="pdActivar()">Activar contabilidad</button></div>';
        else body = ({ tablero: vTablero, apertura: vApertura, pendientes: vPendientes, diario: vDiario, informes: vInformes, gastos: vGastos, cierre: vCierre }[vista])(p);
        root.innerHTML = '<div class="dash-head"><div><h2 class="cash-title" style="margin-bottom:2px">Contabilidad de partida doble</h2><small>Intereses reconocidos al cobrarlos · asientos que no se borran, solo se reversan</small></div></div>' + (p ? nav : '') + body;
    };
    window.pdActivar = function () {
        if (!allowed('accounting')) return alert('Solo el administrador puede activar la contabilidad.');
        if (db.pd) return;
        db.pd = K.nuevoPd(ctx().usuario, ctx().ts);
        persist('Contabilidad de partida doble: activada'); renderPd();
    };

    // -------- Tablero
    function vTablero(p) {
        const t = K.tablero(db, p, hoy());
        const card = (k, v) => '<div class="card" style="padding:12px;flex:1;min-width:150px"><small>' + k + '</small><div style="font-size:1.2rem;font-weight:700">' + v + '</div></div>';
        const aper = p.apertura.estado === 'aprobada';
        return warns(K.advertenciasGenerales(p, hoy())) + (aper ? '' : warns(['La apertura al 31/10/2026 aún no está aprobada: no se pueden contabilizar operaciones.']))
            + '<div style="display:flex;gap:10px;flex-wrap:wrap">' + card('Efectivo', money(t.efectivo)) + card('Capital pendiente', money(t.capitalPendiente)) + card('Ingresos del mes', money(t.ingresosMes)) + card('Gastos del mes', money(t.gastosMes)) + card('Resultado del mes', money(t.resultadoMes)) + card('Pendientes de contabilizar', t.pendientes) + card('Asientos', t.asientos) + '</div>'
            + '<p style="margin-top:10px">Cartera concilia con el sistema: <b>' + (t.carteraConcilia ? 'Sí' : 'No') + '</b> · Período: <b>' + esc(t.estadoCierre) + '</b></p>'
            + warns(K.verificarIntegridad(p));
    }

    // -------- Apertura
    function vApertura(p) {
        const ap = p.apertura, ok = ap.estado === 'aprobada';
        const v = K.validarApertura(p, ap);
        const cuentas = p.cuentas.filter(c => c.movimiento && c.activa);
        const rows = (ap.lineas || []).map((l, i) => tr([esc(l.cuenta) + ' ' + esc((K.cuenta(p, l.cuenta) || {}).nombre || ''), money(l.debe), money(l.haber), esc(l.fuente || ''), ok ? '' : '<button class="btn-mini" onclick="pdQuitarLinea(' + i + ')">✕</button>']));
        const form = ok ? '' : '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:end;margin:10px 0"><div><label>Cuenta</label><select id="pd-ap-c">' + cuentas.map(c => '<option value="' + esc(c.cod) + '">' + esc(c.cod + ' ' + c.nombre) + '</option>').join('') + '</select></div><div><label>Debe</label><input id="pd-ap-d" type="number" step="0.01" style="width:110px"></div><div><label>Haber</label><input id="pd-ap-h" type="number" step="0.01" style="width:110px"></div><div><label>Fuente / documento</label><input id="pd-ap-f" placeholder="Arqueo, extracto…"></div><button class="btn" onclick="pdAgregarLinea()">Agregar</button></div>'
            + '<button class="btn" onclick="pdCartera()">Traer cartera desde el sistema</button> <button class="btn" onclick="pdAprobarApertura()"' + (v.ok ? '' : ' disabled') + '>Aprobar apertura</button>';
        return '<p>Saldos al <b>' + esc(ap.fecha) + '</b> (estado: <b>' + esc(ap.estado) + '</b>). Captura caja, bancos, deudas y aportes con su documento; la cartera sale del sistema. Nada se inventa: si no cuadra, no se aprueba.</p>'
            + table(['Cuenta', 'Debe', 'Haber', 'Fuente', ''], rows) + warns(v.errores) + warns(v.avisos) + form;
    }
    window.pdAgregarLinea = function () {
        const p = pd(); const d = Number($('pd-ap-d').value) || 0, h = Number($('pd-ap-h').value) || 0;
        if (!(d > 0) === !(h > 0)) return alert('Escribe un importe en Debe o en Haber (solo uno).');
        if (!$('pd-ap-f').value.trim()) return alert('Indica la fuente o documento del saldo.');
        p.apertura.lineas.push({ cuenta: $('pd-ap-c').value, debe: d, haber: h, fuente: $('pd-ap-f').value.trim() });
        persist(); renderPd();
    };
    window.pdQuitarLinea = function (i) { pd().apertura.lineas.splice(i, 1); persist(); renderPd(); };
    window.pdCartera = function () {
        const p = pd(), ap = p.apertura;
        const aux = K.sugerirAperturaCartera(db, p, ap.fecha);
        ap.aux = aux;
        ap.lineas = (ap.lineas || []).filter(l => !/Auxiliar de cartera/.test(l.fuente || '')).concat(K.lineasAperturaCartera(aux));
        persist(); renderPd();
    };
    window.pdAprobarApertura = function () {
        if (!confirm('Al aprobar, la apertura queda fija y no se modifica. ¿Confirmas que los saldos están validados al 31/10/2026?')) return;
        const r = K.aprobarApertura(pd(), ctx()); if (r.ok !== false) persist('Contabilidad: apertura aprobada'); msg(r, 'Apertura aprobada'); renderPd();
    };

    // -------- Pendientes
    function vPendientes(p) {
        const pe = K.pendientes(db, p);
        return '<p>Desembolsos y cobros del sistema que aún no tienen asiento. Cada cobro con intereses reconoce ese ingreso en su propio asiento.</p>'
            + warns(pe.advertencia ? [pe.advertencia] : [])
            + table(['Tipo', 'Referencia'], pe.desembolsos.map(c => tr(['Desembolso', esc(c.id || c)])).concat(pe.cobros.map(c => tr(['Cobro', esc(c.id || c)]))))
            + (pe.omitidos.length ? '<p>Omitidos (anteriores a la apertura o de prueba): ' + pe.omitidos.length + '</p>' : '')
            + '<button class="btn" onclick="pdContabilizar()"' + (p.apertura.estado === 'aprobada' ? '' : ' disabled') + '>Contabilizar pendientes</button>';
    }
    window.pdContabilizar = function () {
        const r = K.contabilizarPendientes(db, pd(), ctx());
        if (r.desembolsos || r.cobros) persist('Contabilidad: contabilizó ' + r.desembolsos + ' desembolsos y ' + r.cobros + ' cobros');
        alert(r.desembolsos + ' desembolsos y ' + r.cobros + ' cobros contabilizados.' + (r.errores.length ? '\nErrores:\n- ' + r.errores.join('\n- ') : '')); renderPd();
    };

    // -------- Diario
    function vDiario(p) {
        const d = K.libroDiario(p, '', '');
        const rows = d.asientos.slice(-200).reverse().map(a => tr(['#' + a.num, esc(a.fecha), esc(a.desc) + (a.reversado ? ' <i>(reversado)</i>' : ''), a.lineas.map(l => esc(l.cuenta) + ' D ' + money(l.debe) + ' H ' + money(l.haber)).join('<br>'), a.reversado || a.reversaDe || a.tipo === 'apertura' ? '' : '<button class="btn-mini" onclick="pdReversar(' + a.num + ')">Reversar</button>']));
        return table(['N.º', 'Fecha', 'Descripción', 'Líneas', ''], rows);
    }
    window.pdReversar = function (num) {
        const p = pd(), a = p.asientos.find(x => x.num === num); if (!a) return;
        const motivo = prompt('Motivo del reverso (mínimo 10 caracteres). El asiento original no se borra:'); if (!motivo) return;
        const r = K.reversar(p, a.id, motivo, ctx()); if (r.ok !== false) persist('Contabilidad: reversó asiento #' + num + ' (' + motivo + ')'); msg(r, 'Asiento reversado'); renderPd();
    };

    // -------- Informes
    function vInformes(p) {
        const h = hoy(), d = h.slice(0, 8) + '01';
        const bc = K.balanceComprobacion(p, h), bg = K.balanceGeneral(p, h), er = K.estadoResultados(p, d, h);
        const fila = f => tr([esc(f.cod || ''), esc(f.nombre || ''), money(f.saldo != null ? f.saldo : (f.deudor || f.acreedor || 0))]);
        return '<h3>Balance de comprobación al ' + esc(h) + '</h3>' + table(['Cuenta', 'Nombre', 'Debe', 'Haber', 'Saldo deudor', 'Saldo acreedor'], bc.filas.map(f => tr([esc(f.cod), esc(f.nombre), money(f.debe), money(f.haber), money(f.deudor), money(f.acreedor)])))
            + '<p>Totales: ' + money(bc.totales.debe) + ' / ' + money(bc.totales.haber) + ' — <b>' + (bc.cuadra ? 'cuadra' : 'NO CUADRA') + '</b></p>'
            + '<h3>Balance general</h3>' + warns(bg.advertencias)
            + table(['Cuenta', 'Nombre', 'Saldo'], ['<tr><td colspan="3"><b>Activos</b></td></tr>'].concat(bg.activos.map(fila), ['<tr><td colspan="3"><b>Pasivos</b></td></tr>'], bg.pasivos.map(fila), ['<tr><td colspan="3"><b>Patrimonio</b></td></tr>'], bg.patrimonio.map(fila)))
            + '<p>Activos ' + money(bg.totalActivos) + ' = Pasivos ' + money(bg.totalPasivos) + ' + Patrimonio ' + money(bg.totalPatrimonio) + ' — <b>' + (bg.cuadra ? 'cuadra' : 'NO CUADRA') + '</b></p>'
            + '<h3>Estado de resultados del mes</h3>' + warns(er.advertencias)
            + table(['Cuenta', 'Nombre', 'Importe'], ['<tr><td colspan="3"><b>Ingresos</b></td></tr>'].concat(er.ingresos.map(fila), ['<tr><td colspan="3"><b>Gastos</b></td></tr>'], er.gastos.map(fila)))
            + '<p>Resultado: <b>' + money(er.neto != null ? er.neto : er.resultado) + '</b>' + (er.definitivo === false ? ' (provisional hasta cerrar el mes)' : '') + '</p>';
    }

    // -------- Gastos
    function vGastos(p) {
        const gastos = p.cuentas.filter(c => c.movimiento && c.activa && c.grupo === 'Gasto'), ef = K.cuentasEfectivo(p);
        const form = '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:end;margin:10px 0"><div><label>Fecha</label><input id="pd-g-f" type="date" value="' + hoy() + '"></div><div><label>Cuenta de gasto</label><select id="pd-g-c">' + gastos.map(c => '<option value="' + esc(c.cod) + '">' + esc(c.cod + ' ' + c.nombre) + '</option>').join('') + '</select></div><div><label>Concepto</label><input id="pd-g-d"></div><div><label>Monto</label><input id="pd-g-m" type="number" step="0.01" style="width:110px"></div><div><label>Pagado desde</label><select id="pd-g-e">' + ef.map(c => '<option value="' + esc(c.cod) + '">' + esc(c.nombre) + '</option>').join('') + '</select></div><button class="btn" onclick="pdGasto()">Registrar gasto pagado</button></div>';
        return '<p>Los retiros del propietario no son gastos: se registran aparte.</p>' + form
            + table(['Fecha', 'Concepto', 'Cuenta', 'Monto'], (p.gastos || []).slice(-50).reverse().map(g => tr([esc(g.fecha), esc(g.descripcion), esc(g.cuentaGasto), money(g.monto)])));
    }
    window.pdGasto = function () {
        const r = K.registrarGasto(pd(), { fecha: $('pd-g-f').value, cuentaGasto: $('pd-g-c').value, descripcion: $('pd-g-d').value.trim(), monto: Number($('pd-g-m').value), medio: $('pd-g-e').value, estadoPago: 'pagado' }, ctx());
        if (r.ok !== false) persist('Contabilidad: gasto ' + $('pd-g-d').value.trim() + ' ' + money($('pd-g-m').value)); msg(r, 'Gasto registrado'); renderPd();
    };

    // -------- Cierre
    function vCierre(p) {
        const mes = hoy().slice(0, 7), e = K.estadoCierre(db, p, mes);
        return '<p>Período <b>' + esc(mes) + '</b>: ' + esc(e.estado) + '</p>'
            + table(['Tarea', 'Estado', ''], e.tareas.map(t => tr([esc(t.titulo) + (t.auto ? ' <small>(automática: ' + esc(t.detalle || '') + ')</small>' : ''), esc(t.estado), t.estado === 'aprobado' ? '' : '<button class="btn-mini" onclick="pdTarea(\'' + t.k + '\')">Aprobar</button>'])))
            + warns(e.bloqueos) + '<button class="btn" onclick="pdCerrar(\'' + mes + '\')"' + (e.puedeCerrar ? '' : ' disabled') + '>Cerrar mes</button>';
    }
    window.pdTarea = function (k) { const mes = hoy().slice(0, 7); const r = K.marcarTarea(pd(), mes, k, 'aprobado', '', ctx()); if (r.ok !== false) persist(); msg(r); renderPd(); };
    window.pdCerrar = function (mes) { if (!confirm('Al cerrar ' + mes + ' ya no se podrán registrar asientos en ese mes (solo reabrir con motivo). ¿Cerrar?')) return; const r = K.cerrarPeriodo(db, pd(), mes, ctx()); if (r.ok !== false) persist('Contabilidad: cerró ' + mes); msg(r, 'Mes cerrado'); renderPd(); };
})();
