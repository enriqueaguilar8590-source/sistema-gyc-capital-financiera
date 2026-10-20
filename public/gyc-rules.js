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
    root.GycRules = {normalize,can,canDeleteUser,dateKey,range,cashReport};
})(globalThis);