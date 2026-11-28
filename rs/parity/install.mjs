// Installs wtx as `npm i -g` would install it under a prefix, for the parity
// cases named "v-install" (rs/parity/drive.mjs, PARITY_INSTALL) and for
// rs/parity/launcher.mjs:
//
//   <prefix>/bin/wtx                          the command, a symbolic link
//   <prefix>/lib/node_modules/@snomiao/wtx    the package
//   <prefix>/lib/node_modules/@snomiao/wtx-<platform>   (the binary's side)
//
// The TypeScript's side is @snomiao/wtx 0.3.4 as published: bin/wtx is
// wtx.mjs. The binary's side is the package rustify's pack.mjs packed into
// `dist` (rs/parity/proof.sh packs it with the binary under test): bin/wtx
// is rustify's launcher, which bun runs and which starts the binary from the
// platform package beside it. Both take node_modules (bun-pty,
// @xterm/headless) from this checkout. Returns the command.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `standIn`: a package whose wtx.mjs goes in place of the packed one (the
 *  parity runner's stand-in, in its --handback check). */
export function install({ prefix, side, dist, standIn }) {
  const scope = path.join(prefix, "lib", "node_modules", "@snomiao");
  const pkg = path.join(scope, "wtx");
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  if (side === "ts") {
    fs.mkdirSync(pkg, { recursive: true });
    for (const file of ["wtx.mjs", "package.json", "src"]) fs.cpSync(path.join(REPO, file), path.join(pkg, file), { recursive: true });
    fs.chmodSync(path.join(pkg, "wtx.mjs"), 0o755);
    fs.symlinkSync("../lib/node_modules/@snomiao/wtx/wtx.mjs", path.join(prefix, "bin", "wtx"));
  } else {
    const key = `${process.platform}-${process.arch}`;
    if (!dist || !fs.existsSync(path.join(dist, "main")) || !fs.existsSync(path.join(dist, key))) {
      throw new Error(`no package packed for ${key} in ${dist || "(none given)"}: rs/parity/proof.sh packs one`);
    }
    fs.cpSync(path.join(dist, "main"), pkg, { recursive: true });
    fs.cpSync(path.join(dist, key), path.join(scope, `wtx-${key}`), { recursive: true });
    if (standIn) fs.copyFileSync(path.join(standIn, "wtx.mjs"), path.join(pkg, "wtx.mjs"));
    fs.chmodSync(path.join(pkg, "rustify", "wtx"), 0o755);
    fs.chmodSync(path.join(scope, `wtx-${key}`, "bin", "wtx"), 0o755);
    fs.symlinkSync("../lib/node_modules/@snomiao/wtx/rustify/wtx", path.join(prefix, "bin", "wtx"));
  }
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(pkg, "node_modules"));
  return { command: path.join(prefix, "bin", "wtx"), pkg };
}
