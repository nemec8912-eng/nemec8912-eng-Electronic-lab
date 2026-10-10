// Упрощённые объявления React для сред без доступа к npm (@types/react недоступен).
// Используются только tsconfig.offline.json. На обычной машине — настоящие @types/react.
declare module 'react' {
  export type ReactNode = any;
  export type SetStateAction<S> = S | ((prev: S) => S);
  export type Dispatch<A> = (value: A) => void;
  export interface MutableRefObject<T> { current: T }
  export interface RefObject<T> { readonly current: T | null }
  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useRef<T>(initial: T): MutableRefObject<T>;
  export function useRef<T>(initial: T | null): RefObject<T>;
  export function useEffect(effect: () => void | (() => void) | Promise<void>, deps?: readonly unknown[]): void;
  export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: readonly unknown[]): T;
  export function useMemo<T>(fn: () => T, deps: readonly unknown[]): T;
  export function useContext<T>(ctx: Context<T>): T;
  export interface Context<T> { Provider: (props: { value: T; children?: ReactNode }) => any }
  export function createContext<T>(value: T): Context<T>;
  export type MouseEvent<T = Element> = globalThis.MouseEvent & { currentTarget: T; target: EventTarget };
  export type PointerEvent<T = Element> = globalThis.PointerEvent & { currentTarget: T; target: EventTarget };
  export type WheelEvent<T = Element> = globalThis.WheelEvent & { currentTarget: T; target: EventTarget };
}
