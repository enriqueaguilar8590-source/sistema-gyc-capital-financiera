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
    root.GycRules = {normalize,can,canDeleteUser,dateKey,range,cashReport,addDays,dailySeries,matches,creditSearch,validContribution,partnerReport};
})(globalThis);