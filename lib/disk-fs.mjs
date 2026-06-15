// disk-fs.mjs — a just-bash IFileSystem backed by an Archil disk via the `disk`
// SDK's S3-style object operations (getObject/putObject/listObjects/...).
//
// Why this and not @archildata/just-bash's ArchilFs: ArchilFs needs
// @archildata/native, whose rustls build panics on TLS init under any JS
// runtime. `disk` talks to Archil over plain HTTPS (no native dep), so it works
// under Bun and on Vercel. The agent's shell (just-bash) and file tools all
// share this one fs, so everything stays coherent on the persistent disk.
//
// Object stores have no real directories/symlinks/permissions, so:
//   - directories are implicit (key prefixes); mkdir drops a `.keep` marker so
//     empty dirs are observable, and readdir hides `.keep`.
//   - chmod/utimes are no-ops; symlink/link/readlink are unsupported.

import path from "node:path";

function fsErr(code, syscall, p) {
  const e = new Error(`${code}: ${syscall} '${p}'`);
  e.code = code; e.syscall = syscall; e.path = p;
  e.errno = { ENOENT: -2, EEXIST: -17, EISDIR: -21, ENOTDIR: -20, ENOSYS: -38, EINVAL: -22 }[code];
  return e;
}
const KEEP = ".keep";

export class DiskFs {
  constructor(disk) { this.disk = disk; }

  // path "/a/b" -> object key "a/b"; root "/" -> ""
  _key(p) { return path.posix.normalize("/" + String(p)).replace(/^\/+/, ""); }
  _norm(p) { return path.posix.normalize("/" + String(p)); }

  resolvePath(base, ...paths) {
    // path.posix.resolve (not join) so an absolute segment overrides the base
    // instead of being appended (join("/workspace","/workspace") would double it).
    return path.posix.resolve(base || "/", ...paths.map(String));
  }

  async readFileBuffer(p) {
    const key = this._key(p);
    try { return await this.disk.getObject(key); }
    catch (e) {
      if (e?.status === 404 || e?.code === "NoSuchKey") {
        if (await this._isDir(key)) throw fsErr("EISDIR", "read", this._norm(p));
        throw fsErr("ENOENT", "open", this._norm(p));
      }
      throw e;
    }
  }
  async readFile(p, encoding) {
    const buf = await this.readFileBuffer(p);
    return Buffer.from(buf).toString(encoding && encoding !== "binary" ? encoding : "utf8");
  }

  async writeFile(p, content) {
    const key = this._key(p);
    const body = typeof content === "string" ? content
      : content instanceof Uint8Array ? content : new Uint8Array(content);
    await this.disk.putObject(key, body);
  }
  async appendFile(p, content) {
    let prev = new Uint8Array(0);
    try { prev = await this.readFileBuffer(p); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const add = typeof content === "string" ? new TextEncoder().encode(content)
      : content instanceof Uint8Array ? content : new Uint8Array(content);
    const out = new Uint8Array(prev.length + add.length);
    out.set(prev); out.set(add, prev.length);
    await this.writeFile(p, out);
  }

  async _isDir(key) {
    if (key === "") return true;
    const page = await this.disk.listObjects(key.replace(/\/?$/, "/"), { singlePage: true, limit: 1 });
    return (page.objects?.length || 0) > 0 || (page.commonPrefixes?.length || 0) > 0;
  }
  async exists(p) {
    const key = this._key(p);
    if (key === "") return true;
    if (await this.disk.objectExists(key)) return true;
    return this._isDir(key);
  }
  async stat(p) {
    const key = this._key(p);
    if (key !== "") {
      const meta = await this.disk.headObject(key);
      if (meta) return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o644, size: meta.size ?? 0, mtime: meta.lastModified ? new Date(meta.lastModified) : new Date(0) };
    }
    if (await this._isDir(key)) return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date(0) };
    throw fsErr("ENOENT", "stat", this._norm(p));
  }
  async lstat(p) { return this.stat(p); }

  async readdirWithFileTypes(p) {
    const key = this._key(p);
    const prefix = key === "" ? "" : key + "/";
    const page = await this.disk.listObjects(prefix);
    const out = [];
    for (const obj of page.objects || []) {
      const name = obj.key.slice(prefix.length);
      if (!name || name === KEEP || name.includes("/")) continue;
      out.push({ name, isFile: true, isDirectory: false, isSymbolicLink: false });
    }
    for (const cp of page.commonPrefixes || []) {
      const name = cp.slice(prefix.length).replace(/\/$/, "");
      if (name) out.push({ name, isFile: false, isDirectory: true, isSymbolicLink: false });
    }
    return out;
  }
  async readdir(p) { return (await this.readdirWithFileTypes(p)).map((e) => e.name); }

  async mkdir(p, _options) {
    const key = this._key(p);
    if (key === "") return;
    await this.disk.putObject(key + "/" + KEEP, ""); // marker so empty dir is observable
  }

  async rm(p, options = {}) {
    const key = this._key(p);
    if (await this.disk.objectExists(key)) { await this.disk.deleteObject(key); return; }
    if (options.recursive) {
      const all = await this.disk.listObjects(key + "/", { recursive: true });
      // Deepest-first: Archil (S3 directory buckets) refuses to delete a
      // directory marker while it still has children, so order matters.
      const keys = (all.objects || [])
        .map((o) => o.key)
        .sort((a, b) => b.split("/").length - a.split("/").length || b.length - a.length);
      for (const k of keys) {
        try { await this.disk.deleteObject(k); } catch { /* marker race / already gone */ }
      }
      return;
    }
    if (!options.force) throw fsErr("ENOENT", "unlink", this._norm(p));
  }

  async cp(src, dest, options = {}) {
    const sk = this._key(src);
    if (options.recursive && await this._isDir(sk)) {
      const all = await this.disk.listObjects(sk + "/", { recursive: true });
      for (const obj of all.objects || []) {
        const rel = obj.key.slice(sk.length);
        const body = await this.disk.getObject(obj.key);
        await this.disk.putObject(this._key(dest) + rel, body);
      }
      return;
    }
    await this.disk.putObject(this._key(dest), await this.disk.getObject(sk));
  }
  async mv(src, dest) { await this.cp(src, dest, { recursive: true }); await this.rm(src, { recursive: true, force: true }); }

  async chmod() { /* object store: no perms */ }
  async utimes() { /* object store: no mtime control */ }
  async symlink(_t, p) { throw fsErr("ENOSYS", "symlink", this._norm(p)); }
  async link(_e, p) { throw fsErr("ENOSYS", "link", this._norm(p)); }
  async readlink(p) { throw fsErr("EINVAL", "readlink", this._norm(p)); }
  async realpath(p) { return this._norm(p); }

  async getAllPaths() {
    const all = await this.disk.listObjects("", { recursive: true });
    return (all.objects || []).map((o) => "/" + o.key).filter((k) => !k.endsWith("/" + KEEP));
  }
}
