// Type shim for @lydell/node-pty.
// The package ships types at node-pty.d.ts but its "exports" field only maps
// "./index.js", so TypeScript with moduleResolution:"bundler" cannot discover
// them.  This ambient declaration provides the subset of types we use.

declare module '@lydell/node-pty' {
  export function spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: { [key: string]: string | undefined };
      encoding?: string | null;
    },
  ): IPty;

  export interface IPty {
    readonly pid: number;
    readonly cols: number;
    readonly rows: number;
    readonly process: string;
    readonly onData: IEvent<string>;
    readonly onExit: IEvent<{ exitCode: number; signal?: number }>;
    resize(columns: number, rows: number): void;
    write(data: string | Buffer): void;
    kill(signal?: string): void;
    clear(): void;
    pause(): void;
    resume(): void;
    handleFlowControl: boolean;
  }

  export interface IDisposable {
    dispose(): void;
  }

  export interface IEvent<T> {
    (listener: (e: T) => any): IDisposable;
  }
}
