export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  remove(k: string): void {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
  json<T>(k: string, fallback: T): T {
    try {
      const v = JSON.parse(localStorage.getItem(k) || "");
      return v ?? fallback;
    } catch {
      return fallback;
    }
  },
  setJson<T>(k: string, v: T): boolean {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  }
};
