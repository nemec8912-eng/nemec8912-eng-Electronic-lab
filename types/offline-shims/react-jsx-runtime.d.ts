declare module 'react/jsx-runtime' {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
  export namespace JSX {
    type Element = any;
    interface IntrinsicElements { [name: string]: any }
    interface IntrinsicAttributes { key?: any }
  }
}
