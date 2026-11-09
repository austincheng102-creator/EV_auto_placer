// Generic adapter driven by request templates in config.json, filled in from the
// book's real "Copy as cURL" requests. {{name}} placeholders are substituted.
const num = (v) => (v == null || v === '' ? null : Number(v));
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

function fill(tpl, vars) {
  if (typeof tpl === 'string') {
    const whole = tpl.match(/^\{\{(\w+)\}\}$/);
    if (whole) return vars[whole[1]];           // keep numbers as numbers
    return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
  }
  if (Array.isArray(tpl)) return tpl.map((x) => fill(x, vars));
  if (tpl && typeof tpl === 'object') return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, fill(v, vars)]));
  return tpl;
}

export function makeTemplateBook(name, label, bcfg, bridge) {
  const need = (k) => { if (!bcfg?.[k]) throw new Error(`${name}.${k} not configured (need the captured request)`); return bcfg[k]; };
  return {
    name, label,
    async recheck(row) {
      const spec = need('recheck');
      const res = await bridge.send(name, { kind: 'recheck', ...fill(spec.request, { ...row }) });
      const j = res.json;
      return {
        odds: num(get(j, spec.oddsPath)),
        line: spec.linePath ? num(get(j, spec.linePath)) : row.line,
        maxStake: spec.maxStakePath ? num(get(j, spec.maxStakePath)) : null,
        suspended: spec.suspendedPath ? !!get(j, spec.suspendedPath) : false,
        raw: j,
      };
    },
    async place(row, stake, quote) {
      const spec = need('place');
      const res = await bridge.send(name, { kind: 'place', ...fill(spec.request, {
        ...row, stake, odds: quote.odds, decimalOdds: 1 + (quote.odds > 0 ? quote.odds / 100 : 100 / -quote.odds),
        requestId: crypto.randomUUID(),
      }) });
      const betId = get(res.json, spec.betIdPath);
      if (res.status >= 400 || !betId) {
        const reason = spec.errorPath ? get(res.json, spec.errorPath) : `HTTP ${res.status}`;
        throw new Error(`rejected: ${reason ?? JSON.stringify(res.json).slice(0, 200)}`);
      }
      return { betId };
    },
  };
}
