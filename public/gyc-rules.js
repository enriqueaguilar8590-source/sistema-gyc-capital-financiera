(function(root) {
    const normalize = role => ({owner:'admin', gestor:'cobrador'})[role] || role;
    function can(role, action) {
        role = normalize(role);
        return role === 'admin' || (role === 'desembolsador' && ['createClient','createCredit'].includes(action)) || (role === 'cobrador' && action === 'collect');
    }
    function canDeleteUser(user, current) {
        return !!user && user.s === 'Inactivo' && user.u !== 'admin' && user.u !== current;
    }
    function dateKey(value) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value;
        const p = String(value || '').split('/').map(Number);
        if(p.length !== 3 || p.some(n => !Number.isFinite(n))) return '';
        const day = p[1] > 12 ? p[1] : p[0], month = p[1] > 12 ? p[0] : p[1];
        const d = new Date(p[2], month-1, day);
        return d.getFullYear() === p[2] && d.getMonth() === month-1 && d.getDate() === day ? `${p[2]}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}` : '';
    }
    function range(mode, today) {
        const d = new Date(today+'T12:00:00'), start = new Date(d), end = new Date(d);
        if(mode === 'semana') { start.setDate(d.getDate()-((d.getDay()+6)%7)); end.setDate(start.getDate()+6); }
        if(mode === 'mes') { start.setDate(1); end.setMonth(d.getMonth()+1,0); }
        if(mode === 'anio') { start.setMonth(0,1); end.setMonth(11,31); }
        const key = x => `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
        return [key(start),key(end)];
    }
    function cashReport(db, from, to, collector='') {
        const credits = [...(db.cre || []), ...(db.trash || []).filter(x=>x.type==='cre').map(x=>x.data)];
        const real = new Set(credits.filter(c=>!c.esPrueba).map(c=>c.id));
        const rows = (db.pag || []).filter(p=> {
            const key = dateKey(p.fechaISO || p.f);
            return real.has(p.creId) && p.tipo !== 'refinanciamiento' && !String(p.obs || '').startsWith('Cancelado por descuento en nuevo crédito') && Number(p.t)>0 && key>=from && key<=to && (!collector || p.g === collector);
        }).sort((a,b)=>dateKey(b.fechaISO || b.f).localeCompare(dateKey(a.fechaISO || a.f)));
        const byCollector = {};
        rows.forEach(p=>{ const key=p.g || 'Sin identificar'; byCollector[key]=(byCollector[key] || 0)+Number(p.t); });
        const total = rows.reduce((s,p)=>s+Number(p.t),0), mora = rows.reduce((s,p)=>s+(Number(p.m)||0),0);
        const usdRows = rows.filter(p => p.mon === 'USD' && Number(p.usd) > 0);
        return {rows,total,mora,recovered:total-mora,byCollector,usd:round2(usdRows.reduce((s,p)=>s+Number(p.usd),0)),usdCount:usdRows.length,usdCordobas:round2(usdRows.reduce((s,p)=>s+Number(p.t),0))};
    }
    function addDays(day, n) {
        const d = new Date(day+'T12:00:00');
        d.setDate(d.getDate()+n);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    function dailySeries(db, from, to, collector='') {
        const totals = {};
        cashReport(db, from, to, collector).rows.forEach(p=>{ const k = dateKey(p.fechaISO || p.f); totals[k] = (totals[k] || 0) + Number(p.t); });
        const days = [];
        for(let k = from; k <= to; k = addDays(k, 1)) days.push({date:k,total:totals[k] || 0});
        return days;
    }
    function matches(query, ...values) {
        const clean = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
        const words = clean(query).split(/\s+/).filter(Boolean);
        const text = values.map(clean).join(' ');
        return words.every(word => text.includes(word));
    }
    function creditSearch(db, query) {
        return (db.cre || []).filter(c => {
            const cli = (db.cli || []).find(x => x.id === c.cliId) || {};
            return matches(query, c.id, cli.id, cli.nom, cli.ced, cli.tel);
        });
    }
    function validContribution(partners, partnerId, amount, date, today) {
        return partners.some(p => p.id === partnerId) && Number.isFinite(Number(amount)) && Number(amount) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) && dateKey(date) === date && date <= today && !Number.isNaN(Date.parse(date+'T12:00:00')) && new Date(date+'T12:00:00').getDate() === Number(date.slice(-2));
    }
    function partnerReport(partners, contributions) {
        const rows = partners.map(p => {
            const entries = contributions.filter(a => a.socioId === p.id);
            return {...p, total: Math.round(entries.reduce((sum,a) => sum + Number(a.monto),0)*100)/100, count: entries.length};
        });
        return {rows, total: Math.round(rows.reduce((sum,p) => sum+p.total,0)*100)/100};
    }
    const round2 = n => Math.round(Number(n)*100)/100;
    function addMonths(month, n) {
        const [y, m] = month.split('-').map(Number), d = new Date(y, m-1+n, 1);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    }
    function monthlyContributions(contributions, endMonth, count) {
        const totals = {};
        contributions.forEach(a => { const k = String(a.fecha || '').slice(0,7); if(k) { totals[k] = totals[k] || {total:0,count:0}; totals[k].total += Number(a.monto) || 0; totals[k].count++; } });
        const months = [];
        for(let i = count-1; i >= 0; i--) { const k = addMonths(endMonth, -i), t = totals[k] || {total:0,count:0}; months.push({month:k,total:round2(t.total),count:t.count}); }
        return months;
    }
    function partnerDashboard(partners, contributions) {
        const known = new Set(partners.map(p => p.id));
        const valid = contributions.filter(a => known.has(a.socioId));
        const report = partnerReport(partners, valid);
        const rows = report.rows.map(p => {
            const dates = valid.filter(a => a.socioId === p.id).map(a => a.fecha).sort();
            return {...p, share: report.total > 0 ? Math.round(p.total/report.total*1000)/10 : 0, last: dates[dates.length-1] || ''};
        }).sort((a,b) => b.total-a.total || String(a.nom).localeCompare(String(b.nom)));
        const dates = valid.map(a => a.fecha).sort();
        const largest = valid.reduce((best,a) => !best || Number(a.monto) > Number(best.monto) ? a : best, null);
        return {rows, total: report.total, partners: partners.length, count: valid.length, average: valid.length ? round2(report.total/valid.length) : 0, largest, lastDate: dates[dates.length-1] || '', edited: valid.filter(a => (a.ediciones || []).length).length};
    }
    // Editing a contribution amount: needs a different amount > 0 and a written reason; the previous amount is kept as history.
    function validContributionEdit(entry, amount, reason) {
        const n = Number(amount);
        return !!entry && Number.isFinite(n) && n > 0 && round2(n) !== round2(entry.monto) && String(reason || '').trim().length >= 3;
    }
    function applyContributionEdit(contributions, id, amount, reason, user, stamp) {
        const entry = contributions.find(a => a.id === id);
        if(!validContributionEdit(entry, amount, reason)) return null;
        const edit = {fecha: stamp, usuario: user, montoAnterior: round2(entry.monto), montoNuevo: round2(amount), motivo: String(reason).trim()};
        return contributions.map(a => a.id === id ? {...a, monto: edit.montoNuevo, ediciones: [...(a.ediciones || []), edit]} : a);
    }
    // Editing a partner's name/phone: new name required, unique among partners, something must change, reason kept in history.
    const samePerson = (a, b) => matches(a, b) && matches(b, a);
    function applyPartnerEdit(partners, id, nom, tel, reason, user, stamp) {
        const cur = partners.find(p => p.id === id), name = String(nom || '').trim(), phone = String(tel || '').trim();
        if(!cur || name.length < 2 || String(reason || '').trim().length < 3) return null;
        if(partners.some(p => p.id !== id && samePerson(name, p.nom))) return null;
        if(name === cur.nom && phone === (cur.tel || '')) return null;
        const edit = {fecha: stamp, usuario: user, nomAnterior: cur.nom, nomNuevo: name, telAnterior: cur.tel || '', telNuevo: phone, motivo: String(reason).trim()};
        return partners.map(p => p.id === id ? {...p, nom: name, tel: phone, ediciones: [...(p.ediciones || []), edit]} : p);
    }
    // ---- Pagos en dólares ----
    const DEFAULT_RATE = 36.5;
    const validRate = tc => Number.isFinite(Number(tc)) && Number(tc) >= 1 && Number(tc) <= 1000;
    const toUsd = (cordobas, tc) => validRate(tc) ? round2(Number(cordobas) / Number(tc)) : 0;
    // Smallest US$ amount (to the cent) that covers a córdoba amount; used to suggest what the client hands over.
    const toUsdCeil = (cordobas, tc) => validRate(tc) ? (Math.ceil(Math.round(Number(cordobas) / Number(tc) * 10000) / 100 - 1e-9) / 100 || 0) : 0;
    // The ledger stays in córdobas: a US$ payment is converted and the dollars + rate are kept on the receipt.
    // If rounding to the cent pushes it over the maximum payable by less than one US cent, it is trimmed to the maximum.
    function convertUsdPayment(usd, tc, maxCordobas) {
        if(!validRate(tc) || !(Number(usd) > 0)) return null;
        let cordobas = round2(Number(usd) * Number(tc)), capped = false;
        if(maxCordobas != null && cordobas > maxCordobas + 0.005 && cordobas - maxCordobas <= round2(Number(tc) * 0.01) + 0.005) { cordobas = round2(maxCordobas); capped = true; }
        return {cordobas, usd: round2(usd), tc: round2(tc), capped};
    }
    // ---- Papelera: detalle y eliminación definitiva ----
    const isRefi = p => p.tipo === 'refinanciamiento' || String(p.obs || '').startsWith('Cancelado por descuento en nuevo crédito');
    function trashDetail(db, item) {
        const d = item.data || {}, creditsAll = [...(db.cre || []), ...(db.trash || []).filter(x => x.type === 'cre').map(x => ({...x.data, __trash: true}))];
        const payOf = ids => (db.pag || []).filter(p => ids.has(p.creId));
        if(item.type === 'cli') {
            const credits = creditsAll.filter(c => c.cliId === d.id), ids = new Set(credits.map(c => c.id)), pays = payOf(ids);
            return {kind:'cli', id:d.id, title:d.nom || d.id, deleted:item.date || '', fields:[['Código',d.id],['Cédula',d.ced],['Teléfono',d.tel],['Dirección',d.dir],['Garantía',d.gar]].filter(f => f[1]),
                credits: credits.map(c => ({id:c.id, cap:Number(c.cap)||0, saldo:Math.max(0,Number(c.saldo)||0), active:Number(c.saldo) > 0.005, inTrash:!!c.__trash, test:!!c.esPrueba})),
                payCount: pays.length, payTotal: round2(pays.reduce((t,p) => t + (Number(p.t)||0), 0)), payments: [], loses: 'cliente'};
        }
        const cli = [...(db.cli || []), ...(db.trash || []).filter(x => x.type === 'cli').map(x => x.data)].find(c => c.id === d.cliId) || {};
        const pays = payOf(new Set([d.id])), schedule = d.schedule || [];
        return {kind:'cre', id:d.id, title:d.id, deleted:item.date || '', client: cli.nom || 'Cliente no disponible', cap:Number(d.cap)||0, total:Number(d.total)||0, saldo:Math.max(0,Number(d.saldo)||0), plazo:schedule.length || Number(d.plz) || 0,
            paidInstallments: schedule.filter(isPaidItem).length, date: d.fecDes || d.date || '', test: !!d.esPrueba, intPct: d.intPct,
            payCount: pays.length, payTotal: round2(pays.reduce((t,p) => t + (Number(p.t)||0), 0)), cashPayments: pays.filter(p => !isRefi(p) && Number(p.t) > 0).length,
            payments: pays.slice().sort((a,b) => String(dateKey(b.fechaISO || b.f)).localeCompare(String(dateKey(a.fechaISO || a.f)))).map(p => ({id:p.id, fecha:p.fechaISO || p.f, t:Number(p.t)||0, m:Number(p.m)||0, refi:isRefi(p)}))};
    }
    // Permanent removal of trashed items. Deleting a credit also removes its payments (they would otherwise be orphaned
    // and silently drop out of cash reports); deleting a client keeps its credits and payments untouched.
    function purgeTrash(db, indexes) {
        const pick = new Set(indexes), chosen = (db.trash || []).filter((_, i) => pick.has(i));
        const creIds = new Set(chosen.filter(t => t.type === 'cre').map(t => t.data.id));
        const removedPay = (db.pag || []).filter(p => creIds.has(p.creId));
        return {trash: (db.trash || []).filter((_, i) => !pick.has(i)), pag: (db.pag || []).filter(p => !creIds.has(p.creId)),
            summary: {items: chosen.length, clients: chosen.filter(t => t.type === 'cli').length, credits: creIds.size, payments: removedPay.length, paymentTotal: round2(removedPay.reduce((t,p) => t + (Number(p.t)||0), 0)),
                cashPayments: removedPay.filter(p => !isRefi(p) && Number(p.t) > 0).length, pending: round2(chosen.filter(t => t.type === 'cre').reduce((t,x) => t + Math.max(0, Number(x.data.saldo)||0), 0)),
                orphanClients: chosen.filter(t => t.type === 'cli' && [...(db.cre || [])].some(c => c.cliId === t.data.id)).length}};
    }
    // Access lock for editing contributed capital. Only a salted PBKDF2 hash is stored, never the password itself.
    const PARTNER_LOCK = {user:'SociosGYL', salt:'e93149786d46e9feb07fbbb88db39446', iterations:210000, hash:'07a3608cffb4ae31e040afa2192f049b241ceaba94170a1e70168af272447387'};
    const utf8 = text => Uint8Array.from(unescape(encodeURIComponent(String(text))), c => c.charCodeAt(0));
    async function partnerLockDigest(user, password, subtle) {
        const key = await subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
        const bits = await subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', salt: utf8(PARTNER_LOCK.salt+':'+user), iterations: PARTNER_LOCK.iterations}, key, 256);
        return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');
    }
    async function verifyPartnerLock(user, password, subtle) {
        const digest = await partnerLockDigest(PARTNER_LOCK.user, password, subtle);
        return String(user) === PARTNER_LOCK.user && digest === PARTNER_LOCK.hash;
    }
    // ---- Avisos del día y SMS de pago ----
    const plain = t => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^\x20-\x7E\n]/g,'').replace(/\s+/g,' ').trim();
    const money = n => 'C$' + (Math.round((Number(n)||0)*100)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    // Registered phone -> international number for SMS (Nicaragua +505 by default). '' when it is not a usable number.
    function smsNumber(tel, country = '505') {
        let d = String(tel || '').replace(/[^\d+]/g,'');
        const plus = d.startsWith('+');
        d = d.replace(/\D/g,'');
        if(!plus && d.startsWith('00')) d = d.slice(2);
        else if(!plus && d.length === 8) d = country + d;
        else if(!plus && d.length === 10 && d.startsWith('0')) d = country + d.slice(2);
        return d.length >= 10 && d.length <= 15 ? '+' + d : '';
    }
    // Plain GSM text (no accents) so each SMS carries 160 characters.
    function paymentSms(p) {
        const paid = Number(p.usd) > 0 ? `US$${round2(p.usd).toFixed(2)} (${money(p.monto)} a T/C ${round2(p.tc).toFixed(2)})` : money(p.monto);
        const parts = [`${plain(p.empresa) || 'GYC Capital'}: ${plain(p.cliente).split(' ').slice(0,2).join(' ')}, recibimos su pago de ${paid} el ${plain(p.fecha)}.`];
        if(Number(p.mora) > 0) parts.push(`Incluye mora ${money(p.mora)}.`);
        parts.push(Number(p.saldo) > 0.005 ? `Saldo pendiente: ${money(p.saldo)}.` : 'Su credito quedo cancelado. Gracias!');
        parts.push(`Recibo ${plain(p.recibo)}.`);
        return parts.join(' ');
    }
    // Reminder SMS for a client: kind 'hoy' (installment due today) or 'mora' (overdue).
    function reminderSms(r) {
        const who = plain(r.cliente).split(' ')[0], company = plain(r.empresa) || 'GYC Capital', ref = plain(r.creId);
        if(r.kind === 'mora') {
            const n = Number(r.cuotas) || 1;
            return `${company}: ${who}, su credito ${ref} tiene ${n} ${n===1?'cuota vencida':'cuotas vencidas'} por ${money(r.vencido)}` + (Number(r.mora) > 0 ? ` mas mora ${money(r.mora)}` : '') + `. Total a pagar: ${money(r.total)}. Por favor comuniquese para ponerse al dia.`;
        }
        return `${company}: ${who}, le recordamos que hoy vence su cuota de ${money(r.monto)} del credito ${ref}. Gracias por su pago puntual.`;
    }
    function smsLink(number, text, ios) {
        return `sms:${number}${ios ? '&' : '?'}body=${encodeURIComponent(text)}`;
    }
    // Daily digest: today's installments, overdue clients and accumulated mora.
    function digestText(d) {
        const names = list => list.slice(0,3).map(x => plain(x.nom).split(' ').slice(0,2).join(' ')).join(', ') + (list.length > 3 ? ` y ${list.length-3} mas` : '');
        const lines = [];
        lines.push(d.today.length ? `Hoy cobras ${d.today.length} ${d.today.length===1?'cuota':'cuotas'} por ${money(d.todayAmount)}` : 'Hoy no tienes cuotas por cobrar');
        if(d.overdue.length) lines.push(`${d.overdue.length} ${d.overdue.length===1?'cliente en mora':'clientes en mora'}: cuotas vencidas ${money(d.overdueAmount)} + mora ${money(d.moraAmount)}`);
        else lines.push('Sin clientes en mora');
        if(d.overdue.length) lines.push('Mayor atraso: ' + names(d.overdue));
        return {title: 'Cobros del dia', body: lines.join('\n'), lines};
    }
    // Notify once per day, at or after the chosen hour.
    function shouldNotify(now, hour, lastDay) {
        const key = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        return now.getHours() >= Number(hour) && lastDay !== key ? key : '';
    }
    // ---- Historial del cliente e índice de pago ----
    const daysBetween = (a, b) => Math.round((new Date(b+'T12:00:00') - new Date(a+'T12:00:00')) / 86400000);
    const isPaidItem = s => Number(s.paid) >= Number(s.amount) - 0.005 || s.status === 'Pagado';
    // toKey converts any stored date into YYYY-MM-DD (the page passes its own parser).
    function clientHistory(db, cliId, today, toKey = dateKey) {
        const credits = (db.cre || []).filter(c => c.cliId === cliId && !c.esPrueba);
        const ids = new Set(credits.map(c => c.id));
        const payments = (db.pag || []).filter(p => ids.has(p.creId) && p.tipo !== 'refinanciamiento' && !String(p.obs || '').startsWith('Cancelado por descuento en nuevo crédito') && Number(p.t) > 0);
        const rows = credits.map(c => {
            let ontime = 0, late = 0, overdue = 0, maxDays = 0;
            (c.schedule || []).forEach(it => {
                const key = toKey(it.date);
                if(isPaidItem(it)) { if((Number(it.moraPaidTotal)||0) + (Number(it.moraWaivedTotal)||0) > 0) late++; else ontime++; }
                else if(key && key < today) { overdue++; maxDays = Math.max(maxDays, daysBetween(key, today)); }
            });
            const active = Number(c.saldo) > 0.005;
            return {id:c.id, fecha:toKey(c.fecDes || c.date) || '', cap:Number(c.cap)||0, total:Number(c.total)||0, saldo:Math.max(0,Number(c.saldo)||0), active, ontime, late, overdue, maxDays};
        }).sort((a,b) => b.fecha.localeCompare(a.fecha));
        const sum = key => rows.reduce((t,r) => t + r[key], 0);
        const ontime = sum('ontime'), late = sum('late'), overdue = sum('overdue'), due = ontime + late + overdue;
        const maxDays = rows.reduce((m,r) => Math.max(m,r.maxDays), 0);
        const score = due ? Math.round((ontime + late*0.5) / due * 100) : null;
        let rating = 'Sin historial';
        if(due) {
            rating = maxDays > 30 ? 'Mala' : score >= 85 ? 'Buena' : score >= 60 ? 'Media' : 'Mala';
            if(rating === 'Buena' && overdue > 0) rating = 'Media';
        }
        return {rows, rating, score, ontime, late, overdue, due, maxDays, credits: rows.length, active: rows.filter(r => r.active).length, cancelled: rows.filter(r => !r.active).length,
            capital: round2(sum('cap')), pending: round2(sum('saldo')), paid: round2(payments.reduce((t,p) => t + Number(p.t), 0)), interest: round2(payments.reduce((t,p) => t + (Number(p.int)||0), 0)), mora: round2(payments.reduce((t,p) => t + (Number(p.m)||0), 0)),
            first: rows.length ? rows[rows.length-1].fecha : '', last: rows.length ? rows[0].fecha : ''};
    }

    // ---- Contabilidad ----
    const ACC_TYPES = {ingreso:'Ingreso', gasto:'Gasto / egreso', retiro:'Retiro de socio', activo:'Activo (bien o equipo)', pasivo:'Pasivo (deuda recibida)', pago_pasivo:'Pago de pasivo', capital:'Capital inicial / ajuste'};
    const EXPENSE_CATEGORIES = ['Salarios y comisiones','Alquiler','Servicios (luz, agua, internet, teléfono)','Transporte y combustible','Papelería y útiles','Publicidad','Impuestos y licencias','Mantenimiento','Incobrable / castigo de cartera','Otros'];
    const isRealDate = (date, today) => /^\d{4}-\d{2}-\d{2}$/.test(date || '') && dateKey(date) === date && date <= today && new Date(date+'T12:00:00').getDate() === Number(date.slice(-2));
    function validEntry(e, partners, today) {
        const amount = Number(e && e.monto);
        return !!e && Object.prototype.hasOwnProperty.call(ACC_TYPES, e.tipo) && Number.isFinite(amount) && amount > 0 && isRealDate(e.fecha, today) && String(e.concepto || '').trim().length >= 2
            && (!e.socioId || (partners || []).some(p => p.id === e.socioId));
    }
    // Correcting an entry: the result must still be a valid entry, something must change, and a reason is required.
    // The previous values stay in `ediciones`, so nothing is ever lost.
    const ENTRY_FIELDS = ['tipo','fecha','monto','concepto','categoria','socioId'];
    function applyEntryEdit(entries, id, changes, reason, user, stamp, partners, today) {
        const entry = (entries || []).find(e => e.id === id);
        if(!entry || entry.anulado || String(reason || '').trim().length < 3) return null;
        const next = {...entry, ...changes, monto: round2(changes.monto != null ? changes.monto : entry.monto), concepto: String(changes.concepto != null ? changes.concepto : entry.concepto).trim()};
        if(next.tipo !== 'gasto') delete next.categoria;
        if(next.tipo !== 'retiro') delete next.socioId;
        if(!next.categoria) delete next.categoria;
        if(!next.socioId) delete next.socioId;
        if(!validEntry(next, partners, today)) return null;
        const before = {}, after = {};
        ENTRY_FIELDS.forEach(k => { if(entry[k] !== next[k]) { before[k] = entry[k] == null ? null : entry[k]; after[k] = next[k] == null ? null : next[k]; } });
        if(!Object.keys(after).length) return null;
        next.ediciones = [...(entry.ediciones || []), {fecha: stamp, usuario: user, motivo: String(reason).trim(), antes: before, despues: after}];
        return entries.map(e => e.id === id ? next : e);
    }
    const activeEntries = db => (db.conta || []).filter(e => !e.anulado);
    function accountingReport(db, from, to) {
        const entries = activeEntries(db).filter(e => e.fecha >= from && e.fecha <= to);
        const cash = cashReport(db, from, to);
        const sumType = t => round2(entries.filter(e => e.tipo === t).reduce((s,e) => s + Number(e.monto), 0));
        const interest = round2(cash.rows.reduce((s,p) => s + (Number(p.int)||0), 0)), mora = round2(cash.mora), other = sumType('ingreso'), expenses = sumType('gasto');
        const income = round2(interest + mora + other), profit = round2(income - expenses);
        const byCategory = {};
        entries.filter(e => e.tipo === 'gasto').forEach(e => { const k = e.categoria || 'Otros'; byCategory[k] = round2((byCategory[k]||0) + Number(e.monto)); });
        return {interest, mora, other, income, expenses, profit, margin: income > 0 ? Math.round(profit/income*1000)/10 : 0, withdrawals: sumType('retiro'), liabilityPayments: sumType('pago_pasivo'), byCategory, collected: cash.total};
    }
    function monthlyAccounting(db, endMonth, count) {
        const out = [];
        for(let i = count-1; i >= 0; i--) { const m = addMonths(endMonth, -i), r = accountingReport(db, m+'-01', m+'-31'); out.push({month:m, income:r.income, expenses:r.expenses, profit:r.profit}); }
        return out;
    }
    // Intereses proyectados por mes: la parte de interés de cada cuota que vence en el mes (cuota x interés/total del crédito).
    // Solo créditos reales con saldo pendiente; la mora no se proyecta. `collected` es el interés realmente cobrado en el mes.
    function projectedInterest(db, startMonth, count) {
        const credits = (db.cre || []).filter(c => !c.esPrueba && Number(c.saldo) > 0.005 && Number(c.total) > 0);
        const out = [];
        for(let i = 0; i < count; i++) {
            const month = addMonths(startMonth, i);
            let scheduled = 0, pending = 0, installments = 0;
            credits.forEach(c => {
                const ratio = Math.max(0, (Number(c.total) - Number(c.cap)) / Number(c.total));
                (c.schedule || []).forEach(it => {
                    if(dateKey(it.date).slice(0,7) !== month) return;
                    const amount = Number(it.amount) || 0, open = Math.max(0, amount - (Number(it.paid) || 0));
                    scheduled += amount * ratio; pending += open * ratio; installments++;
                });
            });
            out.push({month, scheduled: round2(scheduled), pending: round2(pending), collected: accountingReport(db, month+'-01', month+'-31').interest, installments});
        }
        return out;
    }
    // Detalle de las cuotas que vencen en un mes: una fila por cuota con su parte de interés (para ver de dónde sale la proyección).
    function projectedInterestDetail(db, month) {
        const rows = [];
        (db.cre || []).filter(c => !c.esPrueba && Number(c.saldo) > 0.005 && Number(c.total) > 0).forEach(c => {
            const ratio = Math.max(0, (Number(c.total) - Number(c.cap)) / Number(c.total));
            (c.schedule || []).forEach(it => {
                const date = dateKey(it.date);
                if(date.slice(0,7) !== month) return;
                const amount = Number(it.amount) || 0, paid = Number(it.paid) || 0;
                rows.push({creId:c.id, cliId:c.cliId, n:it.n, date, amount:round2(amount), interest:round2(amount*ratio), open:round2(Math.max(0, amount-paid)*ratio), done: paid + 0.005 >= amount});
            });
        });
        return rows.sort((a,b) => a.date.localeCompare(b.date) || String(a.creId).localeCompare(String(b.creId)));
    }
    // Mes agrupado por cliente: cada cliente con sus cuotas del mes y el interés que aporta (de mayor a menor).
    function projectedInterestByClient(db, month) {
        const groups = {};
        projectedInterestDetail(db, month).forEach(d => {
            const k = d.cliId || '';
            const g = groups[k] || (groups[k] = {cliId:d.cliId, items:[], amount:0, interest:0, open:0, done:0});
            g.items.push(d); g.amount += d.amount; g.interest += d.interest; g.open += d.open; if(d.done) g.done++;
        });
        return Object.values(groups).map(g => ({...g, amount:round2(g.amount), interest:round2(g.interest), open:round2(g.open)})).sort((a,b) => b.interest - a.interest);
    }
    // Balance as of today. Cash is estimated from recorded flows; portfolio is outstanding capital.
    function balanceSheet(db, today) {
        const entries = activeEntries(db).filter(e => e.fecha <= today);
        const sumType = t => entries.filter(e => e.tipo === t).reduce((s,e) => s + Number(e.monto), 0);
        const credits = [...(db.cre || []), ...(db.trash || []).filter(x => x.type === 'cre').map(x => x.data)].filter(c => !c.esPrueba);
        const disbursed = credits.reduce((s,c) => s + (c.neto != null ? Number(c.neto) : Number(c.cap) || 0), 0);
        const collected = cashReport(db, '0000-01-01', today).total;
        const partnerCapital = (db.aportes || []).filter(a => a.fecha <= today).reduce((s,a) => s + Number(a.monto), 0);
        const initialCapital = sumType('capital'), liabilityIn = sumType('pasivo'), liabilityOut = sumType('pago_pasivo'), fixed = sumType('activo');
        const withdrawals = sumType('retiro'), otherIncome = sumType('ingreso'), expenses = sumType('gasto');
        const cash = partnerCapital + initialCapital + liabilityIn + otherIncome + collected - disbursed - expenses - withdrawals - liabilityOut - fixed;
        const portfolio = (db.cre || []).filter(c => !c.esPrueba && Number(c.saldo) > 0.005 && Number(c.total) > 0).reduce((s,c) => s + Number(c.saldo) * Number(c.cap) / Number(c.total), 0);
        const assets = cash + portfolio + fixed, liabilities = Math.max(0, liabilityIn - liabilityOut), equity = assets - liabilities;
        const contributed = partnerCapital + initialCapital;
        return {cash:round2(cash), portfolio:round2(portfolio), fixed:round2(fixed), assets:round2(assets), liabilities:round2(liabilities), equity:round2(equity), contributed:round2(contributed), withdrawals:round2(withdrawals), results:round2(equity - contributed + withdrawals)};
    }
    // --- Contrato de crédito: texto en letras y datos tomados del plan de pago ---
    const UNI = ['','UNO','DOS','TRES','CUATRO','CINCO','SEIS','SIETE','OCHO','NUEVE','DIEZ','ONCE','DOCE','TRECE','CATORCE','QUINCE','DIECISÉIS','DIECISIETE','DIECIOCHO','DIECINUEVE','VEINTE','VEINTIUNO','VEINTIDÓS','VEINTITRÉS','VEINTICUATRO','VEINTICINCO','VEINTISÉIS','VEINTISIETE','VEINTIOCHO','VEINTINUEVE'];
    const DEC = ['','','','TREINTA','CUARENTA','CINCUENTA','SESENTA','SETENTA','OCHENTA','NOVENTA'];
    const CEN = ['','CIENTO','DOSCIENTOS','TRESCIENTOS','CUATROCIENTOS','QUINIENTOS','SEISCIENTOS','SETECIENTOS','OCHOCIENTOS','NOVECIENTOS'];
    const apocope = s => s.replace(/VEINTIUNO$/, 'VEINTIÚN').replace(/UNO$/, 'UN');
    function below1000(n) {
        if(n === 100) return 'CIEN';
        const c = Math.floor(n / 100), r = n % 100, parts = [];
        if(c) parts.push(CEN[c]);
        if(r < 30) { if(r) parts.push(UNI[r]); }
        else { const d = Math.floor(r / 10), u = r % 10; parts.push(u ? DEC[d] + ' Y ' + UNI[u] : DEC[d]); }
        return parts.join(' ');
    }
    function numberInWords(n) {
        n = Math.floor(Number(n) || 0);
        if(n === 0) return 'CERO';
        const mill = Math.floor(n / 1e6), mil = Math.floor((n % 1e6) / 1000), rest = n % 1000, parts = [];
        if(mill) parts.push(mill === 1 ? 'UN MILLÓN' : apocope(below1000(mill)) + ' MILLONES');
        if(mil) parts.push(mil === 1 ? 'MIL' : apocope(below1000(mil)) + ' MIL');
        if(rest) parts.push(below1000(rest));
        return parts.join(' ');
    }
    function montoEnLetras(amount) {
        const cents = Math.round((Number(amount) || 0) * 100), whole = Math.floor(cents / 100), cc = cents % 100;
        const words = numberInWords(whole);
        const noun = whole === 1 ? 'CÓRDOBA' : (whole >= 1e6 && whole % 1e6 === 0 ? 'DE CÓRDOBAS' : 'CÓRDOBAS');
        return apocope(words) + ' ' + noun + (cc ? ' CON ' + String(cc).padStart(2, '0') + '/100' : '');
    }
    const FREQ_LABEL = {1:'Diario', 7:'Semanal', 15:'Quincenal', 30:'Mensual'};
    function plazoText(count, freq) {
        const days = (Number(count) || 0) * (Number(freq) || 0);
        if(days < 25) return days + (days === 1 ? ' día' : ' días');
        const m = Math.round(days / 30);
        return m + (m === 1 ? ' mes' : ' meses');
    }
    const cMoney = n => 'C$' + (Number(n) || 0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    function displayDate(value) {
        const k = dateKey(value);
        return k ? k.split('-').reverse().join('/') : '';
    }
    // Todos los datos del contrato salen del crédito ya calculado (plan de pago), sin recalcular nada.
    function contractData(c, cli, cfg) {
        cli = cli || {}; cfg = cfg || {};
        const sch = c.schedule || [], cap = Number(c.cap) || 0, total = Number(c.total) || 0;
        const count = sch.length || Number(c.plz) || 0;
        const cuota = sch.length ? Number(sch[0].amount) : (Number(c.cuota) || (count ? total / count : 0));
        const neto = c.descuento > 0 ? Number(c.neto) || 0 : cap;
        return {
            nombre: cli.nom || '', cedula: cli.ced || '', codigo: cli.id || c.cliId || '', credito: c.id || '', contrato: c.contrato || '',
            emision: displayDate(c.fecDes || c.date), primerPago: displayDate(sch[0] && sch[0].date),
            capital: cMoney(cap), capitalLetras: montoEnLetras(cap),
            interesPct: (Number(c.intPct) || 0).toFixed(1) + '%', interes: cMoney(total - cap),
            total: cMoney(total), totalLetras: montoEnLetras(total),
            plazo: plazoText(count, c.freq), frecuencia: FREQ_LABEL[c.freq] || '', cuotas: String(count), cuota: cMoney(cuota),
            descuento: c.descuento > 0 ? cMoney(c.descuento) : '', neto: cMoney(neto), netoLetras: montoEnLetras(neto),
            garTipo: c.garTipo || '', garValor: Number(c.garValor) > 0 ? cMoney(c.garValor) : '', garDesc: c.garDesc || '',
            representante: cfg.rep || '', cargo: cfg.cargo || '',
            fiador: fiadorActivo(c) ? {nombre: String(c.fiador.nom).trim(), cedula: String(c.fiador.ced).trim()} : null
        };
    }
    // --- Fiador opcional: se guarda aparte del cliente, dentro del propio crédito ---
    const fiadorActivo = c => !!(c && c.fiador && c.fiador.activo === true && String(c.fiador.nom || '').trim() && String(c.fiador.ced || '').trim());
    function validFiador(f, clientCed) {
        if(!f || !f.activo) return '';
        if(!String(f.nom || '').trim()) return 'Escriba el nombre completo del fiador.';
        if(!String(f.ced || '').trim()) return 'Escriba el número de cédula del fiador.';
        const norm = v => String(v || '').replace(/[\s-]/g, '').toUpperCase();
        if(clientCed && norm(f.ced) === norm(clientCed)) return 'El fiador no puede ser el mismo cliente (la cédula coincide).';
        return '';
    }
    // --- Número de contrato: correlativo, único y nunca reutilizado ---
    const CONTRACT_PREF = 'GYC-', CONTRACT_PAD = 3;
    const allCredits = db => [...(db.cre || []), ...(db.trash || []).filter(x => x.type === 'cre').map(x => x.data).filter(Boolean)];
    const contractPref = db => (db && db.cfg && db.cfg.secuencias && db.cfg.secuencias.conPref) || CONTRACT_PREF;
    const contractSeq = (db, num) => { const pref = contractPref(db), t = String(num || '').toUpperCase(); const m = t.startsWith(pref.toUpperCase()) ? /^\d+$/.exec(t.slice(pref.length)) : null; return m ? Number(m[0]) : 0; };
    const contractLabel = (db, n) => contractPref(db) + String(n).padStart(CONTRACT_PAD, '0');
    // El siguiente número es el mayor entre el contador guardado y el último usado (incluye papelera), más uno.
    function nextContractNumber(db) {
        const seq = (db.cfg && db.cfg.secuencias) || {};
        const maxUsed = allCredits(db).reduce((m, c) => Math.max(m, contractSeq(db, c.contrato)), 0);
        const n = Math.max(Number(seq.conNext) || 1, maxUsed + 1);
        return {n, id: contractLabel(db, n)};
    }
    // Asigna número solo si el crédito aún no tiene; nunca cambia uno existente. Avanza el contador guardado.
    function assignContractNumber(db, c, wanted) {
        if(!c || c.contrato) return c ? c.contrato : '';
        let id, n;
        const w = String(wanted || '').trim().toUpperCase();
        if(w) {
            if(contractTaken(db, w, c.id)) return '';
            id = w; n = contractSeq(db, w);
        } else { const nx = nextContractNumber(db); id = nx.id; n = nx.n; }
        c.contrato = id;
        db.cfg = db.cfg || {}; db.cfg.secuencias = db.cfg.secuencias || {};
        db.cfg.secuencias.conNext = Math.max(Number(db.cfg.secuencias.conNext) || 1, (n || 0) + 1, nextContractNumber(db).n);
        return id;
    }
    const contractTaken = (db, num, exceptId) => allCredits(db).some(c => c.id !== exceptId && c.contrato && String(c.contrato).toUpperCase() === String(num).toUpperCase());
    root.GycRules = {fiadorActivo,validFiador,nextContractNumber,assignContractNumber,contractTaken,montoEnLetras,plazoText,contractData,DEFAULT_RATE,validRate,toUsd,toUsdCeil,convertUsdPayment,trashDetail,purgeTrash,applyPartnerEdit,applyEntryEdit,daysBetween,clientHistory,ACC_TYPES,EXPENSE_CATEGORIES,validEntry,accountingReport,monthlyAccounting,projectedInterest,projectedInterestDetail,projectedInterestByClient,balanceSheet,smsNumber,paymentSms,reminderSms,smsLink,digestText,shouldNotify,normalize,can,canDeleteUser,dateKey,range,cashReport,addDays,dailySeries,matches,creditSearch,validContribution,partnerReport,addMonths,monthlyContributions,partnerDashboard,validContributionEdit,applyContributionEdit,PARTNER_LOCK,verifyPartnerLock};
})(globalThis);