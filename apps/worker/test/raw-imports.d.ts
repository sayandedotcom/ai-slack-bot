// Vite's `?raw` import, used to read fixture files (the Supabase seed SQL)
// inside the workerd pool, which has no node:fs. Lives in its own file with no
// top-level import: a `declare module` in a module file is an augmentation,
// and wildcard patterns only work in ambient (script) declarations.
declare module "*.sql?raw" {
  const text: string;
  export default text;
}
