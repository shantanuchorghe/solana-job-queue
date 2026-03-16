declare module "react" {
  export type CSSProperties = Record<string, string | number | undefined>;
  export type FormEvent<T = Element> = {
    preventDefault(): void;
    currentTarget: T;
    target: EventTarget & T;
  };

  export function useState<T>(initialState: T | (() => T)): [T, (value: T | ((current: T) => T)) => void];
  export function useEffect(effect: () => void | (() => void | Promise<void>), deps?: readonly unknown[]): void;
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T;

  export const StrictMode: ({ children }: { children?: unknown }) => unknown;

  const React: {
    StrictMode: typeof StrictMode;
  };

  export default React;
}

declare module "react/jsx-runtime" {
  export const Fragment: unique symbol;
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown;
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown;
}

declare module "react-dom/client" {
  export function createRoot(container: Element | DocumentFragment): {
    render(children: unknown): void;
  };
}

declare module "@target/idl/dec_queue.json" {
  const value: { address: string };
  export default value;
}

declare namespace JSX {
  interface IntrinsicAttributes {
    key?: string | number;
  }

  interface IntrinsicElements {
    [elementName: string]: any;
  }
}
