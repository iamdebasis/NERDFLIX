/** Vite serves these as URLs; without this TypeScript rejects the import. */
declare module '*.png' {
  const src: string;
  export default src;
}
