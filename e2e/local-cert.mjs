// The certificate a local HTTPS stack serves in `run-local.mjs --rehearse-test-people`: made for one run, for
// `localhost` and `127.0.0.1` only, and the one thing that run trusts beyond the usual. Certificate checking stays on.
//
// It is a server certificate and not an authority: `CA:FALSE`, and usable only for a TLS server. So its key, which sits
// in a temporary folder for the length of the run, can't sign a certificate for any other name that a process trusting
// this one would accept.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A config of its own, so nothing comes from the machine's openssl.cnf, whose default makes a self-signed certificate
// an authority. These section names work in OpenSSL and in the LibreSSL that macOS ships.
const CONFIG = `[req]
distinguished_name = subject
x509_extensions = server
prompt = no

[subject]
CN = localhost

[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
`;

/**
 * Makes the key and certificate in a new temporary folder, and returns their paths, the certificate's bytes as `ca`, and
 * `remove`. The folder is removed when the process exits, and on SIGINT or SIGTERM, which then end the process.
 */
export function localCertificate({ openssl = "openssl" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "podster-e2e-tls-"));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  process.on("exit", remove);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      remove();
      process.exit(130);
    });
  }
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const config = join(dir, "openssl.cnf");
  writeFileSync(config, CONFIG);
  try {
    execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-config", config, "-keyout", key, "-out", cert], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    remove();
    const said = String(error.stderr ?? "").trim();
    const why = error.code === "ENOENT" ? `\`${openssl}\` isn't installed or isn't on PATH` : `\`${openssl} req\` failed${said ? `:\n${said}` : ` (${error.message})`}`;
    throw new Error(`This run needs the openssl command, to make the certificate its local HTTPS stack serves. ${why}`);
  }
  return { key, cert, ca: readFileSync(cert), dir, remove };
}
