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
        return {rows,total,mora,recovered:total-mora,byCollector};
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
        const parts = [`${plain(p.empresa) || 'GYC Capital'}: ${plain(p.cliente).split(' ').slice(0,2).join(' ')}, recibimos su pago de ${money(p.monto)} el ${plain(p.fecha)}.`];
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
    root.GycRules = {smsNumber,paymentSms,reminderSms,smsLink,digestText,shouldNotify,normalize,can,canDeleteUser,dateKey,range,cashReport,addDays,dailySeries,matches,creditSearch,validContribution,partnerReport,addMonths,monthlyContributions,partnerDashboard,validContributionEdit,applyContributionEdit,PARTNER_LOCK,verifyPartnerLock};
})(globalThis);