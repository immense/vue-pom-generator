declare module "node:fs/promises" {
  export function writeFile(path: string, data: string, encoding: string): Promise<void>;
}
