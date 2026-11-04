import { basename, dirname } from "node:path";
import type { JournalFile, JournalFs } from "../src/agents/lead";

// A file system that can lose power, for the lead's journal.
//
// It keeps two pictures of the disk. The running process sees the live one. A reboot sees only what
// has reached the disk, and the rules for that are the strict ones a program may not rely on more
// than:
//
// - what a file holds reaches the disk when the file is synced (`handle.sync()`), and a file that
//   was never synced is empty after a reboot, even if its name is there;
// - a name (a create, a rename, a remove) reaches the disk when the directory that holds it is
//   synced (`sync()` on a handle opened on the directory), and not before; a new folder is a name
//   in its parent, and without it the folder and all that is in it are gone.
//
// `powerCut()` is the reboot. `cutAfter(n)` lets n more operations through and cuts the power at the
// next one, before it takes effect, and the operation throws `PowerCut`: the process is gone.

/** The process died: the power went. */
export class PowerCut extends Error {
  constructor(op: string) {
    super(`the power went at ${op}`);
    this.name = "PowerCut";
  }
}

interface Inode {
  /** What the running process sees. */
  data: string;
  /** What is on the disk, or null if the file was never synced. */
  disk: string | null;
}

function errno(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

export class PowerFs implements JournalFs {
  private names = new Map<string, Inode>();
  private dirs = new Set<string>(["/"]);
  private diskNames = new Map<string, Inode>();
  private diskDirs = new Set<string>(["/"]);
  private cutAt: number | null = null;
  /** Every operation so far, by name, in order. */
  readonly ops: string[] = [];
  /** Makes the next sync of a directory fail with this error, once. */
  failDirSync: Error | null = null;

  /** Lets `n` more operations through, and cuts the power at the one after. */
  cutAfter(n: number): void {
    this.cutAt = this.ops.length + n;
  }

  /** The reboot: the live picture goes back to what the disk holds. */
  powerCut(): void {
    this.cutAt = null;
    // A folder whose name never reached its parent is gone, and what was in it with it.
    const kept = new Set<string>(["/"]);
    for (const dir of [...this.diskDirs].sort((a, b) => a.length - b.length)) {
      if (kept.has(dirname(dir))) kept.add(dir);
    }
    this.dirs = kept;
    this.names = new Map([...this.diskNames].filter(([path]) => kept.has(dirname(path))));
    for (const inode of this.names.values()) inode.data = inode.disk ?? "";
  }

  /** Everything reaches the disk, as if the system had flushed in the background. */
  settle(): void {
    for (const inode of this.names.values()) inode.disk = inode.data;
    this.diskNames = new Map(this.names);
    this.diskDirs = new Set(this.dirs);
  }

  /** What a file holds right now, or null if there is no such file. */
  peek(path: string): string | null {
    return this.names.get(path)?.data ?? null;
  }

  private step(op: string): void {
    this.ops.push(op);
    if (this.cutAt !== null && this.ops.length > this.cutAt) {
      this.powerCut();
      throw new PowerCut(op);
    }
  }

  private syncDir(dir: string): void {
    for (const path of [...this.diskNames.keys()]) {
      if (dirname(path) === dir) this.diskNames.delete(path);
    }
    for (const [path, inode] of this.names) {
      if (dirname(path) === dir) this.diskNames.set(path, inode);
    }
    for (const path of [...this.diskDirs]) {
      if (path !== "/" && dirname(path) === dir) this.diskDirs.delete(path);
    }
    for (const path of this.dirs) {
      if (path !== "/" && dirname(path) === dir) this.diskDirs.add(path);
    }
  }

  async mkdir(path: string): Promise<string | undefined> {
    this.step(`mkdir ${path}`);
    const missing: string[] = [];
    for (let at = path; !this.dirs.has(at); at = dirname(at)) missing.push(at);
    for (const at of missing) this.dirs.add(at);
    return missing.at(-1);
  }

  async open(path: string, flags: string): Promise<JournalFile> {
    this.step(`open ${flags} ${path}`);
    if (this.dirs.has(path)) {
      return {
        writeFile: async () => {
          throw errno("EISDIR", path);
        },
        sync: async () => {
          this.step(`sync dir ${path}`);
          if (this.failDirSync !== null) {
            const error = this.failDirSync;
            this.failDirSync = null;
            throw error;
          }
          this.syncDir(path);
        },
        close: async () => this.step(`close dir ${path}`),
      };
    }
    if (flags !== "wx") throw errno("ENOENT", path);
    if (!this.dirs.has(dirname(path))) throw errno("ENOENT", path);
    if (this.names.has(path)) throw errno("EEXIST", path);
    const inode: Inode = { data: "", disk: null };
    this.names.set(path, inode);
    return {
      writeFile: async (text) => {
        this.step(`write ${basename(path)}`);
        inode.data = text;
      },
      sync: async () => {
        this.step(`sync ${basename(path)}`);
        inode.disk = inode.data;
      },
      close: async () => this.step(`close ${basename(path)}`),
    };
  }

  async rename(from: string, to: string): Promise<void> {
    this.step(`rename ${basename(from)} to ${basename(to)}`);
    const inode = this.names.get(from);
    if (inode === undefined) throw errno("ENOENT", from);
    this.names.delete(from);
    this.names.set(to, inode);
  }

  async rm(path: string): Promise<void> {
    this.step(`rm ${basename(path)}`);
    this.names.delete(path);
  }

  async readFile(path: string, _encoding?: "utf8"): Promise<string> {
    const inode = this.names.get(path);
    if (inode === undefined) throw errno("ENOENT", path);
    return inode.data;
  }

  async readdir(path: string): Promise<string[]> {
    if (!this.dirs.has(path)) throw errno("ENOENT", path);
    const inside = (all: Iterable<string>) =>
      [...all].filter((one) => one !== "/" && dirname(one) === path).map((one) => basename(one));
    return [...inside(this.names.keys()), ...inside(this.dirs)];
  }
}
