export interface User {
  name: string;
  /** Caret and name label. */
  color: string;
  /** Selection highlight. The same hue at low alpha, so text stays readable. */
  colorLight: string;
}

/** Distinguishable at a glance and readable against a dark editor background. */
const COLORS = ['#e06c75', '#61afef', '#98c379', '#e5c07b', '#c678dd', '#56b6c2'];
const ANIMALS = ['otter', 'heron', 'lynx', 'marten', 'shrike', 'ibex', 'raven', 'vole'];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

/**
 * There is no account system yet, so an identity is generated per tab and kept
 * in sessionStorage. Two tabs are two users, which is exactly what you want when
 * testing collaboration on one machine.
 */
export function localUser(): User {
  const cached = sessionStorage.getItem('cce.user');
  if (cached) return JSON.parse(cached) as User;

  const color = pick(COLORS);
  const user: User = { name: pick(ANIMALS), color, colorLight: `${color}33` };
  sessionStorage.setItem('cce.user', JSON.stringify(user));
  return user;
}
