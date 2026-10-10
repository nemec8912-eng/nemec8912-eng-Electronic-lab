declare module 'react-dom/client' {
  export function createRoot(el: Element): { render(node: any): void; unmount(): void };
}
