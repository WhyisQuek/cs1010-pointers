/**
 * Which build this is. `npm run dev` / `npm run build` make the student app;
 * `npm run dev:instructor` / `npm run build:instructor` (Vite mode "instructor") add the
 * Level editor. Vite replaces the expression with a constant at build time, so the student
 * build leaves the editor out entirely rather than hiding it.
 */
export const INSTRUCTOR = import.meta.env.MODE === 'instructor';
