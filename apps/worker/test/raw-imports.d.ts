// Vite's `?raw` import, used to read fixture files (the Supabase seed SQL)
// inside the workerd pool, which has no node:fs. Lives in its own file with no
// top-level import: a `declare module` in a module file is an augmentation,
// and wildcard patterns only work in ambient (script) declarations.
declare module "*.sql?raw" {
  const text: string;
  export default text;
}

// The committed capability declarations, read as text so `capabilities-dts`
// can compare them against a fresh render from inside the pool. Importing the
// .d.ts as a MODULE would give its declarations, not its bytes, and the drift
// check needs the bytes.
declare module "*.d.ts?raw" {
  const text: string;
  export default text;
}
