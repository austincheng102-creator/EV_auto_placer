export const americanToDecimal=o=>!Number.isFinite(Number(o))||Number(o)===0?null:Number(o)>0?1+Number(o)/100:1+100/-Number(o);
export const impliedProbability=o=>{const d=americanToDecimal(o);return d==null?null:1/d;};
export function noVigProbability(a,b,min=.97,max=1.15){const p=impliedProbability(a),q=impliedProbability(b),s=p+q;if(p==null||q==null||s<min||s>max)return null;return p/s;}
export function expectedValuePct(p,o){const d=americanToDecimal(o);return !Number.isFinite(p)||d==null?null:(p*d-1)*100;}
export function decimalToAmerican(d){d=Number(d);return !Number.isFinite(d)||d<=1?null:d>=2?Math.round((d-1)*100):Math.round(-100/(d-1));}
