const enabled = (process.env.FORCE_COLOR === '1')
  || (process.stdout.isTTY && !process.env.NO_COLOR);

const wrap = (code) => enabled ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => s;

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const magenta = wrap('35');
export const cyan = wrap('36');
export const brightYellow = wrap('93');
